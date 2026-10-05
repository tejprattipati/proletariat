import { randomUUID } from 'node:crypto';
import type { CanvasCredentials, CanvasDependencies } from '../canvas/contracts';
import { verifyCanvasConnection } from '../canvas/transport';
import { currentUserId } from './user-context';
import { deleteValue, getSecret, getValue, saveWorkspace, setSecret, setValue, transaction, withWorkspace } from './storage';
import type { WorkspaceState } from '../types';
import { archiveProviderTasks, restoreProviderTasks } from './provider-task-archive';

export function canvasAllowedOrigins(){return (process.env.CANVAS_ALLOWED_ORIGINS??'').split(',').map(value=>value.trim()).filter(Boolean);}
export function createCanvasDependencies(userId:string):CanvasDependencies{
  return {allowedOrigins:canvasAllowedOrigins(),getOwnerId:async()=>userId,getCredentials:async()=>getSecret<CanvasCredentials>(`${userId}:canvas:connection`),store:{get:async<T>(key:string)=>getValue<T>(`${userId}:canvas:kv:${key}`),set:async(key,value)=>setValue(`${userId}:canvas:kv:${key}`,value),delete:async(key)=>deleteValue(`${userId}:canvas:kv:${key}`)}};
}
export function canvasStatus(){
  const id=currentUserId(),credentials=getSecret<CanvasCredentials>(`${id}:canvas:connection`);
  return {configured:canvasAllowedOrigins().length>0,allowedOrigins:canvasAllowedOrigins(),connected:!!credentials&&credentials.ownerId===id,baseUrl:credentials?.baseUrl,accountLabel:credentials?.accountLabel,accountId:credentials?.accountId};
}
function clearCanvasContext(state:WorkspaceState,userId:string,preserveTasks=false){
  const now=new Date().toISOString(),sourceIds=new Set(state.canvas?.sources.map(source=>source.id)??[]);
  setValue(`${userId}:canvas-context-archive:${now}:${state.version}`,{canvas:state.canvas,tasks:state.tasks.filter(task=>task.sourceIds.some(id=>sourceIds.has(id)||id.startsWith('canvas:'))),history:state.taskHistory});
  if(!preserveTasks)state.tasks=state.tasks.filter(task=>!task.sourceIds.some(id=>sourceIds.has(id)||id.startsWith('canvas:')));
  state.plan=state.plan.filter(block=>state.tasks.some(task=>task.id===block.taskId));
  delete state.canvas;state.canvasContextResetAt=now;
  if(state.canvasConfig)state.canvasConfig.enabled=false;
  state.runs.unshift({id:randomUUID(),title:'Canvas connection changed',description:'Previous Canvas source context was archived privately; weekly reads paused. Google and ChatGPT connections are unchanged.',status:'pending',createdAt:now,mode:state.settings.mode,modelCalls:0,tokens:0,apiCalls:0,writes:0,cacheHits:0,sourceIds:[]});
}
export async function connectCanvas(baseUrl:string,token:string){
  const ownerId=currentUserId();
  const identity=await verifyCanvasConnection({baseUrl,token,ownerId},{allowedOrigins:canvasAllowedOrigins()});
  // Consent material is supplied explicitly through the protected app form.
  // Never reuse credentials from another provider or the user's browser.
  await withWorkspace(ownerId,async state=>{
    transaction(()=>{
      const previous=getSecret<CanvasCredentials>(`${ownerId}:canvas:connection`);
      const sameAccount=previous?.accountId===identity.accountId&&previous?.baseUrl===identity.baseUrl;
      if(previous)archiveProviderTasks(state,ownerId,'canvas',`${previous.baseUrl}|${previous.accountId}`);
      clearCanvasContext(state,ownerId,sameAccount);restoreProviderTasks(state,ownerId,'canvas',`${identity.baseUrl}|${identity.accountId}`);
      setSecret(`${ownerId}:canvas:connection`,{...identity,ownerId,connectionId:randomUUID(),token} satisfies CanvasCredentials);state.version++;saveWorkspace(ownerId,state);
    });
  });
  return canvasStatus();
}
export async function disconnectCanvas(){
  const id=currentUserId();
  await withWorkspace(id,async state=>{
    transaction(()=>{const previous=getSecret<CanvasCredentials>(`${id}:canvas:connection`);if(previous)archiveProviderTasks(state,id,'canvas',`${previous.baseUrl}|${previous.accountId}`);clearCanvasContext(state,id);deleteValue(`${id}:canvas:connection`);state.version++;saveWorkspace(id,state);});
  });
  return {message:'Canvas disconnected locally. No coursework was submitted. Google and ChatGPT accounts remain independent.'};
}
