import type { Task, TaskHistoryEntry, WorkspaceState } from "../types";
import { stableId } from "./core";

/** Provider completion is evidence about the source, never a local completion toggle. */
export function isProviderComplete(task: Task): boolean {
  return ["submitted", "pending_grading", "pending_review", "graded", "excused", "completed"].includes((task.providerState ?? "").trim().toLowerCase().replace(/[ -]+/g, "_"));
}

export function isActiveTask(task: Task): boolean {
  return !task.removedAt && task.status !== "done" && !isProviderComplete(task);
}

export function hasUnknownProviderState(task: Task): boolean {
  return task.providerState?.trim().toLowerCase() === "unknown";
}

export function hasUnverifiedRequirement(task: Task): boolean {
  return task.providerRequirementState === "unknown" || task.providerApplicabilityState === "unknown";
}

/** Internal mutation of a transaction's cloned state; snapshots never alias live records. */
export function recordTaskHistory(state: WorkspaceState, action: TaskHistoryEntry["action"], before: Task | undefined, after: Task, at: string, sourceId?: string): void {
  if (before && JSON.stringify(before) === JSON.stringify(after)) return;
  after.revision = (before?.revision ?? 0) + 1;
  state.taskHistory ??= [];
  state.taskHistory.push({ id: stableId("task-history", after.id, action, at, state.taskHistory.length), taskId: after.id, at, action,
    before: before ? structuredClone(before) : undefined, after: structuredClone(after), sourceId });
}

/** Remove obsolete active execution references; source snapshots and receipts remain history. */
export function reconcileTaskProjections(state: WorkspaceState): void {
  const activeIds = new Set(state.tasks.filter(isActiveTask).map(task => task.id));
  const plannableIds = new Set(state.tasks.filter(task => isActiveTask(task) && task.status !== "blocked" && !hasUnknownProviderState(task) && !hasUnverifiedRequirement(task)).map(task => task.id));
  state.plan = state.plan.filter(block => plannableIds.has(block.taskId));
  if (state.daily) state.daily.taskIds = state.daily.taskIds.filter(id => activeIds.has(id));
}
