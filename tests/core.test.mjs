import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings, createRequest, splitThinking, completedTurns, fitContext, qwenPromptTokens, effectiveSystem, parseBias, restoreConversation } from '../src/core.js';

const settings = overrides => ({ ...DEFAULT_SETTINGS, ...overrides });
const encode = text => Array.from(text); // Deliberately conservative, deterministic budget fixture.

test('settings reject non-finite, out-of-range and incompatible values', () => {
  for (const change of [{ temperature: NaN }, { top_p: 0 }, { max_tokens: 0 }, { seed: 1.5 }, { max_tokens: 4096 }, { presence_penalty: 3 }, { response_format: 'json_object', ignore_eos: true }]) assert.throws(() => validateSettings(settings(change)));
  assert.equal(validateSettings(settings({ max_tokens: 1 })).max_tokens, 1);
});
test('every supported generation control maps to a real runtime field', () => {
  const request = createRequest([{ role: 'user', content: 'Hello' }], settings({ thinking: true, temperature: 1.2, top_p: .9, max_tokens: 512, seed: 42, repetition_penalty: 1.1, frequency_penalty: .3, presence_penalty: .2, stop: 'END\\n\nFIN', logit_bias: '{"123":-5}', logprobs: true, top_logprobs: 5, enable_latency_breakdown: true }));
  assert.equal(request.extra_body.enable_thinking, true);
  assert.equal(request.extra_body.enable_latency_breakdown, true);
  assert.equal(request.temperature, 1.2); assert.equal(request.top_p, .9); assert.equal(request.max_tokens, 512);
  assert.equal(request.seed, 42); assert.equal(request.repetition_penalty, 1.1); assert.equal(request.frequency_penalty, .3); assert.equal(request.presence_penalty, .2);
  assert.deepEqual(request.stop, ['END\n', 'FIN']); assert.deepEqual(request.logit_bias, { 123: -5 }); assert.equal(request.top_logprobs, 5);
  assert.ok(!('enable_thinking' in request)); assert.ok(!('top_k' in request));
});
test('JSON schema is serialized correctly and forces non-thinking generation', () => {
  const s = settings({ response_format: 'json_schema', schema: '{"type":"object"}', thinking: true });
  const request = createRequest([], s);
  assert.deepEqual(request.response_format, { type: 'json_object', schema: '{"type":"object"}' });
  assert.equal(request.extra_body.enable_thinking, false);
  assert.match(effectiveSystem('Be concise.', s), /JSON object only/);
  assert.throws(() => validateSettings(settings({ response_format: 'json_schema', schema: '[]' })));
});
test('token bias validates IDs and numbers without accepting malformed JSON', () => {
  for (const value of ['[]', 'null', '{"151936":1}', '{"12":"1"}', '{"12":101}', '{"-1":2}', '{']) assert.throws(() => parseBias(value));
  assert.deepEqual(parseBias('{"0":-100,"151935":100}'), { 0: -100, 151935: 100 });
});
test('streaming reasoning delimiters do not flash into the final answer', () => {
  const full = '<think>Let me check this.</think>\n\nThe answer is 4.';
  const end = full.indexOf('</think>') + '</think>'.length;
  for (let i = 1; i < end; i++) assert.equal(splitThinking(full.slice(0, i)).answer, '', `prefix ${i}`);
  assert.equal(splitThinking(full, true).answer, 'The answer is 4.');
  assert.equal(splitThinking('<think>\n\n</think>\n\nHello', true).reasoning, '');
  assert.equal(splitThinking('<think>\n\n</think>\n\nHello', true).answer.trim(), 'Hello');
});
test('stopped reasoning stays separate and literal later tags are preserved', () => {
  assert.deepEqual(splitThinking('<think>unfinished', true), { reasoning: 'unfinished', answer: '', inThinking: false });
  const code = 'Use `<think>` in your parser.';
  assert.equal(splitThinking(code, true).answer, code);
});
test('history includes final answers only and omits failed or unanswered turns', () => {
  const history = [{ role: 'user', content: 'a' }, { role: 'assistant', raw: '<think>private reasoning</think>answer' }, { role: 'user', content: 'b' }, { role: 'assistant', raw: '<think>unfinished', pending: false }, { role: 'user', content: 'c' }, { role: 'assistant', raw: 'partial', error: 'GPU lost' }];
  assert.deepEqual(completedTurns(history), [[{ role: 'user', content: 'a' }, { role: 'assistant', content: 'answer' }]]);
});
test('context eviction preserves instructions and latest input and drops complete turns', () => {
  const turns = [[{ role: 'user', content: 'a'.repeat(1200) }, { role: 'assistant', content: 'b'.repeat(600) }], [{ role: 'user', content: 'recent question' }, { role: 'assistant', content: 'recent answer' }]];
  const result = fitContext({ system: 'system', user: 'latest', turns, settings: settings({ context_window_size: 2048, max_tokens: 512 }), encode });
  assert.equal(result.omittedTurns, 1);
  assert.equal(result.messages[0].content, 'system'); assert.equal(result.messages.at(-1).content, 'latest'); assert.equal(result.messages[1].content, 'recent question');
  assert.equal(turns.length, 2); assert.equal(turns[0][0].content.length, 1200);
  assert.ok(result.promptTokens + 512 + 32 <= 2048);
});
test('oversized newest input and stop-on-full policy fail before generation', () => {
  assert.throws(() => fitContext({ system: '', user: 'x'.repeat(4000), turns: [], settings: settings({ context_window_size: 2048, max_tokens: 512 }), encode }), { name: 'ContextBudgetError' });
  assert.throws(() => fitContext({ system: '', user: 'now', turns: [[{ role: 'user', content: 'x'.repeat(2000) }, { role: 'assistant', content: 'old' }]], settings: settings({ context_window_size: 2048, max_tokens: 512, overflow: 'error' }), encode }), { name: 'ContextBudgetError' });
});
test('counter tokenizes each ChatML segment separately and includes non-thinking header', () => {
  const seen = [];
  qwenPromptTokens([{ role: 'system', content: '' }, { role: 'user', content: 'hello' }], false, text => { seen.push(text); return [1]; });
  assert.deepEqual(seen, ['<|im_start|>system\n<|im_end|>\n', '<|im_start|>user\nhello<|im_end|>\n', '<|im_start|>assistant\n<think>\n\n</think>\n\n']);
});
test('system dollar escaping preserves literal shell and regex syntax in WebLLM', () => {
  const prompt = 'Use $& and $$ and $\' and $` literally.';
  const escaped = prompt.replace(/\$/g, () => '$$');
  const rendered = '<|im_start|>system\n{system_message}<|im_end|>\n'.replace('{system_message}', escaped);
  assert.equal(rendered, `<|im_start|>system\n${prompt}<|im_end|>\n`);
});
test('restored interrupted sessions cannot remain stuck in generating state', () => {
  const result = restoreConversation([{ id: '1', role: 'user', content: 'Hi' }, { id: '2', role: 'assistant', raw: '<think>test', pending: true }]);
  assert.equal(result[1].pending, false); assert.equal(result[1].finishReason, 'abort'); assert.equal(completedTurns(result).length, 0);
});
