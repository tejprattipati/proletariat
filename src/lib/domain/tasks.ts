import type { Task, WorkspaceState } from "../types";
import { assert, operationKey, stableId, unique, validateDate } from "./core";
import { bindTaskAlias, getTaskSourceState, resolveTaskAlias, setTaskSourceState, type ProviderValues, type VerifiedTaskAlias } from "./identity";
import { hasUnknownProviderState, hasUnverifiedRequirement, isActiveTask, recordTaskHistory, reconcileTaskProjections } from "./lifecycle";

const defaultTime = (date: string) => new Date(`${date}T00:00:00.000Z`);

export function rolloverTasks(state: WorkspaceState, date: string, now = defaultTime(date)): WorkspaceState {
  validateDate(date);
  assert(date >= state.today, "Rollover cannot move the workspace backwards.");
  assert(Number.isFinite(now.getTime()), "A valid rollover time is required.");
  const next = structuredClone(state);
  next.today = date;
  if (!next.settings.rolloverEnabled) return next;
  const moved = new Set<string>();
  next.tasks = next.tasks.map(task => {
    if (!isActiveTask(task) || hasUnknownProviderState(task) || hasUnverifiedRequirement(task) || task.pinned || task.plannedDate >= date ||
      (task.nextActionDate && task.nextActionDate > date) ||
      (["waiting", "blocked"].includes(task.status) && !task.nextActionDate)) return task;
    moved.add(task.id);
    const updated = { ...task, plannedDate: date, carryoverCount: task.carryoverCount + 1 };
    recordTaskHistory(next, "rolled_over", task, updated, now.toISOString());
    return updated;
  });
  next.plan = next.plan.filter(block => block.pinned || !moved.has(block.taskId));
  reconcileTaskProjections(next);
  return next;
}

export interface TaskCandidate {
  /** Caller must scope this stable source identity to owner, provider instance and account. */
  sourceId: string;
  sourceVersion: string;
  /** Stable external item identity; never a title or changing content hash. */
  itemId: string;
  title: string;
  plannedDate: string;
  /** Omission preserves a partial-read fact; explicit null clears the provider deadline. */
  dueDate?: string | null;
  dueTime?: string | null;
  estimateMinutes?: number;
  notes?: string;
  agentId?: string;
  categories?: string[];
  nextAction?: string;
  priority?: Task["priority"];
  providerState?: string;
  requirementState?: "verified" | "unknown";
  applicabilityState?: "verified" | "unknown";
  completed?: boolean;
  sourceUrl?: string;
  /** Provider-verified equivalent source identities, each carrying this same item identity. */
  aliases?: string[];
  /** Explicit tuple aliases for migrations where both source and item location can differ. */
  verifiedAliases?: VerifiedTaskAlias[];
}

function validateCandidate(candidate: TaskCandidate): void {
  assert(candidate.sourceId?.trim() && candidate.sourceVersion?.trim() && candidate.itemId?.trim() && candidate.title?.trim(), "Source, revision, item identity and title are required.");
  validateDate(candidate.plannedDate);
  if (candidate.dueDate != null) validateDate(candidate.dueDate);
  if (candidate.dueTime != null) assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(candidate.dueTime), "Due time must use HH:mm.");
  assert(candidate.estimateMinutes === undefined || (Number.isFinite(candidate.estimateMinutes) && candidate.estimateMinutes > 0), "Task duration must be positive.");
  assert(candidate.priority === undefined || ["P0", "P1", "P2"].includes(candidate.priority), "Unsupported priority.");
  assert(candidate.categories === undefined || (Array.isArray(candidate.categories) && candidate.categories.every(value => typeof value === "string" && value.trim())), "Categories must be nonempty strings.");
  assert(candidate.completed === undefined || typeof candidate.completed === "boolean", "Provider completion must be boolean.");
  for (const field of ["requirementState", "applicabilityState"] as const) assert(candidate[field] === undefined || candidate[field] === "verified" || candidate[field] === "unknown", `${field} must be verified or unknown.`);
  for (const field of ["notes", "nextAction", "providerState", "agentId", "sourceUrl"] as const) assert(candidate[field] === undefined || typeof candidate[field] === "string", `${field} must be text.`);
  assert(candidate.aliases === undefined || (Array.isArray(candidate.aliases) && candidate.aliases.every(alias => typeof alias === "string" && alias.trim())), "Provider aliases must be nonempty verified source IDs.");
  for (const alias of candidate.verifiedAliases ?? []) assert(alias.verified === true && alias.evidence?.trim() && alias.sourceId?.trim() && alias.itemId?.trim(), "Alias equivalence needs explicit verified evidence.", "ALIAS_REVIEW_REQUIRED");
}

