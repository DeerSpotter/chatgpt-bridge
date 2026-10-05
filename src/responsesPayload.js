import crypto from 'node:crypto';

const CONTEXT_PREFIXES = ['<environment_context>', '<user_instructions>'];
const SHELL_TOOL_NAMES = ['exec_command', 'shell_command', 'shell'];
const MAX_TOOL_CATALOG_CHARS = 16_000;
const MAX_TOOL_ENTRY_CHARS = 2_500;
const TOOL_PRIORITY = [
  'exec_command',
  'shell_command',
  'shell',
  'write_stdin',
  'apply_patch',
  'update_plan',
  'view_image',
  'spawn_agent',
  'send_message',
  'wait_agent',
  'followup_task',
  'request_user_input',
];

function bounded(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated by local bridge]`;
}

export function responsesContentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
  }

  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string' && [undefined, 'input_text', 'output_text', 'text'].includes(item.type)) {
      parts.push(item.text);
    } else if (typeof item.content === 'string') {
      parts.push(item.content);
    }
  }
  return parts.join('');
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return responsesContentText(output);
  if (output && typeof output === 'object') {
    if (typeof output.output === 'string') return output.output;
    if (typeof output.content === 'string' || Array.isArray(output.content)) return responsesContentText(output.content);
    try { return JSON.stringify(output); } catch { return String(output); }
  }
  if (output == null) return '';
  return String(output);
}

function itemToolName(tool) {
  if (!tool || typeof tool !== 'object') return '';
  if (typeof tool.name === 'string') return tool.name;
  if (typeof tool.function?.name === 'string') return tool.function.name;
  return '';
}

function itemToolType(tool) {
  if (!tool || typeof tool !== 'object') return '';
  if (tool.type === 'custom') return 'custom';
  if (tool.type === 'function' || tool.function) return 'function';
  return '';
}

function itemToolDescription(tool) {
  if (!tool || typeof tool !== 'object') return '';
  if (typeof tool.description === 'string') return tool.description;
  if (typeof tool.function?.description === 'string') return tool.function.description;
  return '';
}

function itemToolParameters(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.parameters && typeof tool.parameters === 'object') return tool.parameters;
  if (tool.function?.parameters && typeof tool.function.parameters === 'object') return tool.function.parameters;
  return null;
}

export function findAdvertisedTool(tools = [], name) {
  const wanted = String(name || '');
  if (!wanted) return null;
  const found = tools.find((tool) => itemToolName(tool) === wanted);
  if (!found) return null;
  return {
    name: wanted,
    type: itemToolType(found),
    description: itemToolDescription(found),
    parameters: itemToolParameters(found),
    spec: found,
  };
}

export function findShellTool(tools = []) {
  for (const preferred of SHELL_TOOL_NAMES) {
    const found = findAdvertisedTool(tools, preferred);
    if (found) return found;
  }
  return null;
}

export function findApplyPatchTool(tools = []) {
  return findAdvertisedTool(tools, 'apply_patch');
}

function isContextBlob(text) {
  const trimmed = String(text || '').trimStart();
  return CONTEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function priorToolCall(items, callId, outputIndex) {
  if (!callId) return null;
  for (let index = outputIndex - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    if (!candidate || typeof candidate !== 'object') continue;
    if (candidate.call_id !== callId) continue;
    if (!['function_call', 'custom_tool_call', 'local_shell_call'].includes(candidate.type)) continue;
    return candidate;
  }
  return null;
}

function latestUserTask(items) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || typeof item !== 'object') continue;
    if ((item.type != null && item.type !== 'message') || item.role !== 'user') continue;
    const text = responsesContentText(item.content).trim();
    if (!text || isContextBlob(text)) continue;
    return text;
  }
  return '';
}

export function extractResponsesTurn(body = {}) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const result = {
    kind: 'user',
    message: '',
    toolOutput: '',
    toolName: '',
    toolCallId: '',
    environmentContext: '',
    userInstructions: '',
    tools,
    requestedModel: typeof body.model === 'string' ? body.model : '',
    effort: typeof body.reasoning?.effort === 'string'
      ? body.reasoning.effort
      : typeof body.reasoning_effort === 'string'
        ? body.reasoning_effort
        : '',
  };

  if (typeof body.input === 'string') {
    result.message = body.input.trim();
    return result;
  }

  const items = Array.isArray(body.input) ? body.input : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (!['user', 'assistant'].includes(item.role) || !Object.hasOwn(item, 'content')) continue;
    const text = responsesContentText(item.content).trim();
    if (!text) continue;
    if (text.startsWith('<environment_context>')) result.environmentContext = text;
    else if (text.startsWith('<user_instructions>')) result.userInstructions = text;
  }

  // The web-provider adapter intentionally uses stateless upstream browser turns.
  // Preserve the latest actual user task even when the newest Responses item is a
  // tool result so every round remains grounded without depending on browser chat history.
  result.message = latestUserTask(items);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || typeof item !== 'object') continue;
    if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(item.type)) {
      const previousCall = priorToolCall(items, item.call_id, index);
      result.kind = 'tool_result';
      result.toolOutput = outputText(item.output).trim();
      result.toolCallId = typeof item.call_id === 'string' ? item.call_id : '';
      result.toolName = itemToolName(previousCall) || (item.type === 'local_shell_call_output' ? 'exec_command' : '');
      return result;
    }
  }

  if (!result.message && typeof body.prompt === 'string') result.message = body.prompt.trim();
  return result;
}

function compactSchema(value, depth = 0) {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => compactSchema(item, depth + 1)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;

  const ignored = new Set(['description', 'title', 'examples', 'example', 'default', '$schema', '$id', 'deprecated']);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (ignored.has(key)) continue;
    const compacted = compactSchema(child, depth + 1);
    if (compacted !== undefined) result[key] = compacted;
  }
  return result;
}

function toolPriority(name) {
  const index = TOOL_PRIORITY.indexOf(name);
  return index === -1 ? TOOL_PRIORITY.length : index;
}

function compactToolCatalog(tools = []) {
  const unique = [];
  const seen = new Set();
  for (const tool of tools) {
    const name = itemToolName(tool);
    const type = itemToolType(tool);
    if (!name || !['function', 'custom'].includes(type) || seen.has(name)) continue;
    seen.add(name);
    unique.push(tool);
  }
  unique.sort((left, right) => {
    const leftName = itemToolName(left);
    const rightName = itemToolName(right);
    return toolPriority(leftName) - toolPriority(rightName) || leftName.localeCompare(rightName);
  });

  const entries = [];
  let used = 0;
  let omitted = 0;

  for (const tool of unique) {
    const name = itemToolName(tool);
    const type = itemToolType(tool);
    const entry = {
      name,
      type,
      description: bounded(itemToolDescription(tool), 400),
    };
    const parameters = itemToolParameters(tool);
    if (type === 'function' && parameters) entry.parameters = compactSchema(parameters);
    if (type === 'custom' && tool.format) entry.format = compactSchema(tool.format);

    let line;
    try { line = JSON.stringify(entry); } catch { continue; }
    if (line.length > MAX_TOOL_ENTRY_CHARS) {
      const minimal = { name, type, description: entry.description };
      const required = Array.isArray(parameters?.required) ? parameters.required : [];
      const properties = parameters?.properties && typeof parameters.properties === 'object'
        ? Object.fromEntries(Object.entries(parameters.properties).map(([key, spec]) => [key, compactSchema(spec, 6)]))
        : undefined;
      if (type === 'function' && (required.length || properties)) {
        minimal.parameters = { type: 'object', ...(properties ? { properties } : {}), ...(required.length ? { required } : {}) };
      }
      line = bounded(JSON.stringify(minimal), MAX_TOOL_ENTRY_CHARS);
    }

    if (used + line.length + 1 > MAX_TOOL_CATALOG_CHARS) {
      omitted += 1;
      continue;
    }
    entries.push(line);
    used += line.length + 1;
  }

  omitted += Math.max(0, unique.length - entries.length - omitted);
  if (omitted > 0) entries.push(JSON.stringify({ note: `${omitted} additional advertised tool(s) omitted from the browser prompt to stay within the compact catalog budget` }));
  return entries.join('\n');
}

function protocolForTools(tools) {
  const shell = findShellTool(tools);
  const patch = findApplyPatchTool(tools);
  const callableTools = tools.filter((tool) => ['function', 'custom'].includes(itemToolType(tool)) && itemToolName(tool));
  if (!callableTools.length) return '';

  const lines = [
    'LOCAL AGENT BRIDGE:',
    'You are connected to the user\'s real local Codex workspace. Codex remains the authority that executes tools, applies sandbox/approval policy, and accesses the project directory. Do not claim that you ran, read, changed, viewed, delegated, or queried anything unless you request a local tool and receive its LOCAL TOOL RESULT.',
    'Use only tools listed in the ADVERTISED CODEX TOOLS catalog below. Never invent a tool name or argument.',
    'PREFERRED RENDER-SAFE FUNCTION CALL: output exactly one line and nothing after it:',
    'LOCAL_TOOL_CALL: {"name":"<advertised-function-name>","arguments":{}}',
    'PREFERRED RENDER-SAFE CUSTOM CALL: output exactly one line and nothing after it:',
    'LOCAL_CUSTOM_TOOL_CALL: {"name":"<advertised-custom-tool-name>","input":"<freeform input with newlines JSON-escaped>"}',
    'These LOCAL_* lines are preferred because they survive rendered browser text extraction. Fill arguments exactly according to the advertised schema.',
  ];

  if (shell) {
    lines.push(
      'COMPATIBILITY FAST PATH — shell: a fenced `run` block is also accepted:',
      '```run',
      '<one shell command>',
      '```',
      `The bridge translates that block to ${shell.name}.`,
    );
  }

  if (patch) {
    lines.push(
      'COMPATIBILITY FAST PATH — patch: a fenced `patch` block is also accepted:',
      '```patch',
      '*** Begin Patch',
      '...',
      '*** End Patch',
      '```',
      'The bridge translates that block to apply_patch.',
    );
  }

  lines.push(
    'COMPATIBILITY GENERAL FUNCTION PATH: a fenced `tool` JSON block is also accepted.',
    'COMPATIBILITY GENERAL CUSTOM PATH: a fenced `custom_tool` JSON block is also accepted.',
    'After every tool request, stop and wait for LOCAL TOOL RESULT before deciding the next action. When the task is complete, answer normally with no LOCAL_* call and no tool fence.',
    'ADVERTISED CODEX TOOLS (compact schemas, one JSON object per line):',
    compactToolCatalog(tools),
  );

  return lines.join('\n');
}

