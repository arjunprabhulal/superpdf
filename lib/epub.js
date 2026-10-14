// PDF text → EPUB 3. Takes the per-page text that extractText (browser-pdf.js) returns, rebuilds paragraphs,
// splits chapters by page count or by detected chapter headings and packages the book with fflate. No DOM.
import { zipSync, strToU8, strFromU8 } from 'fflate';
import { unzipLimited } from './unzip.js';
import { pageLines, paragraphs, continues, joinContinued, escapeXml } from './pdf-paragraphs.js';

const NUMBER = '(\\d{1,3}|[ivxlcdm]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[- ]\\w+)?|thirty(?:[- ]\\w+)?)';
const NUMBERED = new RegExp(`^(chapter|part|book)\\s+${NUMBER}\\b\\.?(\\s*[:.\\-–—]?\\s*\\S.*)?$`, 'i');
const NAMED = /^(prologue|epilogue|introduction|preface|foreword|afterword|appendix(\s+[a-z0-9]{1,3})?|conclusion|acknowledg(e)?ments)(\s*[:.\-–—]\s*\S.*)?$/i;

/** A line that looks like a chapter heading: "Chapter 3", "PART TWO: The Return", "Prologue". */
export function isChapterHeading(line) {
  if (line.length > 60 || /[,;]$|\.{3,}|…/.test(line)) return false;
  // A trailing page number after a title ("Chapter 3 The Return 47") marks a table-of-contents line.
  const numbered = line.match(NUMBERED);
  // A title after the number must start with a separator or a capital ("Part one of the plan" is prose).
  if (numbered) return !numbered[3] || (/^\s*([:.\-–—]|\p{Lu}|["“‘'])/u.test(numbered[3]) && !/\s\d{1,4}$/.test(numbered[3]));
  const named = line.match(NAMED);
  return !!named && !(named[4] && /\s\d{1,4}$/.test(named[4]));
}

/**
 * Split pages into chapters.
 * @param {{page: number, text: string}[]} pages
 * @param {{split?: 'headings'|'pages', pagesPerChapter?: number}} options
 * @returns {{chapters: {title: string, heading: boolean, paragraphs: {text: string}[]}[], split: 'headings'|'pages', emptyPages: number}}
 */
export function chapterize(pages, { split = 'headings', pagesPerChapter = 10 } = {}) {
  const perPage = pages.map(p => ({ page: p.page, lines: pageLines(p.text) }));
  const emptyPages = perPage.filter(p => !p.lines.length).length;
  if (emptyPages === perPage.length) throw new Error('This PDF has no readable text layer. Run OCR PDF first, then convert the result.');

  if (split === 'headings') {
    // Pages with three or more heading-like lines are tables of contents, not chapter starts.
    const headingPages = perPage.map(p => p.lines.filter(isChapterHeading).length < 3);
    const chapters = [];
    let current = null;
    perPage.forEach((p, i) => {
      const lines = [...p.lines], headings = new Set(), full = Math.max(...lines.map(l => l.length));
      if (headingPages[i]) for (let n = 0; n < lines.length; n++) {
        if (!isChapterHeading(lines[n])) continue;
        // "Chapter 3" followed by a short capitalised title line becomes "Chapter 3: Title".
        const next = lines[n + 1];
        if (/^(chapter|part|book)\s+\S+\.?$/i.test(lines[n]) && next && next.length <= Math.min(60, full * 0.75) && /^[\p{Lu}"“‘']/u.test(next) && !/[.,;:!?]$/.test(next) && !isChapterHeading(next)) lines.splice(n, 2, `${lines[n].replace(/\.$/, '')}: ${next}`);
        headings.add(lines[n]);
      }
      paragraphs(lines, { isBreak: line => headings.has(line) }).forEach((para, n) => {
        if (para.heading) {
          // A running head that repeats the current chapter's title doesn't start a new chapter.
          if (current?.heading && current.title.toLowerCase().startsWith(para.text.toLowerCase())) return;
          current = { title: para.text, heading: true, paragraphs: [] };
          chapters.push(current);
          return;
        }
        if (!current) { current = { title: 'Opening pages', heading: false, paragraphs: [] }; chapters.push(current); }
        const last = current.paragraphs[current.paragraphs.length - 1];
        if (n === 0 && continues(last, para)) joinContinued(last, para);
        else current.paragraphs.push(para);
      });
    });
    const found = chapters.filter(c => c.heading).length;
    if (found >= 2) return { chapters: chapters.filter(c => c.paragraphs.length || c.heading), split: 'headings', emptyPages };
  }

  const size = Math.max(1, Math.floor(pagesPerChapter) || 10), chapters = [];
  for (let i = 0; i < perPage.length; i += size) {
    const group = perPage.slice(i, i + size), chapter = { title: '', heading: false, paragraphs: [] };
    for (const p of group) {
      paragraphs(p.lines).forEach((para, n) => {
        const last = chapter.paragraphs[chapter.paragraphs.length - 1];
        if (n === 0 && continues(last, para)) joinContinued(last, para); else chapter.paragraphs.push(para);
      });
    }
    const first = group[0].page, end = group[group.length - 1].page;
    chapter.title = first === end ? `Page ${first}` : `Pages ${first}–${end}`;
    if (chapter.paragraphs.length) chapters.push(chapter);
  }
  return { chapters, split: 'pages', emptyPages };
}

const xhtml = (title, body, lang) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>
`;

const CSS = `body { font-family: serif; line-height: 1.5; margin: 0 5%; }
h1 { font-size: 1.5em; margin: 1.5em 0 1em; text-align: center; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
h1 + p, p.first { text-indent: 0; }
nav ol { list-style: none; padding-left: 0; }
`;

/**
 * Build an EPUB 3 file.
 * @param {{page: number, text: string}[]} pages  per-page text from extractText
 * @param {{title?: string, author?: string, language?: string, split?: 'headings'|'pages', pagesPerChapter?: number, id?: string, modified?: Date}} options
 * @returns {{bytes: Uint8Array, chapters: number, split: 'headings'|'pages', emptyPages: number}}
 */
export function pagesToEpub(pages, { title = 'Untitled', author = '', language = 'en', split, pagesPerChapter, id = globalThis.crypto.randomUUID(), modified = new Date() } = {}) {
  const book = chapterize(pages, { split, pagesPerChapter });
  const lang = escapeXml(language);
  const files = book.chapters.map((chapter, i) => {
    // Detected headings are shown; page-range titles ("Pages 1–10") only appear in the table of contents.
    const body = `<section epub:type="chapter">\n${chapter.heading ? `<h1>${escapeXml(chapter.title)}</h1>\n` : ''}`
      + chapter.paragraphs.map((p, n) => `<p${n === 0 && !chapter.heading ? ' class="first"' : ''}>${escapeXml(p.text)}</p>`).join('\n') + '\n</section>';
    return { name: `chapter-${i + 1}.xhtml`, title: chapter.title, content: xhtml(chapter.title, body, lang) };
  });
  const stamp = modified.toISOString().replace(/\.\d+Z$/, 'Z');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${escapeXml(id)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${lang}</dc:language>
${author ? `    <dc:creator>${escapeXml(author)}</dc:creator>\n` : ''}    <meta property="dcterms:modified">${stamp}</meta>
    <meta name="generator" content="superPDF"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${files.map((f, i) => `    <item id="c${i + 1}" href="${f.name}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine toc="ncx">
${files.map((f, i) => `    <itemref idref="c${i + 1}"/>`).join('\n')}
  </spine>
</package>
`;
  const nav = xhtml(title, `<nav epub:type="toc" id="toc">\n<h1>Contents</h1>\n<ol>\n${files.map(f => `<li><a href="${f.name}">${escapeXml(f.title)}</a></li>`).join('\n')}\n</ol>\n</nav>`, lang);
  // toc.ncx is for EPUB 2 readers; EPUB 3 readers use nav.xhtml.
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${escapeXml(id)}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
${files.map((f, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(f.title)}</text></navLabel><content src="${f.name}"/></navPoint>`).join('\n')}
</navMap>
</ncx>
`;
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;
  const mtime = modified;
  // Key order is entry order: mimetype must be first and stored (level 0) with no extra field.
  const entries = {
    mimetype: [strToU8('application/epub+zip'), { level: 0, mtime }],
    'META-INF/container.xml': [strToU8(container), { mtime }],
    'OEBPS/content.opf': [strToU8(opf), { mtime }],
    'OEBPS/nav.xhtml': [strToU8(nav), { mtime }],
    'OEBPS/toc.ncx': [strToU8(ncx), { mtime }],
    'OEBPS/style.css': [strToU8(CSS), { mtime }],
  };
  for (const f of files) entries[`OEBPS/${f.name}`] = [strToU8(f.content), { mtime }];
  const bytes = zipSync(entries, { level: 6 });
  validateEpub(bytes);
  return { bytes, chapters: files.length, split: book.split, emptyPages: book.emptyPages };
}

/**
 * Check the parts of the EPUB container that readers depend on. Throws with a description of the first problem.
 * @returns {string[]} entry names in zip order
 */
export function validateEpub(bytes) {
  const fail = why => { throw new Error(`The EPUB file is not valid: ${why}`); };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) fail('not a zip file.');
  const nameLength = view.getUint16(26, true), extraLength = view.getUint16(28, true);
  if (strFromU8(bytes.subarray(30, 30 + nameLength)) !== 'mimetype') fail('mimetype is not the first entry.');
  if (view.getUint16(8, true) !== 0) fail('mimetype is compressed.');
  if (extraLength !== 0) fail('mimetype has an extra field.');
  if (strFromU8(bytes.subarray(30 + nameLength, 30 + nameLength + 20)) !== 'application/epub+zip') fail('wrong mimetype content.');
  const files = unzipLimited(bytes), names = [...files.keys()];
  const text = name => files.has(name) ? strFromU8(files.get(name)) : fail(`${name} is missing.`);
  const opfPath = text('META-INF/container.xml').match(/full-path="([^"]+)"/)?.[1] || fail('container.xml has no rootfile.');
  const opf = text(opfPath), base = opfPath.replace(/[^/]*$/, '');
  if (!/<package[^>]+version="3\.0"/.test(opf)) fail('the package document is not EPUB 3.');
  for (const tag of ['dc:identifier', 'dc:title', 'dc:language']) if (!opf.includes(`<${tag}`)) fail(`${tag} is missing.`);
  if (!/property="dcterms:modified"/.test(opf)) fail('dcterms:modified is missing.');
  const items = [...opf.matchAll(/<item\s+id="([^"]+)"\s+href="([^"]+)"[^>]*?(properties="([^"]+)")?\/>/g)];
  const ids = new Set(items.map(m => m[1]));
  for (const [, , href] of items) if (!files.has(base + href)) fail(`${href} is listed but missing.`);
  if (!items.some(m => m[4]?.split(' ').includes('nav'))) fail('there is no navigation document.');
  const spine = [...opf.matchAll(/<itemref\s+idref="([^"]+)"/g)].map(m => m[1]);
  if (!spine.length) fail('the reading order is empty.');
  for (const idref of spine) if (!ids.has(idref)) fail(`reading order refers to unknown item ${idref}.`);
  return names;
}
