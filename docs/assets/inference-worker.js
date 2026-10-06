// src/core.js
var DEFAULT_SETTINGS = Object.freeze({
  thinking: false,
  max_tokens: 1024,
  temperature: 0.7,
  top_p: 0.8,
  repetition_penalty: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
  seed: null,
  stop: "",
  ignore_eos: false,
  response_format: "text",
  schema: "",
  grammar: "",
  logit_bias: "",
  logprobs: false,
  top_logprobs: 3,
  enable_latency_breakdown: false,
  precision: "auto",
  context_window_size: 4096,
  overflow: "trim"
});
var MODEL_PREFIX = "Qwen3-0.6B-";
var CONTEXT_RESERVE = 32;
var FORMAT_INSTRUCTION = "Respond with a valid JSON object only. Do not include Markdown fences, commentary, or reasoning.";
var BOOLS = ["thinking", "ignore_eos", "logprobs", "enable_latency_breakdown"];
var BOUNDS = { max_tokens: [1, 32700, true], temperature: [0, 2], top_p: [0.01, 1], repetition_penalty: [0.1, 2], frequency_penalty: [-2, 2], presence_penalty: [-2, 2], top_logprobs: [1, 5, true] };
function validateSettings(input) {
  const s = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(s)) if (Object.hasOwn(input, key)) s[key] = input[key];
  for (const key of BOOLS) if (typeof s[key] !== "boolean") throw new Error(`${key} must be true or false.`);
  for (const [key, [min, max, integer]] of Object.entries(BOUNDS)) {
    const n = s[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || integer && !Number.isInteger(n)) throw new Error(`${key.replaceAll("_", " ")} must be ${integer ? "a whole number " : ""}between ${min} and ${max}.`);
  }
  if (s.seed !== null && (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 2147483647)) throw new Error("Seed must be empty or a whole number between 0 and 2147483647.");
  if (![2048, 4096, 8192, 16384, 32768].includes(s.context_window_size)) throw new Error("Choose one of the available context windows.");
  if (s.max_tokens + CONTEXT_RESERVE >= s.context_window_size) throw new Error("Max output must leave room for instructions and conversation in the context window. Reduce max output or increase context.");
  if (!["auto", "q4f16_1", "q4f32_1", "q0f16", "q0f32"].includes(s.precision)) throw new Error("Choose an available model precision.");
  if (!["trim", "error"].includes(s.overflow)) throw new Error("Choose a conversation overflow policy.");
  if (!["text", "json_object", "json_schema", "grammar"].includes(s.response_format)) throw new Error("Choose an available output format.");
  if (s.response_format !== "text" && s.ignore_eos) throw new Error("Ignore end markers is only available for text output.");
  for (const key of ["stop", "schema", "grammar", "logit_bias"]) if (typeof s[key] !== "string" || s[key].length > 5e4) throw new Error(`${key} must be text of at most 50,000 characters.`);
  if (s.response_format === "json_schema") {
    let schema;
    try {
      schema = JSON.parse(s.schema);
    } catch {
      throw new Error("JSON Schema must contain valid JSON.");
    }
    if (!(typeof schema === "boolean" || schema && typeof schema === "object" && !Array.isArray(schema))) throw new Error("JSON Schema must be an object or a boolean.");
  }
  if (s.response_format === "grammar" && !s.grammar.trim()) throw new Error("Add an EBNF grammar, including its root rule.");
  parseBias(s.logit_bias);
  return s;
}
function parseBias(text) {
  if (!text.trim()) return void 0;
  let bias;
  try {
    bias = JSON.parse(text);
  } catch {
    throw new Error("Token bias must be a valid JSON object.");
  }
  if (!bias || typeof bias !== "object" || Array.isArray(bias)) throw new Error("Token bias must be an object mapping token IDs to numbers.");
  for (const [token, value] of Object.entries(bias)) {
    if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= 151936 || !Number.isFinite(value) || value < -100 || value > 100) throw new Error("Token bias requires IDs from 0 to 151935 and numeric values from \u2212100 to 100.");
  }
  return bias;
}
function effectiveThinking(s) {
  return s.thinking && s.response_format === "text";
}
function effectiveSystem(prompt, s) {
  return s.response_format.startsWith("json") ? [prompt, FORMAT_INSTRUCTION].filter(Boolean).join("\n\n") : prompt;
}
function parseStops(text) {
  return text.split(/\r?\n/).filter((x) => x.length > 0).map((x) => x.replaceAll("\\n", "\n").replaceAll("\\t", "	"));
}
function createRequest(messages, settings) {
  const s = validateSettings(settings);
  const request = { messages, stream: true, stream_options: { include_usage: true }, temperature: s.temperature, top_p: s.top_p, max_tokens: s.max_tokens, repetition_penalty: s.repetition_penalty, frequency_penalty: s.frequency_penalty, presence_penalty: s.presence_penalty, ignore_eos: s.ignore_eos, extra_body: { enable_thinking: effectiveThinking(s), enable_latency_breakdown: s.enable_latency_breakdown } };
  if (s.seed !== null) request.seed = s.seed;
  const stop = parseStops(s.stop);
  if (stop.length) request.stop = stop;
  const bias = parseBias(s.logit_bias);
  if (bias && Object.keys(bias).length) request.logit_bias = bias;
  if (s.logprobs) {
    request.logprobs = true;
    request.top_logprobs = s.top_logprobs;
  }
  if (s.response_format.startsWith("json")) {
    request.response_format = { type: "json_object" };
    if (s.response_format === "json_schema") request.response_format.schema = JSON.stringify(JSON.parse(s.schema));
  } else if (s.response_format === "grammar") request.response_format = { type: "grammar", grammar: s.grammar };
  return request;
}
function qwenPromptTokens(messages, thinking, encode) {
  let total = 0;
  for (const message of messages) total += encode(`<|im_start|>${message.role}
${message.content}<|im_end|>
`).length;
  total += encode("<|im_start|>assistant\n" + (thinking ? "" : "<think>\n\n</think>\n\n")).length;
  return total;
}
function fitContext({ system, turns, user, settings, encode }) {
  const s = validateSettings(settings);
  const messages = [{ role: "system", content: effectiveSystem(system, s) }, ...turns.flat().map((x) => ({ role: x.role, content: x.content })), { role: "user", content: user }];
  const count = () => qwenPromptTokens(messages, effectiveThinking(s), encode);
  let promptTokens = count();
  let omittedTurns = 0;
  const limit = s.context_window_size - s.max_tokens - CONTEXT_RESERVE;
  while (promptTokens > limit && messages.length > 2 && s.overflow === "trim") {
    messages.splice(1, 2);
    omittedTurns++;
    promptTokens = count();
  }
  if (promptTokens > limit) {
    const error = new Error(`The prompt needs ${promptTokens.toLocaleString()} tokens, with ${s.max_tokens.toLocaleString()} reserved for output. This exceeds the ${s.context_window_size.toLocaleString()}-token context. Reduce max output, shorten your message or system prompt, or select a larger context window in settings.${s.overflow === "error" && turns.length ? " You can also choose \u201CKeep recent complete turns.\u201D" : ""}`);
    error.name = "ContextBudgetError";
    throw error;
  }
  return { messages, promptTokens, omittedTurns };
}

