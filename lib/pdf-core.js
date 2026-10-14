import { PDFDocument, StandardFonts, degrees, rgb, PDFName, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFButton, PDFSignature } from 'pdf-lib';

/** Readable form field type that survives minification (class names don't). */
export function fieldType(field) {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'list';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFSignature) return 'signature';
  return 'other';
}

export function pageIndices(value, count) {
  if (!value.trim()) return Array.from({ length: count }, (_, i) => i);
  const result = [];
  for (const segment of value.split(',')) {
    const match = segment.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('Use page numbers or ranges, such as 1, 3-5.');
    const first = Number(match[1]), last = Number(match[2] || first);
    if (last < first) throw new Error(`Write each page range from low to high, such as ${last}-${first}.`);
    if (first < 1 || last > count || last < first) throw new Error(`Page ranges must be between 1 and ${count}.`);
    for (let i = first; i <= last; i++) if (!result.includes(i - 1)) result.push(i - 1);
  }
  return result;
}
export function numberOption(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return n;
}
// The tool form parses each chosen PDF to check its page count (countPages). That parsed document is
// handed to the next function here that opens the same bytes, once, so a run doesn't parse the file twice.
const parsed = new WeakMap(), encrypted = new WeakSet();
/** Page count for the form's page checks, or null when pdf-lib can't read the file (the tool reports that). */
export async function countPages(bytes) {
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    // An encrypted file isn't handed on: open() refuses it, as PDFDocument.load does.
    if (pdf.isEncrypted) encrypted.add(bytes); else parsed.set(bytes, pdf);
    return pdf.getPageCount();
  } catch { return null; }
}
/** True when countPages() found `bytes` encrypted. open() can't read them; qpdf.js decryptOwnerOnly() can, when only an owner password is set. */
export const isEncrypted = bytes => encrypted.has(bytes);
async function open(bytes, options) {
  const pdf = parsed.get(bytes);
  parsed.delete(bytes);
  return (!options && pdf) || PDFDocument.load(bytes, options);
}
/** `options.updateMetadata: false` leaves the producer and dates as they are (PDF agents, after properties were removed). */
export async function transformPdf(bytes, action, options = {}) {
  const pdf = await open(bytes, options.updateMetadata === false ? { updateMetadata: false } : undefined);
  const indices = pageIndices(options.pages || '', pdf.getPageCount());
  const chosen = indices.map(i => pdf.getPage(i));
  if (action === 'extract' || action === 'reorder') {
    const out = await PDFDocument.create();
    for (const page of await out.copyPages(pdf, indices)) out.addPage(page);
    return out.save();
  }
  if (action === 'remove') {
    if (indices.length === pdf.getPageCount()) throw new Error('Keep at least one page.');
    [...indices].sort((a,b) => b-a).forEach(i => pdf.removePage(i));
  } else if (action === 'rotate') {
    const angle = numberOption(options.angle ?? 90, 0, 270, 'Rotation');
    if (angle % 90) throw new Error('Rotation must be a multiple of 90 degrees.');
    chosen.forEach(p => p.setRotation(degrees((p.getRotation().angle + angle) % 360)));
  } else if (action === 'crop') {
    const margin = numberOption(options.margin ?? 24, 0, 500, 'Margin');
    chosen.forEach(p => { const box=p.getCropBox(); if (margin*2>=Math.min(box.width,box.height)) throw new Error('Margin is larger than the page.'); p.setCropBox(box.x+margin,box.y+margin,box.width-2*margin,box.height-2*margin); });
  } else if (action === 'scale') {
    const factor = numberOption(options.factor ?? 1, .1, 4, 'Scale');
    chosen.forEach(p => p.scale(factor, factor));
  } else if (action === 'flatten') {
    pdf.getForm().flatten();
  } else if (action === 'labels' || action === 'watermark' || action === 'annotate') {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const text=String(options.text || '');
    if (/[^\x20-\x7e\u00a0-\u00ff\n]/.test(text)) throw new Error('This text tool currently supports Latin characters.');
    for (const i of indices) {
      const p=pdf.getPage(i), {width,height}=p.getSize();
      if (action==='watermark') {
        if (!text) throw new Error('Enter watermark text.');
        p.drawText(text,{x:width*.12,y:height*.4,size:Math.min(48,width/Math.max(text.length,1)),font,color:rgb(.4,.4,.4),opacity:.2,rotate:degrees(35)});
      } else if (action==='annotate') {
        p.drawText(text,{x:numberOption(options.x ?? 36,0,width,'X'),y:numberOption(options.y ?? 36,0,height,'Y'),size:numberOption(options.size ?? 12,6,72,'Font size'),font,color:rgb(.1,.1,.1)});
      } else {
        const label=text.replaceAll('{page}',String(i+1)).replaceAll('{total}',String(pdf.getPageCount()));
        const x=(width-font.widthOfTextAtSize(label,10))/2;
        p.drawText(label,{x:Math.max(0,x),y:options.position==='top'?height-24:18,size:10,font,color:rgb(.25,.25,.25)});
      }
    }
  } else if (action === 'metadata-clear') {
    pdf.setTitle('');pdf.setAuthor('');pdf.setSubject('');pdf.setKeywords([]);pdf.setCreator('');pdf.setProducer('');
    pdf.catalog.delete(PDFName.of('Metadata'));
  } else if (action === 'fill') {
    const form=pdf.getForm();let values;
    try { values=JSON.parse(options.values||'{}'); } catch { throw new Error('Form values must be a JSON object.'); }
    if (!values || Array.isArray(values) || typeof values!=='object') throw new Error('Form values must be a JSON object.');
    for(const [name,value] of Object.entries(values)){
      // instanceof, not constructor.name: production builds minify class names.
      let field;try{field=form.getField(name);}catch{throw new Error(`There's no form field named ${name}.`);}
      if(field instanceof PDFTextField)field.setText(String(value));
      else if(field instanceof PDFCheckBox){if(typeof value!=='boolean')throw new Error(`${name} requires true or false.`);value?field.check():field.uncheck();}
      else if(field instanceof PDFDropdown||field instanceof PDFOptionList||field instanceof PDFRadioGroup)field.select(value);
      else throw new Error(`${name} is not an editable supported field.`);
    }
  }
  return pdf.save();
}
/** Split into several PDFs: one per comma-separated range (mode 'ranges') or one per page (mode 'pages'). */
export async function splitPdf(bytes, options = {}) {
  const pdf = await open(bytes);
  const count = pdf.getPageCount();
  const spec = (options.pages || '').trim();
  const parts = options.mode === 'pages' || !spec
    ? pageIndices(spec, count).map(i => [i])
    // An empty part ("1,,2", a trailing comma) is skipped; pageIndices would read it as every page.
    : spec.split(',').filter(segment => segment.trim()).map(segment => pageIndices(segment, count));
  if (parts.length < 2) throw new Error('Choose at least two ranges or pages to split into separate files.');
  const files = [];
  for (const indices of parts) {
    const out = await PDFDocument.create();
    for (const page of await out.copyPages(pdf, indices)) out.addPage(page);
    const first = indices[0] + 1, last = indices[indices.length - 1] + 1;
    const file = { name: first === last ? `page-${first}` : `pages-${first}-${last}`, bytes: await out.save() };
    if (options.each) options.each(file, parts.length); else files.push(file);
  }
  // With `each(file, total)`, every file is handed over as it is made instead of kept, and the count is returned.
  return options.each ? parts.length : files;
}
/**
 * Add an invisible, searchable text layer from OCR results without changing how pages look.
 * `pages`: [{ index, words: [{ text, x, y, width, height, angle }] }] in PDF points, where (x, y) is
 * the word's bottom-left corner and `angle` the baseline direction in degrees.
 * Characters the standard font can't encode (outside Windows-1252) are skipped.
 */
