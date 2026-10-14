// Speech models for PDF to audio (text to speech) and Transcribe audio to text (speech to text). Pure (no DOM),
// so the docs, the tools, the On-device AI models screen and the tests share one source of truth.
//
// Like the chat models in ./models.js, every file comes from Hugging Face, pinned to a commit, and is
// downloaded only when a person selects Download. Sizes are the exact byte counts of the pinned files,
// read from the Hugging Face API. Everything is Apache-2.0.
import { MODEL_HOST, fileUrl } from './models.js';

/**
 * Each model comes in builds: `gpu` runs on the graphics processor (WebGPU) and is much faster but larger;
 * `wasm` runs on WebAssembly on any device. Measured in Chrome on an Apple silicon Mac, October 2026:
 * Kokoro spoke 10.9 s of audio in 1.3 s on WebGPU (32-bit weights; its 16-bit builds came out silent there)
 * and in 17 s on WebAssembly (8-bit). Whisper Base transcribed 28 s in 1.4 s on WebGPU (32-bit encoder,
 * 4-bit decoder) and 5.8 s on WebAssembly (8-bit); 8-bit weights on WebGPU were slower than WebAssembly.
 */
export const BUILDS = {
  gpu: { label: 'Faster', detail: 'needs a recent computer and the latest Chrome, Edge or Safari' },
  wasm: { label: 'Smaller', detail: 'works on any device, more slowly' },
};

/** Kokoro 82M (hexgrad, Apache-2.0), the ONNX export run by Transformers.js. Output is 24 kHz mono. */
export const KOKORO = {
  key: 'kokoro-82m',
  label: 'Kokoro 82M',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  upstream: 'hexgrad/Kokoro-82M',
  licence: 'Apache-2.0',
  sampleRate: 24000,
  maxTokens: 510, // phoneme tokens per request, including the two padding tokens
  files: { 'config.json': 44, 'tokenizer.json': 3497, 'tokenizer_config.json': 113 },
  builds: {
    gpu: { device: 'webgpu', dtype: 'fp32', files: { 'onnx/model.onnx': 325532232 } },
    wasm: { device: 'wasm', dtype: 'q8', files: { 'onnx/model_quantized.onnx': 92361116 } },
  },
};

/** American English voices, best rated first (grades from the Kokoro model card). One 522 KB style file each. */
export const VOICES = {
  af_heart: 'Heart (female)',
  af_bella: 'Bella (female)',
  af_nicole: 'Nicole (female, soft)',
  am_fenrir: 'Fenrir (male)',
  am_michael: 'Michael (male)',
  am_puck: 'Puck (male)',
};
export const DEFAULT_VOICE = 'af_heart';
const VOICE_BYTES = 522240;
export const voiceFile = id => `voices/${id}.bin`;

/**
 * Pronunciation dictionaries from misaki (hexgrad, Apache-2.0), Kokoro's own text-to-phoneme library:
 * about 180,000 American English words written in the phonemes Kokoro was trained on.
 */
export const LEXICON = {
  label: 'misaki pronunciation dictionaries',
  repo: 'datasets/hexgrad/misaki',
  revision: '7a6093fd11124188077f2dc16397cc465466d59a',
  licence: 'Apache-2.0',
  files: { 'us_gold.json': 3001196, 'us_silver.json': 3105352 },
};

/**
 * For words the dictionaries don't have: a 3 MB letters-to-phonemes model (BART, one layer), trained by
 * Peter Reid for misaki (PeterReid/graphemes_to_phonemes_en_us, Apache-2.0), in an ONNX export.
 */
export const LETTERS_TO_SOUNDS = {
  label: 'letters-to-sounds model',
  repo: 'konecth/graphemes_to_phonemes_en_us_onnx',
  revision: '8b1b23a6cc963e228bd5ae599a9b3043658288b6',
  upstream: 'PeterReid/graphemes_to_phonemes_en_us',
  licence: 'Apache-2.0',
  files: { 'onnx/encoder_model.onnx': 1414890, 'onnx/decoder_model.onnx': 1750816 },
  // From the model's config.json: token i is character i of these strings (0–3 are special tokens).
  graphemes: "____AIOWYbdfhijklmnpstuvwz'-.BCDEFGHJKLMNPQRSTUVXZacegoqrxy",
  phonemes: '____AIOWYbdfhijklmnpstuvwzæðŋɑɔəɛɜɡɪɹɾʃʊʌʒʔʤʧˈˌθᵊᵻ',
};

/**
 * Whisper (OpenAI, Apache-2.0 weights), ONNX exports run by Transformers.js with 8-bit weights. They
 * recognise about 100 languages and can translate into English. Input is 16 kHz mono.
 */
