import { createHash, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { ActionRequest, ActionResult, DailyConfig, DailyProviderState, DailySource, SourceObligation, WorkspaceState } from '../types';
import { applyAction } from '../domain/actions';
import { validateDate } from '../domain/core';
import { ingestTaskCandidates, type TaskCandidate } from '../domain/tasks';
import { isActiveTask } from '../domain/lifecycle';

export const defaultDailyConfig: DailyConfig={enabled:false,time:'09:00',gmailQuery:'newer_than:1d',calendarId:'primary'};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function configureDaily(input:WorkspaceState,action:ActionRequest):ActionResult {
  const state=structuredClone(input),p=action.payload??{},config={...defaultDailyConfig,...state.dailyConfig};
  if(p.enabled!==undefined){if(typeof p.enabled!=='boolean')throw new Error('Daily enabled must be a boolean.');config.enabled=p.enabled;}
  if(p.time!==undefined){if(typeof p.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time))throw new Error('Daily time must use HH:mm.');config.time=p.time;}
  for(const field of ['gmailQuery','calendarId'] as const)if(p[field]!==undefined){if(typeof p[field]!=='string'||!p[field].trim()||p[field].length>500)throw new Error(`Choose a valid ${field}.`);config[field]=p[field].trim();}
  state.dailyConfig=config;return {state,message:'Daily read settings saved. Provider permissions still apply.'};
}
export function explicitCandidates(sources:DailySource[],date:string):Array<TaskCandidate & Partial<SourceObligation>> {
  const candidates:Array<TaskCandidate & Partial<SourceObligation>>=[];
  for(const source of sources){
    for(const obligation of source.obligations??[]) {
      candidates.push({...obligation,sourceId:source.id,sourceVersion:source.version??hash(source.text),plannedDate:date,notes:obligation.notes??`Verified obligation from ${source.title}.${source.url?` Source: ${source.url}`:''}`});
    }
    // Canvas inventory is authoritative, including an empty obligation list for readings/placeholders.
    if(source.provider==='canvas')continue;
    const seen=new Map<string,number>();
    for(const line of source.text.slice(0,40000).split('\n')){
      const match=line.match(/^\s*(?:[-*]\s*)?(?:task|todo|action):\s*(.{1,500})$/i);if(!match)continue;
      const raw=match[1].trim(),identity=raw.match(/\[id:([A-Za-z0-9_-]{1,100})\]/i)?.[1];
      const key=hash(raw.replace(/\[due:[^\]]+\]/gi,'').trim().toLowerCase()).slice(0,24),occurrence=seen.get(key)??0;seen.set(key,occurrence+1);
      const due=raw.match(/\[due:(\d{4}-\d{2}-\d{2})\]/i)?.[1];
      let dueDate:string|undefined;try{if(due)dueDate=validateDate(due);}catch{/* Leave ambiguous dates in the literal title. */}
      candidates.push({sourceId:source.id,sourceVersion:source.version??hash(source.text),itemId:identity?`explicit-id-${identity}`:`explicit-${key}-${occurrence}`,title:raw,plannedDate:date,dueDate,estimateMinutes:30,notes:`Explicit task marker from ${source.title}. Duration defaults to 30 minutes; review the estimate.${source.url?` Source: ${source.url}`:''}`});
    }
  }
  return candidates;
}
export async function runDaily(input:WorkspaceState,action:ActionRequest,readGoogle:(state:WorkspaceState,request:ActionRequest)=>Promise<ActionResult>):Promise<ActionResult> {
  let state=structuredClone(input);const config={...defaultDailyConfig,...state.dailyConfig};
  const date=validateDate(typeof action.payload?.date==='string'?action.payload.date:DateTime.now().setZone(state.settings.timezone).toISODate()!);
  const now=new Date().toISOString();
  if(state.settings.mode==='live'){
    const result=await readGoogle(state,{type:'daily.read',payload:{date,gmailQuery:action.payload?.gmailQuery??config.gmailQuery,calendarId:action.payload?.calendarId??config.calendarId},requestId:action.requestId});
    state=result.state;
  }else{
    const providers:DailyProviderState[]=(['gmail','calendar','drive'] as const).map(provider=>{
      const enabled=state.permissions[provider==='gmail'?'gmailRead':provider==='calendar'?'calendarRead':'driveRead'];
      const count=provider==='gmail'?1:provider==='calendar'?state.events.length:state.resources.filter(resource=>resource.bound&&resource.kind!=='folder').length;
      return {provider,status:enabled?'complete':'not_enabled',lastReadAt:enabled?now:undefined,discovered:enabled?count:0,read:enabled?count:0,skipped:0,failed:0,coverage:'selected'};
    });
    const sources:DailySource[]=state.permissions.gmailRead?[{id:'demo-daily-gmail-project',provider:'gmail',externalId:'demo-message',title:'Fictional project check-in',text:'This is a synthetic message, not your mailbox.\nTask: Reply to the example project check-in',url:'https://example.com/demo-message',readAt:now,version:'1'}]:[];
    if(state.permissions.calendarRead)for(const event of state.events)sources.push({id:`demo-calendar:${event.id}`,provider:'calendar',externalId:event.id,title:event.title,text:`${event.title}\n${event.start} — ${event.end}`,readAt:now,version:hash(JSON.stringify(event))});
    if(state.permissions.driveRead)for(const resource of state.resources.filter(item=>item.bound&&item.kind!=='folder'))sources.push({id:`demo-drive:${resource.id}`,provider:'drive',resourceId:resource.id,externalId:resource.id,title:resource.name,text:resource.content??'Synthetic document; no external Drive was accessed.',url:resource.url,readAt:now,version:hash(resource.content??resource.modifiedAt)});
    state.daily={id:`daily-demo-${date}`,date,timezone:state.settings.timezone,createdAt:now,updatedAt:now,mode:'demo',sources,providers,taskIds:[],receiptIds:[],summary:'Synthetic daily read. No external accounts were accessed.'};
  }
  if(!state.daily)throw new Error('The provider did not return a Daily snapshot.');
  const before=new Map(state.tasks.map(task=>[task.id,JSON.stringify(task)]));
  state=ingestTaskCandidates(state,explicitCandidates(state.daily.sources,date),new Date(now));
  const added=state.tasks.filter(task=>!before.has(task.id));
  const changed=state.tasks.filter(task=>before.has(task.id)&&before.get(task.id)!==JSON.stringify(task));
  if(date>=state.today)state=applyAction(state,{type:'plan.rollover',payload:{date}}).state;
  state=applyAction(state,{type:'plan.generate',payload:{date}}).state;
  const sourceIds=new Set(state.daily!.sources.map(source=>source.id));
  state.daily!.taskIds=state.tasks.filter(task=>isActiveTask(task)&&task.sourceIds.some(id=>sourceIds.has(id))).map(task=>task.id);
  state.daily!.newTaskIds=added.map(task=>task.id);state.daily!.changedTaskIds=changed.map(task=>task.id);
  const failures=state.daily!.providers.filter(provider=>['failed','not_connected','not_enabled'].includes(provider.status));
  const partial=state.daily!.providers.some(provider=>['partial','running'].includes(provider.status));
  const message=`${state.settings.mode==='demo'?'Synthetic Daily':'Daily'}: ${added.length} new obligation${added.length===1?'':'s'}, ${changed.length} changed; ${state.daily!.sources.length} source records. ${partial?'Coverage is partial; review provider details before continuing. ':''}${failures.length?`${failures.map(provider=>provider.provider).join(', ')} needs setup or review. `:''}Tasks were extracted from verified structured obligations and Task:/Todo:/Action: lines. General-language interpretation is a separate ChatGPT action; no model calls were used.`;
  const receiptId=randomUUID();state.daily!.summary=message;state.daily!.updatedAt=now;state.daily!.receiptIds=[...(state.daily!.receiptIds??[]),receiptId];
  state.runs.unshift({id:receiptId,title:'Daily task extraction',description:message,status:partial?'pending':failures.length?'conflict':'succeeded',createdAt:now,mode:state.settings.mode,modelCalls:0,tokens:0,apiCalls:0,writes:0,cacheHits:0,sourceIds:[...sourceIds]});
  state.usage.deterministicActions++;
  return {state,message,entityId:state.daily!.id};
}
