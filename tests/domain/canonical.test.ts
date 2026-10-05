import { describe, expect, it } from "vitest";
import { applyAction } from "../../src/lib/domain/actions";
import { getTaskAliases, getTaskSourceState, providerSourceId } from "../../src/lib/domain/identity";
import { isActiveTask } from "../../src/lib/domain/lifecycle";
import { projectTasks, selectTasks } from "../../src/lib/domain/projections";
import { getTaskFeedDetails, rankTaskFeed } from "../../src/lib/domain/feed";
import { generatePlan } from "../../src/lib/domain/planner";
import { ingestTaskCandidates, rolloverTasks, type TaskCandidate } from "../../src/lib/domain/tasks";
import { operationKey, stableId } from "../../src/lib/domain/core";
import { now, task, workspace } from "./helpers";

const obligation: TaskCandidate = { sourceId: "canvas-synthetic-account-course-assignment-10", sourceVersion: "1", itemId: "obligation", title: "Example assignment",
  plannedDate: "2026-10-03", dueDate: "2026-10-06", dueTime: "17:00", categories: ["School"], nextAction: "Complete the example assignment", estimateMinutes: 30, notes: "Original source context", providerState: "not_submitted" };

function exampleState() {
  const state = workspace();
  state.tasks = [task("network-email", { title: "Send an example networking email", priority: "P1", categories: ["Networking", "Clubs"], nextAction: "Review the draft", dueDate: "2026-10-06", dueTime: "17:00", sourceIds: ["example-source"], agentId: "agent-comms", revision: 1 })];
  state.events = [{ id: "fixed-event", title: "Example fixed event", start: "2026-10-03T12:00:00Z", end: "2026-10-03T13:00:00Z", calendarId: "example-calendar", status: "confirmed", sourceIds: ["example-source"] }];
  state.plan = [{ id: "pinned-work", taskId: "network-email", start: "2026-10-03T09:00:00Z", end: "2026-10-03T09:30:00Z", pinned: true }];
  state.daily = { id: "example-day", date: state.today, timezone: "UTC", mode: "demo", createdAt: now.toISOString(), updatedAt: now.toISOString(), sources: [], providers: [], taskIds: ["network-email"], receiptIds: [], summary: "Synthetic daily state" };
  return state;
}

