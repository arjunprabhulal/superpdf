// Languages superPDF OCR reads besides English, and how a scanned document's language is told: from the English
// reading of its first scanned page (the common words of a Latin-script language, or a reading too poor to be
// English, which is then tried against the other scripts on a strip of the page). DOM-free: used by ocr.js in the
// browser and by tests and benchmark tooling in Node. Language data: Tesseract's tessdata_best models (Apache-2.0),
// as packaged by naptha's @tesseract.js-data (MIT), self-hosted under /ocr/lang/ and checked against the SHA-256
// below before use.

/**
 * code: Tesseract's; bytes: the gzipped download; sha256: of that download; unpacked: of the data inside it (a server
 * that sends the file with Content-Encoding: gzip has the browser unpack it on the way).
 */
export const OCR_LANGUAGES = [
  { code: 'eng', name: 'English', script: 'Latin', bytes: 2952873, sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91', unpacked: '5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747' },
  { code: 'deu', name: 'German', script: 'Latin', bytes: 1333102, sha256: '306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b', unpacked: 'a1b72cc25753eac167edfef5af4448a8dc34973503a2265c34c84520f896eb03' },
  { code: 'fra', name: 'French', script: 'Latin', bytes: 707406, sha256: 'd611139672b3752c7097e671e4a1d9209dfd37f2aeb081ef6487fba3351e9255', unpacked: 'bf83833fa957ff0076f6aa93f69e3bdf7b014dea829ea0c0d6be6b48a3ceef6d' },
  { code: 'spa', name: 'Spanish', script: 'Latin', bytes: 2100190, sha256: '40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb', unpacked: '0062377729b81cc268b1822f09eb1c08c09f3f7f1c6b422540b51555a7eeea70' },
  { code: 'ita', name: 'Italian', script: 'Latin', bytes: 1660998, sha256: 'f702fcfad297ce028ede3626d1467b67939f23ff23595f9badd54681cf25a4d3', unpacked: '36ec897f5f1f489b257801881286167a79b99a16040c6fbc7e3e30f03821b10b' },
  { code: 'por', name: 'Portuguese', script: 'Latin', bytes: 1392239, sha256: 'dacebc1386ddaaf8389f81094236cca0d690897cde693d48cbdaa881c86e2b4c', unpacked: '42fab1f017aedab69b92bdecc01bbb11166cd3b177575612ee860f8e2825ece0' },
  { code: 'pol', name: 'Polish', script: 'Latin', bytes: 2642356, sha256: 'a20fdec4ff99d8f8e84c708da3e42a4e935c26863055a0ed88aef5c66a59b91b', unpacked: '02b89cad819f1374631b4a3c92bdac79c214150f97a3686df78de6c8c30782db' },
  { code: 'rus', name: 'Russian', script: 'Cyrillic', bytes: 2679598, sha256: 'f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a', unpacked: 'eb9be824435f6bb0f993925acb85fd842c8418d6db7613c818e749e619a1ad6d' },
  { code: 'ukr', name: 'Ukrainian', script: 'Cyrillic', bytes: 2114206, sha256: 'ea2789a0ad99ff84bfd252a7410a1e8661a7bc5acaa41573d23b54b71446aa4c', unpacked: 'c9bceda0ec7f1cd8dc7642ec62221395066b98359fa0e988d5db82ceae727892' },
  { code: 'chi_sim', name: 'Chinese (Simplified)', script: 'Han', bytes: 1718768, sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c', unpacked: '9784f7c917c546424b690fcde708ce1f604a4393d08bb51ddab146d7d7c794e6' },
  { code: 'chi_tra', name: 'Chinese (Traditional)', script: 'Han', bytes: 1656239, sha256: '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743', unpacked: '6abfb87cce5db0d09624f16eedd8a0b24173718856121f721b6d1214193d4dab' },
  { code: 'jpn', name: 'Japanese', script: 'Japanese', bytes: 2030256, sha256: '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88', unpacked: '1a0175291ea145d4a66be681d1084496f10af938aacab247c5d40b31359a604e' },
  { code: 'kor', name: 'Korean', script: 'Hangul', bytes: 1572336, sha256: '78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126', unpacked: 'ec1749377d49ac38fb3d3cd05dd5e2a53359d329f359762bc638a81132109992' },
  { code: 'ara', name: 'Arabic', script: 'Arabic', bytes: 1661906, sha256: 'f4746c44b02342dd5b3d4f0198000f47d7c49f1a229e63e0f436c0592dcd9639', unpacked: 'e7d6494e2ef249ee97ad151eb01e0e6ae3aaf429256442ad6af534862a2a8c0f' },
  { code: 'hin', name: 'Hindi', script: 'Devanagari', bytes: 1389692, sha256: 'f3b6a0d320df38d886178cdd727b90dbf9df3db053adb32bd9cf73f0463cda07', unpacked: '187d00e09ac523b0e7c8c3edf93050ffc1caa8083674fd637f6a493178c5caff' },
];
export const languageOf = code => OCR_LANGUAGES.find(l => l.code === code) || null;

// Common words of three letters or more of each Latin-script language (as an English reading still spells them:
// accents may be lost or misread, so only words without them are listed), and of English for comparison.
const COMMON = {
  eng: 'the and that for with was this are from which have not were has been their they will would there',
  deu: 'der die und den das ist mit sich des nicht ein eine dem auf auch werden wird oder sind bei nach durch fur uber wurde zum zur vom als wie noch einer eines haben kann',
  fra: 'les des est une dans par pour sur pas qui aux sont avec cette leur nous vous elle mais ces ses tout sous comme aussi',
  spa: 'los las del por una con para como mas pero sus esta entre sobre fue son desde hasta cuando muy todo',
  ita: 'della che per con non sono gli nel alla delle dei una come anche dal sul questo degli nella questa essere stato tra',
  por: 'das dos uma com para nao mais como sua pelo foi entre seu esta pela pelos pelas seus suas foram ainda muito',
  pol: 'nie sie jest przez oraz dla tak jak ich jego lub czy przy ktory ktore dnia roku jako sprawie zgodnie tylko gdy ktorych byc moze takze jednak',
};
const COMMON_SETS = Object.fromEntries(Object.entries(COMMON).map(([code, words]) => [code, new Set(words.split(' '))]));

/** How many of an English reading's words are each language's common words, and how many words it has. */
function commonHits(text) {
  const words = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]+/g) || [];
  const hits = Object.fromEntries(Object.keys(COMMON_SETS).map(code => [code, 0]));
  for (const w of words) for (const [code, set] of Object.entries(COMMON_SETS)) if (set.has(w)) hits[code]++;
  const [[best, n], [, second]] = Object.entries(hits).filter(([code]) => code !== 'eng').sort((a, b) => b[1] - a[1]);
  return { words: words.length, hits, best, n, second };
}

