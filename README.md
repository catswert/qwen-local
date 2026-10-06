# Qwen Local

A minimal, Grok-inspired chatbot that runs **Qwen3 0.6B on your own device**, in the browser, using WebGPU and WebLLM 0.2.85. There is no inference server, API key, account system, analytics, or paid API.

## Use it

1. Open the published HTTPS site in a browser with a working WebGPU adapter.
2. Click **Load model**, or send your first message to load automatically.
3. The default 4-bit model downloads roughly **335 MB of weights**, plus runtime/tokenizer files. Completed downloads are cached on this device.
4. Chat normally. **Think** controls Qwen’s actual thinking mode. **System prompt** opens the editable instructions. The sliders button opens the remaining settings.

WebGPU availability depends on your browser, operating system, graphics driver, and enabled hardware acceleration. The page detects support and explains loading failures. This configuration has no CPU fallback.

## Controls

| Group | Controls |
| --- | --- |
| Generation | Thinking, maximum output tokens, temperature, top-p |
| Repetition | Repetition, frequency, and presence penalties |
| Randomness | Optional seed |
| Stopping | Custom stop sequences; optional ignore-end-markers mode for text |
| Output | Text/Markdown, JSON object, JSON Schema, EBNF grammar |
| Advanced | Token-ID logit bias, token probabilities and 1–5 alternatives, detailed timing |
| Device | Automatic 4-bit precision, explicit q4f16/q4f32/q0f16/q0f32, 2K–32K context |
| Context | Keep recent complete turns, or stop before overflowing |
| Model files | Load, cancel loading, unload, clear cached Qwen downloads |
| Chat | Stop, regenerate the last response, copy, inspect response statistics, new chat |

Thinking and the final answer share the output-token budget. The runtime’s non-thinking template inserts a short empty thinking block, which also consumes a few output tokens; the interface removes that block. A very small max-output setting can therefore produce no visible answer.

WebLLM 0.2.85 does **not** expose top-k, min-p, beam search, or a separate thinking-token budget. The interface identifies this explicitly rather than presenting ineffective controls. Streaming is one response at a time. Seed reproducibility is best effort across devices.

Constrained formats disable thinking. JSON modes add a short JSON instruction, displayed in the system-prompt dialog. Ignore-end-markers is disabled for constrained formats because continuing past a completed grammar can cause a runtime failure. A token or custom stop limit can still leave an incomplete JSON result; the interface reports this.

## Privacy and caching

- Inference happens in a dedicated worker on the device’s GPU.
- Messages, system instructions, and preferences stay in this browser’s local storage. The last 200 messages are retained across page loads. Anyone using the same browser profile can see them.
- Messages are never sent to an inference endpoint. Loading runtime code contacts jsDelivr; public model files load from Hugging Face and MLC’s GitHub-hosted files. Those hosts receive ordinary download requests, not chat content.
- The runtime packages use exact versioned CDN URLs. The application, Markdown renderer, and sanitizer are bundled into `docs/`.
- Cached weights reduce subsequent downloads. This is **not** an offline-first/PWA claim: opening the site or loading uncached runtime files still needs network access.
- Markdown is sanitized. Model-provided scripts, media, styles, event handlers, and application-conflicting IDs/classes are excluded. External links open only when clicked.
- **New chat** clears the saved conversation. **Clear model cache** removes downloaded Qwen model data while preserving the conversation and preferences.

## Context behavior

The app counts the fixed Qwen ChatML template using the model’s tokenizer, separately encoding each message to match WebLLM. It reserves max-output tokens plus a safety margin before generation.

When context fills, the default policy removes the oldest complete user/assistant turns from the inference request and displays how many were omitted. They remain visible in chat. The system prompt and newest user message are never truncated. If those cannot fit, generation stops with an actionable explanation.

Historical assistant messages contain final answers only; reasoning remains visible separately. Failed or unanswered earlier turns are omitted. Each request resets the runtime’s conversation cache and prefills the chosen context again, so system changes and removed reasoning cannot leave stale cached state. This is a reliability/performance tradeoff: long histories require more prefill work.

## GitHub Pages deployment

The complete, prebuilt site is in **`docs/`**. No server or GitHub Actions secret is needed.

1. Create a repository named `qwen-local` on your GitHub account.
2. Push this project, including `docs/`, to `main`.
3. In the repository, open **Settings → Pages**.
4. Set **Source** to **Deploy from a branch**.
5. Choose **main** and **/docs**, then **Save**.
6. GitHub will display the live site address after its Pages build completes.

Use a public repository for Pages on a free personal account. A private repository requires a GitHub plan that supports Pages from private repositories. Do not overwrite an existing project: this is designed as a separate repository. All application asset URLs are relative, so repository subpaths work.

If GitHub CLI is already authenticated on your computer, from this project folder:

```sh
git init -b main
git add .
git commit -m "Build Qwen3 0.6B browser chat"
gh repo create qwen-local --public --source=. --remote=origin --push
gh api --method POST repos/{owner}/qwen-local/pages \
  -f 'source[branch]=main' -f 'source[path]=/docs'
```

If a repository with that name already exists, choose another name and update the command. The repository-name choice does not require rebuilding the site.

## Develop

Requires a recent Node.js release (Node 22 or newer recommended).

```sh
npm ci
npm run build
npm test
npm run dev
```

The dev server uses port 4173. The built site is static HTML/CSS/JavaScript in `docs/`. Re-run `npm run build` after source changes and commit the updated `docs/` files to publish them. The small custom dev server rebuilds JavaScript on changes; re-run it after editing the HTML or CSS.

```text
index.html               Accessible chat and settings structure
src/app.js               UI, storage, safe Markdown, worker coordination
src/core.js              Validation, thinking parsing, context budgeting
src/inference-worker.js  WebLLM, exact tokenizer, loading and streaming
src/style.css            Responsive dark interface
public/favicon.svg      App icon
build.mjs                Reproducible static build
docs/                    Ready-to-publish GitHub Pages site
tests/                   Core logic and isolated DOM integration checks
```

Two optional browser-native WebMCP tools expose status and validated settings when `document.modelContext` is available. Ordinary browsers skip them. They do not automatically send messages or download models.

## Verification and limitations

The production bundle is checked with core-logic tests and isolated DOM integration tests for actual UI handlers, multi-turn context, thinking controls, system edits, stop/retry state, validation, model unloading, and safe Markdown. Model-worker events are simulated in the DOM tests; these tests do **not** demonstrate GPU inference.

The build was reviewed against the published WebLLM 0.2.85 package and Qwen model configuration. End-to-end GPU generation and visual browser QA could not be completed in the creation environment because its browser could not reach the internal preview. Test a real device’s first model load and short conversation before relying on a specific browser/GPU combination. JSON/grammar generation is implemented against the documented API but has not been exercised on a real GPU in that environment.

Qwen3 0.6B is a small model. It can make factual and reasoning mistakes, and complex instructions can exceed its capabilities. The application does not add web search or external tools to its answers.

## Primary references

- [Qwen3 0.6B model card](https://huggingface.co/Qwen/Qwen3-0.6B)
- [MLC’s Qwen3 0.6B 4-bit conversion](https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC)
- [WebLLM API reference](https://webllm.mlc.ai/docs/user/api_reference.html)
- [WebLLM source](https://github.com/mlc-ai/web-llm)
- [Configure a GitHub Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

The Qwen model and WebLLM have their respective upstream licenses. Bundled Markdown and sanitization libraries retain license notices in `docs/assets/app.js.LEGAL.txt`. This interface is independent of Qwen/Alibaba, xAI/Grok, and GitHub; the Grok reference describes the visual direction.
