import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { DateTime } from "luxon";
import { configureGoogleIntegration, getGoogleStatus } from "../src/lib/google/index";
import { createGoogleRouter } from "./google-router";
import { googleDependencies } from "../src/lib/server/google-persistence";
import { dispatch, executeState } from "../src/lib/server/execute";
import { closeDatabase, getValue, persistResult, readWorkspace, recentDemoWorkspaces, saveWorkspace, setValue, withWorkspace } from "../src/lib/server/storage";
import { modelConfigured, respondToChat } from "../src/lib/server/chat";
import { isOwner, workspaceFor } from "./security";
import { workflowOccurrenceKey } from "../src/lib/domain/workflows";
import type { ActionRequest, WorkspaceState } from "../src/lib/types";

const actionSchema=z.object({type:z.string().min(1).max(80),payload:z.record(z.string(),z.unknown()).optional(),requestId:z.string().min(1).max(200).optional()});
const chatSchema=z.object({agentId:z.string().min(1).max(100),message:z.string().trim().min(1).max(12000),taskId:z.string().min(1).max(100).optional()});
let lastHeartbeat: string | undefined;
let workerRunning=false;

function allowedOrigins() {
  return (process.env.CORS_ORIGIN || (process.env.NODE_ENV==="production"?"https://tejprattipati.github.io":"http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173")).split(",").map(x=>x.trim()).filter(Boolean);
}

export function createApp() {
  getValue("initialization-check");
  configureGoogleIntegration(googleDependencies);
  const app=express();
  app.disable("x-powered-by");
  app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Cache-Control","no-store"); const origin=req.get("origin"); if(origin&&!allowedOrigins().includes(origin)) {res.status(403).json({error:"This frontend origin is not allowed.",code:"ORIGIN_DENIED"});return;} next();});
  app.use(cors({origin:allowedOrigins(),credentials:true,allowedHeaders:["Content-Type","Authorization","X-Workspace-ID","Idempotency-Key"],methods:["GET","POST","PUT","PATCH","DELETE","OPTIONS"]}));
  app.use(express.json({limit:"200kb"}));
  const hits=new Map<string,{count:number;since:number}>();
  app.use("/api",(req,res,next)=>{ const key=req.socket.remoteAddress||"unknown";const now=Date.now();const hit=hits.get(key);if(!hit||now-hit.since>60000)hits.set(key,{count:1,since:now});else if(++hit.count>180){res.status(429).json({error:"Too many requests. Try again in a minute."});return;}if(hits.size>10000)hits.clear();next(); });
  app.get("/api/health",(_req,res)=>res.json({ok:true,service:"proletariat",worker:{busy:workerRunning,online:!!lastHeartbeat,lastHeartbeat}}));
  app.use("/api/google",createGoogleRouter({authorizeRequest:async(req)=>isOwner(req),getPermissions:async()=>readWorkspace("owner").permissions}));
  async function snapshot(id: string, owner: boolean) {
    const state=readWorkspace(id);
    const google=owner?await getGoogleStatus():{provider:"google" as const,configured:false,connected:false,label:"Owner connection required for live Google access"};
    state.connections=[google,{provider:"model",configured:owner&&modelConfigured(),connected:owner&&modelConfigured(),label:owner&&modelConfigured()?`Model ready: ${process.env.OPENAI_MODEL}`:"Coded demo assistant · model key, model and pricing required for AI"}];
    return state;
  }
  app.get("/api/workspace",async(req,res)=>res.json(await snapshot(workspaceFor(req),isOwner(req))));
  app.post("/api/action",async(req,res)=>{const action=actionSchema.parse(req.body);res.json(await dispatch(workspaceFor(req),action,isOwner(req)));});
  app.post("/api/chat",async(req,res)=>{
    const body=chatSchema.parse(req.body);const id=workspaceFor(req);
    const result=await withWorkspace(id,async(state)=>{
      const execute=async(current:WorkspaceState,action:ActionRequest)=>{const result=await executeState(current,action,partial=>{persistResult(id,partial);});persistResult(id,result);return result;};
      const result=await respondToChat(state,body.agentId,body.message,execute,isOwner(req),partial=>{persistResult(id,partial);},body.taskId);return persistResult(id,result);
    });res.json(result);
  });
  for(const field of ["tasks","agents","resources","workflows","drafts","campaigns","runs","scans"] as const)app.get(`/api/${field}`,(req,res)=>res.json(readWorkspace(workspaceFor(req))[field]));
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
    for (const id of ["owner", ...recentDemoWorkspaces()]) await tickWorkspace(id);
  } finally { workerRunning = false; lastHeartbeat = new Date().toISOString(); }
}
async function tickWorkspace(id: string) {
  let state = readWorkspace(id);
  if (id !== "owner" && state.settings.mode !== "demo") return;
  const now = new Date(), owner = id === "owner";
  const date = DateTime.fromJSDate(now, {zone:state.settings.timezone}).toISODate()!;
  if (getValue<string>(`${id}:usage-date`) !== date) {
    await withWorkspace(id, async current => {
      current.usage.modelCalls = 0; current.usage.inputTokens = 0; current.usage.outputTokens = 0; current.usage.estimatedCostUsd = 0;
      saveWorkspace(id, current); setValue(`${id}:usage-date`, date);
    });
  }
  if (state.settings.rolloverEnabled && state.today < date) await dispatch(id, {type:"plan.rollover",payload:{date},requestId:`rollover:${state.settings.timezone}:${date}`}, owner);
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
