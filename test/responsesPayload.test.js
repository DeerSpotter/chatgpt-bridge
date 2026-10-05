import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResponsesBridgePrompt,
  extractResponsesTurn,
  parseResponsesToolCall,
  responsesContentText,
} from '../src/responsesPayload.js';

test('responsesContentText flattens Responses API text parts', () => {
  assert.equal(
    responsesContentText([
      { type: 'input_text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]),
    'hello world',
  );
});

test('extractResponsesTurn keeps Codex context separate from the real user task', () => {
  const turn = extractResponsesTurn({
    model: 'gpt-5.1',
    tools: [{ type: 'function', name: 'exec_command' }],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\nOS: Windows\n</environment_context>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>\nkeep changes small\n</user_instructions>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the failing test' }] },
    ],
  });

  assert.equal(turn.kind, 'user');
  assert.equal(turn.message, 'fix the failing test');
  assert.match(turn.environmentContext, /Windows/);
  assert.match(turn.userInstructions, /keep changes small/);
});

test('latest tool result keeps tool identity and original task for stateless web turns', () => {
  const turn = extractResponsesTurn({
    tools: [{ type: 'function', name: 'write_stdin' }],
    input: [
      { type: 'message', role: 'user', content: 'inspect the repo' },
      { type: 'function_call', name: 'write_stdin', call_id: 'call_1', arguments: '{"session_id":42}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'process finished' },
    ],
  });

  assert.equal(turn.kind, 'tool_result');
  assert.equal(turn.message, 'inspect the repo');
  assert.equal(turn.toolName, 'write_stdin');
  assert.equal(turn.toolCallId, 'call_1');
  assert.match(turn.toolOutput, /process finished/);
  const prompt = buildResponsesBridgePrompt(turn);
  assert.match(prompt, /ORIGINAL USER TASK:\ninspect the repo/);
  assert.match(prompt, /LOCAL TOOL RESULT from write_stdin/);
});

test('render-safe LOCAL_TOOL_CALL maps advertised exec_command', () => {
  const call = parseResponsesToolCall(
    'LOCAL_TOOL_CALL: {"name":"exec_command","arguments":{"cmd":"git status --short"}}',
    [{ type: 'function', name: 'exec_command' }],
  );

  assert.equal(call.type, 'function_call');
  assert.equal(call.name, 'exec_command');
  assert.deepEqual(JSON.parse(call.arguments), { cmd: 'git status --short' });
});

test('render-safe LOCAL_CUSTOM_TOOL_CALL maps advertised apply_patch', () => {
  const call = parseResponsesToolCall(
    'LOCAL_CUSTOM_TOOL_CALL: {"name":"apply_patch","input":"*** Begin Patch\\n*** End Patch"}',
    [{ type: 'custom', name: 'apply_patch' }],
  );

  assert.equal(call.type, 'custom_tool_call');
  assert.equal(call.name, 'apply_patch');
  assert.match(call.input, /Begin Patch/);
});

test('render-safe call rejects a tool Codex did not advertise', () => {
  const call = parseResponsesToolCall(
    'LOCAL_TOOL_CALL: {"name":"made_up_tool","arguments":{"x":1}}',
    [{ type: 'function', name: 'exec_command' }],
  );
  assert.equal(call, null);
});

test('run fence maps to current Codex exec_command arguments', () => {
  const call = parseResponsesToolCall(
    '```run\ngit status --short\n```',
    [{ type: 'function', name: 'exec_command' }],
  );

  assert.equal(call.type, 'function_call');
  assert.equal(call.name, 'exec_command');
  assert.deepEqual(JSON.parse(call.arguments), { cmd: 'git status --short' });
});

test('patch fence maps to the freeform apply_patch tool', () => {
  const call = parseResponsesToolCall(
    '```patch\n*** Begin Patch\n*** End Patch\n```',
    [{ type: 'custom', name: 'apply_patch' }],
  );

  assert.equal(call.type, 'custom_tool_call');
  assert.equal(call.name, 'apply_patch');
  assert.match(call.input, /Begin Patch/);
});

test('generic function fence passes advertised write_stdin arguments through unchanged', () => {
  const tools = [{
    type: 'function',
    name: 'write_stdin',
    description: 'Write to an existing exec session',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'number' },
        chars: { type: 'string' },
      },
      required: ['session_id'],
    },
  }];

  const call = parseResponsesToolCall(
    '```tool\n{"name":"write_stdin","arguments":{"session_id":42,"chars":"y\\n"}}\n```',
    tools,
  );

  assert.equal(call.type, 'function_call');
  assert.equal(call.name, 'write_stdin');
  assert.deepEqual(JSON.parse(call.arguments), { session_id: 42, chars: 'y\n' });
});

test('generic function fence rejects a tool Codex did not advertise', () => {
  const call = parseResponsesToolCall(
    '```tool\n{"name":"dangerous_made_up_tool","arguments":{"x":1}}\n```',
    [{ type: 'function', name: 'exec_command' }],
  );

  assert.equal(call, null);
});

test('generic custom tool fence passes freeform input only for advertised custom tools', () => {
  const call = parseResponsesToolCall(
    '```custom_tool\n{"name":"apply_patch","input":"*** Begin Patch\\n*** End Patch"}\n```',
    [{ type: 'custom', name: 'apply_patch' }],
  );

  assert.equal(call.type, 'custom_tool_call');
  assert.equal(call.name, 'apply_patch');
  assert.match(call.input, /Begin Patch/);
});

test('bridge prompt includes live advertised function schema and render-safe protocol', () => {
  const prompt = buildResponsesBridgePrompt({
    kind: 'user',
    message: 'continue the process',
    toolOutput: '',
    toolName: '',
    toolCallId: '',
    environmentContext: '',
    userInstructions: '',
    tools: [{
      type: 'function',
      name: 'write_stdin',
      description: 'Write to stdin',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'number' } },
        required: ['session_id'],
      },
    }],
  });

  assert.match(prompt, /LOCAL_TOOL_CALL/);
  assert.match(prompt, /ADVERTISED CODEX TOOLS/);
  assert.match(prompt, /write_stdin/);
  assert.match(prompt, /session_id/);
});

test('browser prompt keeps a large advertised tool set bounded', () => {
  const tools = Array.from({ length: 40 }, (_, index) => ({
    type: 'function',
    name: index === 0 ? 'exec_command' : `mcp_tool_${index}`,
    description: 'Long provider description '.repeat(100),
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 20 }, (__, propertyIndex) => [
        `property_${propertyIndex}`,
        { type: 'string', description: 'Schema description '.repeat(30) },
      ])),
      required: ['property_0'],
    },
  }));

  const prompt = buildResponsesBridgePrompt({
    kind: 'user',
    message: 'inspect the repository',
    toolOutput: '',
    toolName: '',
    toolCallId: '',
    environmentContext: '',
    userInstructions: '',
    tools,
  });

  assert.match(prompt, /exec_command/);
  assert.match(prompt, /additional advertised tool/);
  assert.ok(prompt.length < 22_000, `expected compact browser prompt, got ${prompt.length} chars`);
});

test('normal answer does not become a tool call', () => {
  const call = parseResponsesToolCall(
    'The tests pass now.',
    [{ type: 'function', name: 'exec_command' }],
  );
  assert.equal(call, null);
});
