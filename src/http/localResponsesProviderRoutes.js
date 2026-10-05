import crypto from 'node:crypto';
import express from '../runtime/express.js';
import {
  buildResponsesBridgePrompt,
  extractResponsesTurn,
  makeResponsesCompletedEvent,
  makeResponsesMessageItem,
  makeResponsesUsage,
  parseResponsesToolCall,
} from '../responsesPayload.js';

const LOCAL_MODEL_ID = 'chatgpt-web';

function requestKind(req) {
  const raw = String(req.headers['x-codex-turn-metadata'] || '').trim();
  if (!raw) return 'turn';
  try {
    const value = JSON.parse(raw);
    return String(value?.request_kind || 'turn');
  } catch {
    return 'turn';
  }
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function initResponsesSse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function outputText(response) {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  return String(response.answer || response.response || response.text || '');
}

function localOnly(bridge) {
  return (req, res, next) => {
    if (!bridge.isLocalRequest(req)) {
      res.status(403).json({
        error: {
          code: 'loopback_only',
          message: 'The local ChatGPT Responses provider only accepts loopback requests.',
        },
      });
      return;
    }
    next();
  };
}

function unsupported(res, message) {
  res.status(400).json({
    error: {
      code: 'unsupported',
      message,
    },
  });
}

function connectedClientIds(health) {
  return new Set((health?.clients || []).map((client) => String(client?.id || '')).filter(Boolean));
}

function refreshWorkerState(workerState, health, turn) {
  if (!workerState?.clientId) return;
  if (connectedClientIds(health).has(workerState.clientId)) return;

  if (turn.kind === 'tool_result') {
    const error = new Error('The dedicated ChatGPT worker tab was closed or disconnected during an active local tool loop. The bridge will not silently move this tool result to another conversation.');
    error.statusCode = 409;
    error.code = 'worker_context_lost';
    throw error;
  }

  workerState.clientId = '';
  workerState.sessionId = '';
  workerState.startedAt = 0;
}

async function collectBrowserResponse(req, res, bridge, workerState) {
  const kind = requestKind(req);
  if (kind !== 'turn') {
    const error = new Error(`Background Codex request kind '${kind}' is disabled for the local ChatGPT web provider.`);
    error.statusCode = 400;
    error.code = 'background_request_disabled';
    throw error;
  }

  const health = bridge.health();
  if (!health.ok) {
    const error = new Error('No compatible logged-in ChatGPT browser tab is connected to the local bridge.');
    error.statusCode = 503;
    error.code = 'browser_not_connected';
    throw error;
  }

  const turn = extractResponsesTurn(req.body || {});
  refreshWorkerState(workerState, health, turn);

  const prompt = buildResponsesBridgePrompt(turn);
  if (!prompt) {
    const error = new Error('No user message or local tool result was found in the Responses request.');
    error.statusCode = 400;
    error.code = 'missing_input';
    throw error;
  }

  const firstWorkerTurn = !workerState.clientId;
  if (turn.kind === 'tool_result' && firstWorkerTurn) {
    const error = new Error('A local tool result arrived without an established ChatGPT worker conversation. Refusing to attach it to an unrelated browser tab.');
    error.statusCode = 409;
    error.code = 'worker_context_missing';
    throw error;
  }

  const abortController = new AbortController();
  let complete = false;
  const onClose = () => {
    if (!complete && !abortController.signal.aborted) abortController.abort('Codex client disconnected');
  };
  res.on('close', onClose);

  try {
    const request = {
      message: prompt,
      attachments: [],
      // The browser tab is the authority for the actual ChatGPT model. Do not
      // map the Codex metadata slug into a ChatGPT model selector here.
      model: '',
      effort: '',
      sessionId: '',
      sourceClientId: firstWorkerTurn ? '' : workerState.clientId,
      newSession: firstWorkerTurn,
      freshTab: firstWorkerTurn,
    };
    const options = {
      fullResponse: true,
      signal: abortController.signal,
      sourceClientId: firstWorkerTurn ? '' : workerState.clientId,
      // Create the dedicated worker without stealing focus from the user's
      // normal ChatGPT tab. Subsequent turns are pinned to its client id.
      autoOpenTab: firstWorkerTurn,
      autoOpenTabActive: false,
    };

    const response = await bridge.sendRequest(request, {}, options);
    complete = true;

    const sourceClientId = String(response?.sourceClientId || '').trim();
    if (sourceClientId) workerState.clientId = sourceClientId;
    const sessionId = String(response?.session?.id || '').trim();
    if (sessionId) workerState.sessionId = sessionId;
    if (!workerState.startedAt) workerState.startedAt = Date.now();
    workerState.lastUsedAt = Date.now();

    return { answer: outputText(response), response, turn };
  } finally {
    res.off('close', onClose);
  }
}

function translatedOutput(answer, tools) {
  const toolCall = parseResponsesToolCall(answer, tools);
  if (toolCall) return { item: toolCall, toolCall: true };
  return { item: makeResponsesMessageItem(answer), toolCall: false };
}

function nonStreamingResponse(responseId, requestedModel, translated) {
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: requestedModel || LOCAL_MODEL_ID,
    output: [translated.item],
    usage: makeResponsesUsage(),
    metadata: {
      provider: 'chatgpt-browser-bridge',
      backend: 'chatgpt-web-session',
      codex_backend: false,
    },
  };
}

