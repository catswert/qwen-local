import { MLCEngine, prebuiltAppConfig, deleteModelAllInfoInCache } from '@mlc-ai/web-llm';
// This published package is UMD despite declaring type:module. Its browser entry
// installs globalThis.tokenizers; it does not have actual ESM named exports.
import '@mlc-ai/web-tokenizers';
import { MODEL_PREFIX, fitContext, createRequest, validateSettings } from './core.js';

let engine;
let tokenizer;
let loadedConfig;
let working = false;
let stopRequested = false;
const post = (type, data = {}) => self.postMessage({ type, ...data });
const appConfig = { ...prebuiltAppConfig, cacheBackend: 'cache' };

async function loadModel(settings) {
  const s = validateSettings(settings);
  if (!self.navigator.gpu) throw new Error('WebGPU is unavailable. Use an updated browser and operating system with WebGPU support, and enable hardware acceleration.');
  const adapter = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No compatible GPU was found. Enable hardware acceleration in your browser and update your graphics driver.');
  const f16 = adapter.features.has('shader-f16');
  const precision = s.precision === 'auto' ? (f16 ? 'q4f16_1' : 'q4f32_1') : s.precision;
  if (precision.includes('f16') && !f16) throw new Error('This GPU does not support float16. Choose automatic precision or a float32 model.');
  const modelId = `${MODEL_PREFIX}${precision}-MLC`;
  const record = prebuiltAppConfig.model_list.find(x => x.model_id === modelId);
  if (!record) throw new Error('The selected Qwen model is not present in this runtime.');
  engine = new MLCEngine({ appConfig, logLevel: 'WARN', initProgressCallback: report => post('progress', report) });
  await engine.reload(modelId, { context_window_size: s.context_window_size, conv_config: { role_templates: {} } });
  post('progress', { progress: 0.99, text: 'Preparing accurate context counting…' });
  // Use a separate tokenizer in this worker to reserve an exact prompt budget.
  // Cache only the model's public tokenizer, never any conversation content.
  const base = record.model.replace(/\/$/, '') + (record.model.includes('/resolve/') ? '/' : '/resolve/main/');
  const tokenizerURL = new URL('tokenizer.json', base).href;
  const cache = await caches.open('qwen-local-tokenizer-v1');
  let response = await cache.match(tokenizerURL);
  if (!response) {
    response = await fetch(tokenizerURL);
    if (!response.ok) throw new Error(`Tokenizer download failed (${response.status}). Check your connection and try loading again.`);
    try { await cache.put(tokenizerURL, response.clone()); } catch { /* Inference still works if cache quota is exhausted. */ }
  }
  tokenizer = await globalThis.tokenizers.Tokenizer.fromJSON(await response.arrayBuffer());
  loadedConfig = { modelId, precision, context_window_size: s.context_window_size };
  post('ready', { ...loadedConfig, gpu: adapter.info?.description || adapter.info?.device || adapter.info?.vendor || 'WebGPU device' });
}

async function generate(data) {
  if (!engine || !tokenizer || !loadedConfig) throw new Error('Load the model before sending a message.');
  const s = validateSettings(data.settings);
  if (s.context_window_size !== loadedConfig.context_window_size) throw new Error('Context settings changed. Reload the model before continuing.');
  const context = fitContext({ system: data.system, turns: data.turns, user: data.user, settings: s, encode: text => tokenizer.encode(text) });
  post('context', { requestId: data.requestId, promptTokens: context.promptTokens, omittedTurns: context.omittedTurns });
  await engine.resetChat();
  if (stopRequested) { post('complete', { requestId: data.requestId, raw: '', finishReason: 'abort', usage: null, duration: 0, probabilities: [] }); return; }
  const started = performance.now();
  let raw = '', finishReason = null, usage = null, lastUpdate = 0;
  const probabilities = [];
  const request = createRequest(context.messages, s);
  // WebLLM substitutes system_template using String.replace with a replacement
  // string. Escape dollars so shell/regex examples survive this formatting step.
  request.messages = request.messages.map(message => message.role === 'system'
    ? { ...message, content: message.content.replace(/\$/g, () => '$$') }
    : message);
  const chunks = await engine.chat.completions.create(request);
  for await (const chunk of chunks) {
    const choice = chunk.choices[0];
    raw += choice?.delta?.content ?? '';
    finishReason = choice?.finish_reason ?? finishReason;
    usage = chunk.usage ?? usage;
    if (choice?.logprobs?.content) probabilities.push(...choice.logprobs.content);
    const now = performance.now();
    if (now - lastUpdate >= 32 || choice?.finish_reason) { post('delta', { requestId: data.requestId, raw, duration: (now - started) / 1000 }); lastUpdate = now; }
    // Keep draining after interruptGenerate. Breaking this iterator can strand
    // WebLLM's request lock and prevent the following turn from running.
  }
  post('complete', { requestId: data.requestId, raw, finishReason: stopRequested ? 'abort' : finishReason, usage, duration: (performance.now() - started) / 1000, probabilities });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') { stopRequested = true; engine?.interruptGenerate(); return; }
  if (working) { post('error', { message: 'The model is busy. Wait for the current operation to finish.', requestId: data.requestId, recoverable: true }); return; }
  working = true;
  stopRequested = false;
  try {
    if (data.type === 'load') await loadModel(data.settings);
    else if (data.type === 'generate') await generate(data);
    else if (data.type === 'clear-cache') {
      await engine?.unload();
      tokenizer?.dispose();
      tokenizer = null; engine = null; loadedConfig = null;
      for (const record of prebuiltAppConfig.model_list.filter(x => x.model_id.startsWith(MODEL_PREFIX))) await deleteModelAllInfoInCache(record.model_id, appConfig);
      await caches.delete('qwen-local-tokenizer-v1');
      post('cache-cleared');
    }
  } catch (error) {
    post('error', { requestId: data.requestId, message: error?.message || String(error), recoverable: error?.name === 'ContextBudgetError' });
  } finally { working = false; }
};