/** Latest provider values survive alongside the user's corrections, including date conflicts. */
export function ingestTaskCandidates(state: WorkspaceState, candidates: TaskCandidate[], now = defaultTime(state.today)): WorkspaceState {
  assert(Number.isFinite(now.getTime()), "A valid ingestion time is required.");
  const next = structuredClone(state);
  for (const candidate of candidates) {
    validateCandidate(candidate);
    const aliases = [{ sourceId: candidate.sourceId, itemId: candidate.itemId, url: candidate.sourceUrl, evidence: "Stable source/item identity" },
      ...(candidate.aliases ?? []).map(sourceId => ({ sourceId, itemId: candidate.itemId, evidence: "Verified provider linkage" })), ...(candidate.verifiedAliases ?? [])];
    const ids = unique(aliases.map(alias => resolveTaskAlias(next, alias)).filter((id): id is string => Boolean(id)));
    assert(ids.length <= 1, "Verified aliases identify different existing tasks; preserve both for migration review.", "ALIAS_CONFLICT");
    const id = ids[0] ?? stableId("task", candidate.sourceId, candidate.itemId);
    const key = operationKey("source-revision", candidate.sourceId, candidate.itemId, candidate.sourceVersion);
    const existing = next.tasks.find(task => task.id === id);
    // Legacy deletions have no snapshot to restore. Their tombstone still prevents recreation.
    if (!existing && next.processedKeys.includes(operationKey("task-deleted", id))) {
      for (const alias of aliases) bindTaskAlias(next, id, alias, alias.evidence);
      if (!next.processedKeys.includes(key)) next.processedKeys.push(key);
      continue;
    }
    if (next.processedKeys.includes(key)) {
      if (existing) {
        const before = structuredClone(existing);
        for (const alias of aliases) bindTaskAlias(next, id, alias, alias.evidence);
        existing.sourceIds = unique([...existing.sourceIds, ...aliases.map(alias => alias.sourceId)]);
        existing.providerAliases = unique([...(existing.providerAliases ?? []), ...aliases.map(alias => alias.sourceId)]);
        recordTaskHistory(next, "source_updated", before, existing, now.toISOString(), candidate.sourceId);
      }
      continue;
    }
    const previous = getTaskSourceState(next, id)?.values;
    const values: ProviderValues = { ...previous };
    const sourceFields = ["title", "dueDate", "dueTime", "estimateMinutes", "notes", "agentId", "categories", "nextAction", "priority", "providerState", "requirementState", "applicabilityState"] as const;
    for (const field of sourceFields) if (Object.hasOwn(candidate, field)) values[field] = candidate[field] ?? null;
    values.title = candidate.title.trim();
    if (candidate.categories) values.categories = unique(candidate.categories.map(value => value.trim()));
    if (candidate.completed !== undefined) values.completed = candidate.completed;
    if (candidate.completed !== undefined && !candidate.providerState) values.providerState = candidate.completed ? "completed" : "not_completed";
    const before = existing ? structuredClone(existing) : undefined;
    const task: Task = existing ?? { id, title: candidate.title.trim(), status: "open", priority: candidate.priority ?? "P1", plannedDate: candidate.plannedDate,
      estimateMinutes: candidate.estimateMinutes ?? 30, notes: candidate.notes ?? "", agentId: candidate.agentId,
      categories: candidate.categories ? unique(candidate.categories.map(value => value.trim())) : [], nextAction: candidate.nextAction,
      sourceIds: [], carryoverCount: 0, userEditedFields: [] };
    if (existing) {
      const edited = new Set(task.userEditedFields ?? []);
      for (const field of ["plannedDate", "priority", "categories", "nextAction", "status"]) edited.add(field);
      for (const field of ["title", "dueDate", "dueTime", "estimateMinutes", "notes", "agentId"] as const) {
        const current = task[field] ?? null;
        const withheldUnverifiedDate = (field === "dueDate" || field === "dueTime") && current === null && hasUnverifiedRequirement(task);
        if (!previous || (!withheldUnverifiedDate && Object.hasOwn(previous, field) && JSON.stringify(current) !== JSON.stringify(previous[field]))) edited.add(field);
        if (!edited.has(field) && Object.hasOwn(candidate, field)) {
          if (field === "title") task.title = candidate.title.trim();
          else if (field === "estimateMinutes") task.estimateMinutes = candidate.estimateMinutes ?? task.estimateMinutes;
          else if (field === "notes") task.notes = candidate.notes ?? "";
          else task[field] = candidate[field] ?? undefined;
        }
      }
      task.userEditedFields = [...edited].sort();
    } else {
      task.dueDate = candidate.dueDate ?? undefined; task.dueTime = candidate.dueTime ?? undefined;
      next.tasks.push(task);
    }
    if (Object.hasOwn(candidate, "dueDate")) task.providerDueDate = candidate.dueDate ?? undefined;
    if (Object.hasOwn(candidate, "dueTime")) task.providerDueTime = candidate.dueTime ?? undefined;
    if (typeof values.providerState === "string") task.providerState = values.providerState;
    if (candidate.requirementState !== undefined) task.providerRequirementState = candidate.requirementState;
    if (candidate.applicabilityState !== undefined) task.providerApplicabilityState = candidate.applicabilityState;
    if (hasUnverifiedRequirement(task)) {
      if (!task.userEditedFields?.includes("dueDate")) task.dueDate = undefined;
      if (!task.userEditedFields?.includes("dueTime")) task.dueTime = undefined;
    }
    task.sourceIds = unique([...task.sourceIds, ...aliases.map(alias => alias.sourceId)]);
    task.providerAliases = unique([...(task.providerAliases ?? []), ...aliases.map(alias => alias.sourceId)]);
    task.providerValues = { sourceId: candidate.sourceId, itemId: candidate.itemId, version: candidate.sourceVersion, title: candidate.title.trim(), dueDate: task.providerDueDate, dueTime: task.providerDueTime, state: task.providerState };
    for (const alias of aliases) bindTaskAlias(next, id, alias, alias.evidence);
    setTaskSourceState(next, task, values);
    if (!before || JSON.stringify(before) !== JSON.stringify(task)) {
      task.updatedAt = now.toISOString();
      recordTaskHistory(next, before ? "source_updated" : "created", before, task, now.toISOString(), candidate.sourceId);
    }
    next.processedKeys.push(key);
  }
  reconcileTaskProjections(next);
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
  if (!next.tasks.some(task => task.id === id) && !next.processedKeys.includes(operationKey("task-deleted", id))) {
    const task: Task = { ...structuredClone(template), id, status: "open", plannedDate: date, dueDate: template.dueDate ? date : undefined,
      completedAt: undefined, removedAt: undefined, providerState: undefined, carryoverCount: 0 };
    next.tasks.push(task);
    recordTaskHistory(next, "created", undefined, task, defaultTime(date).toISOString());
  }
  next.processedKeys.push(key);
  return next;
}
