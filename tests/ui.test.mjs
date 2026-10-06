import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
const bundle = (await readFile(new URL('../docs/assets/app.js', import.meta.url), 'utf8')).replaceAll('import.meta.url', '"https://qwen.test/qwen-local/assets/app.js"');
const pause = () => new Promise(resolve => setTimeout(resolve, 15));

function setup() {
  const { window } = new JSDOM(html, { url: 'https://qwen.test/qwen-local/', runScripts: 'outside-only', pretendToBeVisual: true });
  // jsdom has no native dialog top-layer/layout implementation. Exercise our
  // handlers against the standard open attribute; browser focus/layout is not
  // claimed by this isolated integration suite.
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const workers = [];
  class Worker {
    sent = []; terminated = false;
    constructor() { workers.push(this); }
    emit(data) { this.onmessage?.({ data }); }
    postMessage(data) {
      this.sent.push(data);
      if (data.type === 'load') queueMicrotask(() => this.emit({ type: 'ready', modelId: 'Qwen3-0.6B-q4f16_1-MLC', gpu: 'Test adapter', context_window_size: data.settings.context_window_size }));
      if (data.type === 'stop') queueMicrotask(() => this.emit({ type: 'complete', requestId: this.sent.findLast(x => x.type === 'generate').requestId, raw: '<think>interrupted', finishReason: 'abort', duration: .1 }));
    }
    terminate() { this.terminated = true; }
  }
  window.Worker = Worker;
  Object.defineProperty(window.navigator, 'gpu', { value: { requestAdapter: async () => ({ features: new Set(['shader-f16']), info: { vendor: 'Test adapter' } }) } });
  const registered = new Map();
  window.document.modelContext = { registerTool: tool => registered.set(tool.name, tool) };
  window.eval(bundle);
  const $ = s => window.document.querySelector(s);
  const input = (selector, value) => { const element = $(selector); element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = selector => $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { window, $, input, submit, workers, registered, async close() { window.close(); } };
}

test('actual bundled UI sends multiple turns, toggles thinking, preserves system instructions, and stops cleanly', async () => {
  const t = setup();
  try {
    assert.equal(t.$('#welcome').hidden, false);
    t.$('[data-action="system"]').click();
    assert.ok(t.$('#system-dialog').open);
    t.input('#system-prompt', 'Use short answers and preserve $& literally.'); t.submit('#system-form');
    t.$('#thinking-toggle').click();
    t.input('#prompt', 'What is two plus two?'); t.submit('#chat-form'); await pause();
    const worker = t.workers[0];
    const request = worker.sent.find(x => x.type === 'generate');
    assert.equal(request.settings.thinking, true);
    assert.equal(request.system, 'Use short answers and preserve $& literally.');
    worker.emit({ type: 'delta', requestId: request.requestId, raw: '<think>2 + 2 = 4</think>\n\nFour.', duration: .2 });
    worker.emit({ type: 'complete', requestId: request.requestId, raw: '<think>2 + 2 = 4</think>\n\nFour.', finishReason: 'stop', duration: .2, usage: { completion_tokens: 12 } });
    assert.equal(t.$('.message-content').textContent.trim(), 'Four.');
    assert.equal(t.$('.thinking-text').textContent, '2 + 2 = 4');
    t.input('#prompt', 'Double that.'); t.submit('#chat-form'); await pause();
    const second = worker.sent.findLast(x => x.type === 'generate');
    assert.equal(second.turns[0][1].content, 'Four.');
    assert.ok(!JSON.stringify(second.turns).includes('2 + 2 = 4'));
    t.$('#send').click(); await pause();
    assert.equal(t.$('#runtime-status').dataset.state, 'ready');
    assert.match(t.$('#messages').textContent, /Stopped before an answer/);
    t.input('#prompt', 'Try again.'); t.submit('#chat-form'); await pause();
    assert.equal(worker.sent.filter(x => x.type === 'generate').length, 3);
  } finally { await t.close(); }
});

test('bundled UI rejects invalid settings and protects its controls against model HTML', async () => {
  const t = setup();
  try {
    t.$('[data-action="settings"]').click();
    t.input('#setting-top_p', '0'); t.submit('#settings-form');
    assert.equal(t.$('#settings-error').hidden, false);
    assert.ok(t.$('#settings-dialog').open);
    t.input('#setting-top_p', '.9'); t.submit('#settings-form');
    assert.equal(t.$('#settings-dialog').open, false);
    t.input('#prompt', 'Test'); t.submit('#chat-form'); await pause();
    const worker = t.workers[0], request = worker.sent.find(x => x.type === 'generate');
    const raw = '<div id="settings-dialog" class="message-end-note">Hello</div><img src="https://example.com/track"><script>alert(1)</script><a href="javascript:alert(1)">Bad link</a>';
    worker.emit({ type: 'complete', requestId: request.requestId, raw, finishReason: 'stop', duration: .1 });
    assert.equal(t.$('.message-content').querySelectorAll('[id],[class],img,script').length, 0, t.$('.message-content').innerHTML);
    assert.equal(t.window.document.querySelectorAll('#settings-dialog').length, 1);
    assert.equal(t.$('.message-content a').hasAttribute('href'), false);
    t.$('[data-action="settings"]').click();
    assert.ok(t.$('#settings-dialog').open);
  } finally { await t.close(); }
});

test('device changes unload worker and browser tools share validated UI state', async () => {
  const t = setup();
  try {
    t.$('#load-model').click(); await pause();
    const status = t.registered.get('get_qwen_status');
    const configure = t.registered.get('configure_qwen');
    assert.equal(status.execute().status, 'ready');
    assert.throws(() => configure.execute({ settings: { temperature: -1 } }));
    assert.throws(() => configure.execute({ settings: { nonexistent: true } }));
    const result = configure.execute({ settings: { context_window_size: 8192, temperature: .5 } });
    assert.equal(result.status, 'idle');
    assert.equal(result.settings.temperature, .5);
    assert.equal(t.workers[0].terminated, true);
    t.$('[data-action="settings"]').click();
    assert.equal(t.$('#setting-context').value, '8192');
    assert.equal(t.$('#setting-temperature').value, '0.5');
  } finally { await t.close(); }
});
