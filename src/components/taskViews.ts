import type { CalendarEvent, Task, WorkspaceState } from '../lib/types';
import { DEFAULT_CATEGORIES } from '../lib/types';
import { getTaskReceipts } from '../lib/domain/feed';
import { selectTasks, projectTasks } from '../lib/domain/projections';
import { isActiveTask, isProviderComplete, hasUnknownProviderState } from '../lib/domain/lifecycle';
export { isActiveTask, hasUnknownProviderState };
export const priorityNames: Record<Task['priority'],string> = {P0:'High',P1:'Medium',P2:'Low'};
export const taskStates: Record<Task['status'],string> = {open:'Pending',in_progress:'In progress',waiting:'Waiting',blocked:'Blocked',done:'Completed'};
export type TaskView = 'all'|'priority'|'category'|'planned'|'deadline'|'history';
export interface ViewFilters { view: TaskView; priority?: string; category?: string; date?: string; query?: string; history?: string; }
export const submissionSatisfied = isProviderComplete;
export function allCategories(state:WorkspaceState) { return [...new Set([...DEFAULT_CATEGORIES,...state.tasks.flatMap(task=>task.categories || [])])]; }
export function viewTasks(state:WorkspaceState,filters:ViewFilters):Task[] {
  const query=filters.query?.trim().toLowerCase();
  return selectTasks(state,{view:filters.view==='history'?'history':'active'}).filter(task=> {
    if(filters.view==='history') { if(!task.removedAt && task.status!=='done'&&!submissionSatisfied(task)) return false; if(filters.history==='removed'&&!task.removedAt)return false; if(filters.history==='completed'&&(task.removedAt||task.status!=='done'))return false; if(filters.history==='provider'&&!submissionSatisfied(task))return false; }
    else if(!isActiveTask(task))return false;
    if(filters.priority&&task.priority!==filters.priority)return false;
    if(filters.category && !(filters.category==='Uncategorized' ? !task.categories?.length : task.categories?.includes(filters.category)))return false;
    if(filters.view==='deadline' && (!task.dueDate || submissionSatisfied(task)))return false;
    if(filters.date) { const date=filters.view==='history'?(task.removedAt||task.completedAt||'').slice(0,10):filters.view==='deadline'?task.dueDate:task.plannedDate; if(date!==filters.date)return false; }
    return !query || [task.title,task.nextAction,task.notes,task.needsInput,...(task.categories||[])].some(value=>value?.toLowerCase().includes(query));
  }).slice().sort((a,b)=>filters.view==='history' ? (b.removedAt||b.completedAt||'').localeCompare(a.removedAt||a.completedAt||'') : (filters.view==='deadline'?(a.dueDate||'').localeCompare(b.dueDate||'')||(a.dueTime||'23:59').localeCompare(b.dueTime||'23:59'):filters.view==='planned'?a.plannedDate.localeCompare(b.plannedDate):0)||a.priority.localeCompare(b.priority)||a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
}
export function dailyGroups(state:WorkspaceState) {
  const groups=projectTasks(state);return {...groups,events:groups.fixedEvents,completed:groups.completed.filter(task=>task.completedAt&&eventDate({start:task.completedAt} as CalendarEvent,state.settings.timezone)===state.today)};
}
export function eventDate(event:CalendarEvent,timezone:string) {if(event.start.length===10)return event.start;try{return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(event.start.length===10?`${event.start}T12:00:00`:event.start));}catch{return event.start.slice(0,10);}}
export function taskSourceLinks(state:WorkspaceState,task:Task) {
  return [...new Set([...task.sourceIds,...getTaskReceipts(state,task.id).flatMap(receipt=>receipt.sourceIds)])].flatMap(id=> {const source=[...(state.daily?.sources||[]),...(state.canvas?.sources||[])].find(item=>item.id===id);const resource=state.resources.find(item=>item.id===id);const attachment=state.attachments?.find(item=>item.id===id);return source?[{id,name:source.title,url:source.url,provider:source.provider}]:resource?[{id,name:resource.name,url:resource.url,provider:'Drive'}]:attachment?[{id,name:attachment.name,url:attachment.url,provider:attachment.origin}]:[{id,name:'Recorded source',url:undefined,provider:'Source'}];});
}
export function taskHref(id:string,returnTo='#home'){return `#task/${encodeURIComponent(id)}?return=${encodeURIComponent(returnTo)}`;}
export function eventHref(id:string,returnTo='#daily'){return `#event/${encodeURIComponent(id)}?return=${encodeURIComponent(returnTo)}`;}
export function taskViewHref(filters:ViewFilters) {const query=new URLSearchParams();for(const [key,value] of Object.entries(filters))if(value)query.set(key,value);return `#${filters.view==='history'?'history':'tasks'}?${query}`;}
export function parseWorkspaceRoute(hash:string) {
  const [path,search='']=hash.replace(/^#/,'').split('?');const params=new URLSearchParams(search);let id:string|undefined;try{id=decodeURIComponent(path.split('/').slice(1).join('/'));}catch{id=undefined;}
  const allowed=['home','daily','tasks','history','task','event','chats','today','agents','resources','canvas','activity','connections'];const page=allowed.includes(path.split('/')[0])?path.split('/')[0]:'daily';
  const view=params.get('view');const filters:ViewFilters={view:page==='history'?'history':['all','priority','category','planned','deadline'].includes(view||'')?view as TaskView:'all',priority:params.get('priority')||undefined,category:params.get('category')||undefined,date:params.get('date')||undefined,query:params.get('query')||undefined,history:params.get('history')||undefined};
  const requested=params.get('return')||'#home';const returnTo=/^#(home|daily|tasks|history|canvas|today)(\?|$)/.test(requested)?requested:'#home';return {page,id,filters,returnTo};
}
