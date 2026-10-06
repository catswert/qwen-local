import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM, FORMAT_INSTRUCTION, validateSettings, effectiveThinking, splitThinking, completedTurns, restoreConversation } from './core.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ICONS = {
  new: '<path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6"/><path d="m15 4 5 5M10 14l-1 4 4-1L22 8l-3-3Z"/>',
  system: '<path d="m8 5-5 7 5 7M16 5l5 7-5 7M14 4l-4 16"/>',
  sliders: '<path d="M4 6h5m5 0h6M4 12h10m5 0h1M4 18h2m5 0h9"/><circle cx="11.5" cy="6" r="2.5"/><circle cx="16.5" cy="12" r="2.5"/><circle cx="8.5" cy="18" r="2.5"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  brain: '<path d="M12 4a3 3 0 0 0-5.8 1.1A4 4 0 0 0 3 11.7a4 4 0 0 0 2 6.7A3.5 3.5 0 0 0 12 20V4Zm0 0a3 3 0 0 1 5.8 1.1 4 4 0 0 1 3.2 6.6 4 4 0 0 1-2 6.7 3.5 3.5 0 0 1-7 1.6M7 5a3 3 0 0 0 1 4m-3 3a4 4 0 0 1 4 3m8-10a3 3 0 0 1-1 4m3 3a4 4 0 0 0-4 3"/>',
  send: '<path d="m20 4-7 16-3-7-7-3 17-6Z"/><path d="m10 13 10-9"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  shield: '<path d="m12 3 8 3v6c0 4-5 8-8 10-3-2-8-6-8-10V6Z"/><path d="m8 12 3 3 5-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  retry: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.4 7a7 7 0 0 1 11.8-1L20 9M4 15l1.8 3A7 7 0 0 0 17.6 17"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.1"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.spark}</svg>`; }
$$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });

const STORAGE_KEY = 'qwen-local-v1';
let settings = { ...DEFAULT_SETTINGS }, systemPrompt = DEFAULT_SYSTEM, messages = [];
try {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (stored) {
    try { settings = validateSettings(stored.settings ?? {}); } catch { settings = { ...DEFAULT_SETTINGS }; }
    if (typeof stored.systemPrompt === 'string') systemPrompt = stored.systemPrompt.slice(0, 50000);
    messages = restoreConversation(stored.messages);
  }
} catch { /* Storage can be unavailable in privacy-restricted browsers. */ }
let state = 'idle', worker = null, loadPromise = null, loadResolve = null, active = null, modelInfo = null;
let adapterInfo = null, sending = false, stickyScroll = true, toastTimer, saveTimer, lastRender = 0, pendingRender;
let storageWarningShown = false, stopTimer;
const messageElements = new Map();
const dom = { scroll: $('#conversation-scroll'), messages: $('#messages'), welcome: $('#welcome'), prompt: $('#prompt'), send: $('#send'), notice: $('#notice'), status: $('#runtime-status'), load: $('#load-model'), loading: $('#loading-card') };

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, systemPrompt, messages: messages.map(({ probabilities, ...m }) => m).slice(-200) }));
    } catch {
      if (!storageWarningShown) { toast('Browser storage is full or unavailable. This chat will last only for this session.'); storageWarningShown = true; }
    }
  }, 200);
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function notice(message, error = false) { dom.notice.textContent = message; dom.notice.classList.toggle('error', error); dom.notice.hidden = !message; }
function uuid() { return crypto.randomUUID(); }
function autoSize() { dom.prompt.style.height = 'auto'; dom.prompt.style.height = `${Math.min(dom.prompt.scrollHeight, 220)}px`; }
function scrollBottom(force = false) {
  if (stickyScroll || force) requestAnimationFrame(() => { dom.scroll.scrollTop = dom.scroll.scrollHeight; });
}
function setState(next) { state = next; updateControls(); }
function updateControls() {
  const busy = state === 'generating';
  const loading = state === 'loading';
  const labels = { idle: 'Not loaded', loading: 'Loading model', ready: 'Ready on device', generating: 'Generating', error: 'Load failed', clearing: 'Clearing cache' };
  dom.status.dataset.state = state;
  $('span', dom.status).textContent = labels[state] ?? state;
  dom.load.disabled = loading || busy || state === 'clearing';
  dom.load.innerHTML = `${icon(state === 'ready' ? 'chip' : 'download')}<span>${state === 'ready' ? 'Model loaded' : loading ? 'Loading…' : 'Load model'}</span>`;
  dom.load.title = state === 'ready' ? `${modelInfo?.modelId || 'Qwen3'} · ${settings.context_window_size.toLocaleString()}-token context` : 'Download and load Qwen3 0.6B';
  dom.send.disabled = !busy && (loading || state === 'clearing' || sending || !dom.prompt.value.trim());
  dom.send.innerHTML = icon(busy ? 'stop' : 'send');
  dom.send.setAttribute('aria-label', busy ? 'Stop generating' : 'Send message');
  dom.send.classList.toggle('stopping', busy);
  $('#thinking-toggle').setAttribute('aria-pressed', String(effectiveThinking(settings)));
  $('#thinking-toggle').disabled = busy || settings.response_format !== 'text';
  $('#thinking-toggle').title = settings.response_format === 'text' ? 'Enable thinking before answering' : 'Thinking is disabled for constrained output. Change the output format in settings.';
  $('#unload-model').disabled = !worker || state === 'clearing';
  $('#clear-model-cache').disabled = loading || busy || state === 'clearing';
  dom.welcome.hidden = messages.length > 0;
  dom.messages.hidden = messages.length === 0;
  $$('[data-action="new-chat"]').forEach(button => { button.disabled = busy || loading; });
}

