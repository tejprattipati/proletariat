import { describe, expect, it } from "vitest";
import { applyAction } from "../../src/lib/domain/actions";
import { createDemoState } from "../../src/lib/domain/fixtures";
import { now, task, workspace } from "./helpers";

describe("pure action reducer", () => {
  it("builds deterministic synthetic fixtures without modifying caller state", () => {
    expect(createDemoState(now)).toEqual(createDemoState(now));
    const state = workspace(); const before = structuredClone(state);
    const result = applyAction(state, { type: "task.create", payload: { title: "Example task" } }, now);
    expect(state).toEqual(before);
    expect(result.state.tasks).toHaveLength(1);
    expect(result.state.usage.modelCalls).toBe(0);
    expect(result.state.usage.apiCalls).toBe(0);
  });
  it("returns the original receipt on replay and rejects a reused key with different semantics", () => {
    const first = applyAction(workspace(), { type: "task.create", payload: { title: "Example", priority: "P0" }, requestId: "req-one" }, now);
    const replay = applyAction(first.state, { type: "task.create", payload: { priority: "P0", title: "Example" }, requestId: "req-one" }, new Date("2026-10-04T08:00:00Z"));
    expect(replay).toEqual(first);
    expect(() => applyAction(first.state, { type: "task.create", payload: { title: "Different" }, requestId: "req-one" }, now)).toThrow(/already used/);
  });
  it("keeps IDs unique for deliberate separate creates at the same timestamp", () => {
    const first = applyAction(workspace(), { type: "task.create", payload: { title: "Example" } }, now);
    const next = applyAction(first.state, { type: "task.create", payload: { title: "Example" } }, now);
    expect(next.state.tasks).toHaveLength(2);
    expect(next.entityId).not.toBe(first.entityId);
  });
  it("preserves immutable provenance fields and invalidates stale scheduling after user edits", () => {
    const state = workspace(); state.tasks = [task("one", { sourceIds: ["source-one"], dueDate: "2026-10-04" })];
    state.plan = [{ id: "b", taskId: "one", start: "2026-10-03T09:00:00Z", end: "2026-10-03T09:30:00Z", pinned: false }];
    const next = applyAction(state, { type: "task.update", payload: { id: "one", plannedDate: "2026-10-08", sourceIds: ["forged"], carryoverCount: 99 } }, now).state;
    expect(next.tasks[0]).toMatchObject({ id: "one", sourceIds: ["source-one"], carryoverCount: 0, dueDate: "2026-10-04" });
    expect(next.plan).toHaveLength(0);
  });
  it("pins current blocks, completes/reopens tasks and clears completion timestamps", () => {
    const state = workspace(); state.tasks = [task("one")];
    const planned = applyAction(state, { type: "plan.generate" }, now).state;
    const pinned = applyAction(planned, { type: "task.update", payload: { id: "one", pinned: true } }, now).state;
    expect(pinned.plan[0].pinned).toBe(true);
    const done = applyAction(pinned, { type: "task.update", payload: { id: "one", status: "done" } }, now).state;
    expect(done.tasks[0].completedAt).toBe(now.toISOString()); expect(done.plan).toHaveLength(0);
    expect(applyAction(done, { type: "task.update", payload: { id: "one", status: "open" } }, now).state.tasks[0].completedAt).toBeUndefined();
  });
  it("retains a removed task for history and removes its blocks", () => {
    const state = workspace(); state.tasks = [task("one")];
    const planned = applyAction(state, { type: "plan.generate" }, now).state;
    const result = applyAction(planned, { type: "task.delete", payload: { id: "one" } }, now);
    expect(result.state.tasks).toHaveLength(1); expect(result.state.tasks[0].removedAt).toBe(now.toISOString()); expect(result.state.plan).toHaveLength(0);
  });
  it.each([
    { type: "task.create", payload: { title: "" } },
    { type: "task.create", payload: { title: "Test", estimateMinutes: 0 } },
    { type: "task.create", payload: { title: "Test", estimateMinutes: Number.NaN } },
    { type: "task.create", payload: { title: "Test", dueDate: "2026-02-30" } },
    { type: "settings.update", payload: { workingHoursEnd: "07:00" } },
    { type: "settings.update", payload: { rolloverEnabled: "yes" } },
    { type: "permissions.update", payload: { send: "true" } },
    { type: "permissions.update", payload: { unknownPermission: true } },
    { type: "usage.update", payload: { dailyBudgetUsd: -1 } },
    { type: "unknown.action", payload: {} },
  ])("rejects invalid $type without mutation", action => {
    const state = workspace(); const before = structuredClone(state);
    expect(() => applyAction(state, action, now)).toThrow(); expect(state).toEqual(before);
  });
  it("supports settings, permissions, budget and reset actions", () => {
    let state = applyAction(workspace(), { type: "settings.update", payload: { timezone: "Asia/Kolkata", workingHoursStart: "08:30", workingHoursEnd: "16:30", rolloverEnabled: false } }, now).state;
    expect(state.settings.timezone).toBe("Asia/Kolkata");
    state = applyAction(state, { type: "permissions.update", payload: { send: true, gmailFull: true } }, now).state;
    expect(state.permissions.send).toBe(true);
    state = applyAction(state, { type: "usage.update", payload: { dailyBudgetUsd: 0 } }, now).state;
    expect(state.usage.dailyBudgetUsd).toBe(0);
    const reset = applyAction(state, { type: "demo.reset" }, now).state;
    expect(reset.settings.mode).toBe("demo"); expect(reset.permissions.send).toBe(false); expect(reset.tasks.length).toBeGreaterThan(0);
  });
  it("creates and updates agents with consistent initials", () => {
    const result = applyAction(workspace(), { type: "agent.create", payload: { name: "Example Agent", description: "Synthetic" } }, now);
    const state = applyAction(result.state, { type: "agent.update", payload: { id: result.entityId, pinned: true, name: "New Name" } }, now).state;
    expect(state.agents.at(-1)).toMatchObject({ name: "New Name", initials: "NN", pinned: true });
  });
});