/**
 * The Latin-script language of an English reading, when its common words are clearly another language's (at least
 * 6 of them, and three times as many as English ones); otherwise null (English, or too little to tell).
 */
export function latinLanguage(text) {
  const { words, hits, best, n, second } = commonHits(text);
  if (words < 20) return null;
  // Clearly one language: a language it isn't (Czech read as Polish) would only make the reading worse.
  return n >= 6 && n >= hits.eng * 3 && n >= second * 2 ? best : null;
}

/**
 * A Latin-script language an English reading may be in, too few of its common words to be sure (two or more, ahead
 * of every other language's and with no English ones): worth reading the page's main text in it to compare
 * (confirmsLanguage). Null otherwise.
 */
export function latinCandidate(text) {
  const { words, hits, best, n, second } = commonHits(text);
  return words >= 20 && n >= 2 && n > second && hits.eng === 0 && !latinLanguage(text) ? best : null;
}

/**
 * The block of a reading with the most words, as a rectangle of the picture (Tesseract's `rectangle`): the page's
 * main text, where two readings of it are compared. Null when the reading has no block with a box.
 */
export function mainTextArea(data) {
  let best = null, most = 0;
  for (const b of data?.blocks || []) {
    let n = 0;
    for (const p of b.paragraphs || []) for (const l of p.lines || []) n += (l.words || []).length;
    if (n > most && b.bbox) { most = n; best = b.bbox; }
  }
  return best && { left: Math.round(best.x0), top: Math.round(best.y0), width: Math.round(best.x1 - best.x0), height: Math.round(best.y1 - best.y0) };
}