export async function addTextLayer(bytes, pages) {
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const encodable = new Map();
  const canEncode = ch => {
    if (!encodable.has(ch)) { try { font.encodeText(ch); encodable.set(ch, true); } catch { encodable.set(ch, false); } }
    return encodable.get(ch);
  };
  let added = 0;
  for (const { index, words } of pages) {
    const page = pdf.getPage(index);
    for (const word of words) {
      const text = [...(word.text || '')].filter(canEncode).join('').trim();
      if (!text || !(word.width > 0) || !(word.height > 0)) continue;
      const natural = font.widthOfTextAtSize(text, word.height);
      const size = Math.max(1, Math.min(word.height, word.height * word.width / natural));
      page.drawText(text, { x: word.x, y: word.y, size, font, opacity: 0, rotate: degrees(word.angle || 0) });
      added++;
    }
  }
  return { bytes: await pdf.save(), words: added };
}
export async function inspectPdf(bytes) {
  // updateMetadata off: otherwise pdf-lib stamps its own Producer and dates before they are read.
  const pdf=await open(bytes,{updateMetadata:false});
  return {pages:pdf.getPageCount(),title:pdf.getTitle()||'',author:pdf.getAuthor()||'',subject:pdf.getSubject()||'',keywords:pdf.getKeywords()||'',creator:pdf.getCreator()||'',producer:pdf.getProducer()||'',forms:pdf.getForm().getFields().map(f=>({name:f.getName(),type:fieldType(f)})),dimensions:pdf.getPages().map((p,i)=>({page:i+1,...p.getSize(),rotation:p.getRotation().angle}))};
}
export async function createTextPdf(text, title = 'Document') {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  if (/[^\x20-\x7e\u00a0-\u00ff\n\r\t]/.test(text+title)) throw new Error('The local text generator currently supports Latin characters.');
  pdf.setTitle(title);let page,y;
  const next=()=>{page=pdf.addPage([595,842]);y=790;};next();
  for(const paragraph of text.split('\n')){
    let line='';
    for(const word of paragraph.split(/\s+/)){
      if(font.widthOfTextAtSize(word,11)>490)throw new Error('A word is too long to fit the page.');
      if(font.widthOfTextAtSize((line?line+' ':'')+word,11)>490){if(y<50)next();page.drawText(line,{x:50,y,size:11,font});y-=17;line=word;}else line+=(line?' ':'')+word;
    }
    if(y<50)next();page.drawText(line,{x:50,y,size:11,font});y-=23;
  }
  return pdf.save();
}
/** Whether bytes are a PNG or JPEG image: 'png', 'jpeg' or null. */
export function imageKind(bytes) {
  const b = bytes || [];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return null;
}
/**
 * A PNG or JPEG image (a photo or scan of a page) as a one-page PDF the size of the image at 150 dpi, so the readers
 * open it like a scanned page and recognize its text. Returns the PDF bytes.
 */
export async function imagePagePdf(bytes) {
  const kind = imageKind(bytes);
  if (!kind) throw new Error('This image couldn’t be read. It may be damaged, or not really a JPG or PNG file.');
  const pdf = await PDFDocument.create();
  const image = kind === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const width = image.width * 72 / 150, height = image.height * 72 / 150;
  pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  return pdf.save();
}
export async function runPipeline(bytes,steps){
 if(!Array.isArray(steps)||steps.length<1||steps.length>10)throw new Error('A pipeline needs 1–10 steps.');
 const allowed=['extract','remove','rotate','crop','scale','flatten','labels','watermark','metadata-clear'];
 let current=bytes;
 for(const step of steps){if(!allowed.includes(step.action))throw new Error(`Unsupported pipeline step: ${step.action}`);current=await transformPdf(current,step.action,step.options||{});}
 return current;
}
