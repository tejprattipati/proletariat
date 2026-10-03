import type { Task, WorkspaceState } from "../../src/lib/types";
import { createDemoState } from "../../src/lib/domain/fixtures";

export const now = new Date("2026-10-03T08:00:00Z");
export function workspace(): WorkspaceState {
  return { ...createDemoState(now), tasks: [], events: [], plan: [], campaigns: [], runs: [], scans: [], processedKeys: [] };
}
export function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, title: `Example ${id}`, status: "open", priority: "P1", plannedDate: "2026-10-03", estimateMinutes: 30, notes: "", sourceIds: [], carryoverCount: 0, ...fields };
}
