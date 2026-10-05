import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../../server/index';
import { createIdentitySession } from '../../server/identity';
import { createDemoState } from '../../src/lib/domain/fixtures';
import { createGoogleDependencies } from '../../src/lib/server/google-persistence';
import { closeDatabase, getSecret, readWorkspace, saveWorkspace, setSecret } from '../../src/lib/server/storage';
import type { WorkspaceState } from '../../src/lib/types';

const directory=mkdtempSync(join(tmpdir(),'proletariat-user-storage-'));
const nativeFetch=globalThis.fetch;
const revoked:string[]=[];
let server:Server,base:string;
beforeAll(async()=>{
  vi.stubEnv('DATA_DIR',directory);vi.stubEnv('NODE_ENV','production');vi.stubEnv('TOKEN_ENCRYPTION_KEY',Buffer.alloc(32,5).toString('base64'));
  vi.stubEnv('GOOGLE_CLIENT_ID','synthetic-storage-client');vi.stubEnv('GOOGLE_CLIENT_SECRET','synthetic-storage-secret');vi.stubEnv('GOOGLE_REDIRECT_URI','http://127.0.0.1:1234/api/google/callback');
  vi.stubGlobal('fetch',(...args:Parameters<typeof fetch>)=>{
    const input=args[0],url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url.hostname==='127.0.0.1')return nativeFetch(...args);
    if(url.href==='https://oauth2.googleapis.com/revoke'){revoked.push(String(args[1]?.body));return Promise.resolve(new Response('',{status:200}));}
    return Promise.reject(new Error('External networking is disabled in this isolation test.'));
  });
  server=createApp().listen(0,'127.0.0.1');await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));closeDatabase();vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(directory,{recursive:true,force:true});});