describe("canonical task views and lifecycle", () => {
  it("uses the same canonical record in priority, every category, planned-date and deadline views", () => {
    const state = exampleState(), views = projectTasks(state);
    for (const representation of [views.byPriority.P1[0], views.byCategory.Networking[0], views.byCategory.Clubs[0], views.byPlannedDate["2026-10-03"][0], views.byDueDate["2026-10-06"][0]]) expect(representation).toBe(state.tasks[0]);
    expect(views.byCategory.School).toEqual([]);
    expect(views.fixedEvents[0]).toBe(state.events[0]);
  });
  it("completes from any view in one returned state, clears active projections and retains exact history and receipt", () => {
    const state = exampleState(), before = structuredClone(state);
    const plannedRepresentation = projectTasks(state).byPlannedDate["2026-10-03"][0];
    const result = applyAction(state, { type: "task.update", payload: { id: plannedRepresentation.id, status: "done", expectedVersion: state.version }, requestId: "complete-network" }, now);
    const next = result.state, views = projectTasks(next);
    expect(views.active).toEqual([]); expect(views.byPriority.P1).toEqual([]); expect(views.byCategory.Networking).toEqual([]); expect(views.byCategory.Clubs).toEqual([]);
    expect(views.byPlannedDate["2026-10-03"]).toBeUndefined(); expect(views.byDueDate["2026-10-06"]).toBeUndefined();
    expect(rankTaskFeed(next, now)).toEqual([]); expect(next.plan).toEqual([]); expect(next.daily!.taskIds).toEqual([]);
    expect(views.completed[0]).toMatchObject({ id: "network-email", title: state.tasks[0].title, sourceIds: ["example-source"], categories: ["Networking", "Clubs"], completedAt: now.toISOString(), revision: 2 });
    expect(next.taskHistory!.at(-1)).toMatchObject({ taskId: "network-email", action: "completed", before: { status: "open" }, after: { status: "done", revision: 2 } });
    expect(next.runs[0]).toMatchObject({ taskId: "network-email", modelCalls: 0, apiCalls: 0, changedEventIds: [] });
    expect(next.events).toEqual(state.events); expect(state).toEqual(before);
    expect(applyAction(next, { type: "task.update", payload: { id: plannedRepresentation.id, status: "done", expectedVersion: state.version }, requestId: "complete-network" }, now)).toEqual(result);
  });
  it("retains a removal tombstone, restores the same ID, and preserves both lifecycle snapshots", () => {
    const state = exampleState();
    const removed = applyAction(state, { type: "task.delete", payload: { id: projectTasks(state).byCategory.Networking[0].id } }, now).state;
    expect(removed.tasks).toHaveLength(1); expect(projectTasks(removed).removed[0].id).toBe("network-email"); expect(projectTasks(removed).active).toEqual([]);
    expect(removed.processedKeys).toContain(operationKey("task-deleted", "network-email"));
    expect(() => applyAction(removed, { type: "task.update", payload: { id: "network-email", status: "open" } }, now)).toThrow(/Restore/);
    const restored = applyAction(removed, { type: "task.restore", payload: { id: "network-email" } }, new Date("2026-10-04T08:00:00Z")).state;
    expect(projectTasks(restored).byCategory.Networking[0].id).toBe("network-email");
    expect(restored.taskHistory!.map(entry => entry.action)).toEqual(["removed", "restored"]);
    expect(restored.taskHistory![0].after!.removedAt).toBe(now.toISOString());
    expect(restored.tasks[0]).toMatchObject({ status: "open", revision: 3, dueDate: "2026-10-06" });
    expect(restored.tasks[0].removedAt).toBeUndefined(); expect(restored.events).toEqual(state.events);
  });
  it("does not reopen completed work when restoring its removed representation", () => {
    const state = exampleState(); state.tasks[0].status = "done"; state.tasks[0].completedAt = now.toISOString();
    const removed = applyAction(state, { type: "task.delete", payload: { id: "network-email" } }, now).state;
    const restored = applyAction(removed, { type: "task.restore", payload: { id: "network-email" } }, now).state;
    expect(projectTasks(restored).active).toEqual([]); expect(projectTasks(restored).completed[0].id).toBe("network-email");
  });
  it("moves only planned membership and preserves provider deadline and all categories", () => {
    const state = exampleState(); state.tasks[0].providerDueDate = "2026-10-06";
    const next = applyAction(state, { type: "task.update", payload: { id: "network-email", plannedDate: "2026-10-05" } }, now).state;
    const views = projectTasks(next);
    expect(views.byPlannedDate["2026-10-03"]).toBeUndefined(); expect(views.byPlannedDate["2026-10-05"][0].id).toBe("network-email");
    expect(views.byDueDate["2026-10-06"][0]).toMatchObject({ providerDueDate: "2026-10-06", categories: ["Networking", "Clubs"] });
    expect(next.tasks[0].userEditedFields).toContain("plannedDate");
  });
  it("returns the committed revision for a refreshed client and rejects optional stale revision edits", () => {
    const staleClient = exampleState();
    const committed = applyAction(staleClient, { type: "task.update", payload: { id: "network-email", status: "done" } }, now).state;
    expect(committed.version).toBe(staleClient.version + 1);
    expect(projectTasks(structuredClone(committed)).active).toEqual([]);
    expect(() => applyAction(committed, { type: "task.update", payload: { id: "network-email", status: "open", expectedVersion: staleClient.version } }, now)).toThrow(/Refresh/);
    expect(committed.tasks[0].status).toBe("done");
  });
  it("supports custom categories, category normalization, and history search without duplicate records", () => {
    const state = exampleState();
    const edited = applyAction(state, { type: "task.update", payload: { id: "network-email", categories: ["Networking", " Research ", "Research", "__proto__"] } }, now).state;
    expect(edited.tasks[0].categories).toEqual(["Networking", "Research", "__proto__"]);
    expect(projectTasks(edited).byCategory["__proto__"][0].id).toBe("network-email");
    const done = applyAction(edited, { type: "task.update", payload: { id: "network-email", status: "done" } }, now).state;
    expect(selectTasks(done, { view: "completed", q: "networking", category: "Research" })).toHaveLength(1);
    expect(selectTasks(done, { category: "Research" })).toEqual([]);
  });
  it("filters retained completion/removal history by local date independently from planned/deadline dates", () => {
    const state = exampleState(); state.settings.timezone = "America/Los_Angeles";
    const completed = applyAction(state, { type: "task.update", payload: { id: "network-email", status: "done" } }, new Date("2026-10-04T01:00:00Z")).state;
    expect(selectTasks(completed, { view: "completed", completedDate: "2026-10-03" })).toHaveLength(1);
    expect(selectTasks(completed, { view: "completed", completedDate: "2026-10-04" })).toEqual([]);
    const removed = applyAction(completed, { type: "task.delete", payload: { id: "network-email" } }, new Date("2026-10-05T01:00:00Z")).state;
    expect(selectTasks(removed, { view: "removed", removedDate: "2026-10-04" })).toHaveLength(1);
  });
  it("separates deadline, planned, waiting/blocked, fixed-event and completion projections", () => {
    const state = exampleState(); state.tasks.push(task("overdue", { dueDate: "2026-10-02" }), task("blocked", { status: "blocked", needsInput: "Example dependency" }), task("complete", { status: "done" }));
    const views = projectTasks(state);
    expect(views.overdue.map(item => item.id)).toEqual(["overdue"]); expect(views.waiting.map(item => item.id)).toEqual(["blocked"]);
    expect(views.planned.some(item => item.id === "blocked")).toBe(false); expect(views.fixedEvents).toHaveLength(1); expect(views.completed).toHaveLength(1);
    expect(generatePlan(state).blocks.some(block => block.taskId === "blocked")).toBe(false);
    expect(generatePlan(state).conflicts.some(conflict => conflict.includes("past its deadline"))).toBe(true);
  });
  it("rolls eligible work while preserving state/deadlines and records history without moving events", () => {
    const state = exampleState(); state.tasks[0].pinned = false;
    state.tasks.push(task("blocked", { status: "blocked" }), task("followup", { status: "blocked", nextActionDate: "2026-10-04" }), task("removed", { removedAt: now.toISOString() }), task("done", { status: "done" }));
    const next = rolloverTasks(state, "2026-10-04", now);
    expect(next.tasks[0]).toMatchObject({ plannedDate: "2026-10-04", dueDate: "2026-10-06", categories: ["Networking", "Clubs"], nextAction: "Review the draft" });
    expect(next.tasks[1].plannedDate).toBe("2026-10-03"); expect(next.tasks[2]).toMatchObject({ plannedDate: "2026-10-04", status: "blocked" });
    expect(next.tasks[3].plannedDate).toBe("2026-10-03"); expect(next.tasks[4].status).toBe("done");
    expect(next.events).toEqual(state.events); expect(next.taskHistory!.every(entry => entry.action === "rolled_over")).toBe(true);
    expect(rolloverTasks(next, "2026-10-04", now)).toEqual(next);
  });
});

