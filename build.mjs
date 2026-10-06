import * as esbuild from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
const serve = process.argv.includes('--serve');
await mkdir('docs/assets', { recursive: true });
await copyFile('index.html', 'docs/index.html');
await copyFile('public/favicon.svg', 'docs/favicon.svg');
await writeFile('docs/.nojekyll', '');
await copyFile('src/style.css', 'docs/assets/style.css');
// Pin the official published browser bundles. They are loaded only in the
// inference worker, so the chat UI renders immediately without a 10 MB script.
const runtimeVersions = { '@mlc-ai/web-llm': '0.2.85', '@mlc-ai/web-tokenizers': '0.1.6' };
const runtimeCDN = { name: 'pinned-browser-runtime', setup(build) {
  build.onResolve({ filter: /^@mlc-ai\/(web-llm|web-tokenizers)$/ }, args => ({ path: `https://cdn.jsdelivr.net/npm/${args.path}@${runtimeVersions[args.path]}/lib/index.js`, external: true }));
} };
const options = { entryPoints: { app: 'src/app.js', 'inference-worker': 'src/inference-worker.js' }, bundle: true, format: 'esm', outdir: 'docs/assets', target: ['es2022'], plugins: [runtimeCDN], minify: !serve, legalComments: 'linked', logLevel: 'info' };
if (serve) {
  const context = await esbuild.context(options);
  await context.watch();
  const server = await context.serve({ servedir: 'docs', host: '0.0.0.0', port: 4173 });
  console.log(`Preview: http://localhost:${server.port}`);
} else await esbuild.build(options);
