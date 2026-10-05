import { expect, it, vi } from 'vitest';
import { createDemoState } from '../../src/lib/domain/fixtures';
import { interpretDaily } from '../../src/lib/server/audit-interpret';
import type { PlanResponse } from '../../src/lib/server/chatgpt-plan';

function state(){const state=createDemoState();state.tasks=[];state.processedKeys=[];state.permissions.gmailRead=true;state.daily={id:'daily-synthetic',date:state.today,timezone:state.settings.timezone,createdAt:'2026-10-05T09:00:00Z',updatedAt:'2026-10-05T09:00:00Z',mode:'demo',sources:[{id:'synthetic-mail',title:'Fictional project request',provider:'gmail',version:'1',readAt:'2026-10-05T09:00:00Z',text:'Please send the outline by 2026-10-09.'}],providers:[],taskIds:[],receiptIds:[],summary:'Synthetic input'};return state;}
const candidate={sourceId:'synthetic-mail',title:'Send the outline',evidence:'Please send the outline by 2026-10-09.',dueDate:'2026-10-09',categories:['Personal/Admin'],nextAction:'Draft the outline'};
function result(candidates:unknown[]):PlanResponse{return {output:[{type:'function_call',name:'record_obligations',namespace:'proletariat',arguments:JSON.stringify({candidates})}],usage:{input_tokens:100,output_tokens:40}};}
it('requires own plan consent and never activates a paid fallback',async()=>{
  const respond=vi.fn();await expect(interpretDaily(state(),{type:'daily.interpret'},undefined,{connected:()=>false,respond})).rejects.toThrow(/own ChatGPT/);expect(respond).not.toHaveBeenCalled();
});
it('imports evidence-linked obligations once and caches only interpreted excerpts',async()=>{
  const respond=vi.fn(async()=>result([candidate]));const holds:number[]=[];
  const first=await interpretDaily(state(),{type:'daily.interpret'},r=>holds.push(r.state.usage.inputTokens),{connected:()=>true,respond});
  expect(first.state.tasks).toHaveLength(1);expect(first.state.tasks[0].dueDate).toBe('2026-10-09');expect(first.state.runs[0]).toMatchObject({modelCalls:1,tokens:140,status:'succeeded'});expect(holds[0]).toBeGreaterThan(holds[1]);
  const second=await interpretDaily(first.state,{type:'daily.interpret'},undefined,{connected:()=>true,respond});expect(respond).toHaveBeenCalledTimes(1);expect(second.state.tasks).toHaveLength(1);expect(second.message).toContain('Zero model calls');
});
it('rejects a fabricated deadline or evidence without partially importing a batch',async()=>{
  for(const invalid of [{...candidate,dueDate:'2026-10-10'},{...candidate,evidence:'Invented request not in the source'}]){
    const first=await interpretDaily(state(),{type:'daily.interpret'},undefined,{connected:()=>true,respond:async()=>result([candidate,invalid])});
    expect(first.state.tasks).toHaveLength(0);expect(first.state.runs[0].status).toBe('failed');expect(first.state.runs[0].tokens).toBe(140);expect(first.state.processedKeys).toEqual([]);
  }
});
it('keeps revoked sources out of interpretation context',async()=>{
  const input=state();input.permissions.gmailRead=false;const respond=vi.fn();const response=await interpretDaily(input,{type:'daily.interpret'},undefined,{connected:()=>true,respond});expect(respond).not.toHaveBeenCalled();expect(response.state.tasks).toHaveLength(0);
});
it('retains conservative usage and a failure receipt for an interrupted response',async()=>{
  const input=state();const response=await interpretDaily(input,{type:'daily.interpret'},undefined,{connected:()=>true,respond:async()=>{throw new Error('Interrupted synthetic stream');}});
  expect(response.state.tasks).toHaveLength(0);expect(response.state.usage.inputTokens).toBeGreaterThan(input.usage.inputTokens);expect(response.state.runs[0].status).toBe('failed');expect(response.state.processedKeys).toEqual([]);
});
