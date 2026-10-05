import { describe, expect, it } from "vitest";
import { ingestTaskCandidates, materializeOccurrence, rolloverTasks } from "../../src/lib/domain/tasks";
import { applyAction } from "../../src/lib/domain/actions";
import { now } from "./helpers";
import { task, workspace } from "./helpers";

describe("task rollover", () => {
  it("preserves identity, original deadlines and user edits across multiple days", () => {
    const state = workspace();
    state.tasks = [task("one", { dueDate: "2026-10-02", dueTime: "12:30", title: "User title", notes: "User notes", sourceIds: ["source-1"] })];
    const next = rolloverTasks(state, "2026-10-04");
    expect(next.tasks[0]).toMatchObject({ ...state.tasks[0], plannedDate: "2026-10-04", carryoverCount: 1 });
    expect(rolloverTasks(next, "2026-10-04")).toEqual(next);
    expect(rolloverTasks(next, "2026-10-06").tasks[0].carryoverCount).toBe(2);
    expect(state.tasks[0].plannedDate).toBe("2026-10-03");
  });
  it("respects completed, pinned, future-date and waiting overrides", () => {
    const state = workspace();
    state.tasks = [task("done", { status: "done" }), task("pinned", { pinned: true }), task("future", { plannedDate: "2026-10-08" }),
      task("waiting", { status: "waiting" }), task("waiting-future", { status: "waiting", nextActionDate: "2026-10-08" }), task("followup", { status: "waiting", nextActionDate: "2026-10-04" })];
    const next = rolloverTasks(state, "2026-10-04");
    expect(next.tasks.slice(0, 5)).toEqual(state.tasks.slice(0, 5));
    expect(next.tasks[5]).toMatchObject({ id: "followup", plannedDate: "2026-10-04", carryoverCount: 1 });
  });
  it("drops obsolete unpinned blocks and keeps pinned blocks", () => {
    const state = workspace(); state.tasks = [task("one")];
    state.plan = [{ id: "auto", taskId: "one", start: "2026-10-03T09:00:00Z", end: "2026-10-03T09:15:00Z", pinned: false },
      { id: "pin", taskId: "one", start: "2026-10-03T10:00:00Z", end: "2026-10-03T10:15:00Z", pinned: true }];
    expect(rolloverTasks(state, "2026-10-04").plan.map(block => block.id)).toEqual(["pin"]);
  });
  it("advances the date without carrying tasks when disabled", () => {
    const state = workspace(); state.settings.rolloverEnabled = false; state.tasks = [task("one")];
    expect(rolloverTasks(state, "2026-10-04")).toMatchObject({ today: "2026-10-04", tasks: state.tasks });
  });
  it("rejects invalid dates and backwards rollover atomically", () => {
    const state = workspace();
    expect(() => rolloverTasks(state, "2026-02-30")).toThrow();
    expect(() => rolloverTasks(state, "2026-10-02")).toThrow(/backwards/);
  });
});

describe("source identity and recurrence", () => {
  const candidate = { sourceId: "synthetic-file", sourceVersion: "v1", itemId: "session-1", title: "Session one", plannedDate: "2026-10-03", dueDate: "2026-10-04" };
  it("deduplicates repeat extraction and preserves separate sessions within one source", () => {
    const next = ingestTaskCandidates(workspace(), [candidate, candidate, { ...candidate, itemId: "session-2", title: "Session two" }]);
    expect(next.tasks).toHaveLength(2);
    expect(new Set(next.tasks.map(value => value.id)).size).toBe(2);
    expect(ingestTaskCandidates(next, [candidate])).toEqual(next);
  });
  it("handles changed content without duplicating or overwriting user overrides", () => {
    const state = ingestTaskCandidates(workspace(), [candidate]);
    Object.assign(state.tasks[0], { title: "User override", status: "done", plannedDate: "2026-10-09", estimateMinutes: 90, dueDate: "2026-10-10", pinned: true });
    const next = ingestTaskCandidates(state, [{ ...candidate, sourceVersion: "v2", title: "New extraction title", dueDate: "2026-10-05" }]);
    expect(next.tasks[0]).toMatchObject({ id: state.tasks[0].id, title: "User override", status: "done", plannedDate: "2026-10-09", estimateMinutes: 90, dueDate: "2026-10-10", pinned: true, providerDueDate: "2026-10-05" });
    expect(next.processedKeys.filter(key => key.startsWith("source-revision:"))).toHaveLength(2);
  });
  it("does not resurrect a deleted task for the same processed revision", () => {
    const state = ingestTaskCandidates(workspace(), [candidate]); state.tasks = [];
    expect(ingestTaskCandidates(state, [candidate]).tasks).toHaveLength(0);
  });
  it("keeps user-deleted extracted tasks deleted when the source changes", () => {
    const state = ingestTaskCandidates(workspace(), [candidate]);
    const deleted = applyAction(state, { type: "task.delete", payload: { id: state.tasks[0].id } }, now).state;
    const refreshed = ingestTaskCandidates(deleted, [{ ...candidate, sourceVersion: "v2" }]);
    expect(refreshed.tasks).toHaveLength(1);
    expect(refreshed.tasks[0].removedAt).toBe(now.toISOString());
  });
  it("creates each recurring occurrence once, preserving completed occurrences", () => {
    const template = task("template", { dueDate: "2026-10-03", status: "done", completedAt: "2026-10-03T07:00:00Z" });
    const state = materializeOccurrence(workspace(), template, "series-one", "2026-10-04");
    expect(state.tasks[0]).toMatchObject({ status: "open", dueDate: "2026-10-04", plannedDate: "2026-10-04" });
    state.tasks[0].status = "done";
    expect(materializeOccurrence(state, template, "series-one", "2026-10-04")).toEqual(state);
    const next = materializeOccurrence(state, template, "series-one", "2026-10-05");
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[0].id).not.toBe(next.tasks[1].id);
  });
});
