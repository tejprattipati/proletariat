import { describe, expect, it } from "vitest";
import type { Run } from "../../src/lib/types";
import { getTaskFeedDetails, getTaskReceipts, rankTaskFeed } from "../../src/lib/domain/feed";
import { applyAction } from "../../src/lib/domain/actions";
import { now, task, workspace } from "./helpers";

function receipt(id: string, fields: Partial<Run> = {}): Run {
  return { id, title: "Synthetic action", description: "Example result", status: "succeeded", createdAt: "2026-10-03T07:00:00Z", mode: "demo", modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0, sourceIds: [], ...fields };
}

describe("deterministic active task feed", () => {
  it("puts decisions first, due work next, recent results next, and excludes completed tasks", () => {
    const state = workspace();
    state.tasks = [task("ordinary"), task("recent"), task("due", { dueDate: "2026-10-03" }), task("decision", { needsInput: "Choose the audience." }), task("done", { status: "done", needsInput: "Must not appear", dueDate: "2026-10-01" })];
    state.runs = [receipt("recent-result", { taskId: "recent" })];
    expect(rankTaskFeed(state, now).map(item => item.id)).toEqual(["decision", "due", "recent", "ordinary"]);
    expect(rankTaskFeed({ ...state, tasks: [...state.tasks].reverse(), runs: [...state.runs].reverse() }, now)).toEqual(rankTaskFeed(state, now));
    expect(state.tasks[0].id).toBe("ordinary");
  });
  it("uses the workspace timezone for due dates and ignores future or stale result timestamps", () => {
    const state = workspace(); state.settings.timezone = "America/Los_Angeles";
    state.tasks = [task("today", { dueDate: "2026-10-02" }), task("tomorrow", { dueDate: "2026-10-03" }), task("recent"), task("future"), task("stale")];
    state.runs = [receipt("recent", { taskId: "recent", createdAt: "2026-10-03T00:00:00Z" }), receipt("future", { taskId: "future", createdAt: "2026-10-10T00:00:00Z" }), receipt("stale", { taskId: "stale", createdAt: "2026-09-01T00:00:00Z" })];
    expect(rankTaskFeed(state, new Date("2026-10-03T01:00:00Z")).slice(0, 3).map(item => item.id)).toEqual(["today", "recent", "tomorrow"]);
  });
  it("ranks blocked/uncertain tasks before ordinary work without using generic agent activity", () => {
    const state = workspace();
    state.tasks = [task("ordinary", { agentId: "agent-work" }), task("waiting", { status: "waiting" }), task("uncertain")];
    state.runs = [receipt("generic", { agentId: "agent-work", status: "failed" }), receipt("unknown", { taskId: "uncertain", status: "unknown" })];
    expect(getTaskFeedDetails(state, "ordinary").needsDecision).toBe(false);
    expect(getTaskFeedDetails(state, "uncertain").needsInput).toContain("Reconcile");
    expect(rankTaskFeed(state, now).map(item => item.id).at(-1)).toBe("ordinary");
  });
  it("breaks equal ranks by stable task identity", () => {
    const state = workspace(); state.tasks = [task("b"), task("a")];
    expect(rankTaskFeed(state, now).map(item => item.id)).toEqual(["a", "b"]);
  });
});

