import { parentPort, workerData } from 'node:worker_threads';
import { fromBuffer, type Entry } from 'yauzl';

const LIMIT = 40_000;
function decodeXml(text: string) {
  return text.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (match, code: string | undefined, entity: string) => {
    if (code) { const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code); return n>0&&n<=0x10ffff?String.fromCodePoint(n):''; }
    return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[entity.toLowerCase()] ?? match;
  });
}
async function docx(bytes: Buffer) {
  const xml = await new Promise<string>((resolve, reject) => {
    fromBuffer(bytes, {lazyEntries:true, validateEntrySizes:true, autoClose:true}, (error, zip) => {
      if (error || !zip) return reject(new Error('The DOCX archive could not be read.'));
      if (zip.entryCount > 1000) { zip.close(); return reject(new Error('This DOCX has too many entries.')); }
      let found=false;
      zip.on('error', () => reject(new Error('The DOCX archive is invalid.')));
      zip.on('end', () => { if (!found) reject(new Error('The file has no DOCX document body.')); });
      zip.on('entry', (entry: Entry) => {
        if (entry.fileName !== 'word/document.xml') { zip.readEntry(); return; }
        found=true;
        if (entry.isEncrypted() || entry.uncompressedSize > 2*1024*1024) { zip.close(); reject(new Error('The DOCX body exceeds the safe extraction limit.')); return; }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) { zip.close(); reject(new Error('The DOCX body could not be opened.')); return; }
          let size=0; const chunks:Buffer[]=[];
          stream.on('data', (chunk: Buffer) => { size+=chunk.length; if(size>2*1024*1024){stream.destroy(new Error('DOCX expansion limit exceeded.'));return;} chunks.push(chunk); });
          stream.on('error', () => {zip.close(); reject(new Error('The DOCX body exceeded its extraction limit.'));});
          stream.on('end', () => {zip.close(); resolve(Buffer.concat(chunks).toString('utf8'));});
        });
      });
      zip.readEntry();
    });
  });
  // Read Word's literal text nodes only. Relationships, images, macros, and external links are never executed.
  const text = xml.replace(/<\/w:p\s*>/g, '\n').replace(/<w:(?:tab|br)[^>]*\/>/g,'\t').split(/\n/).map(line => [...line.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match=>decodeXml(match[1])).join('')).join('\n').trim();
  return {text:text.slice(0,LIMIT), truncated:text.length>LIMIT};
}
async function parse() {
  const bytes=Buffer.from(workerData.bytes);
  if (workerData.kind === 'docx') return docx(bytes);
  const { PDFParse }=await import('pdf-parse');
  const parser=new PDFParse({data:new Uint8Array(bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:false,verbosity:0});
  try { const result=await parser.getText({first:60}); return {text:result.text.slice(0,LIMIT),truncated:result.text.length>LIMIT || result.total>60}; }
  finally { await parser.destroy(); }
}
parse().then(result=>parentPort?.postMessage({ok:true,...result}),()=>parentPort?.postMessage({ok:false,error:'This file could not be safely extracted. Use an unencrypted, text-based PDF or a valid DOCX.'}));
