export const DEFAULT_SYSTEM = "You are Qwen, a helpful assistant running locally in the user's browser. Be clear, accurate, and direct. If you are unsure, say so.";
export const DEFAULT_SETTINGS = Object.freeze({
  thinking: false, max_tokens: 1024, temperature: 0.7, top_p: 0.8,
  repetition_penalty: 1, frequency_penalty: 0, presence_penalty: 0,
  seed: null, stop: '', ignore_eos: false, response_format: 'text',
  schema: '', grammar: '', logit_bias: '', logprobs: false, top_logprobs: 3,
  enable_latency_breakdown: false, precision: 'auto', context_window_size: 4096, overflow: 'trim',
});
export const MODEL_PREFIX = 'Qwen3-0.6B-';
export const CONTEXT_RESERVE = 32;
export const FORMAT_INSTRUCTION = 'Respond with a valid JSON object only. Do not include Markdown fences, commentary, or reasoning.';
const BOOLS = ['thinking', 'ignore_eos', 'logprobs', 'enable_latency_breakdown'];
const BOUNDS = { max_tokens: [1, 32700, true], temperature: [0, 2], top_p: [0.01, 1], repetition_penalty: [0.1, 2], frequency_penalty: [-2, 2], presence_penalty: [-2, 2], top_logprobs: [1, 5, true] };