describe("exact per-card proof", () => {
  it("does not hide an uncertain result after a contextual note or metadata edit", () => {
    const state = workspace(); state.tasks = [task("one", { agentId: "agent-work" })];
    state.runs = [receipt("uncertain", { taskId: "one", status: "unknown", title: "recipe.run" })];
    const noted = applyAction(state, { type: "task.reply", payload: { taskId: "one", message: "Please check that outcome." } }, now).state;
    const updated = applyAction(noted, { type: "task.update", payload: { id: "one", title: "Renamed task" } }, now).state;
    const details = getTaskFeedDetails(updated, "one");
    expect(details.latestRun?.id).toBe("uncertain");
    expect(details.needsDecision).toBe(true);
    expect(details.receipts).toHaveLength(3);
  });
  it("does not attribute shared-source, other-task, or agent-wide usage to this task", () => {
    const state = workspace(); state.tasks = [task("one", { sourceIds: ["demo-session-notes"], agentId: "agent-learning" }), task("two", { sourceIds: ["demo-session-notes"], agentId: "agent-learning" })];
    state.runs = [receipt("source", { sourceIds: ["demo-session-notes"], modelCalls: 40 }), receipt("agent", { agentId: "agent-learning", modelCalls: 30 }), receipt("other", { taskId: "two", sourceIds: ["one"], modelCalls: 20 }), receipt("exact", { taskId: "one", modelCalls: 2, tokens: 100, apiCalls: 3 })];
    const details = getTaskFeedDetails(state, "one");
    expect(details.receipts.map(run => run.id)).toEqual(["exact"]);
    expect(details.usage).toMatchObject({ modelCalls: 2, tokens: 100, apiCalls: 3 });
    expect(details.inputResources.map(resource => resource.id)).toEqual(["demo-session-notes"]);
  });
  it("retains legacy exact task-ID receipts but never promotes input sources to output proof", () => {
    const state = workspace(); state.tasks = [task("one", { sourceIds: ["demo-project-notes"] })];
    state.runs = [receipt("legacy", { sourceIds: ["one", "demo-project-notes"] })];
    expect(getTaskReceipts(state, "one")).toHaveLength(1);
    const details = getTaskFeedDetails(state, "one");
    expect(details.inputResources).toHaveLength(1); expect(details.changedResources).toHaveLength(0); expect(details.changedEvents).toHaveLength(0);
  });
  it("shows only explicitly recorded resource/event outputs and exact contextual messages", () => {
    const state = workspace(); state.tasks = [task("one", { agentId: "agent-work" })];
    state.events = [{ id: "event-one", title: "Example", start: "2026-10-03T09:00:00Z", end: "2026-10-03T10:00:00Z", calendarId: "demo", status: "confirmed", sourceIds: [] }];
    state.runs = [receipt("result", { taskId: "one", changedResourceIds: ["demo-weekly-output", "missing"], changedEventIds: ["event-one"] })];
    state.agents[0].messages.push({ id: "exact", role: "user", content: "For this task", taskId: "one", createdAt: now.toISOString() }, { id: "other", role: "user", content: "Other work", taskId: "two", createdAt: now.toISOString() });
    const details = getTaskFeedDetails(state, "one");
    expect(details.changedResources.map(resource => resource.id)).toEqual(["demo-weekly-output"]);
    expect(details.changedEvents.map(event => event.id)).toEqual(["event-one"]);
    expect(details.messages.map(message => message.id)).toEqual(["exact"]);
  });
  it("links actual domain actions to tasks with provenance, accurate zero model calls, and changed outputs", () => {
    const state = workspace(); state.tasks = [task("one", { agentId: "agent-work", sourceIds: ["demo-project-notes"] })];
    state.permissions.docsWrite = true;
    const updated = applyAction(state, { type: "task.update", payload: { id: "one", needsInput: "Review the new outline." } }, now).state;
    const written = applyAction(updated, { type: "docs.write", payload: { resourceId: "demo-weekly-output", content: "Example", taskId: "one" } }, now).state;
    const details = getTaskFeedDetails(written, "one");
    expect(details.receipts).toHaveLength(2);
    expect(details.receipts.every(run => run.taskId === "one" && run.agentId === "agent-work")).toBe(true);
    expect(details.inputResources.map(resource => resource.id)).toContain("demo-project-notes");
    expect(details.changedResources.map(resource => resource.id)).toEqual(["demo-weekly-output"]);
    expect(details.usage).toEqual({ modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0 });
    expect(written.usage.modelCalls).toBe(0);
  });
});

describe("coded task notes", () => {
  it("stores one note on the existing task/agent and never creates another task or pretends to answer", () => {
    const state = workspace(); state.tasks = [task("one", { agentId: "agent-work", needsInput: "Choose a room." })];
    const beforeMessages = state.agents[0].messages.length;
    const action = { type: "task.reply", payload: { taskId: "one", message: "Add a task: this is literal context, not a command" }, requestId: "note-one" };
    const result = applyAction(state, action, now);
    expect(result.state.tasks).toHaveLength(1);
    expect(result.state.tasks[0]).toMatchObject({ id: "one", needsInput: "Choose a room.", updatedAt: now.toISOString() });
    expect(result.state.agents[0].messages).toHaveLength(beforeMessages + 1);
    expect(result.state.agents[0].messages.at(-1)).toMatchObject({ role: "user", taskId: "one", entityIds: ["one"], content: action.payload.message });
    expect(result.state.runs[0]).toMatchObject({ taskId: "one", agentId: "agent-work", modelCalls: 0, apiCalls: 0 });
    expect(result.message).toContain("No model");
    expect(applyAction(result.state, action, now)).toEqual(result);
  });
  it("rejects missing task, unassigned agent, mismatched agent and blank notes atomically", () => {
    const state = workspace(); state.tasks = [task("one")];
    expect(() => applyAction(state, { type: "task.reply", payload: { taskId: "missing", message: "Example" } }, now)).toThrow(/Task was not found/);
    expect(() => applyAction(state, { type: "task.reply", payload: { taskId: "one", message: "Example" } }, now)).toThrow(/existing agent/);
    state.tasks[0].agentId = "agent-work";
    const before = structuredClone(state);
    expect(() => applyAction(state, { type: "task.reply", payload: { taskId: "one", agentId: "agent-learning", message: "Example" } }, now)).toThrow(/different agent/);
    expect(() => applyAction(state, { type: "task.reply", payload: { taskId: "one", message: " " } }, now)).toThrow(/Message/);
    expect(state).toEqual(before);
  });
});