export function buildResponsesBridgePrompt(turn) {
  const protocol = protocolForTools(turn.tools);
  const pieces = [];
  if (protocol) pieces.push(protocol);

  if (turn.environmentContext) pieces.push(`CODEX ENVIRONMENT CONTEXT:\n${bounded(turn.environmentContext, 6_000)}`);
  if (turn.userInstructions) pieces.push(`CODEX USER/REPOSITORY INSTRUCTIONS:\n${bounded(turn.userInstructions, 8_000)}`);

  if (turn.kind === 'tool_result') {
    if (turn.message) pieces.push(`ORIGINAL USER TASK:\n${bounded(turn.message, 8_000)}`);
    const source = turn.toolName ? ` from ${turn.toolName}` : '';
    const call = turn.toolCallId ? ` (call ${turn.toolCallId})` : '';
    pieces.push(
      `LOCAL TOOL RESULT${source}${call}:\n<local_tool_result>\n${bounded(turn.toolOutput, 24_000)}\n</local_tool_result>\nContinue the original task from this actual local result.`,
    );
  } else if (turn.message) {
    pieces.push(`USER TASK:\n${turn.message}`);
  }

  return pieces.join('\n\n').trim();
}

function toolArguments(name, command) {
  if (name === 'exec_command') return { cmd: command };
  return { command };
}

