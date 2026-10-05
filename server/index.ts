import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { DateTime } from "luxon";
import { configureGoogleIntegrationResolver, GoogleIntegration, getGoogleStatus } from "../src/lib/google/index";
import { createGoogleRouter } from "./google-router";
import { createGoogleDependencies } from "../src/lib/server/google-persistence";
import { dispatch, executeState } from "../src/lib/server/execute";
import { closeDatabase, getValue, persistResult, readWorkspace, recentDemoWorkspaces, saveWorkspace, setValue, withWorkspace } from "../src/lib/server/storage";
import { MAX_UPLOAD_BYTES, uploadIntoConversation } from "../src/lib/server/attachments";
import { attachToConversation, requireConversation } from "../src/lib/server/conversations";
import { modelConfigured, respondToChat } from "../src/lib/server/chat";
import { beginPlanSignIn, choosePlanModel, disconnectPlan, planConnected, planModels, planStatus, selectPlanProfile } from "../src/lib/server/chatgpt-plan";
import { isOwner, workspaceFor } from "./security";
import { createIdentityRouter, identitySession } from "./identity";
import { currentUserId, runAsUser } from "../src/lib/server/user-context";
import { canvasStatus, connectCanvas, disconnectCanvas } from "../src/lib/server/canvas-persistence";
import { workflowOccurrenceKey } from "../src/lib/domain/workflows";
import { selectTasks } from "../src/lib/domain/projections";
import type { ActionRequest, WorkspaceState } from "../src/lib/types";

const actionSchema=z.object({type:z.string().min(1).max(80),payload:z.record(z.string(),z.unknown()).optional(),requestId:z.string().min(1).max(200).optional()});
const chatSchema=z.object({agentId:z.string().min(1).max(100).optional(),conversationId:z.string().min(1).max(100).optional(),message:z.string().trim().min(1).max(12000),taskId:z.string().min(1).max(100).optional(),attachmentIds:z.array(z.string().min(1).max(100)).max(12).optional()}).refine(value=>!!value.agentId||!!value.conversationId);
let lastHeartbeat: string | undefined;
let workerRunning=false;

function allowedOrigins() {
  return (process.env.CORS_ORIGIN || (process.env.NODE_ENV==="production"?"https://tejprattipati.github.io":"http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173")).split(",").map(x=>x.trim()).filter(Boolean);
}

