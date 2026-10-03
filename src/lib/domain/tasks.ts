import type { Task, WorkspaceState } from "../types";
import { assert, operationKey, stableId, unique, validateDate } from "./core";

export function rolloverTasks(state: WorkspaceState, date: string): WorkspaceState {
  validateDate(date);
  assert(date >= state.today, "Rollover cannot move the workspace backwards.");
  const next = structuredClone(state);
  next.today = date;
  if (!next.settings.rolloverEnabled) return next;
  const moved = new Set<string>();
  next.tasks = next.tasks.map(task => {
    if (task.status === "done" || task.pinned || task.plannedDate >= date ||
      (task.nextActionDate && task.nextActionDate > date) ||
      (task.status === "waiting" && !task.nextActionDate)) return task;
    moved.add(task.id);
    return { ...task, plannedDate: date, carryoverCount: task.carryoverCount + 1 };
  });
  next.plan = next.plan.filter(block => block.pinned || !moved.has(block.taskId));
  return next;
}

export interface TaskCandidate {
  /** Stable provider identity, never a title or changing content hash. */
  sourceId: string;
  sourceVersion: string;
  /** Distinguishes multiple tasks or sessions extracted from one source. */
  itemId: string;
  title: string;
  plannedDate: string;
  dueDate?: string;
  estimateMinutes?: number;
  notes?: string;
  agentId?: string;
}

/** New source revisions add provenance while preserving the user's task edits. */
export function ingestTaskCandidates(state: WorkspaceState, candidates: TaskCandidate[]): WorkspaceState {
  const next = structuredClone(state);
  for (const candidate of candidates) {
    assert(candidate.sourceId && candidate.sourceVersion && candidate.itemId && candidate.title.trim(), "Source, revision, item identity and title are required.");
    validateDate(candidate.plannedDate);
    if (candidate.dueDate) validateDate(candidate.dueDate);
    assert(candidate.estimateMinutes === undefined || (Number.isFinite(candidate.estimateMinutes) && candidate.estimateMinutes > 0), "Task duration must be positive.");
    const key = operationKey("source-revision", candidate.sourceId, candidate.itemId, candidate.sourceVersion);
    if (next.processedKeys.includes(key)) continue;
    const id = stableId("task", candidate.sourceId, candidate.itemId);
    if (next.processedKeys.includes(operationKey("task-deleted", id))) { next.processedKeys.push(key); continue; }
    const existing = next.tasks.find(task => task.id === id);
    if (existing) {
      existing.sourceIds = unique([...existing.sourceIds, candidate.sourceId]);
    } else {
      next.tasks.push({ id, title: candidate.title.trim(), status: "open", priority: "P1", plannedDate: candidate.plannedDate,
        dueDate: candidate.dueDate, estimateMinutes: candidate.estimateMinutes ?? 30, notes: candidate.notes ?? "",
        agentId: candidate.agentId, sourceIds: [candidate.sourceId], carryoverCount: 0 });
    }
    next.processedKeys.push(key);
  }
  return next;
}

/** Recurring tasks have separate stable occurrence IDs; reruns never reopen completed work. */
export function materializeOccurrence(state: WorkspaceState, template: Task, seriesId: string, date: string): WorkspaceState {
  validateDate(date);
  assert(seriesId.trim(), "A recurrence series ID is required.");
  const next = structuredClone(state);
  const key = operationKey("recurrence", seriesId, date);
  if (next.processedKeys.includes(key)) return next;
  const id = stableId("task", "recurrence", seriesId, date);
  if (!next.tasks.some(task => task.id === id)) next.tasks.push({ ...structuredClone(template), id, status: "open", plannedDate: date,
    dueDate: template.dueDate ? date : undefined, completedAt: undefined, carryoverCount: 0 });
  next.processedKeys.push(key);
  return next;
}
