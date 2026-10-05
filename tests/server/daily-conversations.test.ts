import { expect, it } from 'vitest';
import { createDemoState } from '../../src/lib/domain/fixtures';
import { conversationAction, attachToConversation } from '../../src/lib/server/conversations';
import { configureDaily, explicitCandidates, runDaily } from '../../src/lib/server/daily';
import { uploadIntoConversation, extractUpload } from '../../src/lib/server/attachments';
import type { DailySource } from '../../src/lib/types';
const noGoogle=async()=>{throw new Error('Demo must not read Google');};
it('keeps independent conversations and explicitly selected agent scope',()=>{
  const a=conversationAction(createDemoState(),{type:'conversation.create',payload:{title:'Primary'}});
  const b=conversationAction(a.state,{type:'conversation.create',payload:{title:'Specialist',agentId:a.state.agents[1].id}});
  expect(b.state.conversations?.map(c=>c.scope)).toEqual(['agent','workspace']);
  const c=conversationAction(b.state,{type:'conversation.update',payload:{id:b.entityId,agentId:null}});expect(c.state.conversations?.[0].scope).toBe('workspace');
  expect(()=>conversationAction(c.state,{type:'conversation.update',payload:{id:a.entityId,agentId:'outside-agent'}})).toThrow(/Choose an agent/);
});
it('attaches actual extracted text without changing another conversation',async()=>{
  const a=conversationAction(createDemoState(),{type:'conversation.create'});
  const b=conversationAction(a.state,{type:'conversation.create'});
  const result=await uploadIntoConversation(b.state,a.entityId!,'../notes.md',Buffer.from('Task: Draft the synthetic outline'));
  expect(result.state.attachments?.[0]).toMatchObject({content:'Task: Draft the synthetic outline',origin:'local',status:'ready'});
  expect(result.state.conversations?.find(c=>c.id===b.entityId)?.attachmentIds).toEqual([]);
  expect(()=>attachToConversation(createDemoState(),a.entityId,[result.entityId])).toThrow(/does not exist/);
  expect(result.state.runs[0].modelCalls).toBe(0);
});
it('rejects malformed files and reports text truncation',async()=>{
  await expect(extractUpload(Buffer.from('x'),'bad.docx')).rejects.toThrow(/DOCX/);
  await expect(extractUpload(Buffer.from([0xff]),'bad.txt')).rejects.toThrow(/UTF-8/);
  await expect(extractUpload(Buffer.from('image'),'picture.jpg')).rejects.toThrow(/Supported/);
  expect(await extractUpload(Buffer.from('x'.repeat(40010)),'long.txt')).toMatchObject({truncated:true,text:'x'.repeat(40000)});
});
it('extracts only explicit task markers, not invented email deadlines',()=>{
  const source:DailySource={id:'synthetic-source',provider:'gmail',title:'Example',readAt:'2026-10-04T09:00:00Z',text:'Please maybe respond next week.\nTask: Prepare draft [due:2026-10-06]\nTodo: Review slides\nAction: Check dates [due:2026-02-30]'};
  const tasks=explicitCandidates([source],'2026-10-04');expect(tasks).toHaveLength(3);expect(tasks[0].dueDate).toBe('2026-10-06');expect(tasks[2].dueDate).toBeUndefined();
});
it('uses Canvas inventory exclusively, including empty obligation lists for context-only items',()=>{
  const source:DailySource={id:'canvas:fictional-source',provider:'canvas',title:'Fictional source',readAt:'2026-10-05T09:00:00Z',text:'Task: A quoted example [due:2026-10-06]',obligations:[]};
  expect(explicitCandidates([source],'2026-10-05')).toEqual([]);
  source.obligations=[{itemId:'obligation',title:'Verified coursework',dueDate:'2026-10-09'}];
  expect(explicitCandidates([source],'2026-10-05')).toEqual([expect.objectContaining({itemId:'obligation',title:'Verified coursework',dueDate:'2026-10-09'})]);
});
it('Daily repeat preserves edited, completed tasks and adds zero model calls',async()=>{
  const state=createDemoState();state.permissions.gmailRead=true;state.permissions.calendarRead=true;
  const first=await runDaily(state,{type:'daily.run',payload:{date:state.today}},noGoogle);
  const added=first.state.tasks.find(task=>task.sourceIds.includes('demo-daily-gmail-project'))!;added.status='done';added.title='User edited';
  const repeat=await runDaily(first.state,{type:'daily.run',payload:{date:state.today}},noGoogle);
  expect(repeat.state.tasks.filter(task=>task.id===added.id)).toEqual([added]);expect(repeat.state.runs[0].modelCalls).toBe(0);
  expect(repeat.state.daily?.sources.length).toBeGreaterThan(0);
  expect(()=>configureDaily(state,{type:'daily.configure',payload:{time:'25:00'}})).toThrow(/HH:mm/);
});

function minimalPdf(){
  const stream='BT /F1 12 Tf 40 100 Td (Synthetic PDF attachment text) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(text);text+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(text);
}
function minimalDocx(){
  const name=Buffer.from('word/document.xml'),body=Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic DOCX &amp; text</w:t></w:r></w:p></w:body></w:document>');
  let crc=0xffffffff;for(const byte of body){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(name.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+body.length,16);
  return Buffer.concat([local,name,body,central,name,end]);
}
it('parses a real PDF and DOCX in bounded workers',async()=>{
  expect((await extractUpload(minimalPdf(),'synthetic.pdf')).text).toContain('Synthetic PDF attachment text');
  expect((await extractUpload(minimalDocx(),'synthetic.docx')).text).toContain('Synthetic DOCX & text');
},20000);