export function createApp() {
  getValue("initialization-check");
  const integrations=new Map<string,GoogleIntegration>();
  configureGoogleIntegrationResolver(()=>{const id=currentUserId();let integration=integrations.get(id);if(!integration){integration=new GoogleIntegration(createGoogleDependencies(id));integrations.set(id,integration);}return integration;});
  const app=express();
  app.disable("x-powered-by");
  app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Cache-Control","no-store"); const origin=req.get("origin"); if(origin&&!allowedOrigins().includes(origin)) {res.status(403).json({error:"This frontend origin is not allowed.",code:"ORIGIN_DENIED"});return;} next();});
  app.use(cors({origin:allowedOrigins(),credentials:true,allowedHeaders:["Content-Type","Authorization","X-Workspace-ID","Idempotency-Key"],methods:["GET","POST","PUT","PATCH","DELETE","OPTIONS"]}));
  app.use(express.json({limit:"200kb"}));
  const hits=new Map<string,{count:number;since:number}>();
  app.use("/api",(req,res,next)=>{ const key=req.socket.remoteAddress||"unknown";const now=Date.now();const hit=hits.get(key);if(!hit||now-hit.since>60000)hits.set(key,{count:1,since:now});else if(++hit.count>180){res.status(429).json({error:"Too many requests. Try again in a minute."});return;}if(hits.size>10000)hits.clear();next(); });
  app.get("/api/health",(_req,res)=>res.json({ok:true,service:"proletariat",worker:{busy:workerRunning,online:!!lastHeartbeat,lastHeartbeat}}));
  app.use('/api/identity',createIdentityRouter());
  app.use('/api',(req,_res,next)=>{const session=identitySession(req);if(session)runAsUser(session.userId,next);else next();});
  const oauthRouteKey=(value:string)=>`oauth-route:${createHash('sha256').update(value).digest('hex')}`;
  app.use('/api/google',(req,_res,next)=>{
    if(req.method==='GET'&&['/authorize','/callback'].includes(req.path)){
      const value=req.path==='/callback'?req.query.state:req.query.ticket;
      const route=typeof value==='string'?getValue<{userId:string;expiresAt:number}>(oauthRouteKey(value)):undefined;
      if(route&&route.expiresAt>Date.now()){runAsUser(route.userId,next);return;}
    }
    next();
  },createGoogleRouter({authorizeRequest:async(req)=>isOwner(req),getPermissions:async()=>readWorkspace(currentUserId()).permissions,bindPublicCallback:(state,ticket)=>{
    const value={userId:currentUserId(),expiresAt:Date.now()+600000};setValue(oauthRouteKey(state),value);setValue(oauthRouteKey(ticket),value);
  }}));
  app.use('/api',(req,res,next)=>{if(!isOwner(req)){res.status(401).json({error:'Sign in with Google to open your private workspace.',code:'SIGN_IN_REQUIRED'});return;}next();});
  app.use('/api/chatgpt',(req,res,next)=>{if(!isOwner(req)){res.status(401).json({error:'Owner access is required to connect a ChatGPT plan.'});return;}next();});
  app.get('/api/chatgpt/status',(_req,res)=>res.json(planStatus()));
  app.post('/api/chatgpt/authorize',async(req,res)=>res.json(await beginPlanSignIn(z.object({profileId:z.string().optional()}).parse(req.body).profileId)));
  app.get('/api/chatgpt/models',async(_req,res)=>res.json({models:await planModels()}));
  app.post('/api/chatgpt/model',async(req,res)=>{await choosePlanModel(z.object({model:z.string().min(1).max(100)}).parse(req.body).model);res.json(planStatus());});
  app.post('/api/chatgpt/select',(req,res)=>{selectPlanProfile(z.object({id:z.string().min(1).max(100)}).parse(req.body).id);res.json(planStatus());});
  app.post('/api/chatgpt/disconnect',async(_req,res)=>res.json(await disconnectPlan()));
  app.get('/api/canvas/status',(_req,res)=>res.json(canvasStatus()));
  app.post('/api/canvas/connect',async(req,res)=>{
    const input=z.object({baseUrl:z.string().url().max(500),token:z.string().min(1).max(4096)}).strict().parse(req.body);
    res.json(await connectCanvas(input.baseUrl,input.token));
  });
  app.post('/api/canvas/disconnect',async(_req,res)=>res.json(await disconnectCanvas()));
  async function decorateConnections(state: WorkspaceState, owner: boolean) {
    const google=owner?await getGoogleStatus():{provider:"google" as const,configured:false,connected:false,label:"Owner connection required for live Google access"};
    state.connections=[google,{provider:"model",configured:owner&&planStatus().configured,connected:owner&&planConnected(),label:owner&&planConnected()?planStatus().label:"Connect your ChatGPT plan in Connections · coded commands work without model usage"}];
    return state;
  }
  app.get("/api/workspace",async(req,res)=>res.json(await decorateConnections(readWorkspace(workspaceFor(req)),isOwner(req))));
  app.post("/api/action",async(req,res)=>{const action=actionSchema.parse(req.body);const result=await dispatch(workspaceFor(req),action,isOwner(req));await decorateConnections(result.state,isOwner(req));res.json(result);});
  app.post("/api/chat",async(req,res)=>{
    const body=chatSchema.parse(req.body);const id=workspaceFor(req);
    const result=await withWorkspace(id,async(state)=>{
      await decorateConnections(state,isOwner(req));
      const conversation=body.conversationId?requireConversation(state,body.conversationId):undefined;
      if(conversation&&body.attachmentIds)attachToConversation(state,conversation.id,body.attachmentIds);
      const agentId=conversation?.agentId??(conversation?state.agents[0]?.id:body.agentId);
      if(!agentId)throw new Error("Create an agent before starting a conversation.");
      const execute=async(current:WorkspaceState,action:ActionRequest)=>{const result=await executeState(current,action,partial=>{persistResult(id,partial);});persistResult(id,result);return result;};
      const result=await respondToChat(state,agentId,body.message,execute,isOwner(req)&&planConnected(),partial=>{persistResult(id,partial);},body.taskId,body.conversationId);return persistResult(id,result);
    });res.json(result);
  });
  app.post("/api/attachments/upload",express.raw({type:"application/octet-stream",limit:MAX_UPLOAD_BYTES}),async(req,res)=>{
    const id=workspaceFor(req);
    const conversationId=String(req.query.conversationId??""),name=String(req.query.name??"");
    if(!Buffer.isBuffer(req.body))throw new Error("Upload a file as application/octet-stream.");
    const result=await withWorkspace(id,async state=>{
      if(state.settings.mode==="live"&&!isOwner(req))throw new Error("Owner access is required for this workspace.");
      const result=await uploadIntoConversation(state,conversationId,name,req.body);return persistResult(id,result);
    });
    await decorateConnections(result.state,isOwner(req));res.json(result);
  });
  app.get('/api/tasks',(req,res)=>{
    const query=z.object({view:z.enum(['active','completed','removed','history','all']).optional(),priority:z.enum(['P0','P1','P2']).optional(),category:z.string().max(60).optional(),plannedDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),dueDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),status:z.enum(['open','in_progress','waiting','blocked','done']).optional(),q:z.string().max(300).optional()}).parse(req.query);
    res.json(selectTasks(readWorkspace(workspaceFor(req)),query));
  });
  app.get('/api/tasks/:id',(req,res)=>{
    const state=readWorkspace(workspaceFor(req)),task=state.tasks.find(item=>item.id===req.params.id);
    if(!task){res.status(404).json({error:'Task not found in this workspace.'});return;}
    res.json({task,history:(state.taskHistory??[]).filter(entry=>entry.taskId===task.id),runs:state.runs.filter(run=>run.taskId===task.id)});
  });
  for(const field of ["agents","resources","workflows","drafts","campaigns","runs","scans","conversations","attachments"] as const)app.get(`/api/${field}`,(req,res)=>res.json(readWorkspace(workspaceFor(req))[field]));
  app.post("/api/sync",async(req,res)=>res.json(await dispatch(workspaceFor(req),{type:"sync.run",payload:req.body,requestId:req.get("Idempotency-Key")||randomUUID()},isOwner(req))));
  app.post("/api/plan",async(req,res)=>res.json(await dispatch(workspaceFor(req),{type:"plan.generate",payload:req.body},isOwner(req))));
  app.post("/api/resources/resolve",async(req,res)=>res.json(await dispatch(workspaceFor(req),{type:"resource.bind",payload:req.body},isOwner(req))));
  for(const [path,type] of [["/api/gmail/drafts","draft.create"],["/api/gmail/send","draft.send"],["/api/campaigns","campaign.create"],["/api/calendar/events","calendar.upsert"],["/api/docs/write","docs.write"],["/api/scans","scan.start"]])app.post(path,async(req,res)=>res.json(await dispatch(workspaceFor(req),{type,payload:req.body,requestId:req.get("Idempotency-Key")||randomUUID()},isOwner(req))));
  app.get("/api/worker",(req,res)=>{workspaceFor(req);res.json({busy:workerRunning,online:!!lastHeartbeat,lastHeartbeat});});
  app.use((req,res)=>res.status(404).json({error:`Unknown API route: ${req.path}`}));
  const errorHandler:ErrorRequestHandler=(error,_req,res,_next)=>{
    const validation=error instanceof z.ZodError;
    const status=validation?400:Number(error.status||error.statusCode||400);
    res.status(status>=400&&status<600?status:400).json({error:validation?"The request is missing required fields or contains invalid values.":error instanceof Error?error.message:"Request failed.",code:error.code||"ACTION_FAILED"});
  };
  app.use(errorHandler);
  return app;
}

