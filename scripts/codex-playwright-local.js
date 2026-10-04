#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  buildResponsesBridgePrompt,
  extractResponsesTurn,
  makeResponsesCompletedEvent,
  makeResponsesMessageItem,
  makeResponsesUsage,
  parseResponsesToolCall,
} from '../src/responsesPayload.js';
import { PlaywrightChatgptWorker } from '../src/playwrightChatgptWorker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const port = Number.parseInt(process.env.CHATGPT_PLAYWRIGHT_PORT || '8181', 10) || 8181;
const rootUrl = `http://127.0.0.1:${port}`;
const providerBaseUrl = `${rootUrl}/v1`;
const providerId = 'chatgpt_web_playwright';
const harnessModel = process.env.CHATGPT_BRIDGE_CODEX_MODEL || 'gpt-5.3-codex';
const LOCAL_MODEL_ID = 'chatgpt-web';

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function initSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
}

async function readJson(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('Request body is too large'), { statusCode: 413, code: 'body_too_large' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON'), { statusCode: 400, code: 'invalid_json' });
  }
}

function requestKind(req) {
  const raw = String(req.headers['x-codex-turn-metadata'] || '').trim();
  if (!raw) return 'turn';
  try {
    return String(JSON.parse(raw)?.request_kind || 'turn');
  } catch {
    return 'turn';
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
      provider: 'chatgpt-playwright-local',
      backend: 'chatgpt-web-session',
      transport: 'playwright-persistent-context',
      codex_backend: false,
    },
  };
}

async function handleResponseRequest(req, res, worker) {
  const responseId = `resp_local_${crypto.randomUUID().replaceAll('-', '')}`;
  let streamStarted = false;
  try {
    if (requestKind(req) !== 'turn') {
      throw Object.assign(new Error('Background Codex request kinds are disabled for the Playwright ChatGPT provider.'), {
        statusCode: 400,
        code: 'background_request_disabled',
      });
    }

    const body = await readJson(req);
    const turn = extractResponsesTurn(body);
    const prompt = buildResponsesBridgePrompt(turn);
    if (!prompt) {
      throw Object.assign(new Error('No user message or local tool result was found in the Responses request.'), {
        statusCode: 400,
        code: 'missing_input',
      });
    }

    const answer = await worker.send(prompt);
    const translated = translatedOutput(answer, turn.tools);
    const stream = body.stream !== false;

    if (!stream) {
      json(res, 200, nonStreamingResponse(responseId, turn.requestedModel, translated));
      return;
    }

    initSse(res);
    streamStarted = true;
    writeSse(res, { type: 'response.created', response: {} });

    if (translated.toolCall) {
      writeSse(res, { type: 'response.output_item.done', item: translated.item });
    } else {
      writeSse(res, {
        type: 'response.output_item.added',
        item: makeResponsesMessageItem('', translated.item.id),
      });
      if (answer) writeSse(res, { type: 'response.output_text.delta', delta: answer });
      writeSse(res, { type: 'response.output_item.done', item: translated.item });
    }

    writeSse(res, makeResponsesCompletedEvent(responseId));
    res.end();
  } catch (error) {
    const code = error?.code || 'playwright_provider_failed';
    const message = error?.message || String(error);
    if (streamStarted || res.headersSent) {
      writeSse(res, { type: 'response.failed', response: { id: responseId, error: { code, message } } });
      res.end();
      return;
    }
    json(res, Number.isInteger(error?.statusCode) ? error.statusCode : 500, { error: { code, message } });
  }
}

function createProviderServer(worker) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', rootUrl);
    const pathName = url.pathname;

    if (req.method === 'GET' && pathName === '/v1/local-provider/status') {
      json(res, 200, {
        ok: true,
        provider: 'chatgpt-playwright-local',
        modelBackend: 'chatgpt-web-session',
        transport: 'playwright-persistent-context',
        loopbackOnly: true,
        codexBackend: false,
        codexOAuthRequired: false,
        openAiApiKeyRequired: false,
        providerFallback: false,
        worker: worker.status(),
      });
      return;
    }

    if ((req.method === 'GET' || req.method === 'POST') && pathName === '/v1/models') {
      json(res, 200, {
        object: 'list',
        data: [{ id: LOCAL_MODEL_ID, object: 'model', owned_by: 'local-chatgpt-web' }],
        models: [],
      });
      return;
    }

    if (req.method === 'POST' && (pathName === '/v1/responses' || pathName === '/responses')) {
      await handleResponseRequest(req, res, worker);
      return;
    }

    if (req.method === 'POST' && [
      '/v1/responses/compact',
      '/responses/compact',
      '/v1/memories/trace_summarize',
      '/memories/trace_summarize',
    ].includes(pathName)) {
      json(res, 400, {
        error: {
          code: 'unsupported',
          message: 'Remote compaction/memory requests are disabled for the local ChatGPT Playwright provider.',
        },
      });
      return;
    }

    json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  });
}

function existingFile(value) {
  if (!value) return '';
  try { return fs.statSync(value).isFile() ? value : ''; } catch { return ''; }
}

function npmCodexEntryNear(directory) {
  if (!directory) return '';
  return [
    path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.mjs'),
  ].map(existingFile).find(Boolean) || '';
}

