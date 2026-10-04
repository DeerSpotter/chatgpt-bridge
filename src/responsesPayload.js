import crypto from 'node:crypto';

const CONTEXT_PREFIXES = ['<environment_context>', '<user_instructions>'];
const SHELL_TOOL_NAMES = ['exec_command', 'shell_command', 'shell'];

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

export function findShellTool(tools = []) {
  for (const preferred of SHELL_TOOL_NAMES) {
    const found = tools.find((tool) => itemToolName(tool) === preferred);
    if (found) return { name: preferred, spec: found };
  }
  return null;
}

export function findApplyPatchTool(tools = []) {
  const found = tools.find((tool) => itemToolName(tool) === 'apply_patch');
  return found ? { name: 'apply_patch', spec: found } : null;
}

function isContextBlob(text) {
  const trimmed = String(text || '').trimStart();
  return CONTEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function extractResponsesTurn(body = {}) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const result = {
    kind: 'user',
    message: '',
    toolOutput: '',
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

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || typeof item !== 'object') continue;
    if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(item.type)) {
      result.kind = 'tool_result';
      result.toolOutput = outputText(item.output).trim();
      return result;
    }
    if ((item.type == null || item.type === 'message') && item.role === 'user') {
      const text = responsesContentText(item.content).trim();
      if (!text || isContextBlob(text)) continue;
      result.message = text;
      return result;
    }
  }

  if (typeof body.prompt === 'string') result.message = body.prompt.trim();
  return result;
}

function protocolForTools(tools) {
  const shell = findShellTool(tools);
  const patch = findApplyPatchTool(tools);
  if (!shell && !patch) return '';

  const lines = [
    'LOCAL AGENT BRIDGE:',
    'You are connected to the user\'s real local workspace through a bridge. Do not claim that you ran or changed anything unless you request a local tool and receive its result.',
  ];

  if (shell) {
    lines.push(
      'To run one command on the user\'s machine, respond with exactly one fenced `run` block and nothing after it:',
      '```run',
      '<one shell command>',
      '```',
      `The bridge will translate that block to the local ${shell.name} tool. Wait for the LOCAL TOOL RESULT before continuing.`,
    );
  }

  if (patch) {
    lines.push(
      'To apply a patch, respond with exactly one fenced `patch` block and nothing after it:',
      '```patch',
      '*** Begin Patch',
      '...',
      '*** End Patch',
      '```',
      'The bridge will translate that block to the local apply_patch tool. Wait for the LOCAL TOOL RESULT before continuing.',
    );
  }

  lines.push('When the task is complete, answer normally with no `run` or `patch` block.');
  return lines.join('\n');
}

export function buildResponsesBridgePrompt(turn) {
  const protocol = protocolForTools(turn.tools);
  const pieces = [];
  if (protocol) pieces.push(protocol);

  if (turn.environmentContext) pieces.push(`CODEX ENVIRONMENT CONTEXT:\n${bounded(turn.environmentContext, 6_000)}`);
  if (turn.userInstructions) pieces.push(`CODEX USER/REPOSITORY INSTRUCTIONS:\n${bounded(turn.userInstructions, 8_000)}`);

  if (turn.kind === 'tool_result') {
    pieces.push(
      `LOCAL TOOL RESULT:\n<local_tool_result>\n${bounded(turn.toolOutput, 24_000)}\n</local_tool_result>\nContinue the existing task from this actual local result.`,
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

export function parseResponsesToolCall(text, tools = []) {
  const source = String(text || '');
  const patchTool = findApplyPatchTool(tools);
  const patch = source.match(/```patch\s*\r?\n([\s\S]*?)```/i);
  if (patchTool && patch?.[1]?.trim()) {
    return {
      type: 'custom_tool_call',
      call_id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
      name: patchTool.name,
      input: patch[1].trim(),
    };
  }

  const shellTool = findShellTool(tools);
  const run = source.match(/```run\s*\r?\n([\s\S]*?)```/i);
  if (shellTool && run?.[1]?.trim()) {
    return {
      type: 'function_call',
      call_id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
      name: shellTool.name,
      arguments: JSON.stringify(toolArguments(shellTool.name, run[1].trim())),
    };
  }

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