/**
 * Where to try the other scripts on a page: the top of its main text (mainTextArea, 400 px at most, as each script is
 * read there) when that is an inch tall or more at 300 dpi, else a band across the middle of the page. Options for
 * the readers' page reading: `{ area }` or `{ strip: true }`.
 */
export function probePlace(data) {
  const area = mainTextArea(data);
  return area && area.height >= 300 ? { area: { ...area, height: Math.min(area.height, 400) } } : { strip: true };
}

/** A reading in another language that is clearly better than the English one of the same text (3 points or more). */
export const confirmsLanguage = (reading, english) => reading.words >= 10 && reading.confidence >= english.confidence + 3;

/**
 * The OCR language a PDF's /Lang names ("de-DE", "zh-Hant", "ja"), when superPDF OCR reads it; null otherwise.
 */
export function tagLanguage(tag) {
  const [primary, ...rest] = String(tag || '').toLowerCase().split(/[-_]/);
  const codes = { en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', pl: 'pol', ru: 'rus', uk: 'ukr', ja: 'jpn', ko: 'kor', ar: 'ara', hi: 'hin' };
  if (primary === 'zh') return rest.some(r => ['hant', 'tw', 'hk', 'mo'].includes(r)) ? 'chi_tra' : 'chi_sim';
  return codes[primary] || null;
}

/**
 * The language to read pictures on a page in, from the page's own text: its script (Cyrillic, Chinese, Japanese,
 * Korean, Arabic, Devanagari), or for Latin script its common words; English when nothing is clearer.
 */
export function textLanguage(text) {
  const s = String(text || '');
  const count = re => (s.match(re) || []).length;
  const latin = count(/[A-Za-z\u00C0-\u024F]/g);
  const scripts = [
    [count(/[\u3040-\u30FF]/g) * 3, 'jpn'], [count(/[\uAC00-\uD7AF]/g), 'kor'], [count(/[\u4E00-\u9FFF]/g), 'chi_sim'],
    [count(/[\u0400-\u04FF]/g), /[іїєґІЇЄҐ]/.test(s) ? 'ukr' : 'rus'], [count(/[\u0600-\u06FF]/g), 'ara'], [count(/[\u0900-\u097F]/g), 'hin'],
  ].sort((a, b) => b[0] - a[0]);
  const [n, code] = scripts[0];
  if (n >= 20 && n > latin) return code;
  return latinLanguage(s) || 'eng';
}

/** Mean confidence (0-100) of the words of a Tesseract reading (its `data` with blocks), and how many there are. */
export function readingConfidence(data) {
  let sum = 0, n = 0;
  for (const b of data?.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
    if (!w.text?.trim()) continue;
    sum += w.confidence; n++;
  }
  return { confidence: n ? sum / n : 0, words: n };
}

/**
 * A page read poorly (an old or faint scan, mean confidence 40 to 75 over eight words or more; below 40 it is mostly
 * handwriting, which a second reading rarely saves and which would take twice as long): worth reading again with
 * Sauvola's thresholding (Tesseract's thresholding_method 2), which sets the cut between ink and paper from each
 * pixel's surroundings, so stained or unevenly lit paper and faded print come out cleaner.
 */
export const readPoorly = data => { const { confidence, words } = readingConfidence(data); return words >= 8 && confidence >= 40 && confidence < 75; };

/** Of two readings of one page, the second when its words are read with higher confidence and few are lost. */
export function betterReading(first, second) {
  const a = readingConfidence(first), b = readingConfidence(second);
  return b.confidence > a.confidence && b.words >= a.words * 0.9 ? second : first;
}

/** Tesseract's setting for Sauvola's thresholding, and its default (Otsu's). */
export const SAUVOLA = { thresholding_method: '2' }, OTSU = { thresholding_method: '0' };

const HAN_KANA = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;

/**
 * A reading with the words of Chinese and Japanese runs joined: Tesseract splits them into words with spaces between,
 * which those scripts don't write. Two words of a line join when the end of one and the start of the next are Chinese
 * or Japanese characters (or their punctuation) and no more than about half a character apart (not across a gap
 * between columns); Korean, which is written with spaces, is left as it is.
 */
export function joinedHanKana(data) {
  if (!HAN_KANA.test(data?.text ?? readingText(data))) return data;
  const join = words => words.reduce((out, w) => {
    const last = out.at(-1);
    const close = last && w.bbox.x0 - last.bbox.x1 <= 0.6 * Math.max(last.bbox.y1 - last.bbox.y0, w.bbox.y1 - w.bbox.y0);
    if (close && HAN_KANA.test([...last.text].at(-1) || '') && HAN_KANA.test([...w.text][0] || '')) {
      out[out.length - 1] = { ...last, text: last.text + w.text, confidence: Math.min(last.confidence, w.confidence),
        bbox: { x0: Math.min(last.bbox.x0, w.bbox.x0), y0: Math.min(last.bbox.y0, w.bbox.y0), x1: Math.max(last.bbox.x1, w.bbox.x1), y1: Math.max(last.bbox.y1, w.bbox.y1) } };
    } else out.push(w);
    return out;
  }, []);
  return { ...data, blocks: (data.blocks || []).map(b => ({ ...b, paragraphs: (b.paragraphs || []).map(p => ({ ...p, lines: (p.lines || []).map(l => ({ ...l, words: join(l.words || []) })) })) })) };
}

// Signs that never sit inside a word of real text: a letter beside one of them is a glyph of a font whose text layer
// maps its letters to the wrong characters (legacy Hindi, Marathi or Gujarati fonts read as Latin-1).
const ODD_INSIDE = /[\p{L}\p{M}][$#{}~^`|¥©«»¾½¼§¶®±¤¢£µ¸¨¯°\\<>@=+*[\]][\p{L}\p{M}]/u;
const ODD_EDGE = /[\p{L}\p{M}][$#{}~^`|¥©«»¾½¼§¶®±¤¢£µ¸¨¯°\\<>@=+*]$|^[$#{}~^`|¥©«»¾½¼§¶®±¤¢£µ¸¨¯°\\<>@=+*][\p{L}\p{M}]/u;
const SUSPECT = /[\u0000-\u001f\u00a0-\u00ff$#{}~^`|\\<>@=+*[\]!%\u0900-\u0dff]/g;
const INDIC_BROKEN = /[\u0900-\u0dff][(\d)[\]!%]|[(\d)[\]!%][\u0900-\u0dff]/u;

/**
 * Text of a page's text layer that is garbled: a font whose characters map to the wrong letters, so the text reads
 * as signs and stray accented letters ("H¥$VrH$m`©H«$_mMr", "ý â ! C $") or control characters. Such a page is better
 * read with OCR. Needs 30 words or more to tell.
 */
export function garbledText(text) {
  const s = String(text || '');
  // Most pages have almost none of the characters garbled text is made of: they are let go at once.
  if ((s.match(SUSPECT) || []).length < s.length * 0.02) return false;
  const words = s.split(/\s+/).filter(t => t.length >= 2);
  if (words.length < 30) return false;
  const chars = [...s.replace(/\s/g, '')];
  const control = chars.filter(c => /[\u0000-\u001f]/.test(c)).length / chars.length;
  const signs = chars.filter(c => !/[\p{L}\p{M}\p{N}]/u.test(c)).length / chars.length;
  const latin1 = w => (w.match(/[\u00c0-\u00ff]/g) || []).length >= 2 && /[a-z]/i.test(w) && !/^\p{Lu}?[\p{Ll}\u00c0-\u00ff]+$/u.test(w);
  const odd = words.filter(w => ODD_INSIDE.test(w) || ODD_EDGE.test(w) || INDIC_BROKEN.test(w) || latin1(w)).length / words.length;
  // Plain words (lower case or capitalised, with a vowel): most of the words of real Latin-script text, and of code.
  const plain = words.filter(w => /^(\p{Lu}?\p{Ll}{2,}|\p{Lu}{3,})[.,;:]?$/u.test(w) && /[aeiouy\u00e0-\u00ff]/i.test(w)).length / words.length;
  return control >= 0.05 || (plain < 0.35 && (signs >= 0.4 || odd >= 0.3));
}

/** A reading of a whole page clear enough to stand in for its garbled text layer: mean confidence 65 or more. */
export const clearPage = data => { const { confidence, words } = readingConfidence(data); return words >= 10 && confidence >= 65; };

/** The words of a Tesseract reading (its `data` with blocks), one line per line. */
export function readingText(data) {
  const lines = [];
  for (const b of data?.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push((l.words || []).map(w => w.text).join(' '));
  return lines.join('\n');
}

/**
 * An English reading too poor to be English text: probably another script (or no text at all). A poor reading that
 * still has English common words all through it (3% of its words or more: an old or faint English scan) is English;
 * a few English words on a page of another script (a heading, a name) don't make it English.
 */
export function readingLooksForeign(data) {
  const { confidence, words } = readingConfidence(data);
  const { hits, words: all } = commonHits(readingText(data));
  return words >= 8 && confidence < 60 && !(hits.eng >= 3 && hits.eng >= all * 0.03);
}

/** The scripts tried, in turn, on a page whose English reading looks foreign. */
export const SCRIPT_PROBES = ['chi_sim', 'rus', 'jpn', 'kor', 'ara', 'hin'];

/**
 * The scripts to try on a page (each try costs a reading of part of it): all of them, the page's own script first,
 * when the page's text layer points away from Latin script (text in another script, or garbled text); otherwise the
 * two most common (Chinese, Cyrillic), so an old or handwritten scan that doesn't read as English costs little more.
 */
export function scriptProbes(text = '') {
  const own = textLanguage(text);
  if (SCRIPT_PROBES.includes(own)) return [own, ...SCRIPT_PROBES.filter(c => c !== own)];
  return garbledText(text) ? SCRIPT_PROBES : SCRIPT_PROBES.slice(0, 2);
}

/**
 * The language whose reading of the probed text is clearly the best: at least 70 mean confidence and 15 points above
 * the English reading, or, on a hard page (an old scan), at least 55 and 30 points above it; eight words or more
 * read. `results`: [{code, confidence, words}].
 */
export function bestProbe(results, english) {
  const best = results.filter(r => r.words >= 8).sort((a, b) => b.confidence - a.confidence)[0];
  if (!best) return null;
  return (best.confidence >= 70 && best.confidence >= english + 15) || (best.confidence >= 55 && best.confidence >= english + 30) ? best.code : null;
}

/** SHA-256 of bytes, hex (Web Crypto: browsers and Node). */
export async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A downloaded language pack, checked: its bytes when they are the published file (or the data inside it, when the
 * server sent it compressed and the browser unpacked it), else an error.
 */
export async function verifiedPack(code, bytes) {
  const lang = languageOf(code);
  if (!lang) throw new Error(`No language data for ${code}.`);
  const packed = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (await sha256(bytes) !== (packed ? lang.sha256 : lang.unpacked)) throw new Error(`The ${lang.name} language data didn't download correctly. Try again.`);
  return bytes;
}