function npmNativeCodexNear(directory) {
  if (!directory) return '';
  const packageRoot = path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules');
  return [
    path.join(packageRoot, '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    path.join(packageRoot, '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'),
  ].map(existingFile).find(Boolean) || '';
}

function launchFromExplicit(explicit, variableName) {
  const raw = String(explicit || '').trim();
  if (!raw) return null;
  const resolved = existingFile(path.isAbsolute(raw) ? raw : path.resolve(raw)) || existingFile(raw);
  const target = resolved || raw;
  const ext = path.extname(target).toLowerCase();
  if (ext === '.js' || ext === '.mjs') return { command: process.execPath, argsPrefix: [target], label: target };
  if (ext === '.cmd' || ext === '.bat') {
    const directory = path.dirname(target);
    const nativeExe = npmNativeCodexNear(directory);
    if (nativeExe) return { command: nativeExe, argsPrefix: [], label: nativeExe };
    const entry = npmCodexEntryNear(directory);
    if (entry) return { command: process.execPath, argsPrefix: [entry], label: entry };
    throw new Error(`${variableName} points to ${ext} shim '${raw}', but its Codex executable/JS entrypoint was not found.`);
  }
  return { command: target, argsPrefix: [], label: target };
}

function resolveCodexLaunch() {
  const explicit = launchFromExplicit(process.env.CODEX_BIN, 'CODEX_BIN')
    || launchFromExplicit(process.env.CODEX_CLI_PATH, 'CODEX_CLI_PATH');
  if (explicit) return explicit;

  if (process.platform !== 'win32') return { command: 'codex', argsPrefix: [], label: 'codex' };

  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.replace(/^\"|\"$/g, '').trim())
    .filter(Boolean);
  const candidates = [
    ...pathDirs.map((directory) => path.join(directory, 'codex.exe')),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex', 'packages', 'standalone', 'current', 'codex.exe') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const exe = existingFile(candidate);
    if (exe) return { command: exe, argsPrefix: [], label: exe };
  }
  throw new Error('Codex CLI executable was not found. Install Codex or set CODEX_CLI_PATH/CODEX_BIN.');
}

function localCodexHome() {
  if (process.env.CHATGPT_BRIDGE_CODEX_HOME) return path.resolve(process.env.CHATGPT_BRIDGE_CODEX_HOME);
  return path.join(os.homedir(), '.bridge-data', 'codex-local');
}

function buildCodexArgs(userArgs) {
  const overrides = [
    `model_providers.${providerId}.name=\"ChatGPT Web Playwright\"`,
    `model_providers.${providerId}.base_url=\"${providerBaseUrl}\"`,
    `model_providers.${providerId}.wire_api=\"responses\"`,
    `model_providers.${providerId}.requires_openai_auth=false`,
    `model_provider=${providerId}`,
    `model=\"${harnessModel}\"`,
    'approval_policy=\"never\"',
    'sandbox_mode=\"workspace-write\"',
    'check_for_update_on_startup=false',
    'features.memories=false',
    'features.chronicle=false',
  ];
  const args = [];
  for (const override of overrides) args.push('-c', override);
  args.push(...userArgs);
  return args;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function main() {
  const worker = new PlaywrightChatgptWorker();
  const server = createProviderServer(worker);
  let child = null;
  const cleanup = async () => {
    if (child && !child.killed) child.kill();
    await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    await worker.close().catch(() => {});
  };

  process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
  process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });

  try {
    console.log('[local] starting dedicated Playwright ChatGPT worker');
    await worker.start();
    await worker.newConversation();
    await listen(server);
    console.log(`[local] provider: ${providerBaseUrl}`);
    console.log('[local] model path: Codex CLI -> localhost -> Playwright -> logged-in ChatGPT web session');
    console.log('[local] Chrome extension: not required for this mode');
    console.log('[local] Codex backend/OAuth model inference: disabled for this provider');
    console.log('[local] OpenAI API key billing: disabled for this provider');
    console.log(`[local] Codex harness metadata profile: ${harnessModel} (actual model is selected by the ChatGPT web session)`);

    const home = localCodexHome();
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, CODEX_HOME: home };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_API_BASE;
    delete env.OPENAI_BASE_URL;

    const launch = resolveCodexLaunch();
    console.log(`[local] Codex executable: ${launch.label}`);
    console.log(`[local] isolated CODEX_HOME: ${home}`);

    child = spawn(launch.command, [...launch.argsPrefix, ...buildCodexArgs(process.argv.slice(2))], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
    });

    const exitCode = await new Promise((resolve) => {
      child.on('error', (error) => {
        console.error(`[local] failed to launch Codex: ${error.message}`);
        resolve(127);
      });
      child.on('exit', (code, signal) => {
        if (signal) console.error(`[local] Codex exited via signal ${signal}`);
        resolve(Number.isInteger(code) ? code : 1);
      });
    });
    child = null;
    await cleanup();
    process.exit(exitCode);
  } catch (error) {
    console.error(`[local] ${error.stack || error.message}`);
    await cleanup();
    process.exit(1);
  }
}

main();
