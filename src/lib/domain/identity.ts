import type { Task, WorkspaceState } from "../types";
import { assert, operationKey, stableId } from "./core";

export interface ProviderIdentity { ownerId: string; provider: string; instance: string; accountId: string; containerId: string; kind: string; externalId: string; }
export interface TaskSourceAlias { sourceId: string; itemId: string; url?: string; }
export interface VerifiedTaskAlias extends TaskSourceAlias { verified: true; evidence: string; }
export type ProviderValues = Record<string, string | number | boolean | string[] | null>;
export interface TaskSourceState { values: ProviderValues; conflicts: string[]; }

/** Callers supply the verified app owner and connected-provider identity, never an email guess. */
export function providerSourceId(identity: ProviderIdentity): string {
  for (const field of ["ownerId", "provider", "instance", "accountId", "containerId", "kind", "externalId"] as const) assert(typeof identity[field] === "string" && identity[field].trim(), "Complete owner-scoped provider identity is required.");
  return stableId("source", identity.ownerId, identity.provider, identity.instance, identity.accountId, identity.containerId, identity.kind, identity.externalId);
}

function aliasPrefix(alias: TaskSourceAlias): string { return `${operationKey("task-alias", alias.sourceId, alias.itemId)}:`; }
export function resolveTaskAlias(state: WorkspaceState, alias: TaskSourceAlias): string | undefined {
  const prefix = aliasPrefix(alias);
  const record = state.processedKeys.find(key => key.startsWith(prefix));
  if (record) return (JSON.parse(record.slice(prefix.length)) as { taskId: string }).taskId;
  const legacyId = stableId("task", alias.sourceId, alias.itemId);
  return state.tasks.some(task => task.id === legacyId) || state.processedKeys.includes(operationKey("task-deleted", legacyId)) ? legacyId : undefined;
}

/** Register only caller-verified equivalence. A conflict requires review, not an automatic merge. */
export function bindTaskAlias(state: WorkspaceState, taskId: string, alias: TaskSourceAlias, evidence: string): void {
  assert(alias.sourceId.trim() && alias.itemId.trim() && evidence.trim(), "A source alias and identity evidence are required.");
  const existing = resolveTaskAlias(state, alias);
  assert(!existing || existing === taskId, "Source alias points at different canonical tasks; review the migration before merging.", "ALIAS_CONFLICT");
  const prefix = aliasPrefix(alias);
  if (state.processedKeys.some(key => key.startsWith(prefix))) return;
  state.processedKeys.push(`${prefix}${JSON.stringify({ taskId, ...alias, evidence })}`);
}

export function getTaskAliases(state: WorkspaceState, taskId: string): Array<TaskSourceAlias & { evidence: string }> {
  return state.processedKeys.filter(key => key.startsWith("task-alias:")).flatMap(key => {
    // Parse the framed identity without relying on a delimiter inside a user-provided ID.
    let end = "task-alias:".length;
    for (; end < key.length; end++) {
      if (key[end] !== ":") continue;
      try { const tuple = JSON.parse(key.slice("task-alias:".length, end)); if (Array.isArray(tuple) && tuple.length === 2) break; } catch { /* Not the tuple boundary. */ }
    }
    const record = JSON.parse(key.slice(end + 1)) as TaskSourceAlias & { taskId: string; evidence: string };
    return record.taskId === taskId ? [{ sourceId: record.sourceId, itemId: record.itemId, url: record.url, evidence: record.evidence }] : [];
  });
}

export function getTaskSourceState(state: WorkspaceState, taskId: string): TaskSourceState | undefined {
  const prefix = `${operationKey("task-provider-values", taskId)}:`;
  const record = state.processedKeys.find(key => key.startsWith(prefix));
  return record ? JSON.parse(record.slice(prefix.length)) as TaskSourceState : undefined;
}

export function setTaskSourceState(state: WorkspaceState, task: Task, values: ProviderValues): void {
  const conflicts = Object.keys(values).filter(field => (task.userEditedFields ?? []).includes(field) &&
    JSON.stringify((task as unknown as Record<string, unknown>)[field] ?? null) !== JSON.stringify(values[field]));
  const prefix = `${operationKey("task-provider-values", task.id)}:`;
  task.providerConflicts = conflicts;
  state.processedKeys = state.processedKeys.filter(key => !key.startsWith(prefix));
  state.processedKeys.push(`${prefix}${JSON.stringify({ values, conflicts })}`);
}