function user(label:string){const subject=`synthetic-storage-${label}-${randomUUID()}`;const identity=createIdentitySession({subject,email:'same-login@example.com',emailVerified:true});return {subject,id:identity.session.userId,headers:{Authorization:`Bearer ${identity.token}`,'Content-Type':'application/json'}};}
function seed(label:string):WorkspaceState{
  const state=createDemoState();state.tasks=[{...state.tasks[0],id:`${label}-task`,title:`Private ${label} task`,sourceIds:[]}];state.plan=[];state.events=[];
  state.resources=[{...state.resources[1],id:`${label}-resource`,name:`Private ${label} file`,content:`Private ${label} content`}];
  state.agents=[{...state.agents[0],id:`${label}-agent`,messages:[{id:`${label}-message`,role:'user',content:`Private ${label} chat`,createdAt:new Date().toISOString()}],resourceIds:[`${label}-resource`],workflowIds:[`${label}-workflow`]}];
  state.conversations=[{id:`${label}-conversation`,title:`Private ${label} conversation`,scope:'workspace',attachmentIds:[`${label}-attachment`],messages:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}];
  state.attachments=[{id:`${label}-attachment`,origin:'local',name:`${label}.txt`,mimeType:'text/plain',content:`Private ${label} upload`,status:'ready',createdAt:new Date().toISOString(),mode:'demo'}];
  state.workflows=[{...state.workflows[0],id:`${label}-workflow`,agentId:`${label}-agent`,enabled:false}];
  state.campaigns=[{id:`${label}-campaign`,name:`Private ${label} campaign`,subject:'Fictional',body:'Fictional',status:'running',recipients:[],mode:'demo',createdAt:new Date().toISOString(),ratePerMinute:1}];
  state.scans=[{id:`${label}-scan`,provider:'drive',coverage:'selected',status:'running',discovered:1,read:0,analyzed:0,skipped:0,failed:0,createdAt:new Date().toISOString(),mode:'demo'}];
  state.runs=[{...state.runs[0],id:`${label}-receipt`,taskId:`${label}-task`,agentId:`${label}-agent`,description:`Private ${label} receipt`}];
  state.settings.workingHoursStart=label==='a'?'08:00':'10:00';state.dailyConfig={enabled:false,time:label==='a'?'08:30':'10:30',gmailQuery:`label:${label}`,calendarId:`${label}-calendar`};state.processedKeys=[];
  return state;
}
it('persists every workspace collection by verified app user and denies foreign object edits even with a forged workspace header',async()=>{
  const a=user('collections-a'),b=user('collections-b');saveWorkspace(a.id,seed('a'));saveWorkspace(b.id,seed('b'));closeDatabase();
  for(const collection of ['tasks','agents','resources','workflows','campaigns','runs','scans','conversations','attachments']){
    const response=await fetch(`${base}/api/${collection}`,{headers:{...b.headers,'X-Workspace-ID':a.id}});expect(response.ok).toBe(true);const records=await response.json();expect(records).toHaveLength(1);expect(records[0].id.startsWith('b-')).toBe(true);
  }
  expect((await fetch(`${base}/api/tasks/a-task`,{headers:b.headers})).status).toBe(404);
  const before=readWorkspace(a.id);
  for(const [type,id] of [['task.update','a-task'],['conversation.update','a-conversation'],['resource.bind','a-resource'],['campaign.pause','a-campaign'],['scan.pause','a-scan'],['workflow.update','a-workflow']]){
    const response=await fetch(`${base}/api/action`,{method:'POST',headers:{...b.headers,'X-Workspace-ID':a.id},body:JSON.stringify({type,payload:{id,title:'Unauthorized edit',name:'Unauthorized edit',ownerId:a.id},requestId:randomUUID()})});expect(response.ok,`${type} must reject the foreign object`).toBe(false);
  }
  expect(readWorkspace(a.id)).toEqual(before);expect(readWorkspace(b.id).settings.workingHoursStart).toBe('10:00');expect(readWorkspace(b.id).dailyConfig?.calendarId).toBe('b-calendar');
  expect((await fetch(`${base}/api/resources`)).status).toBe(401);
});
it('persists appearance under the app user, validates it, and retains it across mode switches',async()=>{
  const a=user('theme-a'),b=user('theme-b');saveWorkspace(a.id,seed('a'));saveWorkspace(b.id,seed('b'));
  async function update(identity:ReturnType<typeof user>,payload:object){return fetch(`${base}/api/action`,{method:'POST',headers:identity.headers,body:JSON.stringify({type:'settings.update',payload,requestId:randomUUID()})});}
  const blue={id:'blue',hue:213,scale:.92},plum={id:'plum',hue:282,scale:.88};
  expect((await update(a,{accentTheme:blue})).ok).toBe(true);expect((await update(b,{accentTheme:plum})).ok).toBe(true);closeDatabase();
  expect(readWorkspace(a.id).settings.accentTheme).toEqual(blue);expect(readWorkspace(b.id).settings.accentTheme).toEqual(plum);
  expect((await update(b,{accentTheme:{id:'custom',hue:900,scale:1}})).ok).toBe(false);expect(readWorkspace(b.id).settings.accentTheme).toEqual(plum);
  expect((await update(a,{mode:'live'})).ok).toBe(true);expect((await update(a,{mode:'demo'})).ok).toBe(true);expect(readWorkspace(a.id).settings.accentTheme).toEqual(blue);expect(readWorkspace(b.id).settings.accentTheme).toEqual(plum);
});
it.each(['same','different'] as const)('keeps %s external provider accounts independently owned and disconnects only the caller',async(kind)=>{
  const a=user(`providers-${kind}-a`),b=user(`providers-${kind}-b`),depsA=createGoogleDependencies(a.id),depsB=createGoogleDependencies(b.id);
  const subjectA='synthetic-external-account-a',subjectB=kind==='same'?subjectA:'synthetic-external-account-b';
  for(const [identity,deps,subject,label] of [[a,depsA,subjectA,'a'],[b,depsB,subjectB,'b']] as const){
    await deps.tokenStore.save({accessToken:`synthetic-google-${label}`,connectionId:`grant-${kind}-${label}`,ownerSubject:identity.subject,subject,email:'same-provider@example.com',expiresAt:Date.now()+100000,scopes:[]});
    const state=seed(label);state.settings.mode='live';saveWorkspace(identity.id,state);
    await deps.store.set('same-cache-key',{owner:label});expect((await deps.store.reserveOperation('same-operation-key',label)).created).toBe(true);
    setSecret(`${identity.id}:chatgpt:profiles`,{activeId:`profile-${label}`,profiles:[{id:`profile-${label}`,clientId:'oaiapp_synthetic',subject,accessToken:`synthetic-plan-${label}`,expiresAt:Date.now()+100000,scopes:['chatgpt.tokens.use.direct']}]});
  }
  closeDatabase();
  expect(await depsA.store.get('same-cache-key')).toEqual({owner:'a'});expect(await depsB.store.get('same-cache-key')).toEqual({owner:'b'});
  expect(await depsA.tokenStore.load()).toMatchObject({ownerSubject:a.subject,subject:subjectA,accessToken:'synthetic-google-a'});expect(await depsB.tokenStore.load()).toMatchObject({ownerSubject:b.subject,subject:subjectB,accessToken:'synthetic-google-b'});
  const status=await fetch(`${base}/api/chatgpt/status`,{headers:b.headers}).then(response=>response.json());expect(status.profiles.map((profile:{id:string})=>profile.id)).toEqual(['profile-b']);expect(JSON.stringify(status)).not.toContain('synthetic-plan-');
  expect((await fetch(`${base}/api/chatgpt/select`,{method:'POST',headers:b.headers,body:JSON.stringify({id:'profile-a'})})).ok).toBe(false);
  const beforeB=readWorkspace(b.id);
  const priorRevocations=revoked.length;
  expect((await fetch(`${base}/api/google/disconnect`,{method:'POST',headers:a.headers,body:'{}'})).ok).toBe(true);
  expect(await depsA.tokenStore.load()).toBeUndefined();expect(await depsB.tokenStore.load()).toMatchObject({accessToken:'synthetic-google-b'});expect(readWorkspace(b.id)).toEqual(beforeB);expect(readWorkspace(a.id).campaigns[0].status).toBe('paused');expect(readWorkspace(a.id).scans[0].status).toBe('paused');
  expect(revoked.slice(priorRevocations)).toEqual(['token=synthetic-google-a']);
  expect((await fetch(`${base}/api/chatgpt/disconnect`,{method:'POST',headers:a.headers,body:'{}'})).ok).toBe(true);
  const disconnected=getSecret<{profiles:Array<{accessToken?:string;scopes:string[]}>}>(`${a.id}:chatgpt:profiles`)!;
  expect(disconnected.profiles[0].accessToken).toBeUndefined();expect(disconnected.profiles[0].scopes).toEqual([]);expect(getSecret<{profiles:unknown[]}>(`${b.id}:chatgpt:profiles`)?.profiles).toHaveLength(1);
});