export function validateSettings(input) {
  const s = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(s)) if (Object.hasOwn(input, key)) s[key] = input[key];
  for (const key of BOOLS) if (typeof s[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
  for (const [key, [min, max, integer]] of Object.entries(BOUNDS)) {
    const n = s[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${key.replaceAll('_', ' ')} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`);
  }
  if (s.seed !== null && (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 2147483647)) throw new Error('Seed must be empty or a whole number between 0 and 2147483647.');
  if (![2048, 4096, 8192, 16384, 32768].includes(s.context_window_size)) throw new Error('Choose one of the available context windows.');
  if (s.max_tokens + CONTEXT_RESERVE >= s.context_window_size) throw new Error('Max output must leave room for instructions and conversation in the context window. Reduce max output or increase context.');
  if (!['auto', 'q4f16_1', 'q4f32_1', 'q0f16', 'q0f32'].includes(s.precision)) throw new Error('Choose an available model precision.');
  if (!['trim', 'error'].includes(s.overflow)) throw new Error('Choose a conversation overflow policy.');
  if (!['text', 'json_object', 'json_schema', 'grammar'].includes(s.response_format)) throw new Error('Choose an available output format.');
  if (s.response_format !== 'text' && s.ignore_eos) throw new Error('Ignore end markers is only available for text output.');
  for (const key of ['stop', 'schema', 'grammar', 'logit_bias']) if (typeof s[key] !== 'string' || s[key].length > 50000) throw new Error(`${key} must be text of at most 50,000 characters.`);
  if (s.response_format === 'json_schema') {
    let schema;
    try { schema = JSON.parse(s.schema); } catch { throw new Error('JSON Schema must contain valid JSON.'); }
    if (!(typeof schema === 'boolean' || (schema && typeof schema === 'object' && !Array.isArray(schema)))) throw new Error('JSON Schema must be an object or a boolean.');
  }
  if (s.response_format === 'grammar' && !s.grammar.trim()) throw new Error('Add an EBNF grammar, including its root rule.');
  parseBias(s.logit_bias);
  return s;
}

export function parseBias(text) {
  if (!text.trim()) return undefined;
  let bias;
  try { bias = JSON.parse(text); } catch { throw new Error('Token bias must be a valid JSON object.'); }
  if (!bias || typeof bias !== 'object' || Array.isArray(bias)) throw new Error('Token bias must be an object mapping token IDs to numbers.');
  for (const [token, value] of Object.entries(bias)) {
    if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= 151936 || !Number.isFinite(value) || value < -100 || value > 100) throw new Error('Token bias requires IDs from 0 to 151935 and numeric values from −100 to 100.');
  }
  return bias;
}

export function effectiveThinking(s) { return s.thinking && s.response_format === 'text'; }
export function effectiveSystem(prompt, s) {
  return s.response_format.startsWith('json') ? [prompt, FORMAT_INSTRUCTION].filter(Boolean).join('\n\n') : prompt;
}
export function parseStops(text) { return text.split(/\r?\n/).filter(x => x.length > 0).map(x => x.replaceAll('\\n', '\n').replaceAll('\\t', '\t')); }
export function createRequest(messages, settings) {
  const s = validateSettings(settings);
  const request = { messages, stream: true, stream_options: { include_usage: true }, temperature: s.temperature, top_p: s.top_p, max_tokens: s.max_tokens, repetition_penalty: s.repetition_penalty, frequency_penalty: s.frequency_penalty, presence_penalty: s.presence_penalty, ignore_eos: s.ignore_eos, extra_body: { enable_thinking: effectiveThinking(s), enable_latency_breakdown: s.enable_latency_breakdown } };
  if (s.seed !== null) request.seed = s.seed;
  const stop = parseStops(s.stop);
  if (stop.length) request.stop = stop;
  const bias = parseBias(s.logit_bias);
  if (bias && Object.keys(bias).length) request.logit_bias = bias;
  if (s.logprobs) { request.logprobs = true; request.top_logprobs = s.top_logprobs; }
  if (s.response_format.startsWith('json')) {
    request.response_format = { type: 'json_object' };
    if (s.response_format === 'json_schema') request.response_format.schema = JSON.stringify(JSON.parse(s.schema));
  } else if (s.response_format === 'grammar') request.response_format = { type: 'grammar', grammar: s.grammar };
  return request;
}

// Only an initial Qwen reasoning block is special. Literal tags later in an answer
// (for example, code explaining Qwen) remain part of the answer.
export function splitThinking(raw, finished = false) {
  const prefixWhitespace = raw.match(/^\s*/)?.[0].length ?? 0;
  const text = raw.slice(prefixWhitespace);
  const open = '<think>';
  if (!finished && text && open.startsWith(text)) return { reasoning: '', answer: '', inThinking: false };
  if (!text.startsWith(open)) return { reasoning: '', answer: raw, inThinking: false };
  const end = text.indexOf('</think>', open.length);
  if (end < 0) {
    let reasoning = text.slice(open.length);
    // Do not flash a partially streamed closing delimiter.
    if (!finished) for (let i = 1; i < '</think>'.length; i++) if (reasoning.endsWith('</think>'.slice(0, i))) { reasoning = reasoning.slice(0, -i); break; }
    return { reasoning: reasoning.trim(), answer: '', inThinking: !finished };
  }
  return { reasoning: text.slice(open.length, end).trim(), answer: text.slice(end + '</think>'.length).replace(/^\s*\n/, ''), inThinking: false };
}

// Historical reasoning is for display only. A stopped/failed answer may be empty;
// omit that entire earlier turn so requests always alternate user/assistant.
export function completedTurns(messages) {
  const turns = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].role !== 'user' || messages[i + 1].role !== 'assistant') continue;
    const a = messages[i + 1];
    const answer = splitThinking(a.raw ?? '', true).answer;
    if (answer.trim() && !a.error && !a.pending) turns.push([{ role: 'user', content: messages[i].content }, { role: 'assistant', content: answer }]);
    i++;
  }
  return turns;
}

export function qwenPromptTokens(messages, thinking, encode) {
  let total = 0;
  for (const message of messages) total += encode(`<|im_start|>${message.role}\n${message.content}<|im_end|>\n`).length;
  total += encode('<|im_start|>assistant\n' + (thinking ? '' : '<think>\n\n</think>\n\n')).length;
  return total;
}

export function fitContext({ system, turns, user, settings, encode }) {
  const s = validateSettings(settings);
  const messages = [{ role: 'system', content: effectiveSystem(system, s) }, ...turns.flat().map(x => ({ role: x.role, content: x.content })), { role: 'user', content: user }];
  const count = () => qwenPromptTokens(messages, effectiveThinking(s), encode);
  let promptTokens = count();
  let omittedTurns = 0;
  const limit = s.context_window_size - s.max_tokens - CONTEXT_RESERVE;
  while (promptTokens > limit && messages.length > 2 && s.overflow === 'trim') {
    messages.splice(1, 2);
    omittedTurns++;
    promptTokens = count();
  }
  if (promptTokens > limit) {
    const error = new Error(`The prompt needs ${promptTokens.toLocaleString()} tokens, with ${s.max_tokens.toLocaleString()} reserved for output. This exceeds the ${s.context_window_size.toLocaleString()}-token context. Reduce max output, shorten your message or system prompt, or select a larger context window in settings.${s.overflow === 'error' && turns.length ? ' You can also choose “Keep recent complete turns.”' : ''}`);
    error.name = 'ContextBudgetError';
    throw error;
  }
  return { messages, promptTokens, omittedTurns };
}

export function restoreConversation(data) {
  if (!Array.isArray(data)) return [];
  return data.filter(x => x && (x.role === 'user' || x.role === 'assistant')).slice(-200).map(x => x.role === 'user'
    ? { id: String(x.id), role: 'user', content: String(x.content ?? '').slice(0, 120000) }
    : { id: String(x.id), role: 'assistant', raw: String(x.raw ?? '').slice(0, 300000), pending: false, finishReason: x.pending ? 'abort' : x.finishReason, error: typeof x.error === 'string' ? x.error : '', usage: x.usage ?? null, settings: x.settings ?? null, duration: Number(x.duration) || 0, omittedTurns: Number(x.omittedTurns) || 0 });
}