function jsonFence(source, label) {
  const pattern = new RegExp('```' + label + '\\s*\\r?\\n([\\s\\S]*?)```', 'i');
  const match = source.match(pattern);
  if (!match?.[1]?.trim()) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function taggedJson(source, tag) {
  const prefix = `${tag}:`;
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) continue;
    const payload = line.slice(prefix.length).trim();
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function functionToolCall(payload, tools) {
  if (!payload) return null;
  const advertised = findAdvertisedTool(tools, payload.name);
  const args = payload.arguments ?? payload.args;
  if (advertised?.type !== 'function' || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  return {
    type: 'function_call',
    call_id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
    name: advertised.name,
    arguments: JSON.stringify(args),
  };
}

function customToolCall(payload, tools) {
  if (!payload) return null;
  const advertised = findAdvertisedTool(tools, payload.name);
  if (advertised?.type !== 'custom' || !Object.hasOwn(payload, 'input')) return null;
  const input = typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input);
  return {
    type: 'custom_tool_call',
    call_id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
    name: advertised.name,
    input,
  };
}

export function parseResponsesToolCall(text, tools = []) {
  const source = String(text || '');

  const taggedFunction = functionToolCall(taggedJson(source, 'LOCAL_TOOL_CALL'), tools);
  if (taggedFunction) return taggedFunction;

  const taggedCustom = customToolCall(taggedJson(source, 'LOCAL_CUSTOM_TOOL_CALL'), tools);
  if (taggedCustom) return taggedCustom;

  const patchTool = findApplyPatchTool(tools);
  const patch = source.match(/```patch\s*\r?\n([\s\S]*?)```/i);
  if (patchTool?.type === 'custom' && patch?.[1]?.trim()) {
    return {
      type: 'custom_tool_call',
      call_id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
      name: patchTool.name,
      input: patch[1].trim(),
    };
  }

  const shellTool = findShellTool(tools);
  const run = source.match(/```run\s*\r?\n([\s\S]*?)```/i);
  if (shellTool?.type === 'function' && run?.[1]?.trim()) {
    return {
      type: 'function_call',
      call_id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
      name: shellTool.name,
      arguments: JSON.stringify(toolArguments(shellTool.name, run[1].trim())),
    };
  }

  const genericFunction = functionToolCall(jsonFence(source, 'tool'), tools);
  if (genericFunction) return genericFunction;

  const genericCustom = customToolCall(jsonFence(source, 'custom_tool'), tools);
  if (genericCustom) return genericCustom;

  return null;
}

export function makeResponsesMessageItem(text, itemId = `msg_${crypto.randomUUID().replaceAll('-', '')}`) {
  return {
    id: itemId,
    type: 'message',
    role: 'assistant',
    content: text ? [{ type: 'output_text', text }] : [],
  };
}

export function makeResponsesUsage() {
  return {
    input_tokens: 0,
    input_tokens_details: null,
    output_tokens: 0,
    output_tokens_details: null,
    total_tokens: 0,
  };
}

export function makeResponsesCompletedEvent(responseId) {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: makeResponsesUsage(),
    },
  };
}