export async function workerTick() {
  if (workerRunning) return;
  workerRunning = true; lastHeartbeat = new Date().toISOString();
  try {
    for(const id of getValue<string[]>('identity:users')??[]) await runAsUser(id,()=>tickWorkspace(id));
  } finally { workerRunning = false; lastHeartbeat = new Date().toISOString(); }
}
async function tickWorkspace(id: string) {
  let state = readWorkspace(id);
  if (!id.startsWith('user:')) return;
  const now = new Date(), owner = true;
  const date = DateTime.fromJSDate(now, {zone:state.settings.timezone}).toISODate()!;
  if (getValue<string>(`${id}:usage-date`) !== date) {
    await withWorkspace(id, async current => {
      current.usage.modelCalls = 0; current.usage.inputTokens = 0; current.usage.outputTokens = 0; current.usage.estimatedCostUsd = 0;
      saveWorkspace(id, current); setValue(`${id}:usage-date`, date);
    });
  }
  if (state.settings.rolloverEnabled && state.today < date) await dispatch(id, {type:"plan.rollover",payload:{date},requestId:`rollover:${state.settings.timezone}:${date}`}, owner);
  state = readWorkspace(id);
  if(state.dailyConfig?.enabled){
    const due=DateTime.fromJSDate(now,{zone:state.settings.timezone}).toFormat("HH:mm")>=state.dailyConfig.time;
    const key=`daily:${id}:${date}`;
    const partial=state.daily?.date===date&&state.daily.providers.some(provider=>["partial","running"].includes(provider.status)&&!provider.error);
    if(due&&(!getValue(key)||partial)){
      try{await dispatch(id,{type:partial?"daily.resume":"daily.run",payload:{date},requestId:`${key}:${partial?Math.floor(now.getTime()/60000):"first"}`},owner);setValue(key,{at:now.toISOString()});}catch{setValue(key,{at:now.toISOString(),status:"failed"});}
    }
  }
  state = readWorkspace(id);
  if(state.canvasConfig?.enabled){
    const local=DateTime.fromJSDate(now,{zone:state.settings.timezone});
    const due=local.weekday>state.canvasConfig.weekday||(local.weekday===state.canvasConfig.weekday&&local.toFormat('HH:mm')>=state.canvasConfig.time);
    const key=`canvas-weekly:${id}:${local.weekYear}-${local.weekNumber}`;
    const partial=state.canvas?.report?.hasMore===true;
    if(due&&(!getValue(key)||partial)){
      try{await dispatch(id,{type:partial?'canvas.resume':'canvas.run',requestId:`${key}:${partial?Math.floor(now.getTime()/60000):'first'}`},owner);setValue(key,{at:now.toISOString()});}
      catch{setValue(key,{at:now.toISOString(),status:'failed'});}
    }
  }
  state = readWorkspace(id);
  for (const workflow of state.workflows.filter(item => item.enabled && item.mode === "automatic")) {
    const occurrence = workflowOccurrenceKey(workflow, now);
    if (!occurrence || getValue(`worker:${id}:${occurrence}`)) continue;
    try {
      await dispatch(id, {type:"workflow.run",payload:{id:workflow.id},requestId:occurrence}, owner);
      setValue(`worker:${id}:${occurrence}`, {status:"succeeded",at:now.toISOString()});
    } catch (error) {
      setValue(`worker:${id}:${occurrence}`, {status:"failed",at:now.toISOString(),error:error instanceof Error?error.message:"Failed"});
    }
  }
  state = readWorkspace(id);
  for (const campaign of state.campaigns.filter(item => item.status === "scheduled" && item.scheduledAt && new Date(item.scheduledAt) <= now)) {
    try { await dispatch(id, {type:"campaign.start",payload:{id:campaign.id},requestId:`scheduled-campaign:${campaign.id}:${campaign.scheduledAt}`}, owner); } catch { /* dispatch persists a visible failure receipt */ }
  }
  state = readWorkspace(id);
  for (const campaign of state.campaigns.filter(item => item.status === "running")) {
    try { await dispatch(id, {type:"campaign.resume",payload:{id:campaign.id},requestId:`campaign-tick:${campaign.id}:${Math.floor(now.getTime()/60000)}`}, owner); } catch { /* dispatch persists a visible failure receipt */ }
  }
  state = readWorkspace(id);
  for (const scan of state.scans.filter(item => ["running", "queued"].includes(item.status))) {
    try { await dispatch(id, {type:"scan.resume",payload:{id:scan.id},requestId:`scan-tick:${scan.id}:${Math.floor(now.getTime()/60000)}`}, owner); } catch { /* saved cursors allow explicit reconciliation */ }
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createApp();
  const port=Number(process.env.PORT||3001),host=process.env.HOST||"127.0.0.1";
  let activeTick: Promise<void> | undefined;
  const runWorker = () => { activeTick ??= workerTick().catch(() => console.error("Worker tick failed; inspect Activity and configuration.")).finally(() => { activeTick=undefined; }); };
  const server=app.listen(port,host,()=>{console.log(`proletariat API listening on ${host}:${port}`);runWorker();});
  const timer=setInterval(runWorker,60000);timer.unref();
  for(const signal of ["SIGINT","SIGTERM"] as const)process.on(signal,()=>{clearInterval(timer);server.close(async()=>{await activeTick;closeDatabase();process.exit(0);});});
}