describe("canonical source reconciliation", () => {
  it("updates an unedited provider deadline/title on the same task and records before/after values", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now), id = first.tasks[0].id;
    const next = ingestTaskCandidates(first, [{ ...obligation, sourceVersion: "2", dueDate: "2026-10-07", title: "Updated provider title" }], new Date("2026-10-04T08:00:00Z"));
    expect(next.tasks).toHaveLength(1); expect(next.tasks[0]).toMatchObject({ id, title: "Updated provider title", dueDate: "2026-10-07", providerDueDate: "2026-10-07", revision: 2 });
    expect(next.taskHistory!.at(-1)).toMatchObject({ action: "source_updated", before: { dueDate: "2026-10-06" }, after: { dueDate: "2026-10-07" } });
    expect(projectTasks(next).byDueDate["2026-10-06"]).toBeUndefined(); expect(projectTasks(next).byDueDate["2026-10-07"][0].id).toBe(id);
  });
  it("preserves explicit user corrections and keeps conflicting latest provider values for review", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now), id = first.tasks[0].id;
    const corrected = applyAction(first, { type: "task.update", payload: { id, title: "My title", priority: "P0", categories: ["School", "Personal/Admin"], plannedDate: "2026-10-05", dueDate: "2026-10-08", nextAction: "Read my notes", notes: "My notes", estimateMinutes: 90, status: "done" } }, now).state;
    const changed = { ...obligation, sourceVersion: "2", title: "Changed provider title", dueDate: "2026-10-09", categories: ["Provider category"], nextAction: "Provider next action", estimateMinutes: 5, notes: "Provider notes", providerState: "not_submitted", completed: false };
    const next = ingestTaskCandidates(corrected, [changed], now);
    expect(next.tasks[0]).toMatchObject({ id, title: "My title", priority: "P0", categories: ["School", "Personal/Admin"], plannedDate: "2026-10-05", dueDate: "2026-10-08", providerDueDate: "2026-10-09", nextAction: "Read my notes", notes: "My notes", estimateMinutes: 90, status: "done" });
    expect(next.tasks[0].providerValues).toMatchObject({ title: "Changed provider title", version: "2", dueDate: "2026-10-09", state: "not_submitted" });
    expect(next.tasks[0].providerConflicts).toEqual(expect.arrayContaining(["title", "dueDate", "categories", "nextAction", "estimateMinutes", "notes"]));
    expect(getTaskSourceState(next, id)?.values.notes).toBe("Provider notes"); expect(projectTasks(next).active).toEqual([]);
  });
  it("never reopens completion on an unchanged or changed-source scan", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now), id = first.tasks[0].id;
    const completed = applyAction(first, { type: "task.update", payload: { id, status: "done" } }, now).state;
    expect(ingestTaskCandidates(completed, [obligation], now)).toEqual(completed);
    const refreshed = ingestTaskCandidates(completed, [{ ...obligation, sourceVersion: "2", completed: false }], now);
    expect(refreshed.tasks[0]).toMatchObject({ id, status: "done", completedAt: now.toISOString() });
    expect(refreshed.taskHistory!.filter(entry => entry.action === "completed")).toHaveLength(1);
  });
  it("keeps removal across changed revisions and new aliases, then restores the same ID", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now), id = first.tasks[0].id;
    const removed = applyAction(first, { type: "task.delete", payload: { id } }, now).state;
    const alias = { ...obligation, sourceId: "canvas-synthetic-quiz-20", sourceVersion: "2", aliases: [obligation.sourceId] };
    const refreshed = ingestTaskCandidates(removed, [alias], now);
    expect(refreshed.tasks).toHaveLength(1); expect(refreshed.tasks[0]).toMatchObject({ id, removedAt: now.toISOString() }); expect(projectTasks(refreshed).active).toEqual([]);
    const restored = applyAction(refreshed, { type: "task.restore", payload: { id } }, now).state;
    expect(ingestTaskCandidates(restored, [alias], now).tasks[0].id).toBe(id); expect(projectTasks(restored).active).toHaveLength(1);
  });
  it("keeps legacy hard-delete tombstones effective through newly discovered aliases", () => {
    const state = workspace(), id = stableId("task", obligation.sourceId, obligation.itemId);
    state.processedKeys.push(operationKey("task-deleted", id));
    const alias = { ...obligation, sourceId: "canvas-synthetic-quiz-20", aliases: [obligation.sourceId] };
    const discovered = ingestTaskCandidates(state, [alias], now);
    expect(discovered.tasks).toEqual([]);
    expect(ingestTaskCandidates(discovered, [{ ...alias, sourceVersion: "2", aliases: [] }], now).tasks).toEqual([]);
  });
  it.each(["submitted", "pending_grading", "graded", "excused", "pending_review"])("keeps provider %s separate from local completion and out of active submission work", providerState => {
    const state = ingestTaskCandidates(workspace(), [{ ...obligation, providerState, completed: true }], now);
    expect(state.tasks[0].status).toBe("open"); expect(state.tasks[0].completedAt).toBeUndefined();
    expect(projectTasks(state).active).toEqual([]); expect(projectTasks(state).providerCompleted).toHaveLength(1);
    expect(generatePlan(state).blocks).toEqual([]);
  });
  it("does not invent a deadline for verified reading work or create absent source obligations", () => {
    const reading = { ...obligation, sourceId: "reading-source", itemId: "required-reading", dueDate: undefined, dueTime: undefined, providerState: "not_completed", nextAction: "Read the required page" };
    const state = ingestTaskCandidates(workspace(), [reading], now);
    expect(projectTasks(state).overdue).toEqual([]); expect(projectTasks(state).planned).toHaveLength(1);
    expect(ingestTaskCandidates(state, [], now).tasks).toEqual(state.tasks);
  });
  it("preserves the last verified deadline when completion becomes unknown without declaring definite overdue work", () => {
    const first = ingestTaskCandidates(workspace(), [{ ...obligation, dueDate: "2026-10-02" }], now);
    const { dueDate: omitted, dueTime: omittedTime, ...unknown } = obligation; void omitted; void omittedTime;
    const refreshed = ingestTaskCandidates(first, [{ ...unknown, sourceVersion: "2", providerState: "unknown", completed: false }], now);
    expect(refreshed.tasks[0].status).toBe("open"); expect(refreshed.tasks[0].dueDate).toBe("2026-10-02");
    expect(refreshed.tasks[0].providerDueDate).toBe("2026-10-02");
    expect(refreshed.taskHistory!.at(-1)!.before!.dueDate).toBe("2026-10-02");
    expect(projectTasks(refreshed).deadlines).toHaveLength(1); expect(projectTasks(refreshed).overdue).toEqual([]); expect(projectTasks(refreshed).waiting).toHaveLength(1);
    expect(generatePlan(refreshed).blocks).toEqual([]);
  });
  it.each(["2026-10-02", "2026-10-09"])("keeps a verified dated lab visible with unknown completion for deadline %s", dueDate => {
    const state = ingestTaskCandidates(workspace(), [{ ...obligation, title: "Verified in-person lab", nextAction: "Attend the verified lab", providerState: "unknown", requirementState: "verified", applicabilityState: "verified", completed: false, dueDate }], now);
    const views = projectTasks(state);
    expect(state.tasks[0]).toMatchObject({ title: "Verified in-person lab", dueDate, providerDueDate: dueDate, providerState: "unknown", status: "open" });
    expect(views.byDueDate[dueDate][0].id).toBe(state.tasks[0].id);
    expect(views.waiting.map(task => task.id)).toContain(state.tasks[0].id);
    expect(projectTasks(state, dueDate).deadlines.map(task => task.id)).toContain(state.tasks[0].id);
    expect(views.overdue).toEqual([]); expect(rankTaskFeed(state, now)[0].id).toBe(state.tasks[0].id);
    if (dueDate < state.today) expect(getTaskFeedDetails(state, state.tasks[0].id).needsInput).toBe("Deadline passed; completion unverified.");
  });
  it.each(["requirementState", "applicabilityState"] as const)("withholds an inferred hard deadline only when %s is explicitly unverified", field => {
    const first = ingestTaskCandidates(workspace(), [{ ...obligation, requirementState: "verified", applicabilityState: "verified", [field]: "unknown" }], now);
    expect(first.tasks[0].dueDate).toBeUndefined(); expect(first.tasks[0].providerDueDate).toBe(obligation.dueDate);
    expect(projectTasks(first).deadlines).toEqual([]); expect(projectTasks(first).waiting).toHaveLength(1);
    expect(getTaskFeedDetails(first, first.tasks[0].id).needsInput).toMatch(/requirement and its applicability/);
    const confirmed = ingestTaskCandidates(first, [{ ...obligation, sourceVersion: "2", requirementState: "verified", applicabilityState: "verified" }], now);
    expect(confirmed.tasks[0].id).toBe(first.tasks[0].id); expect(confirmed.tasks[0].dueDate).toBe(obligation.dueDate);
    expect(confirmed.tasks[0].userEditedFields).not.toContain("dueDate");
  });
  it("preserves an explicit user deadline even when provider applicability becomes unknown", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now);
    const corrected = applyAction(first, { type: "task.update", payload: { id: first.tasks[0].id, dueDate: "2026-10-10" } }, now).state;
    const next = ingestTaskCandidates(corrected, [{ ...obligation, sourceVersion: "2", applicabilityState: "unknown" }], now);
    expect(next.tasks[0].dueDate).toBe("2026-10-10"); expect(next.tasks[0].providerApplicabilityState).toBe("unknown");
    expect(projectTasks(next).waiting).toHaveLength(1);
  });
  it("does not invent a date for a source obligation lacking a verified deadline", () => {
    const { dueDate, dueTime, ...undated } = obligation; void dueDate; void dueTime;
    const state = ingestTaskCandidates(workspace(), [{ ...undated, providerState: "unknown" }], now);
    expect(state.tasks[0].dueDate).toBeUndefined(); expect(state.tasks[0].providerDueDate).toBeUndefined();
    expect(projectTasks(state).deadlines).toEqual([]); expect(projectTasks(state).waiting).toHaveLength(1);
  });
  it("retains unseen records after partial/empty refreshes rather than interpreting absence as removal", () => {
    const state = ingestTaskCandidates(workspace(), [obligation, { ...obligation, sourceId: "second-source" }], now);
    const partial = ingestTaskCandidates(state, [{ ...obligation, sourceVersion: "2" }], now);
    expect(partial.tasks).toHaveLength(2); expect(partial.tasks.every(isActiveTask)).toBe(true);
    expect(ingestTaskCandidates(partial, [], now)).toEqual(partial);
  });
  it("preserves omitted deadline fields but clears explicit null after JSON transport", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now);
    const partialCandidate: TaskCandidate = JSON.parse(JSON.stringify({ ...obligation, sourceVersion: "2", dueDate: undefined, dueTime: undefined }));
    const partial = ingestTaskCandidates(first, [partialCandidate], now);
    expect(partial.tasks[0]).toMatchObject({ dueDate: obligation.dueDate, dueTime: obligation.dueTime, providerDueDate: obligation.dueDate, providerDueTime: obligation.dueTime });
    const clearCandidate: TaskCandidate = JSON.parse(JSON.stringify({ ...obligation, sourceVersion: "3", dueDate: null, dueTime: null }));
    const cleared = ingestTaskCandidates(partial, [clearCandidate], now), task = cleared.tasks[0];
    expect(cleared.tasks).toHaveLength(1); expect(task.id).toBe(first.tasks[0].id);
    expect(task.dueDate).toBeUndefined(); expect(task.dueTime).toBeUndefined();
    expect(task.providerDueDate).toBeUndefined(); expect(task.providerDueTime).toBeUndefined();
    expect(task.providerValues!.dueDate).toBeUndefined(); expect(task.providerValues!.dueTime).toBeUndefined();
    expect(getTaskSourceState(cleared, task.id)?.values).toMatchObject({ dueDate: null, dueTime: null });
    expect(projectTasks(cleared).byDueDate["2026-10-06"]).toBeUndefined();
    expect(cleared.taskHistory!.at(-1)).toMatchObject({ action: "source_updated", before: { dueDate: obligation.dueDate, dueTime: obligation.dueTime }, after: { id: task.id, revision: 3 } });
    expect(cleared.taskHistory!.at(-1)!.after!.dueDate).toBeUndefined();
    expect(first.tasks[0].dueDate).toBe(obligation.dueDate);
    const persisted = JSON.parse(JSON.stringify(cleared));
    expect(ingestTaskCandidates(persisted, [clearCandidate], now)).toEqual(persisted);
  });
  it("preserves user deadline corrections while recording an explicitly cleared provider deadline", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now), id = first.tasks[0].id;
    const corrected = applyAction(first, { type: "task.update", payload: { id, dueDate: "2026-10-08", dueTime: "12:30" } }, now).state;
    const candidate: TaskCandidate = JSON.parse(JSON.stringify({ ...obligation, sourceVersion: "2", dueDate: null, dueTime: null }));
    const next = ingestTaskCandidates(corrected, [candidate], now);
    expect(next.tasks[0]).toMatchObject({ id, dueDate: "2026-10-08", dueTime: "12:30" });
    expect(next.tasks[0].providerDueDate).toBeUndefined(); expect(next.tasks[0].providerDueTime).toBeUndefined();
    expect(next.tasks[0].providerConflicts).toEqual(expect.arrayContaining(["dueDate", "dueTime"]));
    expect(getTaskSourceState(next, id)?.values).toMatchObject({ dueDate: null, dueTime: null });
    expect(projectTasks(next).byDueDate["2026-10-08"][0].id).toBe(id);
  });
  it("clears a provider due time without losing the omitted verified date", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now);
    const candidate: TaskCandidate = JSON.parse(JSON.stringify({ ...obligation, sourceVersion: "2", dueDate: undefined, dueTime: null }));
    const next = ingestTaskCandidates(first, [candidate], now);
    expect(next.tasks[0].dueDate).toBe(obligation.dueDate); expect(next.tasks[0].providerDueDate).toBe(obligation.dueDate);
    expect(next.tasks[0].dueTime).toBeUndefined(); expect(next.tasks[0].providerDueTime).toBeUndefined();
    expect(getTaskSourceState(next, next.tasks[0].id)?.values).toMatchObject({ dueDate: obligation.dueDate, dueTime: null });
  });
  it("accepts initially null deadlines and later verified dates without inferring a user correction", () => {
    const first = ingestTaskCandidates(workspace(), [{ ...obligation, dueDate: null, dueTime: null }], now);
    expect(first.tasks[0].dueDate).toBeUndefined(); expect(first.tasks[0].dueTime).toBeUndefined();
    const restored = ingestTaskCandidates(JSON.parse(JSON.stringify(first)), [{ ...obligation, sourceVersion: "2" }], now);
    expect(restored.tasks[0]).toMatchObject({ id: first.tasks[0].id, dueDate: obligation.dueDate, dueTime: obligation.dueTime });
    expect(restored.tasks[0].userEditedFields).not.toContain("dueDate"); expect(restored.tasks[0].userEditedFields).not.toContain("dueTime");
    expect(restored.tasks[0].providerConflicts).not.toContain("dueDate");
  });
  it.each(["completed", "removed"] as const)("never reopens a %s task when a provider clears its deadline", lifecycle => {
    const first = ingestTaskCandidates(workspace(), [obligation], now), id = first.tasks[0].id;
    const saved = applyAction(first, lifecycle === "completed" ? { type: "task.update", payload: { id, status: "done" } } : { type: "task.delete", payload: { id } }, now).state;
    const next = ingestTaskCandidates(saved, [{ ...obligation, sourceVersion: "2", dueDate: null, dueTime: null }], now);
    expect(next.tasks).toHaveLength(1); expect(next.tasks[0].id).toBe(id);
    expect(next.tasks[0].status).toBe(saved.tasks[0].status); expect(next.tasks[0].removedAt).toBe(saved.tasks[0].removedAt);
    expect(next.tasks[0].dueDate).toBeUndefined(); expect(next.tasks[0].providerDueDate).toBeUndefined();
    expect(projectTasks(next).active).toEqual([]);
  });
  it("rejects an invalid batch atomically and uses no model/API work", () => {
    const state = workspace(), before = structuredClone(state);
    expect(() => ingestTaskCandidates(state, [obligation, { ...obligation, sourceId: "bad", dueDate: "2026-02-30" }], now)).toThrow();
    expect(state).toEqual(before);
    const next = ingestTaskCandidates(state, [obligation], now);
    expect(next.usage).toEqual(state.usage);
  });
});

