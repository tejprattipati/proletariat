import { DateTime } from "luxon";
import type { PermissionKey, Permissions, Workflow, WorkflowAction, WorkspaceState } from "../types";
import { assert, operationKey, unique, validateTimezone } from "./core";

export const workflowActions: WorkflowAction[] = ["extract_tasks", "plan", "rollover", "calendar_upsert", "docs_write", "draft", "send", "campaign"];

export function intersectPermissions(global: Permissions, local: Partial<Permissions> = {}): Permissions {
  return Object.fromEntries(Object.entries(global).map(([key, value]) => [key, value === true && local[key as PermissionKey] !== false])) as Permissions;
}

export function requirePermission(permissions: Permissions, ...keys: PermissionKey[]): void {
  for (const key of keys) assert(permissions[key] === true, `Permission ${key} is disabled.`, "PERMISSION_DENIED");
}

export function interpretIntent(intent: string): WorkflowAction[] {
  const value = intent.toLowerCase();
  const actions: WorkflowAction[] = [];
  if (/\b(extract|find|identify|import)\b.*\b(tasks?|actions?|sessions?)\b|\baction items?\b/.test(value)) actions.push("extract_tasks");
  if (/\b(plan|schedule my day|time ?block)\b/.test(value)) actions.push("plan");
  if (/\b(rollover|roll over|carry over|carry forward)\b/.test(value)) actions.push("rollover");
  if (/\b(calendar|events?)\b/.test(value)) actions.push("calendar_upsert");
  if (/\b(write|update|append)\b.*\b(doc|docs|document)\b/.test(value)) actions.push("docs_write");
  if (/\bdraft\b/.test(value)) actions.push("draft");
  if (/\b(campaign|bulk|mail ?merge)\b/.test(value)) actions.push("campaign");
  else if (/\bsend\b/.test(value) && !/\b(do not|don't|never) send\b/.test(value)) actions.push("send");
  assert(actions.length, "Intent is unsupported. Choose explicit supported actions.", "UNSUPPORTED_INTENT");
  const order: WorkflowAction[] = ["extract_tasks", "rollover", "plan", "calendar_upsert", "docs_write", "draft", "send", "campaign"];
  return unique(actions).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export function workflowPermissions(workflow: Workflow): PermissionKey[] {
  const required: PermissionKey[] = [];
  for (const action of workflow.actions) {
    if (action === "extract_tasks") required.push(workflow.resourceIds.length ? "driveRead" : "gmailRead");
    if (action === "calendar_upsert") required.push("calendarWrite");
    if (action === "docs_write") required.push("docsWrite");
    if (action === "draft") required.push("draft");
    if (action === "send") required.push("send");
    if (action === "campaign") required.push("send", "bulkSend");
  }
  return unique(required);
}

export function validateWorkflow(workflow: Workflow, state: WorkspaceState, localPermissions: Partial<Permissions> = {}): void {
  assert(workflow.name.trim() && workflow.intent.trim(), "Workflow name and intent are required.");
  assert(state.agents.some(agent => agent.id === workflow.agentId), "Choose an existing agent.");
  assert(workflow.actions.length > 0 && workflow.actions.every(action => workflowActions.includes(action)), "Workflow has unsupported actions.");
  assert(["manual", "review", "automatic"].includes(workflow.mode), "Unsupported workflow mode.");
  assert(["manual", "daily", "interval"].includes(workflow.trigger), "Unsupported workflow trigger.");
  validateTimezone(workflow.timezone);
  if (workflow.trigger === "daily") assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(workflow.schedule ?? ""), "Daily schedules must use HH:mm.");
  if (workflow.trigger === "interval") assert(/^[1-9]\d*$/.test(workflow.schedule ?? "") && Number(workflow.schedule) <= 10080, "Interval schedules must be minutes between 1 and 10080.");
  for (const id of workflow.resourceIds) assert(state.resources.some(resource => resource.id === id && resource.bound), `Resource ${id} must exist and be bound.`);
  if (workflow.actions.includes("docs_write")) assert(state.resources.some(resource => workflow.resourceIds.includes(resource.id) && resource.kind === "document" && resource.role === "output"), "Document writes require a bound output document.");
  requirePermission(intersectPermissions(state.permissions, localPermissions), ...workflowPermissions(workflow));
}

/** Return a single due occurrence. Missed runs coalesce, avoiding an unbounded catch-up queue. */
export function workflowOccurrenceKey(workflow: Workflow, now: Date): string | undefined {
  if (!workflow.enabled || workflow.trigger === "manual") return undefined;
  const time = DateTime.fromJSDate(now, { zone: validateTimezone(workflow.timezone) });
  assert(time.isValid, "A valid execution time is required.");
  if (workflow.trigger === "daily") {
    assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(workflow.schedule ?? ""), "Daily schedules must use HH:mm.");
    if (time.toFormat("HH:mm") < workflow.schedule!) return undefined;
    // Both occurrences of a repeated DST hour map to the same local date.
    return operationKey("workflow-occurrence", workflow.id, time.toISODate());
  }
  const minutes = Number(workflow.schedule);
  assert(Number.isInteger(minutes) && minutes >= 1 && minutes <= 10080, "Invalid interval schedule.");
  return operationKey("workflow-occurrence", workflow.id, "interval", Math.floor(time.toMillis() / (minutes * 60_000)));
}