describe("synthetic integrations", () => {
  it("does not duplicate the source-backed tasks already present in the demo", () => {
    const state = createDemoState(now);
    const refreshed = applyAction(state, { type: "sync.run", payload: { provider: "drive" } }, now).state.tasks;
    expect(refreshed.map(task => task.id)).toEqual(state.tasks.map(task => task.id));
    for (let i = 0; i < state.tasks.length; i++) expect(refreshed[i]).toMatchObject({ title: state.tasks[i].title, estimateMinutes: state.tasks[i].estimateMinutes, plannedDate: state.tasks[i].plannedDate, status: state.tasks[i].status });
  });
  it("syncs idempotently and keeps multiple sessions from one bound resource", () => {
    const state = workspace();
    const first = applyAction(state, { type: "sync.run", payload: { provider: "drive" } }, now).state;
    expect(first.tasks.filter(value => value.sourceIds.includes("demo-session-notes"))).toHaveLength(2);
    const second = applyAction(first, { type: "sync.run", payload: { provider: "drive" } }, now).state;
    expect(second.tasks).toEqual(first.tasks);
    const gmail = applyAction(second, { type: "sync.run", payload: { provider: "gmail" } }, now).state;
    expect(gmail.tasks).toHaveLength(second.tasks.length + 1);
  });
  it("requires separate broad-read permission and exposes complete scan accounting", () => {
    const state = workspace();
    expect(() => applyAction(state, { type: "scan.start", payload: { provider: "drive", coverage: "all" } }, now)).toThrow(/driveFull/);
    state.permissions.driveFull = true;
    const start = applyAction(state, { type: "scan.start", payload: { provider: "drive", coverage: "all" } }, now);
    expect(start.state.scans[0]).toMatchObject({ coverage: "all", status: "running", discovered: 5, analyzed: 0 });
    const paused = applyAction(start.state, { type: "scan.pause", payload: { id: start.entityId } }, now).state;
    expect(paused.scans[0].status).toBe("paused");
    paused.permissions.driveFull = false;
    expect(() => applyAction(paused, { type: "scan.resume", payload: { id: start.entityId } }, now)).toThrow(/driveFull/);
    paused.permissions.driveFull = true;
    const resumed = applyAction(paused, { type: "scan.resume", payload: { id: start.entityId } }, now).state;
    expect(resumed.scans[0]).toMatchObject({ status: "completed", discovered: 5, read: 4, analyzed: 4, skipped: 1, failed: 0 });
  });
  it("keeps selected scans within the bound-resource set", () => {
    const state = workspace(); state.resources[4].content = "Task: Unbound action";
    const start = applyAction(state, { type: "scan.start", payload: { provider: "drive", coverage: "selected" } }, now);
    expect(start.state.scans[0].discovered).toBe(3);
    const completed = applyAction(start.state, { type: "scan.resume", payload: { id: start.entityId } }, now).state;
    expect(completed.tasks.some(value => value.title === "Unbound action")).toBe(false);
  });
  it("binds exact resource targets, rejects unsafe URLs, and disallows output writes after unbinding", () => {
    const state = workspace();
    expect(() => applyAction(state, { type: "resource.bind", payload: { url: "javascript:alert(1)" } }, now)).toThrow(/HTTP/);
    const bound = applyAction(state, { type: "resource.bind", payload: { id: "demo-weekly-output", role: "output", tabId: "tab-example", namedRangeId: "range-example" } }, now).state;
    expect(bound.resources[3]).toMatchObject({ tabId: "tab-example", namedRangeId: "range-example" });
    bound.permissions.docsWrite = true;
    const written = applyAction(bound, { type: "docs.write", payload: { resourceId: "demo-weekly-output", content: "Synthetic replacement" } }, now).state;
    expect(written.resources[3].content).toBe("Synthetic replacement");
    const unbound = applyAction(written, { type: "resource.unbind", payload: { id: "demo-weekly-output" } }, now).state;
    expect(() => applyAction(unbound, { type: "docs.write", payload: { resourceId: "demo-weekly-output", content: "No" } }, now)).toThrow(/bound output/);
  });
  it("upserts a calendar event without duplication and validates timestamp offsets", () => {
    const state = workspace(); state.permissions.calendarWrite = true;
    const payload = { title: "Example event", start: "2026-10-03T09:00:00-04:00", end: "2026-10-03T10:00:00-04:00" };
    const first = applyAction(state, { type: "calendar.upsert", payload }, now);
    const updated = applyAction(first.state, { type: "calendar.upsert", payload: { ...payload, id: first.entityId, title: "Updated" } }, now).state;
    expect(updated.events).toHaveLength(1); expect(updated.events[0].title).toBe("Updated");
    expect(() => applyAction(state, { type: "calendar.upsert", payload: { ...payload, end: payload.start } }, now)).toThrow(/after/);
  });
  it("edits and sends a reviewed draft at most once, blocking uncertain retries", () => {
    const state = workspace();
    const created = applyAction(state, { type: "draft.create", payload: { to: "alex@example.com", subject: "Example", body: "Synthetic" } }, now);
    const edited = applyAction(created.state, { type: "draft.update", payload: { id: created.entityId, body: "Updated synthetic body" } }, now).state;
    expect(() => applyAction(edited, { type: "draft.send", payload: { id: created.entityId } }, now)).toThrow(/send/);
    edited.permissions.send = true;
    const sent = applyAction(edited, { type: "draft.send", payload: { id: created.entityId } }, now).state;
    const repeated = applyAction(sent, { type: "draft.send", payload: { id: created.entityId } }, now).state;
    expect(repeated.drafts).toEqual(sent.drafts);
    expect(repeated.processedKeys.filter(key => key.startsWith("draft-delivery:"))).toHaveLength(1);
    edited.drafts.at(-1)!.status = "unknown";
    expect(() => applyAction(edited, { type: "draft.send", payload: { id: created.entityId } }, now)).toThrow(/blindly/);
  });
  it("never silently simulates live external actions", () => {
    const state = workspace(); state.settings.mode = "live";
    for (const type of ["sync.run", "draft.send", "calendar.upsert", "docs.write", "scan.start"]) expect(() => applyAction(state, { type }, now)).toThrow(/adapter/);
    expect(applyAction(state, { type: "task.create", payload: { title: "Local task" } }, now).state.tasks).toHaveLength(1);
  });
});