const WHISPER_SHARED = { 'config.json': 2243, 'generation_config.json': 3832, 'preprocessor_config.json': 339, 'tokenizer.json': 2480466, 'tokenizer_config.json': 282682 };
const Q8 = { device: 'wasm', dtype: 'q8' };
export const WHISPER_MODELS = {
  'whisper-base': {
    key: 'whisper-base',
    label: 'Whisper Base',
    repo: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    upstream: 'openai/whisper-base',
    licence: 'Apache-2.0',
    summary: 'Fast. Good for clear speech.',
    files: WHISPER_SHARED,
    builds: {
      gpu: { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, files: { 'onnx/encoder_model.onnx': 82468078, 'onnx/decoder_model_merged_q4.onnx': 123602419 } },
      wasm: { ...Q8, files: { 'onnx/encoder_model_quantized.onnx': 23201314, 'onnx/decoder_model_merged_quantized.onnx': 53693315 } },
    },
  },
  'whisper-small': {
    key: 'whisper-small',
    label: 'Whisper Small',
    repo: 'onnx-community/whisper-small',
    revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    upstream: 'openai/whisper-small',
    licence: 'Apache-2.0',
    summary: 'More accurate, especially with accents, noise and languages other than English; about twice as slow.',
    files: { ...WHISPER_SHARED, 'config.json': 2227, 'generation_config.json': 3893, 'tokenizer_config.json': 282683 },
    // Only the WebAssembly build: its 8-bit weights were slower on WebGPU, and the fast build would be 590 MB.
    builds: { wasm: { ...Q8, files: { 'onnx/encoder_model_quantized.onnx': 92326160, 'onnx/decoder_model_merged_quantized.onnx': 156750845 } } },
  },
};
export const DEFAULT_WHISPER = 'whisper-base';
export const WHISPER_SAMPLE_RATE = 16000;

/** Languages offered for transcription (Whisper's best-supported ones), by the code Whisper uses. */
export const TRANSCRIBE_LANGUAGES = {
  Arabic: 'ar', Chinese: 'zh', Czech: 'cs', Dutch: 'nl', English: 'en', French: 'fr', German: 'de', Hindi: 'hi', Indonesian: 'id',
  Italian: 'it', Japanese: 'ja', Korean: 'ko', Polish: 'pl', Portuguese: 'pt', Russian: 'ru', Spanish: 'es', Swedish: 'sv', Turkish: 'tr', Ukrainian: 'uk', Vietnamese: 'vi',
};

const sum = object => Object.values(object).reduce((a, b) => a + b, 0);

/** The build to use: `gpu` when asked for and offered, else `wasm`. */
export const buildOf = (spec, build) => spec.builds[build] ? build : 'wasm';

/** Every file the voice needs, as {url: bytes}: Kokoro (one build), the voices, the dictionaries and the letters-to-sounds model. */
export function voiceDownload(build = 'wasm', voices = Object.keys(VOICES)) {
  const files = {};
  for (const [file, size] of Object.entries({ ...KOKORO.files, ...KOKORO.builds[buildOf(KOKORO, build)].files })) files[fileUrl(KOKORO.repo, KOKORO.revision, file)] = size;
  for (const id of voices) files[fileUrl(KOKORO.repo, KOKORO.revision, voiceFile(id))] = VOICE_BYTES;
  for (const spec of [LEXICON, LETTERS_TO_SOUNDS]) for (const [file, size] of Object.entries(spec.files)) files[fileUrl(spec.repo, spec.revision, file)] = size;
  return files;
}
/** Every file one build of a Whisper model needs, as {url: bytes}. */
export function whisperDownload(key = DEFAULT_WHISPER, build = 'wasm') {
  const model = WHISPER_MODELS[key] || WHISPER_MODELS[DEFAULT_WHISPER];
  const files = { ...model.files, ...model.builds[buildOf(model, build)].files };
  return Object.fromEntries(Object.entries(files).map(([file, size]) => [fileUrl(model.repo, model.revision, file), size]));
}
export const downloadSize = files => sum(files);

/** Repositories and the commit each is pinned to, for the workers' URL check and for cache clean-up. */
export const SPEECH_REPOS = [KOKORO, LEXICON, LETTERS_TO_SOUNDS, ...Object.values(WHISPER_MODELS)].map(({ repo, revision }) => ({ repo, revision }));
/** Every pinned speech file, {url: bytes}. The desktop app downloads only these for the page. */
export function speechFiles() {
  const all = {};
  for (const build of Object.keys(KOKORO.builds)) Object.assign(all, voiceDownload(build));
  for (const [key, model] of Object.entries(WHISPER_MODELS)) for (const build of Object.keys(model.builds)) Object.assign(all, whisperDownload(key, build));
  return Object.fromEntries(Object.entries(all).filter(([url]) => new URL(url).hostname === MODEL_HOST));
}
