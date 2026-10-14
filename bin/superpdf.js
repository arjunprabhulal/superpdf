#!/usr/bin/env node
import {readFile,writeFile,stat} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {PDFDocument} from 'pdf-lib';
import {inspectPdf,transformPdf,runPipeline} from '../lib/pdf-core.js';
import {cleanText,cleanValue} from '../contracts/untrusted.js';
import {plainMessage} from '../contracts/errors.js';

const help=`superPDF: PDF tools on your computer

Usage: superpdf <command> [options]   ·   superpdf help

superpdf info input.pdf
superpdf merge a.pdf b.pdf --output combined.pdf
superpdf extract input.pdf --pages 1,3-5 --output selected.pdf
superpdf rotate input.pdf --pages 2 --angle 90 --output rotated.pdf
superpdf pipeline input.pdf --steps operations.json --output result.pdf
superpdf export input.pdf --output input.md     (Markdown, HTML or JSON; --format, or from the extension)
superpdf export input.pdf --tables html         (Markdown with tables written as HTML, as in the HTML export)
superpdf convert report.docx --output report.pdf   (.docx .xlsx .pptx .odt .ods .odp; needs LibreOffice)
superpdf audio input.pdf --output input.m4a   (read aloud with the macOS system voice; --pages, --voice, --speed slower|faster)
superpdf mcp --allow-dir ~/Documents/PDFs   (MCP server for AI agents, over stdio)
superpdf serve --allow-dir ~/Documents/PDFs (HTTP API on 127.0.0.1:7341; superpdf serve --help)

Files are processed on this computer. Nothing is uploaded.
export reads scanned pages (no text layer) with superPDF OCR (English and 14 other languages, told from the page), as the app does; --no-ocr skips it.
audio uses macOS's built-in voice (say); list voices with: say -v '?'
convert uses LibreOffice on this computer (brew install --cask libreoffice); set SUPERPDF_SOFFICE to its soffice path if it isn't found.
Outputs must be new files; existing files are never overwritten.
Limits: none on file size or pages.
The MCP server and the HTTP API can only use files inside the --allow-dir folders.
`;
/**
 * Markdown as toMarkdown (lib/pdf-structure.js) writes it, with each table as the HTML export's table (colspans and
 * header rows kept), page by page.
 */
