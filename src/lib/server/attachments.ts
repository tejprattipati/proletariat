import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { ActionResult, Attachment, WorkspaceState } from '../types';
import { attachToConversation, requireConversation } from './conversations';

export const MAX_UPLOAD_BYTES=5*1024*1024;
let parsing=0;
async function parseBinary(bytes: Uint8Array, kind:'pdf'|'docx'): Promise<{text:string;truncated:boolean}> {
  if(bytes.length>MAX_UPLOAD_BYTES) throw new Error('Files must be at most 5 MiB.');
  if(parsing>=2) throw new Error('Two files are being extracted. Try again shortly.');
  parsing++;
  try { return await new Promise((resolve,reject)=>{
    // Node 24's newer V8/parser initialization exceeds 128 MiB even for a tiny PDF.
    const worker=new Worker(new URL('./parse-worker.ts',import.meta.url),{workerData:{bytes,kind},execArgv:['--import','tsx'],resourceLimits:{maxOldGenerationSizeMb:256}});
    let settled=false;
    const finish=(error?:Error,result?:{text:string;truncated:boolean})=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result!);};
    const timer=setTimeout(()=>{void worker.terminate();finish(new Error('Extraction exceeded 15 seconds. Try a smaller document.'));},15000);
    worker.once('message',result=>finish(result.ok?undefined:new Error(result.error),result));
    worker.once('error',(error:Error&{code?:string})=>{
      const code=typeof error.code==='string'&&/^ERR_[A-Z_]+$/.test(error.code)?error.code:'WORKER_ERROR';
      finish(new Error(code==='ERR_WORKER_OUT_OF_MEMORY'?'File extraction exceeded the safe memory limit.':`File extraction worker could not start (${code}).`));
    });
    worker.once('exit',code=>{if(!settled)finish(new Error(`File extraction ended without a result (${code}).`));});
  }); } finally {parsing--;}
}
export async function extractPdfText(bytes: Uint8Array) {
  if(Buffer.from(bytes.slice(0,5)).toString()!=='%PDF-')throw new Error('The file is not a PDF.');
  return parseBinary(bytes,'pdf');
}
export async function extractUpload(bytes: Buffer,name: string): Promise<{text:string;truncated:boolean;mimeType:string}> {
  if(!bytes.length || bytes.length>MAX_UPLOAD_BYTES)throw new Error('Choose a nonempty file up to 5 MiB.');
  const extension=name.toLowerCase().split('.').pop();
  if(extension==='pdf')return {...await extractPdfText(bytes),mimeType:'application/pdf'};
  if(extension==='docx') {
    if(bytes.length<2 || bytes.readUInt16LE(0)!==0x4b50)throw new Error('This file is not a DOCX archive.');
    return {...await parseBinary(bytes,'docx'),mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
  }
  if(!['txt','md','csv','json'].includes(extension ?? ''))throw new Error('Supported uploads: PDF, DOCX, TXT, MD, CSV and JSON.');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('Text uploads must use UTF-8 encoding.');}
  if(text.includes('\0'))throw new Error('Binary data cannot be uploaded as a text file.');
  return {text:text.slice(0,40000),truncated:text.length>40000,mimeType:extension==='csv'?'text/csv':extension==='json'?'application/json':'text/plain'};
}
export async function uploadIntoConversation(input: WorkspaceState,conversationId: string,filename: string,bytes: Buffer): Promise<ActionResult> {
  requireConversation(input,conversationId);
  if((input.attachments?.length ?? 0)>=100)throw new Error('This prototype supports 100 attachments per workspace.');
  const name=filename.replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180).trim();
  if(!name)throw new Error('A filename is required.');
  const parsed=await extractUpload(bytes,name);
  if(!parsed.text.trim())throw new Error('No readable text was found. Scanned images need OCR, which is not enabled.');
  const state=structuredClone(input);state.attachments ??= [];
  const id=`upload-${createHash('sha256').update(state.settings.mode).update(bytes).digest('hex').slice(0,32)}`;
  let attachment=state.attachments.find(item=>item.id===id);
  if(!attachment){attachment={id,name,origin:'local',mimeType:parsed.mimeType,byteSize:bytes.length,content:parsed.text,status:'ready',truncated:parsed.truncated,createdAt:new Date().toISOString(),mode:state.settings.mode};state.attachments.push(attachment);}
  attachToConversation(state,conversationId,[attachment.id]);
  const message=`Attached ${name}.${parsed.truncated?' The extracted text was truncated at the document limit.':''} No model call was used.`;
  state.runs.unshift({id:randomUUID(),title:'File attached',description:message,status:'succeeded',createdAt:new Date().toISOString(),mode:state.settings.mode,modelCalls:0,tokens:0,apiCalls:0,writes:0,cacheHits:0,sourceIds:[attachment.id]});
  return {state,entityId:attachment.id,message};
}