function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'picture', 'video', 'audio', 'iframe', 'style', 'form', 'input', 'button', 'textarea'],
    FORBID_ATTR: ['style', 'id', 'name', 'class'],
  });
}
function setMarkdown(element, text) {
  element.innerHTML = markdown(text);
  $$('a', element).forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}
function createMessageElement(message) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  article.dataset.id = message.id;
  article.setAttribute('aria-label', message.role === 'user' ? 'Your message' : 'Qwen response');
  if (message.role === 'user') {
    const content = document.createElement('div'); content.className = 'user-content'; content.textContent = message.content; article.append(content);
  } else {
    article.innerHTML = `<header class="assistant-header"><span class="mini-mark" aria-hidden="true">Q</span>Qwen3<span class="model-size">0.6B</span></header><details class="thinking-block" hidden><summary>${icon('brain')}<span class="thinking-label">Thinking</span>${icon('chevron')}</summary><div class="thinking-text"></div></details><div class="message-content"></div><div class="message-end-note" hidden></div><footer class="message-footer"><button class="icon-button copy-response" aria-label="Copy response" title="Copy response">${icon('copy')}</button><button class="icon-button retry-response" aria-label="Regenerate response" title="Regenerate response">${icon('retry')}</button><button class="icon-button response-info" aria-label="View response details" title="Response details">${icon('info')}</button><span class="message-metrics"></span></footer>`;
    $('.copy-response', article).addEventListener('click', async () => {
      const answer = splitThinking(message.raw ?? '', true).answer;
      try { await navigator.clipboard.writeText(answer); toast('Response copied'); } catch { toast('Copy is unavailable. Select the response text to copy it.'); }
    });
    $('.retry-response', article).addEventListener('click', () => regenerate(message.id));
    $('.response-info', article).addEventListener('click', () => {
      $('#response-details').textContent = JSON.stringify({ model: message.modelId || modelInfo?.modelId || 'Qwen3-0.6B', finish_reason: message.finishReason ?? null, total_seconds: message.duration, usage: message.usage, omitted_history_turns: message.omittedTurns || 0, generation_settings: message.settings, error: message.error || undefined, token_probabilities: message.probabilities?.length ? message.probabilities : message.settings?.logprobs ? 'Token details are available until the page is reloaded.' : undefined }, null, 2);
      $('#details-dialog').showModal();
    });
  }
  dom.messages.append(article); messageElements.set(message.id, article);
  return article;
}
function updateMessage(message, final = false) {
  const article = messageElements.get(message.id) || createMessageElement(message);
  if (message.role === 'user') return;
  const split = splitThinking(message.raw ?? '', !message.pending);
  const thought = $('.thinking-block', article), content = $('.message-content', article);
  const thinking = !!split.reasoning || split.inThinking;
  if (thinking && thought.hidden && message.pending) thought.open = true;
  thought.hidden = !thinking;
  $('.thinking-text', article).textContent = split.reasoning;
  $('.thinking-label', article).textContent = split.inThinking ? 'Thinking…' : message.pending ? 'Thought process' : message.finishReason === 'abort' && !split.answer ? 'Thinking stopped' : 'Thought process';
  if (final && split.answer && thought.open) thought.open = false;
  if (split.answer) setMarkdown(content, split.answer);
  else if (message.pending && !thinking) content.innerHTML = '<div class="typing-indicator" aria-label="Generating"><i></i><i></i><i></i></div>';
  else content.textContent = '';
  const end = $('.message-end-note', article);
  const notes = [];
  if (message.error) notes.push(message.error);
  else if (!message.pending && message.finishReason === 'length') notes.push(split.answer ? 'Output limit reached. Increase max output in settings for longer replies.' : 'The output budget was used before an answer was produced. Increase max output or turn thinking off.');
  else if (!message.pending && message.finishReason === 'abort') notes.push(split.answer ? 'Stopped.' : 'Stopped before an answer was produced.');
  else if (!message.pending && !split.answer) notes.push('No answer text was returned. Try regenerating or changing the settings.');
  if (!message.pending && split.answer && message.settings?.response_format?.startsWith('json')) {
    try { JSON.parse(split.answer); } catch { notes.push('This output is not complete, valid JSON. It may have reached a token or stop limit.'); }
  }
  end.textContent = notes.join(' '); end.hidden = !notes.length;
  const tokens = message.usage?.completion_tokens;
  const speed = message.usage?.extra?.decode_tokens_per_s;
  $('.message-metrics', article).textContent = message.pending ? '' : [typeof tokens === 'number' ? `${tokens.toLocaleString()} tokens` : '', Number.isFinite(speed) && speed > 0 ? `${speed.toFixed(1)} tok/s` : '', message.duration ? `${message.duration.toFixed(1)}s` : ''].filter(Boolean).join(' · ');
  $('.message-footer', article).hidden = message.pending;
  $('.copy-response', article).disabled = !split.answer;
  $('.retry-response', article).hidden = messages[messages.length - 1]?.id !== message.id;
  scrollBottom();
}
function renderAll() {
  dom.messages.replaceChildren(); messageElements.clear(); messages.forEach(m => updateMessage(m)); updateControls(); scrollBottom(true);
}
function renderActive(force = false) {
  if (!active) return;
  const now = performance.now();
  if (!force && now - lastRender < 45) {
    if (!pendingRender) pendingRender = setTimeout(() => { pendingRender = null; renderActive(true); }, 45);
    return;
  }
  lastRender = now; updateMessage(active, force && !active.pending);
}