describe("verified source and migration aliases", () => {
  it("maps assignments/quizzes/discussions/module aliases to one obligation with stable identity", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now), id = first.tasks[0].id;
    const sources = ["synthetic-quiz-20", "synthetic-discussion-30", "synthetic-module-item-40"];
    let state = first;
    for (const sourceId of sources) state = ingestTaskCandidates(state, [{ ...obligation, sourceId, aliases: [obligation.sourceId] }], now);
    expect(state.tasks).toHaveLength(1); expect(state.tasks[0].id).toBe(id);
    expect(state.tasks[0].providerAliases).toEqual(expect.arrayContaining([obligation.sourceId, ...sources]));
    const replay = ingestTaskCandidates(state, sources.map(sourceId => ({ ...obligation, sourceId, aliases: [obligation.sourceId] })), now);
    expect(replay).toEqual(state);
  });
  it("keeps distinct same-title provider IDs separate", () => {
    const state = ingestTaskCandidates(workspace(), [obligation, { ...obligation, sourceId: "another-assignment" }], now);
    expect(state.tasks).toHaveLength(2); expect(state.tasks[0].id).not.toBe(state.tasks[1].id);
  });
  it("supports verified tracker-location aliases without changing the original task ID", () => {
    const first = ingestTaskCandidates(workspace(), [obligation], now);
    const migrated = ingestTaskCandidates(first, [{ ...obligation, sourceId: "tracker-category-view", itemId: "row-7", sourceUrl: "https://example.com/tracker#row-7",
      verifiedAliases: [{ sourceId: obligation.sourceId, itemId: obligation.itemId, verified: true, evidence: "Reviewed tracker crosslink" }] }], now);
    expect(migrated.tasks).toHaveLength(1); expect(migrated.tasks[0].id).toBe(first.tasks[0].id);
    expect(getTaskAliases(migrated, first.tasks[0].id)).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: "tracker-category-view", itemId: "row-7", url: "https://example.com/tracker#row-7" })]));
  });
  it("preserves ambiguous existing identities for review instead of merging them by assertion", () => {
    const first = ingestTaskCandidates(workspace(), [obligation, { ...obligation, sourceId: "other" }], now), before = structuredClone(first);
    expect(() => ingestTaskCandidates(first, [{ ...obligation, sourceVersion: "2", aliases: ["other"] }], now)).toThrow(/migration review/);
    expect(first).toEqual(before);
    expect(() => ingestTaskCandidates(first, [{ ...obligation, verifiedAliases: [{ sourceId: "x", itemId: "y", verified: false, evidence: "Same title" } as never] }], now)).toThrow(/verified evidence/);
  });
  it("scopes provider identity by owner, instance, account, container, kind and external ID", () => {
    const identity = { ownerId: "example-owner", provider: "canvas", instance: "https://canvas.example.com", accountId: "example-account", containerId: "course-10", kind: "assignment", externalId: "100" };
    const id = providerSourceId(identity);
    expect(providerSourceId({ ...identity })).toBe(id);
    for (const field of Object.keys(identity) as Array<keyof typeof identity>) expect(providerSourceId({ ...identity, [field]: `${identity[field]}-different` })).not.toBe(id);
  });
});
