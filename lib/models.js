// The models superPDF's on-device AI can download, and what each one needs. Pure (no DOM), so the
// docs, the On-device AI models screen and the tests share one source of truth.
//
// Every model file comes from Hugging Face (huggingface.co, which serves large files from its CDN on
// hf.co subdomains), pinned to a commit so the files can't change underneath a release. The engines'
// WebAssembly files are served by superPDF itself under /ai/ort/ and /ai/genai/ (see vite.config.js).
// Sizes are the exact byte counts of the pinned files, read from the Hugging Face API.

export const MODEL_HOST = 'huggingface.co';
export const CACHE_NAME = 'transformers-cache'; // Cache API bucket for every model file (Transformers.js's own name)

/** ONNX Runtime Web (MIT) engine files, served from superPDF's own site and cached on first use. */
export const RUNTIME = {
  name: 'ONNX Runtime Web',
  licence: 'MIT',
  path: '/ai/ort/',
  files: { 'ort-wasm-simd-threaded.asyncify.mjs': 53057, 'ort-wasm-simd-threaded.asyncify.wasm': 26861777 },
};

/** MediaPipe LLM Inference (Apache-2.0) engine files for Gemma 4, served from superPDF's own site. */
export const GENAI_RUNTIME = {
  name: 'MediaPipe LLM Inference',
  licence: 'Apache-2.0',
  path: '/ai/genai/',
  files: { 'genai_wasm_module_internal.js': 334104, 'genai_wasm_module_internal.wasm': 27220735 },
};

/**
 * Instruct models, default first. `runtime`: 'mediapipe' (MediaPipe LLM Inference, one .task file) or
 * 'transformers' (Transformers.js ONNX). `dtypes`: weight files per build, with sizes. For ONNX models,
 * q4f16 needs the WebGPU shader-f16 feature and is used when offered; q4 works everywhere.
 *
 * Tested in Chrome on an Apple silicon Mac, October 2026:
 * - Gemma 4 E2B (Google's web build): loads from cache in about 2 s, about 50 words a second, cites pages
 *   and ignored a planted instruction. The first answer after loading is slow while the GPU warms up.
 * - Qwen3 0.6B: the small fallback for devices that can't hold Gemma 4 E2B.
 * - Dropped: Granite 4.0 1B and Gemma 3 1B (worked, but weaker than Gemma 4 E2B); Qwen3 1.7B (one 1.4 GB
 *   ONNX file ran out of WebAssembly memory while loading); Gemma 4 E2B ONNX (3.1 GB for text alone).
 */
export const CHAT_MODELS = {
  'gemma-4-e2b': {
    key: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    runtime: 'mediapipe',
    repo: 'litert-community/gemma-4-E2B-it-litert-lm',
    revision: 'b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1',
    upstream: 'google/gemma-4-E2B-it',
    licence: 'Apache-2.0',
    summary: 'Google’s small model: the best answers, summaries and translations here, in many languages.',
    memoryGB: 8,
    dtypes: { web: { 'gemma-4-E2B-it-web.task': 2003697664 } },
    extra: {},
    contextTokens: 6144,
    // Picks the right document sections from their summaries (9 of 10 in testing; see page-index.js).
    navigates: true,
  },
  'qwen3-0.6b': {
    key: 'qwen3-0.6b',
    label: 'Qwen3 0.6B',
    runtime: 'transformers',
    repo: 'onnx-community/Qwen3-0.6B-ONNX',
    revision: '1e0a4a196ecabdf9a879664110574563d3f372d3',
    upstream: 'Qwen/Qwen3-0.6B',
    licence: 'Apache-2.0',
    summary: 'A smaller fallback for devices with less memory. Answers are simpler and miss details or citations more often.',
    // Lists most sections when asked to choose, so section navigation is off by default with it.
    navigates: false,
    memoryGB: 4,
    dtypes: {
      q4f16: { 'onnx/model_q4f16.onnx': 569789750 },
      q4: { 'onnx/model_q4.onnx': 919096585 },
    },
    extra: { 'config.json': 912, 'generation_config.json': 219, 'tokenizer.json': 9117040, 'tokenizer_config.json': 10360 },
  },
};
export const DEFAULT_MODEL = 'gemma-4-e2b';

/** Said wherever on-device AI can't run because the browser has no WebGPU (or no usable graphics adapter). */
export const NO_ON_DEVICE_AI = 'This browser can’t run AI on your device. Use the latest Chrome, Edge or Safari, or use your own API key.';

const sum = object => Object.values(object).reduce((a, b) => a + b, 0);

/** Build to download on a device: q4f16 when the model offers it and the GPU has 16-bit shaders, else q4, else its only build. */
export function pickDtype(model, f16) {
  if (f16 && model.dtypes.q4f16) return 'q4f16';
  return model.dtypes.q4 ? 'q4' : Object.keys(model.dtypes)[0];
}

/** Files a chat model needs, relative to its repository, with sizes. */
export function chatFiles(model, dtype) {
  return { ...model.extra, ...model.dtypes[dtype] };
}

/** Total bytes one download fetches: the chat model and the engine that runs it. */
export function downloadBytes(model, dtype) {
  return sum(chatFiles(model, dtype)) + sum((model.runtime === 'mediapipe' ? GENAI_RUNTIME : RUNTIME).files);
}

/** URL Transformers.js fetches (and uses as the cache key) for a file in a pinned repository. */
export function fileUrl(repo, revision, file) {
  return `https://${MODEL_HOST}/${repo}/resolve/${revision}/${file}`;
}

/** "1.4 GB", "570 MB", "23 MB": decimal units, as download pages usually show them. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/**
 * What a cancelled download keeps, said honestly: finished files stay in the cache, but a file cut off part-way
 * starts again from the beginning. So "kept" is only said when the download has several files and some finished.
 */
export function cancelledMessage(files, finished) {
  return files > 1 && finished > 0
    ? 'Download cancelled. Files that finished downloading are kept; select Download to continue.'
    : 'Download cancelled. Select Download to start again.';
}

/**
 * Roughly how long a download takes, without promising a number: 2 GB took 40 s at 60 MB/s in testing, and
 * many connections are several times slower.
 */
export function downloadEstimate(bytes) {
  return bytes <= 1e9 ? 'Under a minute on a fast connection, longer on slower ones.' : 'A minute or two on a fast connection, longer on slower ones.';
}
