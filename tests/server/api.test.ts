import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createApp, workerTick } from "../../server/index";
import { closeDatabase, getSecret, readWorkspace, reserveOperation, saveWorkspace, setSecret } from "../../src/lib/server/storage";
import { createGoogleDependencies } from "../../src/lib/server/google-persistence";
import { createIdentitySession } from "../../server/identity";
import type { WorkspaceState } from "../../src/lib/types";

let server: Server;
let base: string;
const directory = mkdtempSync(join(tmpdir(), "proletariat-api-test-"));
let userA="",userB="",userC="";
const owner = { Authorization: "Bearer synthetic-owner-access", "Content-Type": "application/json" };
const visitor = { "X-Workspace-ID": randomUUID(), "Content-Type": "application/json" };
const visitorTwo = { "X-Workspace-ID": randomUUID(), "Content-Type": "application/json" };
async function action(type: string, payload: object, headers: Record<string, string> = owner, requestId = randomUUID()) {
  return fetch(`${base}/api/action`, { method: "POST", headers, body: JSON.stringify({ type, payload, requestId }) });
}
beforeAll(async () => {
  vi.stubEnv("DATA_DIR", directory); vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ACCESS_TOKEN", "synthetic-owner-access"); vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("GOOGLE_CLIENT_ID", ""); vi.stubEnv("GOOGLE_CLIENT_SECRET", ""); vi.stubEnv("GOOGLE_REDIRECT_URI", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  const a=createIdentitySession({subject:"synthetic-a",email:"same@example.com",emailVerified:true});
  const b=createIdentitySession({subject:"synthetic-b",email:"same@example.com",emailVerified:true});
  const c=createIdentitySession({subject:"synthetic-c",email:"third@example.com",emailVerified:true});
  userA=a.session.userId;userB=b.session.userId;userC=c.session.userId;
  owner.Authorization=`Bearer ${a.token}`;
  Object.assign(visitor,{Authorization:`Bearer ${b.token}`});Object.assign(visitorTwo,{Authorization:`Bearer ${c.token}`});
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});
it("serves health while refusing anonymous access to workspace and Google routes", async () => {
  expect((await fetch(`${base}/api/health`)).status).toBe(200);
  expect((await fetch(`${base}/api/workspace`)).ok).toBe(false);
  expect((await fetch(`${base}/api/google/status`)).status).toBe(401);
});
it("isolates three Google identities, including two with the same email", async () => {
  expect((await action("task.create", { title: "Owner-specific synthetic task" })).ok).toBe(true);
  const first = await fetch(`${base}/api/workspace`, { headers: visitor }).then(r => r.json()) as WorkspaceState;
  expect(first.tasks.some(t => t.title === "Owner-specific synthetic task")).toBe(false);
  const response = await action("task.create", { title: "Visitor-specific synthetic task" }, visitor);
  expect(response.ok).toBe(true);
  const second = await fetch(`${base}/api/workspace`, { headers: visitorTwo }).then(r => r.json()) as WorkspaceState;
  expect(second.tasks.some(t => t.title === "Visitor-specific synthetic task")).toBe(false);
});
it("keeps live workspace mode independent of service grants and rejects invalid modes", async () => {
  expect((await action("settings.update", { mode: "live" }, visitor)).ok).toBe(true);
  expect((await action('calendar.read',{calendarId:'primary',start:'2026-10-05T00:00:00Z',end:'2026-10-06T00:00:00Z'},visitor)).ok).toBe(false);
  expect((await action('settings.update',{mode:'demo'},visitor)).ok).toBe(true);
  expect((await action("settings.update", { mode: "unexpected" })).ok).toBe(false);
  expect(readWorkspace(userA).settings.mode).toBe("demo");
});
it("rejects unapproved browser origins, including bearer-authenticated requests", async () => {
  const response = await fetch(`${base}/api/workspace`, { headers: { ...owner, Origin: "https://untrusted.example.com" } });
  expect(response.status).toBe(403);
});
it("persists request deduplication across database reopen", async () => {
  const requestId = randomUUID();
  expect((await action("task.create", { title: "Exactly once synthetic task" }, owner, requestId)).ok).toBe(true);
  closeDatabase();
  expect((await action("task.create", { title: "Exactly once synthetic task" }, owner, requestId)).ok).toBe(true);
  expect(readWorkspace(userA).tasks.filter(t => t.title === "Exactly once synthetic task")).toHaveLength(1);
  expect((await action("task.create", { title: "Changed contents" }, owner, requestId)).ok).toBe(false);
});
it("records failed commands without discarding earlier completed state", async () => {
  const requestId = randomUUID();
  const response = await action("task.update", { id: "missing-task", title: "No task" }, owner, requestId);
  expect(response.ok).toBe(false);
  const state = readWorkspace(userA);
  expect(state.runs[0].status).toBe("failed");
  expect(state.runs[0].requestId).toBe(requestId);
  expect(state.tasks.some(t => t.title === "Exactly once synthetic task")).toBe(true);
});
it("provides a model-free coded chat action with persistent history", async () => {
  const state = readWorkspace(userA);
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: owner, body: JSON.stringify({ agentId: state.agents[0].id, message: "add task: Prepare the synthetic demo" }) });
  expect(response.ok).toBe(true);
  const result = await response.json();
  expect(result.message).toContain("zero model calls");
  expect(result.state.tasks.some((t: {title:string}) => t.title === "Prepare the synthetic demo")).toBe(true);
});
it("encrypts stored tokens and preserves pending operation reservations", () => {
  setSecret("test-secret", { value: "synthetic-private-payload" });
  expect(getSecret<{value:string}>("test-secret")?.value).toBe("synthetic-private-payload");
  expect(readFileSync(join(directory, "proletariat.sqlite-wal")).includes(Buffer.from("synthetic-private-payload"))).toBe(false);
  expect(reserveOperation("test-pending", "fingerprint").reserved).toBe(true);
  closeDatabase();
  expect(reserveOperation("test-pending", "fingerprint").record.status).toBe("started");
  expect(reserveOperation("test-pending", "fingerprint").reserved).toBe(false);
});
it("pauses live queues and automatic workflows when OAuth grants change", async () => {
  const state = readWorkspace(userA); state.settings.mode = "live";
  state.campaigns = [{ id: "synthetic-campaign", name: "Example", subject: "Example", body: "Example", status: "running", recipients: [], mode: "live", createdAt: new Date().toISOString(), ratePerMinute: 1 }];
  state.scans = [{ id: "synthetic-scan", provider: "gmail", coverage: "all", status: "running", discovered: 1, read: 0, analyzed: 0, skipped: 0, failed: 0, createdAt: new Date().toISOString(), mode: "live" }];
  state.workflows[0].mode = "automatic"; state.workflows[0].enabled = true;
  state.attachments=[{id:'local-preserved',origin:'local',name:'local.txt',mimeType:'text/plain',content:'Local example',status:'ready',createdAt:new Date().toISOString(),mode:'live'},{id:'remote-removed',origin:'drive',name:'remote.txt',mimeType:'text/plain',content:'Previous Google source',status:'ready',createdAt:new Date().toISOString(),mode:'live'}];
  saveWorkspace(userA, state);
  await createGoogleDependencies(userA).tokenStore.save({ accessToken: "synthetic-test-token", connectionId: "synthetic-new-grant", expiresAt: Date.now()+100000, scopes: [] });
  const updated = readWorkspace(userA);
  expect(updated.campaigns[0].status).toBe("paused"); expect(updated.scans[0].status).toBe("paused"); expect(updated.workflows[0].enabled).toBe(false);
  expect(updated.resources).toEqual([]);expect(updated.events).toEqual([]);expect(updated.attachments?.map(item=>item.id)).toEqual(['local-preserved']);expect(updated.googleContextResetAt).toBeTruthy();
  const marker=updated.googleContextResetAt;
  await createGoogleDependencies(userA).tokenStore.save({accessToken:'synthetic-refreshed-token',connectionId:'synthetic-new-grant',expiresAt:Date.now()+100000,scopes:[]});
  expect(readWorkspace(userA).googleContextResetAt).toBe(marker);
});
it('denies every operational route without a session, including legacy owner keys',async()=>{
  for(const path of ['/api/workspace','/api/tasks','/api/attachments','/api/conversations','/api/runs','/api/worker','/api/chatgpt/status','/api/google/resources','/api/canvas/status']){
    const response=await fetch(base+path,{headers:{Authorization:'Bearer synthetic-owner-access','X-Workspace-ID':randomUUID()}});
    expect(response.status,path).toBe(401);
  }
  expect((await fetch(base+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'task.create',payload:{title:'Denied'}})})).status).toBe(401);
});
it('commits one canonical completion/removal across all API projections with retained history',async()=>{
  const response=await action('task.create',{title:'Canonical example',priority:'P1',categories:['Networking','Personal/Admin'],plannedDate:'2026-10-05',dueDate:'2026-10-09'}).then(r=>r.json());
  const id=response.entityId;
  for(const query of ['priority=P1','category=Networking','plannedDate=2026-10-05','dueDate=2026-10-09']){
    const tasks=await fetch(`${base}/api/tasks?${query}`,{headers:owner}).then(r=>r.json());expect(tasks.some((task:{id:string})=>task.id===id)).toBe(true);
  }
  expect((await fetch(`${base}/api/tasks/${id}`,{headers:visitorTwo})).status).toBe(404);
  expect((await action('task.update',{id,status:'done'})).ok).toBe(true);
  for(const query of ['priority=P1','category=Networking','plannedDate=2026-10-05','dueDate=2026-10-09']){
    const tasks=await fetch(`${base}/api/tasks?${query}`,{headers:owner}).then(r=>r.json());expect(tasks.some((task:{id:string})=>task.id===id)).toBe(false);
  }
  const completed=await fetch(`${base}/api/tasks/${id}`,{headers:owner}).then(r=>r.json());expect(completed.task.status).toBe('done');expect(completed.history.some((entry:{action:string})=>entry.action==='completed')).toBe(true);
  expect((await action('task.delete',{id})).ok).toBe(true);
  expect(readWorkspace(userA).tasks.find(task=>task.id===id)?.removedAt).toBeTruthy();
  expect((await action('task.restore',{id})).ok).toBe(true);expect(readWorkspace(userA).tasks.find(task=>task.id===id)?.removedAt).toBeUndefined();
});
it('rejects cross-user tasks, chats, uploads and attachment references',async()=>{
  const conversation=await action('conversation.create',{title:'A private chat'}).then(r=>r.json());
  const chatId=conversation.entityId;
  const upload=await fetch(`${base}/api/attachments/upload?conversationId=${chatId}&name=example.txt`,{method:'POST',headers:{...owner,'Content-Type':'application/octet-stream'},body:'Private synthetic attachment'});
  expect(upload.ok).toBe(true);const result=await upload.json();
  const foreignUpload=await fetch(`${base}/api/attachments/upload?conversationId=${chatId}&name=example.txt`,{method:'POST',headers:{...visitor,'Content-Type':'application/octet-stream'},body:'Not allowed'});expect(foreignUpload.ok).toBe(false);
  expect((await fetch(base+'/api/chat',{method:'POST',headers:visitor,body:JSON.stringify({conversationId:chatId,message:'Read the file'})})).ok).toBe(false);
  const b=await action('conversation.create',{title:'B private chat'},visitor).then(r=>r.json());
  expect((await action('conversation.attach',{id:b.entityId,attachmentIds:[result.entityId]},visitor)).ok).toBe(false);
  const task=readWorkspace(userA).tasks.find(task=>task.title==="Owner-specific synthetic task")!;expect((await action('task.update',{id:task.id,title:'Unauthorized change'},visitor)).ok).toBe(false);
  const bAttachments=await fetch(base+'/api/attachments',{headers:visitor}).then(r=>r.json());expect(bAttachments).toEqual([]);
});
it('isolates Google credentials, operation reservations and ChatGPT registrations',async()=>{
  const a=createGoogleDependencies(userA),b=createGoogleDependencies(userB);
  await a.tokenStore.save({accessToken:'synthetic-a-only',connectionId:'grant-a',expiresAt:Date.now()+100000,scopes:[]});
  expect(await b.tokenStore.load()).toBeUndefined();
  expect((await a.store.reserveOperation('same','a')).created).toBe(true);expect((await b.store.reserveOperation('same','b')).created).toBe(true);
  setSecret(`${userA}:chatgpt:profiles`,{activeId:'profile-a',profiles:[{id:'profile-a',clientId:'oaiapp_synthetic',subject:'synthetic-chatgpt',email:'plan@example.com',accessToken:'synthetic-plan-a',expiresAt:Date.now()+100000,scopes:['chatgpt.tokens.use.direct']}]});
  const statusA=await fetch(base+'/api/chatgpt/status',{headers:owner}).then(r=>r.json());const statusB=await fetch(base+'/api/chatgpt/status',{headers:visitor}).then(r=>r.json());
  expect(statusA.connected).toBe(true);expect(statusB.connected).toBe(false);expect(statusB.profiles).toEqual([]);expect(JSON.stringify(statusA)).not.toContain('synthetic-plan-a');
  expect((await fetch(base+'/api/chatgpt/select',{method:'POST',headers:visitor,body:JSON.stringify({id:'profile-a'})})).ok).toBe(false);
});
it('logs out only the calling user session and rejects its replay',async()=>{
  expect((await fetch(base+'/api/identity/logout',{method:'POST',headers:visitor,body:'{}'})).ok).toBe(true);
  expect((await fetch(base+'/api/workspace',{headers:visitor})).status).toBe(401);
  expect((await fetch(base+'/api/workspace',{headers:owner})).status).toBe(200);
});
it('never activates a shared paid API key for a user without their own ChatGPT grant',async()=>{
  vi.stubEnv('OPENAI_API_KEY','synthetic-global-key');vi.stubEnv('OPENAI_MODEL','synthetic-model');vi.stubEnv('MODEL_PROVIDER','api');vi.stubEnv('ALLOW_PAID_API','true');vi.stubEnv('MODEL_INPUT_USD_PER_MILLION','1');vi.stubEnv('MODEL_OUTPUT_USD_PER_MILLION','1');
  const state=readWorkspace(userC);
  const response=await fetch(base+'/api/chat',{method:'POST',headers:visitorTwo,body:JSON.stringify({agentId:state.agents[0].id,message:'Summarize the next steps'})});
  const result=await response.json();expect(result.message).toContain('No AI model is connected');expect(result.state.runs[0].modelCalls).toBe(0);
  expect((await fetch(base+'/api/workspace',{headers:visitorTwo}).then(r=>r.json())).connections.find((item:{provider:string})=>item.provider==='model').connected).toBe(false);
});
it('runs scheduled Daily work in its owning user workspace',async()=>{
  const c=readWorkspace(userC);c.settings.mode='demo';c.settings.timezone='UTC';c.workflows=[];c.campaigns=[];c.scans=[];c.permissions.gmailRead=true;c.dailyConfig={enabled:true,time:'00:00',gmailQuery:'newer_than:1d',calendarId:'primary'};saveWorkspace(userC,c);
  const prior=readWorkspace(userA).daily;
  await workerTick();
  expect(readWorkspace(userC).daily?.sources.some(source=>source.id==='demo-daily-gmail-project')).toBe(true);
  expect(readWorkspace(userA).daily).toEqual(prior);
});
it('preserves task identity/corrections on same verified Google data account reconnect and clears them on account change',async()=>{
  const dependencies=createGoogleDependencies(userC);
  await dependencies.tokenStore.save({accessToken:'synthetic-first',connectionId:'same-account-first',subject:'data-account-one',ownerSubject:'synthetic-c',expiresAt:Date.now()+100000,scopes:[]});
  const state=readWorkspace(userC);state.settings.mode='live';state.tasks=[{...readWorkspace(userA).tasks[0],id:'same-account-task',title:'User corrected',status:'done',sourceIds:['google:gmail:verified-account:message']}];saveWorkspace(userC,state);
  await dependencies.tokenStore.save({accessToken:'synthetic-reconnect',connectionId:'same-account-next',subject:'data-account-one',ownerSubject:'synthetic-c',expiresAt:Date.now()+100000,scopes:[]});
  expect(readWorkspace(userC).tasks).toMatchObject([{id:'same-account-task',title:'User corrected',status:'done'}]);
  await dependencies.tokenStore.save({accessToken:'synthetic-different',connectionId:'different-data-account',subject:'data-account-two',ownerSubject:'synthetic-c',expiresAt:Date.now()+100000,scopes:[]});
  expect(readWorkspace(userC).tasks).toEqual([]);
});
it('restores only the same verified Google account task archive after disconnect',async()=>{
  const dependencies=createGoogleDependencies(userC);
  await dependencies.tokenStore.clear();
  await dependencies.tokenStore.save({accessToken:'synthetic-account-one-return',connectionId:'account-one-restored',subject:'data-account-one',ownerSubject:'synthetic-c',expiresAt:Date.now()+100000,scopes:[]});
  expect(readWorkspace(userC).tasks).toMatchObject([{id:'same-account-task',title:'User corrected',status:'done'}]);
  expect(readWorkspace(userB).tasks.some(task=>task.id==='same-account-task')).toBe(false);
});