// src/inference-worker.js
var MLCEngine;
var prebuiltAppConfig;
var deleteModelAllInfoInCache;
var appConfig;
async function loadRuntime() {
  if (appConfig) return;
  try {
    ({ MLCEngine, prebuiltAppConfig, deleteModelAllInfoInCache } = await import("https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/lib/index.js"));
    await import("https://cdn.jsdelivr.net/npm/@mlc-ai/web-tokenizers@0.1.6/lib/index.js");
    appConfig = { ...prebuiltAppConfig, cacheBackend: "cache" };
  } catch (error) {
    throw new Error(`Could not load the model runtime: ${error.message}. Check your connection and allow downloads from cdn.jsdelivr.net.`);
  }
}
var engine;
var tokenizer;
var loadedConfig;
var working = false;
var stopRequested = false;
var post = (type, data = {}) => self.postMessage({ type, ...data });
async function loadModel(settings) {
  const s = validateSettings(settings);
  if (!self.navigator.gpu) throw new Error("WebGPU is unavailable. Use an updated browser and operating system with WebGPU support, and enable hardware acceleration.");
  const adapter = await self.navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No compatible GPU was found. Enable hardware acceleration in your browser and update your graphics driver.");
  await loadRuntime();
  const f16 = adapter.features.has("shader-f16");
  const precision = s.precision === "auto" ? f16 ? "q4f16_1" : "q4f32_1" : s.precision;
  if (precision.includes("f16") && !f16) throw new Error("This GPU does not support float16. Choose automatic precision or a float32 model.");
  const modelId = `${MODEL_PREFIX}${precision}-MLC`;
  const record = prebuiltAppConfig.model_list.find((x) => x.model_id === modelId);
  if (!record) throw new Error("The selected Qwen model is not present in this runtime.");
  engine = new MLCEngine({ appConfig, logLevel: "WARN", initProgressCallback: (report) => post("progress", report) });
  await engine.reload(modelId, { context_window_size: s.context_window_size, conv_config: { role_templates: {} } });
  post("progress", { progress: 0.99, text: "Preparing accurate context counting\u2026" });
  const base = record.model.replace(/\/$/, "") + (record.model.includes("/resolve/") ? "/" : "/resolve/main/");
  const tokenizerURL = new URL("tokenizer.json", base).href;
  const cache = await caches.open("qwen-local-tokenizer-v1");
  let response = await cache.match(tokenizerURL);
  if (!response) {
    response = await fetch(tokenizerURL);
    if (!response.ok) throw new Error(`Tokenizer download failed (${response.status}). Check your connection and try loading again.`);
    try {
      await cache.put(tokenizerURL, response.clone());
    } catch {
    }
  }
  tokenizer = await globalThis.tokenizers.Tokenizer.fromJSON(await response.arrayBuffer());
  loadedConfig = { modelId, precision, context_window_size: s.context_window_size };
  post("ready", { ...loadedConfig, gpu: adapter.info?.description || adapter.info?.device || adapter.info?.vendor || "WebGPU device" });
}
async function generate(data) {
  if (!engine || !tokenizer || !loadedConfig) throw new Error("Load the model before sending a message.");
  const s = validateSettings(data.settings);
  if (s.context_window_size !== loadedConfig.context_window_size) throw new Error("Context settings changed. Reload the model before continuing.");
  const context = fitContext({ system: data.system, turns: data.turns, user: data.user, settings: s, encode: (text) => tokenizer.encode(text) });
  post("context", { requestId: data.requestId, promptTokens: context.promptTokens, omittedTurns: context.omittedTurns });
  await engine.resetChat();
  if (stopRequested) {
    post("complete", { requestId: data.requestId, raw: "", finishReason: "abort", usage: null, duration: 0, probabilities: [] });
    return;
  }
  const started = performance.now();
  let raw = "", finishReason = null, usage = null, lastUpdate = 0;
  const probabilities = [];
  const request = createRequest(context.messages, s);
  request.messages = request.messages.map((message) => message.role === "system" ? { ...message, content: message.content.replace(/\$/g, () => "$$") } : message);
  const chunks = await engine.chat.completions.create(request);
  for await (const chunk of chunks) {
    const choice = chunk.choices[0];
    raw += choice?.delta?.content ?? "";
    finishReason = choice?.finish_reason ?? finishReason;
    usage = chunk.usage ?? usage;
    if (choice?.logprobs?.content) probabilities.push(...choice.logprobs.content);
    const now = performance.now();
    if (now - lastUpdate >= 32 || choice?.finish_reason) {
      post("delta", { requestId: data.requestId, raw, duration: (now - started) / 1e3 });
      lastUpdate = now;
    }
  }
  post("complete", { requestId: data.requestId, raw, finishReason: stopRequested ? "abort" : finishReason, usage, duration: (performance.now() - started) / 1e3, probabilities });
}
self.onmessage = async ({ data }) => {
  if (data.type === "stop") {
    stopRequested = true;
    engine?.interruptGenerate();
    return;
  }
  if (working) {
    post("error", { message: "The model is busy. Wait for the current operation to finish.", requestId: data.requestId, recoverable: true });
    return;
  }
  working = true;
  stopRequested = false;
  try {
    if (data.type === "load") await loadModel(data.settings);
    else if (data.type === "generate") await generate(data);
    else if (data.type === "clear-cache") {
      await loadRuntime();
      await engine?.unload();
      tokenizer?.dispose();
      tokenizer = null;
      engine = null;
      loadedConfig = null;
      for (const record of prebuiltAppConfig.model_list.filter((x) => x.model_id.startsWith(MODEL_PREFIX))) await deleteModelAllInfoInCache(record.model_id, appConfig);
      await caches.delete("qwen-local-tokenizer-v1");
      post("cache-cleared");
    }
  } catch (error) {
    post("error", { requestId: data.requestId, message: error?.message || String(error), recoverable: error?.name === "ContextBudgetError" });
  } finally {
    working = false;
  }
};
