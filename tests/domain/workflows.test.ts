import { describe, expect, it } from "vitest";
import { applyAction } from "../../src/lib/domain/actions";
import { intersectPermissions, interpretIntent, validateWorkflow, workflowOccurrenceKey } from "../../src/lib/domain/workflows";
import { now, workspace } from "./helpers";

describe("workflow validation and authorization", () => {
  it("interprets supported keywords and rejects unspecified behavior", () => {
    expect(interpretIntent("Extract tasks, roll over unfinished work, and plan my day")).toEqual(["extract_tasks", "rollover", "plan"]);
    expect(interpretIntent("Draft a reply; do not send it")).toEqual(["draft"]);
    expect(() => interpretIntent("Make everything wonderful")).toThrow(/unsupported/);
  });
  it("intersects local and global permissions without allowing escalation", () => {
    const permissions = workspace().permissions;
    const effective = intersectPermissions(permissions, { send: true, driveRead: false });
    expect(effective.send).toBe(false);
    expect(effective.driveRead).toBe(false);
    expect(effective.gmailRead).toBe(true);
    expect(permissions.driveRead).toBe(true);
  });
  it("rejects invalid destinations, schedules, actions and agents", () => {
    const state = workspace(); const workflow = state.workflows[0];
    expect(() => validateWorkflow({ ...workflow, agentId: "missing" }, state)).toThrow(/agent/);
    expect(() => validateWorkflow({ ...workflow, resourceIds: ["missing"] }, state)).toThrow(/bound/);
    expect(() => validateWorkflow({ ...workflow, schedule: "25:00" }, state)).toThrow(/HH:mm/);
    expect(() => validateWorkflow({ ...workflow, trigger: "interval", schedule: "0" }, state)).toThrow(/minutes/);
    expect(() => validateWorkflow({ ...workflow, actions: ["unsupported" as never] }, state)).toThrow(/unsupported/);
  });
  it("requires a bound output document and intersects execution permissions", () => {
    const state = workspace(); state.permissions.docsWrite = true;
    const workflow = { ...state.workflows[0], actions: ["docs_write" as const], resourceIds: ["demo-project-notes"] };
    expect(() => validateWorkflow(workflow, state)).toThrow(/output/);
    workflow.resourceIds = ["demo-weekly-output"];
    expect(() => validateWorkflow(workflow, state)).not.toThrow();
    expect(() => validateWorkflow(workflow, state, { docsWrite: false })).toThrow(/disabled/);
  });
  it("rechecks permissions after workflow creation and fails atomically", () => {
    const created = applyAction(workspace(), { type: "workflow.create", payload: { intent: "Extract tasks", actions: ["extract_tasks"], mode: "automatic" } }, now);
    const state = created.state; state.permissions.gmailRead = false;
    const before = structuredClone(state);
    expect(() => applyAction(state, { type: "workflow.run", payload: { id: created.entityId } }, now)).toThrow(/gmailRead/);
    expect(state).toEqual(before);
  });
  it("honors disabled and review modes and rejects implicit email destinations", () => {
    const state = workspace(); state.workflows[0].enabled = false;
    expect(() => applyAction(state, { type: "workflow.run", payload: { id: state.workflows[0].id } }, now)).toThrow(/disabled/);
    state.workflows[0].enabled = true; state.workflows[0].mode = "review";
    expect(() => applyAction(state, { type: "workflow.run", payload: { id: state.workflows[0].id } }, now)).toThrow(/confirm/);
    expect(() => applyAction(state, { type: "workflow.run", payload: { id: state.workflows[0].id, confirmed: true } }, now)).not.toThrow();
    state.workflows[0].actions = ["send"]; state.permissions.send = true;
    expect(() => applyAction(state, { type: "workflow.run", payload: { id: state.workflows[0].id, confirmed: true } }, now)).toThrow(/explicit/);
  });
  it("keeps agent workflow references consistent when reassigned", () => {
    const state = workspace(); const workflow = state.workflows[0];
    const next = applyAction(state, { type: "workflow.update", payload: { id: workflow.id, agentId: "agent-learning" } }, now).state;
    expect(next.agents[0].workflowIds).not.toContain(workflow.id);
    expect(next.agents[1].workflowIds).toContain(workflow.id);
    expect(next.workflows[0].version).toBe(2);
  });
});

describe("scheduled occurrence identity", () => {
  it("uses the workspace calendar date for rollover when the workflow timezone differs", () => {
    const state = workspace(); state.today = "2026-10-04";
    state.workflows[0].timezone = "America/New_York";
    expect(() => applyAction(state, { type: "workflow.run", payload: { id: state.workflows[0].id } }, new Date("2026-10-04T00:30:00Z"))).not.toThrow();
  });
  it("honors local time and coalesces repeated DST hours", () => {
    const workflow = { ...workspace().workflows[0], timezone: "America/New_York", schedule: "01:00" };
    const first = workflowOccurrenceKey(workflow, new Date("2026-11-01T05:30:00Z"));
    const repeated = workflowOccurrenceKey(workflow, new Date("2026-11-01T06:30:00Z"));
    expect(first).toBe(repeated);
    expect(workflowOccurrenceKey(workflow, new Date("2026-11-01T04:30:00Z"))).toBeUndefined();
    expect(workflowOccurrenceKey(workflow, new Date("2026-11-02T06:30:00Z"))).not.toBe(first);
  });
  it("uses stable interval buckets and ignores disabled/manual workflows", () => {
    const workflow = { ...workspace().workflows[0], trigger: "interval" as const, schedule: "60" };
    expect(workflowOccurrenceKey(workflow, now)).toBe(workflowOccurrenceKey(workflow, new Date("2026-10-03T08:59:59Z")));
    expect(workflowOccurrenceKey(workflow, now)).not.toBe(workflowOccurrenceKey(workflow, new Date("2026-10-03T09:00:00Z")));
    expect(workflowOccurrenceKey({ ...workflow, enabled: false }, now)).toBeUndefined();
    expect(workflowOccurrenceKey({ ...workflow, trigger: "manual" }, now)).toBeUndefined();
  });
  it("does not recreate a daily draft on repeated runs with different request IDs", () => {
    const state = workspace(); state.workflows[0].actions = ["draft"];
    const first = applyAction(state, { type: "workflow.run", payload: { id: state.workflows[0].id }, requestId: "one" }, now);
    const again = applyAction(first.state, { type: "workflow.run", payload: { id: state.workflows[0].id }, requestId: "two" }, now);
    expect(again.state.drafts).toEqual(first.state.drafts);
    expect(again.message).toContain("already run");
  });
});