async function markdownHtmlTables(structure){
 const {blockMarkdown,tableHtml}=await import('../lib/pdf-structure.js');
 const out=[];
 for(const page of structure.pages){
  let previous=null;
  for(const block of page.blocks){const md=block.type==='table'?tableHtml(block):blockMarkdown(block);if(!md)continue;if(block.type==='list'&&previous==='list')out[out.length-1]+=`\n${md}`;else out.push(md);previous=block.type;}
  out.push(`<!-- end of page ${page.page} -->`);
 }
 return out.join('\n\n')+'\n';
}
/** Throws EEXIST when the output path is taken. Writes still use flag wx, so a file created meanwhile isn't overwritten. */
async function mustBeNew(path){
 try{await stat(path);}catch(error){if(error.code==='ENOENT')return;throw error;}
 throw Object.assign(new Error('exists'),{code:'EEXIST'});
}
const actions=new Set(['info','merge','extract','rotate','pipeline','export','convert','audio']);
if(process.argv[2]==='mcp'){
 // stdout belongs to the MCP protocol from here on; diagnostics go to stderr.
 const {main}=await import('../mcp/server.js');
 await main(process.argv.slice(3)).catch(error=>{process.stderr.write(`superPDF: ${error.message}\n`);process.exitCode=1;});
}
else if(process.argv[2]==='serve'){
 const {main}=await import('../api/server.js');
 await main(process.argv.slice(3)).catch(error=>{process.stderr.write(`superPDF: ${error.message}\n`);process.exitCode=1;});
}
else try {
 // pdf-lib prints parser warnings ("Invalid object ref: 2 0 R") for damaged files; the error below says it plainly.
 console.warn=()=>{};
 const options={help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'},output:{type:'string',short:'o'},pages:{type:'string'},angle:{type:'string'},steps:{type:'string'},format:{type:'string'},voice:{type:'string'},speed:{type:'string'},'no-ocr':{type:'boolean'},tables:{type:'string'}};
 // A value that starts with a dash and a digit ("--angle -90", "--pages -1") is the option's value, not another option.
 // Only for options that take a value; anywhere else ("--no-ocr -1.pdf") it is a file, passed on as ./-1.pdf.
 const takesValue=arg=>{const m=/^(?:--([a-z][\w-]*)|-([a-z]))$/i.exec(arg||'');return !!m&&(m[1]?options[m[1]]:Object.values(options).find(o=>o.short===m[2]))?.type==='string';};
 const args=process.argv.slice(2).flatMap((arg,i,all)=>/^-\d/.test(arg)?(takesValue(all[i-1])?[]:[`./${arg}`]):/^-\d/.test(all[i+1]||'')&&takesValue(arg)?[`${arg}=${all[i+1]}`]:[arg]);
 const {values,positionals}=parseArgs({args,allowPositionals:true,options});
 if(values.version||positionals[0]==='version'){process.stdout.write(`${JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version}\n`);}
 else if(values.help||!positionals.length||positionals[0]==='help'){process.stdout.write(help);process.exitCode=0;}
 else {
  const [action,...inputs]=positionals;
  if(!actions.has(action))throw new Error(`Unsupported command: ${action}. Run superpdf help.`);
  if(action==='merge'?inputs.length<2:inputs.length!==1)throw new Error(action==='merge'?'Provide at least two PDFs.':action==='convert'?'Provide exactly one Office file.':'Provide exactly one PDF.');
  if(action!=='info'&&action!=='export'&&!values.output)throw new Error('Provide --output with a new file path.');
  if(action==='extract'&&!values.pages?.trim())throw new Error('Provide --pages, such as 1,3-5.');
  if(action==='pipeline'&&!values.steps)throw new Error('Provide --steps with a JSON pipeline file.');
  const allowed={info:[],merge:['output'],extract:['output','pages'],rotate:['output','pages','angle'],pipeline:['output','steps'],convert:['output'],export:['output','format','pages','no-ocr','tables'],audio:['output','pages','voice','speed']}[action];
  for(const key of Object.keys(values))if(key!=='help'&&!allowed.includes(key))throw new Error(`--${key} does not apply to ${action}.`);
  if(action==='convert'){
   const {convertWithSoffice,officeExtension}=await import('../lib/soffice.js');
   const [file]=inputs;officeExtension(file);
   if(!/\.pdf$/i.test(values.output))throw new Error('Use an --output file name ending in .pdf.');
   const info=await stat(file);if(!info.isFile())throw new Error(`${file} isn’t a file.`);
   await mustBeNew(values.output);
   const result=await convertWithSoffice(await readFile(file),file);
   await writeFile(values.output,result,{flag:'wx'});
   process.stdout.write(JSON.stringify({operation:'convert',engine:'LibreOffice',output:values.output,pages:(await inspectPdf(result)).pages})+'\n');
  } else {
  // Before reading anything (audio checks it after its own options): an existing output would only fail after all the work.
  if(values.output&&action!=='audio')await mustBeNew(values.output);
  // Owner-only encryption is removed so the file can be read; a PDF that needs a password to open is refused.
  const {openWithoutPassword}=await import('../contracts/tools.js');
  const bytes=[];let pages=0;
  for(const file of inputs){const info=await stat(file);if(!info.isFile())throw new Error(`${file} isn’t a file. Provide a path to a PDF.`);let data=await readFile(file);if(!data.length)throw new Error(`${file} is empty (0 bytes), so it isn’t a PDF.`);data=await openWithoutPassword(new Uint8Array(data));const pdf=await PDFDocument.load(data).catch(error=>{throw Object.assign(new Error(`${file}: ${plainMessage(error)}`),{plain:true});});pages+=pdf.getPageCount();bytes.push(data);}
  // Metadata and page text are untrusted: printed without terminal controls or bidi overrides.
  if(action==='info')process.stdout.write(JSON.stringify(cleanValue(await inspectPdf(bytes[0])),null,2)+'\n');
  else if(action==='audio'){
   // Read aloud with macOS's own voice: text from the shared structure module, audio from `say` (lib/say.js).
   const {sayAvailable,sayToFile,readingText,RATES,UNAVAILABLE}=await import('../lib/say.js');
   if(!/\.m4a$/i.test(values.output))throw new Error('Use an --output file name ending in .m4a.');
   if(values.speed&&!(values.speed in RATES))throw new Error('Use --speed slower, normal or faster.');
   if(!await sayAvailable())throw new Error(UNAVAILABLE);
   await mustBeNew(values.output);
   const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
   const {extractStructure}=await import('../lib/pdf-structure.js');
   const {pageIndices}=await import('../lib/pdf-core.js');
   const {documentOptions}=await import('../lib/pdf-node.js');
   const task=pdfjs.getDocument(documentOptions(new Uint8Array(bytes[0])));
   try{
    const doc=await task.promise;
    const structure=await extractStructure(pdfjs,doc,{pages:pageIndices(values.pages||'',doc.numPages),images:false});
    const text=readingText(structure);
    if(!text.trim())throw new Error('There is no text to read on the chosen pages. If the PDF is scanned, run OCR PDF in superPDF first.');
    const audio=await sayToFile(text,{speed:values.speed||'normal',voice:values.voice||''});
    await writeFile(values.output,audio,{flag:'wx'});
    process.stdout.write(JSON.stringify({operation:'audio',engine:'macOS say',output:values.output,pages:structure.pages.length,characters:text.length})+'\n');
   }finally{await task.destroy();}
  }
  else if(action==='export'){
   // Markdown, HTML or JSON from the shared structure module; the format follows --format or the output extension.
   const byExt={'.md':'markdown','.markdown':'markdown','.html':'html','.htm':'html','.json':'json'};
   const ext=values.output?values.output.slice(values.output.lastIndexOf('.')).toLowerCase():'';
   const format=values.format||byExt[ext]||(values.output?null:'markdown');
   if(!['markdown','html','json'].includes(format))throw new Error('Use --format markdown, html or json, or an output ending in .md, .html or .json.');
   if(values.tables&&!['markdown','html'].includes(values.tables))throw new Error('Use --tables markdown or html.');
   if(values.tables&&format!=='markdown')throw new Error('--tables applies to Markdown.');
   const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
   const {extractStructure,buildPageIndex,toMarkdown,toHtml}=await import('../lib/pdf-structure.js');
   const {pageIndices}=await import('../lib/pdf-core.js');
   const {documentOptions,scannedPageReader}=await import('../lib/pdf-node.js');
   // superPDF OCR reads pages that have no text, as the app's exports do.
   const ocr=values['no-ocr']?null:scannedPageReader({progress:text=>process.stderr.write(`superPDF: ${text}\n`)});
   const task=pdfjs.getDocument(documentOptions(new Uint8Array(bytes[0])));
   try{
    const doc=await task.promise;
    if(ocr)ocr.documentLanguage=(await doc.getMetadata().catch(()=>({}))).info?.Language;
    const read=await extractStructure(pdfjs,doc,{pages:pageIndices(values.pages||'',doc.numPages),recognize:ocr&&((page,index,options)=>ocr.recognize(page,index,options))});
    if(ocr?.pages)process.stderr.write(`superPDF: ${ocr.pages===1?'1 scanned page was':`${ocr.pages} scanned pages were`} recognized with OCR (${(await import('../lib/ocr-languages.js')).languageOf(ocr.language).name}), so check ${ocr.pages===1?'its':'their'} text.\n`);
    if(ocr?.missed)process.stderr.write(`superPDF: OCR couldn’t read ${ocr.missed===1?'1 scanned page':`${ocr.missed} scanned pages`} (${plainMessage(ocr.failed)}), so ${ocr.missed===1?'it is':'they are'} left without text.\n`);
    const scanned=read.pages.filter(p=>!p.blocks.length).length;
    if(scanned)process.stderr.write(`superPDF: ${scanned} page${scanned===1?' has':'s have'} no text${ocr?', even after OCR':' layer (probably scanned). Run without --no-ocr to recognize '+(scanned===1?'it':'them')+' with superPDF OCR'}.\n`);
    const structure=cleanValue(read);
    const content=format==='html'?toHtml(structure):format==='json'?JSON.stringify({...structure,sections:cleanValue(await buildPageIndex(doc,structure))},null,2):values.tables==='html'?await markdownHtmlTables(structure):toMarkdown(structure);
    if(values.output){await writeFile(values.output,content,{flag:'wx'});process.stdout.write(JSON.stringify({operation:'export',format,output:values.output,pages:structure.pages.length})+'\n');}
    else process.stdout.write(content);
   }finally{await ocr?.close();await task.destroy();}
  }
  else {
   let result;
   if(action==='merge'){const out=await PDFDocument.create();for(const data of bytes){const source=await PDFDocument.load(data);for(const page of await out.copyPages(source,source.getPageIndices()))out.addPage(page);}result=await out.save();}
   else if(action==='pipeline'){const stepInfo=await stat(values.steps);if(stepInfo.size>64*1024)throw new Error('Pipeline JSON must be no larger than 64 KB.');let list;try{list=JSON.parse(await readFile(values.steps,'utf8'));}catch(error){if(error.code)throw error;throw new Error(`${values.steps} isn’t valid JSON. Write the steps as a JSON array, such as [{"action":"rotate","options":{"angle":90}}].`);}result=await runPipeline(bytes[0],list);}
   else result=await transformPdf(bytes[0],action,{pages:values.pages||'',angle:values.angle??90});
   await writeFile(values.output,result,{flag:'wx'});
   process.stdout.write(JSON.stringify({operation:action,output:values.output,pages:(await inspectPdf(result)).pages})+'\n');
  }
  }
 }
} catch(error){
 const message=error.code==='EEXIST'?'Output already exists. Choose a new file name.'
  // Inputs are checked with stat before anything is read; a write that can't open its path has no folder.
  :error.code==='ENOENT'?(error.syscall==='stat'?`No file at ${error.path}.`:`The folder for ${error.path} doesn’t exist.`)
  :error.code==='EISDIR'?`${error.path} is a folder. Provide a path to a file.`
  :error.code==='ERR_PARSE_ARGS_UNKNOWN_OPTION'?`${error.message.replace(/\. To specify .*$/s,'')}. Run superpdf help.`
  :error.plain?error.message:plainMessage(error);
 process.stderr.write(`superPDF: ${cleanText(message)}\n`);process.exitCode=1;
}
