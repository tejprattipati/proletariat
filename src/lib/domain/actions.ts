import { DateTime } from "luxon";
import type { ActionRequest, ActionResult, Agent, Campaign, PermissionKey, Recipe, Resource, Run, ScanJob, Task, Workflow, WorkflowAction, WorkspaceState } from "../types";
import { assert, finiteNumber, localDate, operationKey, stableId, text, unique, validateDate, validateTimezone } from "./core";
import { createDemoState } from "./fixtures";
import { generatePlan, validateInterval } from "./planner";
import { ingestTaskCandidates, rolloverTasks } from "./tasks";
import { deduplicateRecipients, dispatchDemoCampaign, normalizeEmail, transitionCampaign } from "./campaigns";
import { interpretIntent, requirePermission, validateWorkflow, workflowOccurrenceKey } from "./workflows";
import { runDemoRecipe, validateRecipe } from "./recipes";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",") + "}";
  return JSON.stringify(value);
}

function find<T extends { id: string }>(items: T[], id: unknown, kind: string): T {
  const value = items.find(item => item.id === id);
  assert(value, `${kind} was not found.`, "NOT_FOUND");
  return value;
}

function boolean(value: unknown, field: string): boolean {
  assert(typeof value === "boolean", `${field} must be a boolean.`);
  return value;
}

function strings(value: unknown, field: string): string[] {
  assert(Array.isArray(value) && value.every(item => typeof item === "string"), `${field} must be a list of strings.`);
  return unique(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field);
}

function taskChanges(task: Task, p: Record<string, unknown>, state: WorkspaceState, timestamp: string): void {
  if (p.title !== undefined) task.title = text(p.title, "Title");
  if (p.notes !== undefined) { assert(typeof p.notes === "string", "Notes must be text."); task.notes = p.notes; }
  if (p.status !== undefined) {
    assert(["open", "in_progress", "waiting", "done"].includes(String(p.status)), "Unsupported task status.");
    task.status = p.status as Task["status"];
    task.completedAt = task.status === "done" ? task.completedAt ?? timestamp : undefined;
  }
  if (p.priority !== undefined) { assert(["P0", "P1", "P2"].includes(String(p.priority)), "Unsupported priority."); task.priority = p.priority as Task["priority"]; }
  if (p.estimateMinutes !== undefined) task.estimateMinutes = finiteNumber(p.estimateMinutes, "Estimate", 30);
  if (p.plannedDate !== undefined) task.plannedDate = validateDate(text(p.plannedDate, "Planned date"));
  for (const field of ["dueDate", "nextActionDate"] as const) if (field in p) { const value = optionalString(p[field], field); task[field] = value ? validateDate(value) : undefined; }
  if ("dueTime" in p) {
    const value = optionalString(p.dueTime, "Due time");
    assert(!value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value), "Due time must use HH:mm.");
    task.dueTime = value;
  }
  if ("agentId" in p) {
    const id = optionalString(p.agentId, "Agent");
    if (id) find(state.agents, id, "Agent");
    task.agentId = id;
  }
  if (p.pinned !== undefined) task.pinned = boolean(p.pinned, "Pinned");
  if (p.splittable !== undefined) task.splittable = boolean(p.splittable, "Splittable");
  if ("needsInput" in p) task.needsInput = optionalString(p.needsInput, "Pending decision");
  task.updatedAt = timestamp;
}

function readDemoSources(state: WorkspaceState, provider: "gmail" | "drive", resourceIds?: string[], includeAll = false): WorkspaceState {
  requirePermission(state.permissions, provider === "gmail" ? "gmailRead" : "driveRead");
  if (provider === "gmail") return ingestTaskCandidates(state, [{ sourceId: "demo-email-project", sourceVersion: "1", itemId: "project-followup", title: "Reply to the example project check-in", plannedDate: state.today, estimateMinutes: 15, notes: "Synthetic message from alex@example.com.", agentId: state.agents[0]?.id }]);
  const candidates = state.resources.filter(resource => (includeAll || resource.bound) && (!resourceIds || resourceIds.includes(resource.id)))
    .flatMap(resource => (resource.content ?? "").split("\n").flatMap((line, index) => {
      const match = line.match(/^\s*(?:task|todo|session|action):\s*(.+)$/i);
      return match ? [{ sourceId: resource.id, sourceVersion: resource.modifiedAt, itemId: `line-${index}`, title: match[1].trim(), plannedDate: state.today, estimateMinutes: 30, notes: `Extracted from synthetic resource ${resource.name}.` }] : [];
    }));
  return ingestTaskCandidates(state, candidates);
}

