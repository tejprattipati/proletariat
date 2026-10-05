import { createHash } from 'node:crypto';
import type { Task, WorkspaceState } from '../types';
import { getValue, setValue } from './storage';

const key=(owner:string,provider:string,account:string)=>`${owner}:${provider}:task-archive:${createHash('sha256').update(account).digest('hex')}`;
/** Preserve user lifecycle/corrections separately from revocable raw provider content. */
export function archiveProviderTasks(state:WorkspaceState,owner:string,provider:'google'|'canvas',account:string,sourceIds=new Set<string>()){
  const tasks=state.tasks.filter(task=>task.sourceIds.some(id=>id.startsWith(`${provider}:`)||sourceIds.has(id)));
  const old=getValue<Task[]>(key(owner,provider,account))??[];
  const combined=new Map(old.map(task=>[task.id,task]));for(const task of tasks)combined.set(task.id,structuredClone(task));
  setValue(key(owner,provider,account),[...combined.values()]);
}
/** Call only after verifying the newly selected provider identity for this owner. */
export function restoreProviderTasks(state:WorkspaceState,owner:string,provider:'google'|'canvas',account:string){
  for(const task of getValue<Task[]>(key(owner,provider,account))??[]){
    if(!state.tasks.some(current=>current.id===task.id))state.tasks.push(structuredClone(task));
  }
}
