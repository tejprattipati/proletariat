import { createHash, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type { ActionRequest, ActionResult, WorkspaceState } from "../types";
import { applyAction } from "../domain/actions";
import { attachToConversation, conversationAction, requireConversation } from "./conversations";
import { configureDaily, runDaily } from "./daily";
import { interpretDaily } from "./audit-interpret";
import { configureCanvas, runCanvas } from "./canvas";
import { dispatchDemoCampaign } from "../domain/campaigns";
import { createDemoState } from "../domain/fixtures";
import { validateWorkflow } from "../domain/workflows";
import { executeGoogleAction, getGoogleStatus, isGoogleAction } from "../google/index";
import { finishOperation, getValue, persistResult, reserveOperation, setValue, withWorkspace } from "./storage";

type Checkpoint = (result: ActionResult) => void;

export async function executeState(state: WorkspaceState, action: ActionRequest, checkpoint?: Checkpoint): Promise<ActionResult> {
  if (action.type.startsWith("conversation.")) return conversationAction(state, action);
  if (action.type === "daily.configure") return configureDaily(state, action);
  if (["daily.run", "daily.resume"].includes(action.type)) return runDaily(state, action, executeGoogleAction);
  if (action.type === "daily.interpret") return interpretDaily(state, action, checkpoint);
  if (action.type === "canvas.configure") return configureCanvas(state, action);
  if (["canvas.run","canvas.resume"].includes(action.type)) return runCanvas(state, action);
  if (action.type === "attachment.attachDrive") {
    let current = structuredClone(state);
    requireConversation(current, action.payload?.conversationId);
    if (!current.permissions.driveRead) throw new Error("Enable Drive read before attaching a file.");
    const id = action.payload?.resourceId;
    let resource = current.resources.find(item => item.id === id);
    if (action.payload?.url || !resource?.bound) {
      const binding = await executeState(current, {type:"resource.bind",payload:{id:typeof id==="string"?id:undefined,url:action.payload?.url,role:"reference"},requestId:`${action.requestId}:bind`});
      current=binding.state; resource=current.resources.find(item=>item.id===binding.entityId);
    }
    if (!resource || resource.kind === "folder" || resource.mode !== current.settings.mode) throw new Error("Choose a file in this workspace, not a folder.");
    let attachmentId: string;
    let message: string;
    if (current.settings.mode === "live") {
      const result = await executeGoogleAction(current,{type:"attachment.read",payload:{resourceId:resource.id},requestId:action.requestId});
      current=result.state; attachmentId=String(result.entityId); message=result.message;
    } else {
      current.attachments ??= []; attachmentId=`attachment:${resource.id}`;
      const content=resource.content || `Synthetic reference: ${resource.name}. No Google account has been read.`;
      if (!current.attachments.some(item=>item.id===attachmentId)) current.attachments.push({id:attachmentId,name:resource.name,origin:"drive",mimeType:"text/plain",resourceId:resource.id,url:resource.url,content:content.slice(0,40000),status:"ready",truncated:content.length>40000,createdAt:new Date().toISOString(),mode:"demo"});
      message="Attached the synthetic Drive reference. No Google API or model call was used.";
    }
    attachToConversation(current,action.payload?.conversationId,[attachmentId]);
    return {state:current,entityId:attachmentId,message};
  }
  if (action.type === "settings.update" && action.payload?.mode !== undefined && !["demo", "live"].includes(String(action.payload.mode))) {
    throw new Error("Mode must be demo or live.");
  }
  if (state.settings.mode === "live" && action.type === "workflow.run") return runLiveWorkflow(state, action, checkpoint);
  if (state.settings.mode === "live" && isGoogleAction(action.type)) return executeGoogleAction(state, action);
  if (state.settings.mode === "demo" && action.type === "campaign.resume" && state.campaigns.some(campaign => campaign.id === action.payload?.id && campaign.status === "running")) {
    const next = dispatchDemoCampaign(state, String(action.payload?.id), new Date());
    next.usage.deterministicActions++;
    const message = "Synthetic campaign advanced within its rate limit. No real messages were sent.";
    next.runs.unshift({id:randomUUID(),title:"campaign.resume",description:message,status:"succeeded",createdAt:new Date().toISOString(),mode:"demo",modelCalls:0,tokens:0,apiCalls:0,writes:0,cacheHits:0,sourceIds:[String(action.payload?.id)]});
    return {state:next,message,entityId:String(action.payload?.id)};
  }
  const result = applyAction(state, action);
  if (action.type === "demo.reset") result.state.usage = {...state.usage};
  if (["workflow.create", "workflow.update"].includes(action.type) && result.entityId) {
    const workflow = result.state.workflows.find(item => item.id === result.entityId)!;
    for (const key of ["draftIds", "campaignIds"] as const) {
      const value = action.payload?.[key];
      if (value === undefined) continue;
      if (!Array.isArray(value) || !value.every(id => typeof id === "string")) throw new Error(`${key} must be an array of IDs.`);
      const collection = key === "draftIds" ? state.drafts : state.campaigns;
      if (value.some(id => !collection.some(item => item.id === id))) throw new Error(`Choose existing ${key === "draftIds" ? "drafts" : "campaigns"}.`);
      workflow[key] = [...new Set(value)];
    }
  }
  return result;
}

export async function dispatch(workspaceId: string, action: ActionRequest, owner: boolean): Promise<ActionResult> {
  if (action.type === "recipe.resume") {
    const originalId = action.payload?.requestId;
    if (typeof originalId !== "string") throw new Error("Choose the original recipe run to resume.");
    const original = getValue<ActionRequest>(`recipe-request:${workspaceId}:${originalId}`);
    if (!original) throw new Error("The original recipe request is unavailable.");
    action = original;
  }
  return withWorkspace(workspaceId, async state => {
    if (action.type === "settings.update" && action.payload?.mode !== undefined) {
      const destination = action.payload.mode;
      if (destination !== "demo" && destination !== "live") throw new Error("Mode must be demo or live.");
      if (destination !== state.settings.mode) {
        if (destination === "live") {
          if (!owner) throw new Error("Owner access is required for live mode.");
          // Live mode is an owned workspace choice, independent of which data
          // provider is connected. Each external action enforces its own grant.
        }
        setValue(`${workspaceId}:saved:${state.settings.mode}`, state);
        let next = getValue<WorkspaceState>(`${workspaceId}:saved:${destination}`);
        if (!next) {
          next = createDemoState();
          next.settings = { ...state.settings, mode: destination };
          next.permissions = { ...state.permissions };
          if (destination === "live") {
            next.tasks = []; next.events = []; next.plan = []; next.resources = []; next.workflows = [];
            next.drafts = []; next.campaigns = []; next.runs = []; next.scans = []; next.processedKeys = []; next.recipes = []; next.conversations = []; next.attachments = []; delete next.daily;
            next.agents = next.agents.map(agent => ({ ...agent, messages: [], resourceIds: [], workflowIds: [], summary: "Ready for your live workflow.", unread: 0, status: "quiet" }));
          }
        }
        // A mode switch is a dataset switch, not a way to reset the owner's daily model budget.
        next.usage = { ...state.usage };
        next.permissions = { ...state.permissions };
        return persistResult(workspaceId, { state: next, message: `Switched to ${destination} mode. Each mode keeps separate records.` });
      }
    }
    if (state.settings.mode === "live" && !owner) throw new Error("Owner access is required for live actions.");
    const requestId = action.requestId || randomUUID();
    const fingerprint = createHash("sha256").update(JSON.stringify({ type: action.type, payload: action.payload || {} })).digest("hex");
    const key = `request:${workspaceId}:${requestId}`;
    const claim = reserveOperation(key, fingerprint);
    if (!claim.reserved) {
      if (action.type !== "recipe.run") {
        if (claim.record.status === "succeeded") return { state, message: "This request was already processed." };
        throw new Error("This request is already running or has an uncertain result. Check Activity before retrying.");
      }
    }
    if (action.type === "recipe.run") setValue(`recipe-request:${workspaceId}:${requestId}`, {...action, requestId});
    let progress = state;
    const checkpoint: Checkpoint = result => { progress = result.state; persistResult(workspaceId, result); };
    try {
      const result = await executeState(state, { ...action, requestId }, checkpoint);
      for (const run of result.state.runs) if (!state.runs.some(previous => previous.id === run.id)) run.requestId = requestId;
      // Google mutates the supplied state; its newest receipt therefore also needs an explicit request link.
      if (result.state.runs[0]) result.state.runs[0].requestId ??= requestId;
      persistResult(workspaceId, result);
      finishOperation(key, { message: result.message, entityId: result.entityId });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action failed.";
      // Retain completed steps and failed scan progress even if a later operation fails.
      progress.runs.unshift({ id: randomUUID(), title: action.type, description: message, status: "failed", createdAt: new Date().toISOString(), mode: progress.settings.mode, modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0, sourceIds: [], requestId, taskId: progress.tasks.some(task => task.id === action.payload?.taskId) ? String(action.payload?.taskId) : undefined, recipeId: action.type === "recipe.run" ? String(action.payload?.id) : undefined, workflowId: action.type === "workflow.run" ? String(action.payload?.id) : undefined });
      persistResult(workspaceId, { state: progress, message });
      finishOperation(key, { error: message }, "unknown");
      throw error;
    }
  });
}

async function runLiveWorkflow(state: WorkspaceState, request: ActionRequest, checkpoint?: Checkpoint): Promise<ActionResult> {
  const workflow = state.workflows.find(item => item.id === request.payload?.id);
  if (!workflow) throw new Error("Workflow not found.");
  if (!workflow.enabled) throw new Error("Enable this workflow before running it.");
  if (workflow.mode === "review" && request.payload?.confirmed !== true) throw new Error("Review this workflow and run it explicitly before execution.");
  validateWorkflow(workflow, state);
  const outputs = state.resources.filter(resource => workflow.resourceIds.includes(resource.id) && resource.role === "output" && resource.kind === "document");
  if (workflow.actions.includes("docs_write") && outputs.some(resource => !resource.namedRangeId)) throw new Error("Each document output needs a managed named range before this workflow can run.");
  if (workflow.actions.includes("calendar_upsert") && !workflow.calendarId) throw new Error("Choose a destination calendar before running this workflow.");
  const draftIds = workflow.draftIds ?? [];
  const campaignIds = workflow.campaignIds ?? [];
  if (workflow.actions.some(step => step === "draft" || step === "send") && (!draftIds.length || draftIds.some(id => !state.drafts.some(draft => draft.id === id && draft.mode === "live")))) throw new Error("Bind an existing live draft with its exact recipient and content to this workflow.");
  if (workflow.actions.includes("campaign") && (!campaignIds.length || campaignIds.some(id => !state.campaigns.some(campaign => campaign.id === id && campaign.mode === "live")))) throw new Error("Bind an existing live campaign with its recipient list to this workflow.");
  let current = structuredClone(state);
  const messages: string[] = [];
  async function run(action: ActionRequest) {
    const result = isGoogleAction(action.type) ? await executeGoogleAction(current, action) : applyAction(current, action);
    current = result.state; messages.push(result.message); checkpoint?.(result);
    if (current.runs[0] && ["failed", "unknown", "conflict"].includes(current.runs[0].status)) throw new Error(`Workflow paused: ${result.message}`);
  }
  for (const step of workflow.actions) {
    if (step === "extract_tasks") await run({ type: "sync.run", payload: { provider: workflow.resourceIds.length ? "drive" : "gmail", query: workflow.query, resourceIds: workflow.resourceIds }, requestId: `${request.requestId}:sync` });
    if (step === "rollover") await run({ type: "plan.rollover", payload: { date: DateTime.now().setZone(workflow.timezone).toISODate() } });
    if (step === "plan") await run({ type: "plan.generate", payload: { date: current.today } });
    if (step === "docs_write") {
      const content = `Daily plan — ${current.today}\n${current.tasks.filter(task => task.status !== "done").map(task => `${task.priority} · ${task.title} · ${task.estimateMinutes} min${task.dueDate ? ` · due ${task.dueDate}` : ""}`).join("\n")}`;
      for (const resource of outputs) await run({ type: "docs.write", payload: { resourceId: resource.id, content }, requestId: `${request.requestId}:docs:${resource.id}` });
    }
    if (step === "calendar_upsert") {
      for (const block of current.plan) {
        const task = current.tasks.find(item => item.id === block.taskId);
        if (!task) continue;
        const binding = `${workflow.id}:${task.id}:${block.start.slice(0, 10)}`;
        const existing = current.events.find(event => event.calendarId === workflow.calendarId && event.sourceIds.includes(binding));
        await run({ type: "calendar.upsert", payload: { ...(existing ? { id: existing.id } : {}), title: task.title, start: block.start, end: block.end, calendarId: workflow.calendarId }, requestId: `${request.requestId}:calendar:${block.id}` });
        const created = current.events.find(event => event.calendarId === workflow.calendarId && event.title === task.title && event.start === block.start && event.end === block.end);
        if (created) { created.sourceIds = [...new Set([...created.sourceIds, binding, task.id])]; checkpoint?.({ state: current, message: "Calendar block binding saved." }); }
      }
    }
    if (step === "draft") for (const id of draftIds) {
      const draft = current.drafts.find(item => item.id === id)!;
      if (draft.status === "accepted") continue;
      await run({ type: "draft.update", payload: { id }, requestId: `${request.requestId}:draft:${id}` });
    }
    if (step === "send") for (const id of draftIds) await run({ type: "draft.send", payload: { id }, requestId: `${request.requestId}:send:${id}` });
    if (step === "campaign") for (const id of campaignIds) {
      const campaign = current.campaigns.find(item => item.id === id)!;
      if (campaign.status === "completed" || campaign.status === "cancelled") continue;
      await run({ type: campaign.status === "running" ? "campaign.resume" : "campaign.start", payload: { id }, requestId: `${request.requestId}:campaign:${id}` });
    }
  }
  current.workflows = current.workflows.map(item => item.id === workflow.id ? { ...item, lastRunAt: new Date().toISOString() } : item);
  return { state: current, entityId: workflow.id, message: messages.join(" ") || "Workflow completed. No changes were needed." };
}