async function inspectGPU() {
  let text;
  if (!navigator.gpu) text = 'WebGPU is not available in this browser. Use a current WebGPU-capable browser and operating system with hardware acceleration enabled.';
  else {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) text = 'WebGPU is present, but no compatible GPU adapter is available. Check browser hardware acceleration and graphics drivers.';
      else {
        adapterInfo = { f16: adapter.features.has('shader-f16'), description: adapter.info?.description || adapter.info?.vendor || 'WebGPU adapter' };
        text = `${adapterInfo.description}\nFloat16: ${adapterInfo.f16 ? 'supported' : 'unavailable; automatic mode uses float32'}`;
      }
    } catch (error) { text = `Could not inspect the GPU: ${error.message}`; }
  }
  $('#device-info').textContent = text;
  if (!adapterInfo) notice(text, true);
}

function createWorker() {
  if (worker) return worker;
  const instance = new Worker(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
  worker = instance;
  instance.onmessage = ({ data }) => { if (worker === instance) handleWorker(data); };
  instance.onerror = event => { if (worker === instance) handleFailure(event.message || 'The inference worker stopped unexpectedly. Reload the model and try again.'); };
  instance.onmessageerror = () => { if (worker === instance) handleFailure('The inference worker returned an unreadable message. Reload the model.'); };
  return instance;
}
function releaseWorker() {
  worker?.terminate(); worker = null; modelInfo = null;
  if (loadResolve) loadResolve(false);
  loadPromise = null; loadResolve = null;
  dom.loading.hidden = true;
  clearTimeout(stopTimer);
}
function finishActive(data) {
  if (!active) return;
  Object.assign(active, { pending: false, raw: data.raw ?? active.raw, finishReason: data.finishReason ?? 'abort', duration: data.duration ?? active.duration, usage: data.usage ?? active.usage, probabilities: data.probabilities ?? [] });
  renderActive(true);
  $('#chat-announcement').textContent = active.error ? 'The response could not be completed.' : active.finishReason === 'abort' ? 'Generation stopped.' : 'Qwen finished responding.';
  active = null; clearTimeout(stopTimer); save();
}
function handleFailure(message, recoverable = false) {
  if (active) { active.error = message; finishActive({ finishReason: 'error' }); }
  if (!recoverable) { releaseWorker(); setState('error'); }
  else setState('ready');
  notice(message, true); sending = false; updateControls();
}
function handleWorker(data) {
  if (data.requestId && data.requestId !== active?.id) return;
  if (data.type === 'progress') {
    $('#load-progress').style.width = `${Math.max(0, Math.min(100, (data.progress || 0) * 100))}%`;
    $('#load-progress-text').textContent = data.text || 'Loading model files…';
  } else if (data.type === 'ready') {
    modelInfo = data; dom.loading.hidden = true; setState('ready');
    $('#device-info').textContent = `${data.gpu}\n${data.modelId}\n${data.context_window_size.toLocaleString()}-token context`;
    const resolve = loadResolve; loadResolve = null; loadPromise = null; resolve?.(true);
  } else if (data.type === 'context' && active) {
    active.promptTokens = data.promptTokens; active.omittedTurns = data.omittedTurns;
    notice(data.omittedTurns ? `${data.omittedTurns} older ${data.omittedTurns === 1 ? 'turn is' : 'turns are'} outside the model’s current context. They remain visible here.` : '');
  } else if (data.type === 'delta' && active) {
    active.raw = data.raw; active.duration = data.duration; renderActive(); save();
  } else if (data.type === 'complete') { finishActive(data); setState('ready'); }
  else if (data.type === 'error') handleFailure(data.message, data.recoverable);
  else if (data.type === 'cache-cleared') { releaseWorker(); setState('idle'); notice(''); toast('Downloaded Qwen model files cleared'); }
}

async function loadModel() {
  if (state === 'ready') return true;
  if (loadPromise) return loadPromise;
  if (state === 'generating' || state === 'clearing') return false;
  releaseWorker();
  notice(''); dom.loading.hidden = false;
  $('#load-progress').style.width = '0%';
  $('#loading-title').textContent = 'Preparing your model';
  $('#load-progress-text').textContent = settings.precision.startsWith('q0') ? 'The unquantized model is a larger download. Model files are cached on this device.' : 'First download: about 350 MB, plus runtime files. Cached on this device for future visits.';
  setState('loading');
  loadPromise = new Promise(resolve => { loadResolve = resolve; });
  const pending = loadPromise;
  try { createWorker().postMessage({ type: 'load', settings }); } catch (error) { handleFailure(error.message); }
  return pending;
}

async function sendMessage(text = dom.prompt.value, reuseLastUser = false) {
  if (sending || state === 'generating' || state === 'loading' || state === 'clearing') return;
  const userText = text.trim();
  if (!userText) return;
  if (userText.length > 120000) { notice('The message is too long. Limit it to 120,000 characters.', true); return; }
  sending = true; updateControls();
  try {
    if (!(await loadModel())) return;
    const turns = completedTurns(reuseLastUser ? messages.slice(0, -1) : messages);
    if (!reuseLastUser) messages.push({ id: uuid(), role: 'user', content: userText });
    if (dom.prompt.value.trim() === userText) dom.prompt.value = '';
    autoSize(); stickyScroll = true; notice('');
    active = { id: uuid(), role: 'assistant', raw: '', pending: true, duration: 0, usage: null, settings: { ...settings }, modelId: modelInfo?.modelId, omittedTurns: 0 };
    messages.push(active); renderAll(); setState('generating');
    worker.postMessage({ type: 'generate', requestId: active.id, user: userText, system: systemPrompt, turns, settings: { ...settings } });
    $('#chat-announcement').textContent = 'Qwen is generating a response.'; save();
  } catch (error) { handleFailure(error.message); }
  finally { sending = false; updateControls(); }
}
async function regenerate(id) {
  if (state === 'generating' || state === 'loading' || sending) return;
  const last = messages[messages.length - 1], user = messages[messages.length - 2];
  if (last?.id !== id || user?.role !== 'user') return;
  if (!(await loadModel())) return;
  messages.pop(); renderAll();
  await sendMessage(user.content, true);
}
function stopGeneration() {
  if (state !== 'generating') return;
  worker?.postMessage({ type: 'stop' });
  $('#chat-announcement').textContent = 'Stopping generation.';
  notice('Stopping… Large prompts may need a moment to finish processing.');
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    if (state !== 'generating') return;
    notice('The GPU is still finishing its current work. Open settings and choose “Unload model” to stop the worker immediately.');
  }, 5000);
}

