import { describe, expect, it } from "vitest";
import { generatePlan } from "../../src/lib/domain/planner";
import { task, workspace } from "./helpers";

describe("feasible deterministic planning", () => {
  it("respects timezone, overlapping meetings and both calendar buffers", () => {
    const state = workspace(); state.settings.timezone = "America/New_York"; state.settings.workingHoursEnd = "12:00";
    state.tasks = [task("one", { estimateMinutes: 60 }), task("two", { estimateMinutes: 30 })];
    state.events = [{ id: "a", title: "Meeting A", calendarId: "synthetic", status: "confirmed", sourceIds: [], start: "2026-10-03T09:30:00-04:00", end: "2026-10-03T10:30:00-04:00" },
      { id: "b", title: "Meeting B", calendarId: "synthetic", status: "tentative", sourceIds: [], start: "2026-10-03T10:00:00-04:00", end: "2026-10-03T10:45:00-04:00" }];
    const result = generatePlan(state);
    expect(result.blocks[0]).toMatchObject({ taskId: "one", start: "2026-10-03T14:55:00.000Z", end: "2026-10-03T15:55:00.000Z" });
    expect(result.unscheduledTaskIds).toEqual(["two"]);
    expect(generatePlan(state)).toEqual(result);
  });
  it("keeps unsplittable overflow visible and allows explicit splitting", () => {
    const state = workspace(); state.settings.workingHoursEnd = "11:00";
    state.events = [{ id: "a", title: "Meeting", start: "2026-10-03T09:45:00Z", end: "2026-10-03T10:15:00Z", calendarId: "synthetic", status: "confirmed", sourceIds: [] }];
    state.tasks = [task("large", { estimateMinutes: 60 })];
    expect(generatePlan(state).blocks).toHaveLength(0);
    state.tasks[0].splittable = true;
    const result = generatePlan(state);
    expect(result.blocks).toHaveLength(2);
    expect(result.unscheduledTaskIds).toHaveLength(0);
    expect(result.blocks.map(block => (Date.parse(block.end) - Date.parse(block.start)) / 60000)).toEqual([35, 25]);
  });
  it("reports partial overflow without losing the remaining estimate", () => {
    const state = workspace(); state.settings.workingHoursEnd = "10:00"; state.tasks = [task("long", { estimateMinutes: 90, splittable: true })];
    const result = generatePlan(state);
    expect(result.remainingMinutes).toEqual({ long: 30 });
    expect(state.tasks[0].estimateMinutes).toBe(90);
  });
  it("orders by priority and deadline, ignores completed and deferred tasks", () => {
    const state = workspace();
    state.tasks = [task("later", { priority: "P2" }), task("urgent", { priority: "P0" }), task("done", { status: "done" }), task("waiting", { status: "waiting" }), task("future", { plannedDate: "2026-10-04" })];
    const blocks = generatePlan(state).blocks;
    expect(blocks.map(block => block.taskId)).toEqual(["urgent", "later"]);
    expect(Date.parse(blocks[1].start) - Date.parse(blocks[0].end)).toBe(10 * 60000);
  });
  it("honors same-day hard deadlines and does not erase overdue deadlines", () => {
    const state = workspace();
    state.tasks = [task("missed", { dueDate: "2026-10-03", dueTime: "09:15", estimateMinutes: 30 }), task("overdue", { dueDate: "2026-10-02" })];
    const result = generatePlan(state);
    expect(result.unscheduledTaskIds).toContain("missed");
    expect(result.blocks[0].taskId).toBe("overdue");
    expect(state.tasks[1].dueDate).toBe("2026-10-02");
  });
  it("preserves pinned times and deducts their duration from the task estimate", () => {
    const state = workspace(); state.tasks = [task("one", { estimateMinutes: 60 })];
    state.plan = [{ id: "pin", taskId: "one", start: "2026-10-03T10:00:00Z", end: "2026-10-03T10:30:00Z", pinned: true }];
    const result = generatePlan(state);
    expect(result.blocks).toContainEqual(state.plan[0]);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.reduce((sum, block) => sum + Date.parse(block.end) - Date.parse(block.start), 0)).toBe(60 * 60000);
    expect(result.conflicts).toHaveLength(0);
  });
  it("reports conflicting pins instead of silently moving them", () => {
    const state = workspace(); state.tasks = [task("one")];
    state.plan = [{ id: "pin", taskId: "one", start: "2026-10-03T08:50:00Z", end: "2026-10-03T09:30:00Z", pinned: true }];
    state.events = [{ id: "meeting", title: "Meeting", start: "2026-10-03T09:20:00Z", end: "2026-10-03T10:00:00Z", calendarId: "synthetic", status: "confirmed", sourceIds: [] }];
    expect(generatePlan(state).conflicts).toHaveLength(2);
    expect(generatePlan(state).blocks).toEqual(state.plan);
  });
  it.each([["2026-03-08", "2026-03-08T13:00:00.000Z"], ["2026-11-01", "2026-11-01T14:00:00.000Z"]])("uses actual DST offset on %s", (date, expected) => {
    const state = workspace(); state.settings.timezone = "America/New_York"; state.tasks = [task("one", { plannedDate: date })];
    expect(generatePlan(state, date).blocks[0].start).toBe(expected);
  });
  it("rejects nonexistent local working time, bad timezone and naive calendar timestamps", () => {
    const state = workspace(); state.settings.timezone = "America/New_York"; state.settings.workingHoursStart = "02:30";
    expect(() => generatePlan(state, "2026-03-08")).toThrow(/nonexistent/);
    state.settings.timezone = "Invalid/Zone"; expect(() => generatePlan(state)).toThrow(/timezone/);
    state.settings.timezone = "UTC";
    state.events = [{ id: "a", title: "Invalid", start: "2026-10-03T10:00:00", end: "2026-10-03T11:00:00", status: "confirmed", calendarId: "synthetic", sourceIds: [] }];
    expect(() => generatePlan(state)).toThrow(/offset/);
  });
  it("never overlaps generated blocks across varied durations", () => {
    const state = workspace(); state.tasks = Array.from({ length: 20 }, (_, i) => task(`t-${i}`, { estimateMinutes: 15 + (i * 17) % 90, splittable: i % 2 === 0 }));
    const result = generatePlan(state);
    for (let i = 1; i < result.blocks.length; i++) expect(Date.parse(result.blocks[i].start) - Date.parse(result.blocks[i - 1].end)).toBeGreaterThanOrEqual(600000);
    for (const block of result.blocks) expect(Date.parse(block.end)).toBeLessThanOrEqual(Date.parse("2026-10-03T17:00:00Z"));
    expect(result.unscheduledTaskIds.length).toBeGreaterThan(0);
  });
});
