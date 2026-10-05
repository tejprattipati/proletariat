import type { AgentMessage, CalendarEvent, Resource, Run, Task, WorkspaceState } from "../types";
import { assert, localDate, unique } from "./core";
import { sortReceipts, summarizeReceiptUsage, type ReceiptUsage } from "./receipts";
import { hasUnknownProviderState, hasUnverifiedRequirement, isActiveTask } from "./lifecycle";

export interface TaskFeedDetails {
  receipts: Run[];
  latestRun?: Run;
  needsDecision: boolean;
  needsInput?: string;
  messages: AgentMessage[];
  inputResources: Resource[];
  changedResources: Resource[];
  changedEvents: CalendarEvent[];
  usage: ReceiptUsage;
}

/** A shared source or agent is context, not proof that an action happened to this task. */
export function getTaskReceipts(state: WorkspaceState, taskId: string): Run[] {
  return sortReceipts(state.runs.filter(run => run.taskId === taskId || (!run.taskId && run.sourceIds.includes(taskId))));
}

export function getTaskFeedDetails(state: WorkspaceState, taskId: string): TaskFeedDetails {
  const task = state.tasks.find(item => item.id === taskId);
  assert(task, "Task was not found.", "NOT_FOUND");
  const receipts = getTaskReceipts(state, taskId);
  // A saved note or metadata edit must not hide an earlier uncertain execution result.
  const contextActions = new Set(["task.reply", "task.create", "task.update", "recipe.create", "recipe.update"]);
  const latestRun = receipts.find(run => !contextActions.has(run.title)) ?? receipts[0];
  const sourceIds = new Set(unique([...task.sourceIds, ...receipts.flatMap(run => run.sourceIds)]));
  const resourceIds = new Set(receipts.flatMap(run => run.changedResourceIds ?? []));
  const eventIds = new Set(receipts.flatMap(run => run.changedEventIds ?? []));
  const agent = state.agents.find(item => item.id === task.agentId);
  const messages = (agent?.messages ?? []).filter(message => message.taskId === task.id)
    .slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const needsInput = task.needsInput?.trim() || (hasUnverifiedRequirement(task) ? "Confirm this requirement and its applicability before treating it as work." : hasUnknownProviderState(task) ?
    task.dueDate && task.dueDate < state.today ? "Deadline passed; completion unverified." : "Confirm the provider's completion state before treating this obligation as outstanding." : ["waiting", "blocked"].includes(task.status) ? "This task is waiting for a next step." :
    latestRun?.status === "unknown" ? "Reconcile the uncertain result before retrying." :
      latestRun?.status === "failed" || latestRun?.status === "conflict" ? latestRun.description || "Review the task's unsuccessful result." : undefined);
  return {
    receipts, latestRun, needsDecision: Boolean(needsInput), needsInput, messages,
    inputResources: state.resources.filter(resource => sourceIds.has(resource.id)),
    changedResources: state.resources.filter(resource => resourceIds.has(resource.id)),
    changedEvents: state.events.filter(event => eventIds.has(event.id)),
    usage: summarizeReceiptUsage(receipts),
  };
}

/** Active tasks: decisions first, due work next, then results from the last 24 hours. */
export function rankTaskFeed(state: WorkspaceState, now = new Date()): Task[] {
  assert(Number.isFinite(now.getTime()), "A valid feed time is required.");
  const today = localDate(now, state.settings.timezone);
  const items = state.tasks.filter(isActiveTask).map(task => {
    const details = getTaskFeedDetails(state, task.id);
    const latest = details.latestRun ? Date.parse(details.latestRun.createdAt) : 0;
    const recent = latest <= now.getTime() && latest >= now.getTime() - 24 * 60 * 60_000;
    const tier = details.needsDecision ? 0 : task.dueDate && task.dueDate <= today ? 1 : recent ? 2 : 3;
    return { task, tier, latest };
  });
  items.sort((a, b) => a.tier - b.tier ||
    (a.tier === 2 ? b.latest - a.latest : 0) ||
    (a.task.dueDate ?? "9999-12-31").localeCompare(b.task.dueDate ?? "9999-12-31") ||
    (a.task.dueTime ?? "23:59").localeCompare(b.task.dueTime ?? "23:59") ||
    a.task.priority.localeCompare(b.task.priority) || b.latest - a.latest ||
    (b.task.updatedAt ?? "").localeCompare(a.task.updatedAt ?? "") ||
    a.task.plannedDate.localeCompare(b.task.plannedDate) || a.task.id.localeCompare(b.task.id));
  return items.map(item => item.task);
}