function fillSettings(s) {
  for (const [key, value] of Object.entries(s)) {
    const input = $(`[name="${key}"]`, $('#settings-form'));
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value;
    else input.value = String(value ?? '');
    const range = $(`[data-setting="${key}"] input[type="range"]`);
    if (range) range.value = String(value);
  }
  syncFormat(); $('#settings-error').hidden = true;
}
function readSettings() {
  const result = { ...settings };
  for (const [key, original] of Object.entries(DEFAULT_SETTINGS)) {
    const input = $(`[name="${key}"]`, $('#settings-form'));
    if (!input) continue;
    if (input.type === 'checkbox') result[key] = input.checked;
    else if (key === 'seed') result.seed = input.value === '' ? null : Number(input.value);
    else if (typeof original === 'number') result[key] = input.value === '' ? NaN : Number(input.value);
    else result[key] = input.value;
  }
  return validateSettings(result);
}
function syncFormat() {
  const format = $('#setting-response_format').value;
  $('#schema-field').hidden = format !== 'json_schema';
  $('#grammar-field').hidden = format !== 'grammar';
  $('#setting-thinking').disabled = format !== 'text';
  $('#setting-ignore_eos').disabled = format !== 'text';
  if (format !== 'text') $('#setting-ignore_eos').checked = false;
  $('#setting-top_logprobs').disabled = !$('#setting-logprobs').checked;
}
function applySettings(next) {
  if (state === 'generating' || state === 'loading' || state === 'clearing') throw new Error('Finish or stop the current operation before applying settings.');
  const clean = validateSettings(next);
  const reload = clean.precision !== settings.precision || clean.context_window_size !== settings.context_window_size;
  settings = clean;
  if (reload) { releaseWorker(); setState('idle'); notice('Device settings changed. Load the model again to use the new precision or context window.'); }
  else notice('');
  save(); updateControls();
}
function openSettings() { fillSettings(settings); $('#settings-dialog').showModal(); }
function openSystem() {
  $('#system-prompt').value = systemPrompt;
  const formatNote = $('#system-format-note');
  formatNote.hidden = !settings.response_format.startsWith('json');
  formatNote.textContent = `JSON mode adds this instruction after your prompt: “${FORMAT_INSTRUCTION}”`;
  $('#system-dialog').showModal();
}
let confirmAction = null;
function confirm(title, description, label, action) {
  $('#confirm-title').textContent = title; $('#confirm-description').textContent = description; $('#confirm-yes').textContent = label; confirmAction = action; $('#confirm-dialog').showModal();
}
function newChat() {
  if (!messages.length) { dom.prompt.focus(); return; }
  confirm('Start a new chat?', 'This clears the conversation saved in this browser. Your settings and downloaded model stay.', 'New chat', () => {
    messages = []; active = null; notice(''); renderAll(); save(); dom.prompt.focus();
  });
}
$$('[data-action]').forEach(button => button.addEventListener('click', () => ({ settings: openSettings, system: openSystem, 'new-chat': newChat }[button.dataset.action]?.())));
$$('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('#confirm-cancel').addEventListener('click', () => { confirmAction = null; $('#confirm-dialog').close(); });
$('#confirm-yes').addEventListener('click', () => { const action = confirmAction; confirmAction = null; $('#confirm-dialog').close(); action?.(); });
$('#chat-form').addEventListener('submit', event => { event.preventDefault(); if (state === 'generating') stopGeneration(); else sendMessage(); });
dom.prompt.addEventListener('input', () => { autoSize(); updateControls(); });
dom.prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (state !== 'generating') sendMessage(); }
});
dom.scroll.addEventListener('scroll', () => { stickyScroll = dom.scroll.scrollHeight - dom.scroll.scrollTop - dom.scroll.clientHeight < 100; }, { passive: true });
$$('[data-prompt]').forEach(button => button.addEventListener('click', () => { dom.prompt.value = button.dataset.prompt; autoSize(); updateControls(); dom.prompt.focus(); }));
dom.load.addEventListener('click', () => { if (state === 'ready') openSettings(); else loadModel(); });
$('#cancel-load').addEventListener('click', () => { releaseWorker(); sending = false; setState('idle'); notice('Loading cancelled. Any completed downloads remain cached.'); });
$('#thinking-toggle').addEventListener('click', () => {
  if (state === 'generating' || settings.response_format !== 'text') return;
  settings.thinking = !settings.thinking; save(); updateControls();
});
$$('.slider-field').forEach(field => {
  const number = $('input[type=number]', field), range = $('input[type=range]', field);
  range.addEventListener('input', () => { number.value = range.value; });
  number.addEventListener('input', () => { range.value = number.value; });
});
$('#setting-response_format').addEventListener('change', syncFormat);
$('#setting-logprobs').addEventListener('change', syncFormat);
$('#recommended-settings').addEventListener('click', () => {
  const think = $('#setting-thinking').checked && $('#setting-response_format').value === 'text';
  for (const [key, value] of Object.entries({ temperature: think ? 0.6 : 0.7, top_p: think ? 0.95 : 0.8 })) { $(`[name=${key}]`).value = value; $(`[data-setting=${key}] input[type=range]`).value = value; }
});
$('#reset-settings').addEventListener('click', () => fillSettings(DEFAULT_SETTINGS));
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  try { applySettings(readSettings()); $('#settings-dialog').close(); toast('Settings applied'); }
  catch (error) { $('#settings-error').textContent = error.message; $('#settings-error').hidden = false; $('#settings-error').scrollIntoView({ block: 'nearest' }); }
});
$('#unload-model').addEventListener('click', () => {
  if (active) finishActive({ finishReason: 'abort' });
  releaseWorker(); sending = false; setState('idle'); notice('Model unloaded. Downloaded files remain cached.');
});
$('#clear-model-cache').addEventListener('click', () => {
  confirm('Clear downloaded model files?', 'This removes Qwen3 0.6B model downloads from this site’s cache. Your conversation and settings stay. The next load will download the model again.', 'Clear cache', () => {
    releaseWorker(); setState('clearing'); notice('Clearing cached Qwen model files…');
    createWorker().postMessage({ type: 'clear-cache' });
  });
});
$('#system-form').addEventListener('submit', event => {
  event.preventDefault(); systemPrompt = $('#system-prompt').value; save(); $('#system-dialog').close(); toast('System prompt saved for the next response');
});
$('#reset-system').addEventListener('click', () => { $('#system-prompt').value = DEFAULT_SYSTEM; });
window.addEventListener('pagehide', () => { clearTimeout(saveTimer); try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, systemPrompt, messages: messages.map(({ probabilities, ...m }) => m).slice(-200) })); } catch {} });

// Optional browser-native agent tools use the same validated controls as the UI.
// Ordinary browsers simply skip registration.
function registerBrowserTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const register = tool => { try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {} };
  register({ name: 'get_qwen_status', title: 'Read local model status', description: 'Read the current Qwen model status and generation settings without loading or running a model.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute: () => ({ status: state, model: modelInfo?.modelId ?? null, settings: { ...settings }, messages: messages.length }) });
  register({ name: 'configure_qwen', title: 'Configure Qwen generation', description: 'Change generation settings using the same validation as the visible settings panel. Does not generate text. Device settings may unload the current model.', inputSchema: { type: 'object', properties: { settings: { type: 'object' } }, required: ['settings'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: input => { if (!input || typeof input.settings !== 'object' || input.settings === null || Array.isArray(input.settings)) throw new Error('settings must be an object.'); for (const key of Object.keys(input.settings)) if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`Unknown setting: ${key}`); applySettings({ ...settings, ...input.settings }); return { status: state, settings: { ...settings } }; } });
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}

renderAll(); autoSize(); inspectGPU(); registerBrowserTools();