function planIntoState(state: WorkspaceState, date: string, now: Date): { state: WorkspaceState; message: string } {
  const result = generatePlan(state, date, { now });
  const zone = state.settings.timezone;
  const dayStart = DateTime.fromISO(date, { zone }).startOf("day").toMillis();
  const dayEnd = DateTime.fromISO(date, { zone }).plus({ days: 1 }).startOf("day").toMillis();
  const otherDays = state.plan.filter(block => Date.parse(block.end) <= dayStart || Date.parse(block.start) >= dayEnd);
  state.plan = [...otherDays, ...result.blocks];
  const message = `Plan generated for ${date}. ${result.unscheduledTaskIds.length} task(s) have work remaining outside available hours.${result.conflicts.length ? ` ${result.conflicts.join(" ")}` : ""}`;
  return { state, message };
}

/** Pure reducer: all writes occur on a clone and failures leave the input unchanged. */
export function applyAction(input: WorkspaceState, action: ActionRequest, now = new Date()): ActionResult {
  assert(Number.isFinite(now.getTime()), "A valid execution time is required.");
  assert(action && typeof action.type === "string", "An action type is required.");
  assert(action.payload === undefined || (action.payload !== null && typeof action.payload === "object" && !Array.isArray(action.payload)), "Payload must be an object.");
  const p = action.payload ?? {};
  if (action.requestId !== undefined) text(action.requestId, "Request ID");
  const requestPrefix = action.requestId ? `${operationKey("request", action.requestId)}:` : undefined;
  const signature = canonical({ type: action.type, payload: p });
  const processed = requestPrefix ? input.processedKeys.find(key => key.startsWith(requestPrefix)) : undefined;
  if (processed) {
    const prior = JSON.parse(processed.slice(requestPrefix!.length)) as { signature: string; entityId?: string; message: string };
    assert(prior.signature === signature, "Request ID was already used for a different action.", "IDEMPOTENCY_CONFLICT");
    return { state: structuredClone(input), message: prior.message, entityId: prior.entityId };
  }
  let state = structuredClone(input);
  state.recipes ??= [];
  const timestamp = now.toISOString();
  const id = (kind: string) => stableId(kind, action.type, action.requestId ?? timestamp, state.version);
  let entityId: string | undefined;
  let receiptTaskId = optionalString(p.taskId, "Task ID");
  if (receiptTaskId) find(state.tasks, receiptTaskId, "Task");
  let recipeId: string | undefined;
  let receiptStatus: Run["status"] = "succeeded";
  let receiptAgentId: string | undefined;
  let receiptSourceIds: string[] = [];
  let message = "Action completed.";
  const externalActions = new Set(["resource.bind", "resource.browse", "sync.run", "scan.start", "scan.pause", "scan.resume", "draft.create", "draft.update", "draft.send", "calendar.upsert", "docs.write", "campaign.start", "campaign.resume", "recipe.run"]);
  assert(state.settings.mode === "demo" || !externalActions.has(action.type), "This action requires the live Google adapter.", "LIVE_ADAPTER_REQUIRED");

  switch (action.type) {
    case "task.create": {
      const task: Task = { id: id("task"), title: text(p.title, "Title"), status: "open", priority: "P1", plannedDate: state.today,
        estimateMinutes: 30, notes: "", sourceIds: [], carryoverCount: 0 };
      taskChanges(task, p, state, timestamp);
      state.tasks.push(task); entityId = task.id; receiptTaskId = task.id; message = "Task created."; break;
    }
    case "task.update": {
      const task = find(state.tasks, p.id, "Task");
      taskChanges(task, p, state, timestamp);
      if (task.status === "done") state.plan = state.plan.filter(block => block.taskId !== task.id);
      else {
        if (p.pinned !== undefined) state.plan = state.plan.map(block => block.taskId === task.id ? { ...block, pinned: task.pinned! } : block);
        if (["plannedDate", "estimateMinutes", "dueDate", "dueTime", "status", "nextActionDate"].some(field => field in p)) state.plan = state.plan.filter(block => block.taskId !== task.id || block.pinned);
      }
      entityId = task.id; receiptTaskId = task.id; message = "Task updated."; break;
    }
    case "task.delete": {
      const task = find(state.tasks, p.id, "Task");
      state.tasks = state.tasks.filter(item => item.id !== task.id);
      state.plan = state.plan.filter(block => block.taskId !== task.id);
      state.processedKeys.push(operationKey("task-deleted", task.id));
      entityId = task.id; receiptTaskId = task.id; receiptAgentId = task.agentId; receiptSourceIds = task.sourceIds;
      message = "Task deleted."; break;
    }
    case "task.reply": {
      const task = find(state.tasks, p.taskId ?? p.id, "Task");
      assert(task.agentId, "Assign this task to an existing agent before saving a contextual note.");
      const agent = find(state.agents, task.agentId, "Agent");
      assert(p.agentId === undefined || p.agentId === agent.id, "This task belongs to a different agent.");
      const content = text(p.message, "Message");
      assert(content.length <= 20_000, "Task notes must be at most 20000 characters.");
      agent.messages.push({ id: id("message"), role: "user", content, createdAt: timestamp, taskId: task.id, entityIds: [task.id] });
      agent.lastActiveAt = timestamp; agent.unread = 0; agent.status = "updated";
      agent.summary = `Note saved for ${task.title}.`;
      task.updatedAt = timestamp;
      entityId = task.id; receiptTaskId = task.id; receiptAgentId = agent.id;
      message = "Contextual note saved on the existing task. No model was called or assistant reply generated.";
      break;
    }
    case "recipe.create":
    case "recipe.update": {
      const previous = action.type === "recipe.update" ? find(state.recipes, p.id, "Recipe") : undefined;
      const recipe: Recipe = {
        id: previous?.id ?? id("recipe"), name: text(p.name, "Recipe name", previous?.name),
        referenceResourceId: text(p.referenceResourceId, "Reference document", previous?.referenceResourceId),
        destinationFolderId: text(p.destinationFolderId, "Destination folder", previous?.destinationFolderId),
        agentId: "agentId" in p ? optionalString(p.agentId, "Agent") : previous?.agentId,
        createdAt: previous?.createdAt ?? timestamp,
      };
      validateRecipe(state, recipe);
      state.recipes = [...state.recipes.filter(item => item.id !== recipe.id), recipe];
      entityId = recipe.id; recipeId = recipe.id; receiptAgentId = recipe.agentId; receiptSourceIds = [recipe.referenceResourceId];
      message = "Reusable document recipe saved."; break;
    }
    case "recipe.run": {
      const recipe = find(state.recipes, p.id, "Recipe");
      const output = runDemoRecipe(state, recipe, id("resource"), {
        title: text(p.title, "Document title"), context: text(p.context, "Context"), person: optionalString(p.person, "Person"), taskId: receiptTaskId,
      }, now);
      state.resources.push(output);
      entityId = output.id; recipeId = recipe.id; receiptAgentId = recipe.agentId; receiptSourceIds = [recipe.referenceResourceId];
      const task = receiptTaskId ? find(state.tasks, receiptTaskId, "Task") : undefined;
      if (task) { task.updatedAt = timestamp; receiptAgentId = task.agentId ?? recipe.agentId; }
      message = "Created a synthetic personalized document in the bound destination folder. The reference is unchanged; no Google API or model was called.";
      break;
    }
    case "plan.generate": {
      const result = planIntoState(state, validateDate(text(p.date, "Date", state.today)), now);
      message = result.message; break;
    }
    case "plan.rollover": {
      state = rolloverTasks(state, validateDate(text(p.date, "Date")));
      message = state.settings.rolloverEnabled ? "Unfinished tasks rolled forward; original deadlines preserved." : "Workspace date advanced; automatic rollover is disabled."; break;
    }
    case "settings.update": {
      if (p.timezone !== undefined) state.settings.timezone = validateTimezone(text(p.timezone, "Timezone"));
      if (p.workingHoursStart !== undefined) state.settings.workingHoursStart = text(p.workingHoursStart, "Working hours start");
      if (p.workingHoursEnd !== undefined) state.settings.workingHoursEnd = text(p.workingHoursEnd, "Working hours end");
      if (p.rolloverEnabled !== undefined) state.settings.rolloverEnabled = boolean(p.rolloverEnabled, "Rollover");
      if (p.mode !== undefined) { assert(p.mode === "demo" || p.mode === "live", "Mode must be demo or live."); state.settings.mode = p.mode; }
      generatePlan({ ...state, tasks: [], events: [], plan: [] });
      message = "Settings updated."; break;
    }
    case "permissions.update": {
      for (const [key, value] of Object.entries(p)) {
        assert(Object.hasOwn(state.permissions, key), `Unknown permission ${key}.`);
        state.permissions[key as PermissionKey] = boolean(value, key);
      }
      message = "Permissions updated. Queued execution will use these permissions."; break;
    }
    case "usage.update": {
      state.usage.dailyBudgetUsd = finiteNumber(p.dailyBudgetUsd, "Daily budget", state.usage.dailyBudgetUsd, 0, 1_000_000);
      message = "Daily budget updated."; break;
    }
    case "demo.reset": state = createDemoState(now); message = "Synthetic demo workspace reset."; break;
    case "agent.create": {
      const name = text(p.name, "Name");
      const agent: Agent = { id: id("agent"), name, description: text(p.description, "Description", ""), initials: name.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase(),
        color: "#7569e8", status: "quiet", summary: "Ready for a workflow.", pinned: false, unread: 0, lastActiveAt: timestamp, resourceIds: [], workflowIds: [], messages: [] };
      state.agents.push(agent); entityId = agent.id; message = "Agent created."; break;
    }
    case "agent.update": {
      const agent = find(state.agents, p.id, "Agent");
      if (p.name !== undefined) { agent.name = text(p.name, "Name"); agent.initials = agent.name.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase(); }
      if (p.description !== undefined) { assert(typeof p.description === "string", "Description must be text."); agent.description = p.description; }
      if (p.pinned !== undefined) agent.pinned = boolean(p.pinned, "Pinned");
      entityId = agent.id; message = "Agent updated."; break;
    }
    case "workflow.create":
    case "workflow.update": {
      const previous = action.type === "workflow.update" ? find(state.workflows, p.id, "Workflow") : undefined;
      const intent = text(p.intent, "Intent", previous?.intent);
      const workflow: Workflow = { id: previous?.id ?? id("workflow"), name: text(p.name, "Name", previous?.name ?? "New workflow"), intent,
        agentId: text(p.agentId, "Agent", previous?.agentId ?? state.agents[0]?.id), enabled: p.enabled === undefined ? previous?.enabled ?? true : boolean(p.enabled, "Enabled"), version: (previous?.version ?? 0) + 1,
        mode: (p.mode ?? previous?.mode ?? "review") as Workflow["mode"], trigger: (p.trigger ?? previous?.trigger ?? "manual") as Workflow["trigger"],
        query: p.query === undefined ? previous?.query ?? "" : String(p.query), actions: p.actions === undefined ? (p.intent === undefined && previous ? previous.actions : interpretIntent(intent)) : strings(p.actions, "Actions") as WorkflowAction[],
        resourceIds: p.resourceIds === undefined ? previous?.resourceIds ?? [] : strings(p.resourceIds, "Resources"), timezone: text(p.timezone, "Timezone", previous?.timezone ?? state.settings.timezone),
        schedule: p.schedule === undefined ? previous?.schedule : optionalString(p.schedule, "Schedule"), calendarId: p.calendarId === undefined ? previous?.calendarId : optionalString(p.calendarId, "Calendar"),
        recipientIds: p.recipientIds === undefined ? previous?.recipientIds : strings(p.recipientIds, "Recipients"), draftIds: p.draftIds === undefined ? previous?.draftIds : strings(p.draftIds, "Drafts"), campaignIds: p.campaignIds === undefined ? previous?.campaignIds : strings(p.campaignIds, "Campaigns"), lastRunAt: previous?.lastRunAt };
      validateWorkflow(workflow, state);
      state.workflows = [...state.workflows.filter(item => item.id !== workflow.id), workflow];
      for (const agent of state.agents) agent.workflowIds = agent.workflowIds.filter(value => value !== workflow.id);
      find(state.agents, workflow.agentId, "Agent").workflowIds.push(workflow.id);
      entityId = workflow.id; message = "Workflow validated and saved."; break;
    }
    case "workflow.run": {
      const workflow = find(state.workflows, p.id, "Workflow");
      receiptAgentId = workflow.agentId; receiptSourceIds = [...workflow.resourceIds];
      assert(workflow.enabled, "Workflow is disabled.");
      assert(workflow.mode !== "review" || p.confirmed === true, "Review this workflow and confirm it before execution.", "REVIEW_REQUIRED");
      validateWorkflow(workflow, state);
      const occurrence = workflowOccurrenceKey(workflow, now);
      if (occurrence && state.processedKeys.includes(occurrence)) { entityId = workflow.id; message = "This workflow occurrence has already run."; break; }
      const external = workflow.actions.some(value => ["extract_tasks", "calendar_upsert", "docs_write", "draft", "send", "campaign"].includes(value));
      assert(state.settings.mode === "demo" || !external, "Live source and write workflows require the Google adapter.", "LIVE_ADAPTER_REQUIRED");
      // Validate unresolved destinations before any execution, even when permissions are enabled.
      if (workflow.actions.includes("send")) assert(workflow.draftIds?.length && workflow.draftIds.every(id => state.drafts.some(draft => draft.id === id)), "Sending workflows require explicit reviewed draft IDs.", "DESTINATION_REQUIRED");
      if (workflow.actions.includes("campaign")) assert(workflow.campaignIds?.length && workflow.campaignIds.every(id => state.campaigns.some(campaign => campaign.id === id)), "Sending workflows require explicit reviewed campaign IDs.", "DESTINATION_REQUIRED");
      for (const step of workflow.actions) {
        if (step === "rollover") state = rolloverTasks(state, localDate(now, state.settings.timezone));
        if (step === "extract_tasks") state = readDemoSources(state, workflow.resourceIds.length ? "drive" : "gmail", workflow.resourceIds);
        if (step === "plan") message = planIntoState(state, state.today, now).message;
        if (step === "calendar_upsert") {
          for (const block of state.plan) {
            const task = find(state.tasks, block.taskId, "Task");
            const eventId = stableId("event", workflow.id, task.id, block.start);
            const event = { id: eventId, title: task.title, start: block.start, end: block.end, calendarId: workflow.calendarId ?? "demo-primary", status: "confirmed" as const, sourceIds: [task.id] };
            state.events = [...state.events.filter(value => value.id !== eventId), event];
          }
        }
        if (step === "docs_write") {
          const resource = state.resources.find(value => workflow.resourceIds.includes(value.id) && value.role === "output" && value.kind === "document")!;
          resource.content = `Synthetic workflow summary for ${state.today}\n${state.tasks.map(task => `- ${task.title} (${task.status})`).join("\n")}`;
          resource.modifiedAt = timestamp;
        }
        if (step === "send") for (const draftId of workflow.draftIds!) state = applyAction(state, { type: "draft.send", payload: { id: draftId }, requestId: `${action.requestId ?? occurrence ?? timestamp}:send:${draftId}` }, now).state;
        if (step === "campaign") for (const campaignId of workflow.campaignIds!) {
          const campaign = find(state.campaigns, campaignId, "Campaign");
          if (campaign.status === "completed" || campaign.status === "cancelled") continue;
          if (campaign.status === "running") state = dispatchDemoCampaign(state, campaignId, now);
          else state = applyAction(state, { type: campaign.status === "paused" ? "campaign.resume" : "campaign.start", payload: { id: campaignId }, requestId: `${action.requestId ?? occurrence ?? timestamp}:campaign:${campaignId}` }, now).state;
        }
        if (step === "draft" && !workflow.draftIds?.length) {
          const draftId = stableId("draft", workflow.id, occurrence ?? action.requestId ?? timestamp);
          if (!state.drafts.some(value => value.id === draftId)) state.drafts.push({ id: draftId, to: "review@example.com", subject: workflow.name, body: `Synthetic review draft: ${workflow.intent}`, status: "draft", mode: "demo", updatedAt: timestamp });
        }
      }
      find(state.workflows, workflow.id, "Workflow").lastRunAt = timestamp;
      if (occurrence) state.processedKeys.push(occurrence);
      entityId = workflow.id;
      if (message === "Action completed.") message = "Workflow completed in deterministic demo mode.";
      break;
    }
    case "resource.browse": requirePermission(state.permissions, "driveRead"); message = "Available synthetic resources loaded."; break;
    case "resource.bind": {
      requirePermission(state.permissions, "driveRead");
      let resource: Resource;
      if (p.id) resource = find(state.resources, p.id, "Resource");
      else {
        const url = text(p.url, "Resource URL");
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error("Use a valid resource URL."); }
        assert(parsed.protocol === "https:" || parsed.protocol === "http:", "Resource URLs must use HTTP or HTTPS.");
        assert(!parsed.username && !parsed.password, "Resource URLs cannot contain credentials.");
        resource = state.resources.find(value => value.url === parsed.href) ?? { id: stableId("resource", parsed.href), name: text(p.name, "Name", "Bound resource"), kind: "document", url: parsed.href, modifiedAt: timestamp, mode: "demo" };
        if (!state.resources.some(value => value.id === resource.id)) state.resources.push(resource);
      }
      if (p.role !== undefined) assert(p.role === "reference" || p.role === "output", "Resource role must be reference or output.");
      resource.role = (p.role ?? resource.role ?? "reference") as Resource["role"];
      if (p.name !== undefined) resource.name = text(p.name, "Name");
      if ("tabId" in p) resource.tabId = optionalString(p.tabId, "Tab ID");
      if ("namedRangeId" in p) resource.namedRangeId = optionalString(p.namedRangeId, "Named range ID");
      resource.bound = true; entityId = resource.id; message = "Synthetic resource bound."; break;
    }
    case "resource.unbind": {
      const resource = find(state.resources, p.id, "Resource");
      resource.bound = false;
      for (const agent of state.agents) agent.resourceIds = agent.resourceIds.filter(value => value !== resource.id);
      message = "Resource unbound. Workflows using it must be rebound before execution."; break;
    }
    case "sync.run": {
      const provider = p.provider ?? "gmail";
      assert(provider === "gmail" || provider === "drive", "Provider must be gmail or drive.");
      const count = state.tasks.length;
      state = readDemoSources(state, provider);
      message = `Synthetic sync completed. ${state.tasks.length - count} new task(s); existing identities preserved.`; break;
    }
    case "scan.start": {
      assert(p.provider === "gmail" || p.provider === "drive", "Provider must be gmail or drive.");
      assert(p.coverage === "selected" || p.coverage === "all", "Coverage must be selected or all.");
      requirePermission(state.permissions, p.provider === "gmail" ? "gmailRead" : "driveRead");
      if (p.coverage === "all") requirePermission(state.permissions, p.provider === "gmail" ? "gmailFull" : "driveFull");
      const count = p.provider === "gmail" ? (p.coverage === "all" ? 3 : 1) : state.resources.filter(resource => p.coverage === "all" || resource.bound).length;
      const job: ScanJob = { id: id("scan"), provider: p.provider, coverage: p.coverage, status: "running", discovered: count, read: 0, analyzed: 0, skipped: 0, failed: 0, cursor: "demo:0", createdAt: timestamp, mode: "demo" };
      state.scans.push(job); entityId = job.id; receiptStatus = "pending"; message = `Synthetic ${p.coverage} scan started; ${count} items discovered.`; break;
    }
    case "scan.pause": {
      const job = find(state.scans, p.id, "Scan");
      assert(job.status === "running" || job.status === "queued", "Only active scans can be paused.");
      job.status = "paused"; entityId = job.id; message = "Scan paused with progress preserved."; break;
    }
    case "scan.resume": {
      const job = find(state.scans, p.id, "Scan");
      assert(job.status === "paused" || job.status === "running" || job.status === "queued", "This scan cannot resume.");
      requirePermission(state.permissions, job.provider === "gmail" ? "gmailRead" : "driveRead");
      if (job.coverage === "all") requirePermission(state.permissions, job.provider === "gmail" ? "gmailFull" : "driveFull");
      state = readDemoSources(state, job.provider, undefined, job.coverage === "all");
      const updated = find(state.scans, job.id, "Scan");
      const resources = state.resources.filter(resource => job.coverage === "all" || resource.bound);
      updated.discovered = job.provider === "gmail" ? updated.discovered : resources.length;
      updated.skipped = job.provider === "gmail" ? 0 : resources.filter(resource => resource.kind === "folder").length;
      updated.read = updated.discovered - updated.skipped; updated.analyzed = updated.read; updated.cursor = `demo:${updated.discovered}`; updated.status = "completed";
      entityId = job.id; message = "Synthetic scan completed; all discovered items accounted for."; break;
    }
    case "draft.create": {
      requirePermission(state.permissions, "draft");
      const draft = { id: id("draft"), to: normalizeEmail(text(p.to, "Recipient")), subject: text(p.subject, "Subject"), body: text(p.body, "Body"), threadId: optionalString(p.threadId, "Thread ID"), status: "draft" as const, mode: "demo" as const, updatedAt: timestamp };
      state.drafts.push(draft); entityId = draft.id; message = "Synthetic draft created for review."; break;
    }
    case "draft.update": {
      requirePermission(state.permissions, "draft");
      const draft = find(state.drafts, p.id, "Draft");
      assert(draft.status === "draft" || draft.status === "failed", "Only an unsent draft can be edited.");
      if (p.to !== undefined) draft.to = normalizeEmail(text(p.to, "Recipient"));
      if (p.subject !== undefined) draft.subject = text(p.subject, "Subject");
      if (p.body !== undefined) draft.body = text(p.body, "Body");
      draft.status = "draft"; draft.updatedAt = timestamp; entityId = draft.id; message = "Draft updated."; break;
    }
    case "draft.send": {
      requirePermission(state.permissions, "send");
      const draft = find(state.drafts, p.id, "Draft");
      const key = operationKey("draft-delivery", draft.id);
      if (draft.status === "accepted" || state.processedKeys.includes(key)) { message = "Draft was already accepted; no duplicate send."; entityId = draft.id; break; }
      assert(draft.status === "draft", "An uncertain, queued or failed delivery cannot be blindly retried.");
      normalizeEmail(draft.to); text(draft.subject, "Subject"); text(draft.body, "Body");
      draft.status = "accepted"; draft.externalId = stableId("demo-delivery", draft.id); draft.updatedAt = timestamp;
      state.processedKeys.push(key); entityId = draft.id; message = "Synthetic send accepted. No real message was sent."; break;
    }
    case "campaign.create": {
      requirePermission(state.permissions, "draft");
      const campaignId = id("campaign");
      assert(Array.isArray(p.recipients) && p.recipients.every(item => item && typeof item === "object" && typeof item.email === "string" && (item.name === undefined || typeof item.name === "string")), "Recipients must be email/name objects.");
      const scheduledAt = optionalString(p.scheduledAt, "Scheduled time");
      if (scheduledAt) assert(/(?:Z|[+-]\d{2}:\d{2})$/i.test(scheduledAt) && Number.isFinite(Date.parse(scheduledAt)), "Scheduled time must be an ISO timestamp with offset.");
      const ratePerMinute = finiteNumber(p.ratePerMinute, "Rate per minute", 10, 1, state.settings.mode === "live" ? 60 : 1000);
      assert(Number.isInteger(ratePerMinute), "Rate per minute must be an integer.");
      const campaign: Campaign = { id: campaignId, name: text(p.name, "Name"), subject: text(p.subject, "Subject"), body: text(p.body, "Body"),
        recipients: deduplicateRecipients(campaignId, p.recipients as Array<{ email: string; name?: string }>), status: scheduledAt ? "scheduled" : "draft", mode: state.settings.mode, createdAt: timestamp, scheduledAt, ratePerMinute };
      state.campaigns.push(campaign); entityId = campaign.id; message = "Campaign created with unique recipients for review."; break;
    }
    case "campaign.start":
    case "campaign.pause":
    case "campaign.resume":
    case "campaign.cancel": {
      const campaign = find(state.campaigns, p.id, "Campaign");
      const transition = action.type.split(".")[1] as "start" | "pause" | "resume" | "cancel";
      if (transition === "start" || transition === "resume") requirePermission(state.permissions, "send", "bulkSend");
      transitionCampaign(campaign, transition);
      if (transition === "start" || transition === "resume") state = dispatchDemoCampaign(state, campaign.id, now);
      entityId = campaign.id;
      const status = find(state.campaigns, campaign.id, "Campaign").status;
      const recipients = find(state.campaigns, campaign.id, "Campaign").recipients;
      receiptStatus = recipients.some(recipient => recipient.status === "unknown") ? "unknown" : recipients.some(recipient => recipient.status === "failed") ? "failed" : ["scheduled", "running", "paused"].includes(status) ? "pending" : "succeeded";
      message = state.settings.mode === "demo" ? `Synthetic campaign ${status}. No real messages were sent.` : `Campaign ${status}.`;
      break;
    }
    case "calendar.upsert": {
      requirePermission(state.permissions, "calendarWrite");
      const start = text(p.start, "Start"), end = text(p.end, "End");
      validateInterval(start, end);
      const previous = p.id ? find(state.events, p.id, "Event") : undefined;
      const event = { id: previous?.id ?? id("event"), title: text(p.title, "Title"), start, end, location: optionalString(p.location, "Location"), calendarId: text(p.calendarId, "Calendar", previous?.calendarId ?? "demo-primary"), status: "confirmed" as const, sourceIds: previous?.sourceIds ?? [] };
      state.events = [...state.events.filter(item => item.id !== event.id), event]; entityId = event.id; message = "Synthetic calendar event saved."; break;
    }
    case "docs.write": {
      requirePermission(state.permissions, "docsWrite");
      const resource = find(state.resources, p.resourceId, "Resource");
      assert(resource.bound && resource.role === "output" && resource.kind === "document", "Writes require a bound output document.");
      assert(typeof p.content === "string", "Document content must be text.");
      resource.content = p.content; resource.modifiedAt = timestamp; entityId = resource.id; message = "Synthetic output document updated."; break;
    }
    default: assert(false, `Unsupported action: ${action.type}`, "UNSUPPORTED_ACTION");
  }
  state.version = input.version + 1;
  state.usage.deterministicActions++;
  const runId = stableId("run", action.type, action.requestId ?? timestamp, state.version);
  const linkedTask = state.tasks.find(task => task.id === receiptTaskId);
  receiptAgentId ??= linkedTask?.agentId;
  receiptSourceIds = unique([...receiptSourceIds, ...(linkedTask?.sourceIds ?? [])]);
  const changedResourceIds = state.resources.filter(resource => JSON.stringify(input.resources.find(previous => previous.id === resource.id)) !== JSON.stringify(resource)).map(resource => resource.id);
  const changedEventIds = state.events.filter(event => JSON.stringify(input.events.find(previous => previous.id === event.id)) !== JSON.stringify(event)).map(event => event.id);
  state.runs.unshift({ id: runId, title: action.type, description: message, status: receiptStatus, createdAt: timestamp, mode: state.settings.mode,
    workflowId: action.type === "workflow.run" ? entityId : undefined, agentId: receiptAgentId, taskId: receiptTaskId, recipeId,
    changedResourceIds, changedEventIds, modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0, sourceIds: receiptSourceIds });
  if (requestPrefix) state.processedKeys.push(`${requestPrefix}${JSON.stringify({ signature, entityId, message })}`);
  return { state, message, entityId };
}