async function handleResponses(req, res, workerState) {
  const responseId = `resp_local_${crypto.randomUUID().replaceAll('-', '')}`;
  const stream = req.body?.stream !== false;

  try {
    const { answer, turn } = await collectBrowserResponse(req, res, req.app.locals.bridge, workerState);
    const translated = translatedOutput(answer, turn.tools);

    if (!stream) {
      res.json(nonStreamingResponse(responseId, turn.requestedModel, translated));
      return;
    }

    initResponsesSse(res);
    // Keep this minimal: Codex's eventsource client only needs the event type and
    // response object here, and this exactly matches the proven Cyrus shim shape.
    writeSse(res, { type: 'response.created', response: {} });

    if (translated.toolCall) {
      writeSse(res, {
        type: 'response.output_item.done',
        item: translated.item,
      });
    } else {
      const emptyItem = makeResponsesMessageItem('', translated.item.id);
      writeSse(res, {
        type: 'response.output_item.added',
        item: emptyItem,
      });
      if (answer) {
        writeSse(res, {
          type: 'response.output_text.delta',
          delta: answer,
        });
      }
      writeSse(res, {
        type: 'response.output_item.done',
        item: translated.item,
      });
    }

    writeSse(res, makeResponsesCompletedEvent(responseId));
    res.end();
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (res.headersSent) {
      writeSse(res, {
        type: 'response.failed',
        response: {
          id: responseId,
          error: {
            code: error?.code || 'local_bridge_failed',
            message: error?.message || 'Local ChatGPT bridge request failed',
          },
        },
      });
      res.end();
      return;
    }
    res.status(statusCode).json({
      error: {
        code: error?.code || 'local_bridge_failed',
        message: error?.message || 'Local ChatGPT bridge request failed',
      },
    });
  }
}

export function createLocalResponsesProviderRouter(bridge) {
  const router = express.Router();
  const workerState = {
    clientId: '',
    sessionId: '',
    startedAt: 0,
    lastUsedAt: 0,
  };

  router.use((req, _res, next) => {
    req.app.locals.bridge = bridge;
    next();
  });

  const requireLocal = localOnly(bridge);

  router.get('/v1/local-provider/status', requireLocal, (_req, res) => {
    const health = bridge.health();
    const workerConnected = Boolean(workerState.clientId && connectedClientIds(health).has(workerState.clientId));
    res.json({
      ok: health.ok,
      provider: 'chatgpt-browser-bridge',
      modelBackend: 'chatgpt-web-session',
      transport: 'loopback-browser-extension',
      loopbackOnly: true,
      codexBackend: false,
      codexOAuthRequired: false,
      openAiApiKeyRequired: false,
      providerFallback: false,
      browserConnected: health.ok,
      selectedClientId: health.selectedClientId || '',
      activeClient: health.activeClient || null,
      workerMode: 'dedicated-background-tab',
      workerConnected,
      workerClientId: workerConnected ? workerState.clientId : '',
      workerSessionId: workerConnected ? workerState.sessionId : '',
      workerStartedAt: workerConnected ? workerState.startedAt : 0,
      workerLastUsedAt: workerConnected ? workerState.lastUsedAt : 0,
    });
  });

  const models = (_req, res) => {
    res.json({
      object: 'list',
      data: [{ id: LOCAL_MODEL_ID, object: 'model', owned_by: 'local-chatgpt-web' }],
      // Codex's model manager accepts this shape and keeps its bundled metadata
      // when the provider does not publish an authoritative model catalog.
      models: [],
    });
  };
  router.get('/v1/models', requireLocal, models);
  router.post('/v1/models', requireLocal, models);

  router.post('/v1/responses', requireLocal, (req, res) => handleResponses(req, res, workerState));
  router.post('/responses', requireLocal, (req, res) => handleResponses(req, res, workerState));

  router.post('/v1/responses/compact', requireLocal, (_req, res) => unsupported(
    res,
    'Remote compaction is disabled for the local ChatGPT web provider. The launcher disables background features so hidden model calls cannot silently consume another quota pool.',
  ));
  router.post('/responses/compact', requireLocal, (_req, res) => unsupported(
    res,
    'Remote compaction is disabled for the local ChatGPT web provider.',
  ));
  router.post('/v1/memories/trace_summarize', requireLocal, (_req, res) => unsupported(
    res,
    'Memory trace summarization is disabled for the local ChatGPT web provider.',
  ));
  router.post('/memories/trace_summarize', requireLocal, (_req, res) => unsupported(
    res,
    'Memory trace summarization is disabled for the local ChatGPT web provider.',
  ));

  return router;
}
