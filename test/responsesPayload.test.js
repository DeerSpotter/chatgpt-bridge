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

test('latest tool result becomes the next ChatGPT web turn', () => {
  const turn = extractResponsesTurn({
    tools: [{ type: 'function', name: 'exec_command' }],
    input: [
      { type: 'message', role: 'user', content: 'inspect the repo' },
      { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"git status"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'On branch main\nnothing to commit' },
    ],
  });

  assert.equal(turn.kind, 'tool_result');
  assert.match(turn.toolOutput, /nothing to commit/);
  assert.match(buildResponsesBridgePrompt(turn), /LOCAL TOOL RESULT/);
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

test('normal answer does not become a tool call', () => {
  const call = parseResponsesToolCall(
    'The tests pass now.',
    [{ type: 'function', name: 'exec_command' }],
  );
  assert.equal(call, null);
});
