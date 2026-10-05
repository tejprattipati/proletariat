import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { ActionRequest, ActionResult, CanvasConfig, CanvasSnapshot, WorkspaceState } from '../types';
import { CanvasIntegration, type CanvasReadResult } from '../canvas/index';
import { explicitCandidates } from './daily';
import { ingestTaskCandidates } from '../domain/tasks';
import { createCanvasDependencies } from './canvas-persistence';
import { currentUserId } from './user-context';

export const defaultCanvasConfig:CanvasConfig={enabled:false,time:'09:00',weekday:1};
export function configureCanvas(input:WorkspaceState,action:ActionRequest):ActionResult{
  const state=structuredClone(input),p=action.payload??{},config={...defaultCanvasConfig,...state.canvasConfig};
  if(p.enabled!==undefined){if(typeof p.enabled!=='boolean')throw new Error('Canvas enabled must be a boolean.');config.enabled=p.enabled;}
  if(p.time!==undefined){if(typeof p.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time))throw new Error('Canvas time must use HH:mm.');config.time=p.time;}
  if(p.weekday!==undefined){if(!Number.isInteger(p.weekday)||Number(p.weekday)<1||Number(p.weekday)>7)throw new Error('Canvas weekday must be 1 (Monday) through 7 (Sunday).');config.weekday=Number(p.weekday);}
  state.canvasConfig=config;return {state,message:'Canvas weekly settings saved. Reading is read-only; no coursework submission is available.'};
}
const integrations=new Map<string,CanvasIntegration>();
async function collect(action:ActionRequest,state:WorkspaceState):Promise<CanvasReadResult>{
  const owner=currentUserId();let integration=integrations.get(owner);if(!integration){integration=new CanvasIntegration(createCanvasDependencies(owner));integrations.set(owner,integration);}
  return integration.collect({resume:action.type==='canvas.resume',runId:action.type==='canvas.resume'?state.canvas?.id:undefined,maxPages:5,timezone:state.settings.timezone});
}
/** Applies every replayable provider page to the same owner-scoped canonical tasks. */
export async function runCanvas(input:WorkspaceState,action:ActionRequest,reader=collect):Promise<ActionResult>{
  let state=structuredClone(input),apiCalls=0;
  const now=new Date().toISOString(),date=DateTime.now().setZone(state.settings.timezone).toISODate()!;
  let snapshot:CanvasSnapshot;
  if(state.settings.mode==='live'){
    const result=await reader(action,state);snapshot=result.snapshot;apiCalls=result.apiCalls;
    // Keep the provider's exact report separate from canonical task counts.
    snapshot.report={id:result.report.id,initial:result.report.initial,newItems:result.report.newItems.map(item=>({id:item.id,title:item.title,url:item.url,courseName:item.courseName,state:item.state,dueAt:item.dueAt??undefined,discoveredAfterGap:item.discoveredAfterGap})),changedItems:result.report.changedItems.map(change=>({id:change.id,title:change.after.title,url:change.after.url,courseName:change.after.courseName,fields:change.fields,before:{dueAt:change.before.dueAt??undefined,state:change.before.state},after:{dueAt:change.after.dueAt??undefined,state:change.after.state}})),hasMore:result.hasMore};
  }else{
    snapshot={id:state.canvas?.id??'canvas-demo-inventory',createdAt:now,updatedAt:now,status:'complete',initial:!state.canvas,sources:[{id:'canvas:synthetic:course:assignment:1',provider:'canvas',externalId:'synthetic-assignment-1',title:'Fictional project outline',url:'https://example.com/synthetic-course/outline',text:'Fictional assignment. Task: Prepare the example outline [due:2026-10-09]',readAt:now,version:'1',obligations:[{itemId:'assignment',title:'Prepare the example outline',dueDate:'2026-10-09',categories:['School'],providerState:'not_submitted',nextAction:'Write the example outline'}]}],coverage:[{courseId:'synthetic-course',courseName:'Fictional example course',family:'assignments',status:'complete',discovered:1}],newTaskIds:[],changedTaskIds:[],summary:'Synthetic Canvas inventory. No institution or personal coursework was accessed.'};
    // Structured records take precedence over textual markers for this source.
    snapshot.sources[0].text='Fictional assignment: prepare the example outline. No real coursework was accessed.';
  }
  const before=new Map(state.tasks.map(task=>[task.id,JSON.stringify(task)]));
  state=ingestTaskCandidates(state,explicitCandidates(snapshot.sources,date),new Date(now));
  snapshot.newTaskIds=state.tasks.filter(task=>!before.has(task.id)).map(task=>task.id);
  snapshot.changedTaskIds=state.tasks.filter(task=>before.has(task.id)&&before.get(task.id)!==JSON.stringify(task)).map(task=>task.id);
  state.canvas=snapshot;state.usage.apiCalls+=apiCalls;state.usage.deterministicActions++;
  const message=`${state.settings.mode==='demo'?'Synthetic Canvas':'Canvas'}: ${snapshot.newTaskIds.length} new task records, ${snapshot.changedTaskIds.length} changed. ${snapshot.summary}`;
  state.runs.unshift({id:randomUUID(),title:'Canvas weekly inventory',description:message,status:snapshot.status==='complete'?'succeeded':snapshot.status==='failed'?'failed':'pending',createdAt:now,mode:state.settings.mode,modelCalls:0,tokens:0,apiCalls,writes:0,cacheHits:0,sourceIds:snapshot.sources.map(source=>source.id)});
  return {state,message,entityId:snapshot.id};
}
