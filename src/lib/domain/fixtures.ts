import { DateTime } from "luxon";
import type { Agent, Task, WorkspaceState } from "../types";
import { localDate, stableId } from "./core";
import { generatePlan } from "./planner";

/** All names, emails, resources and activity below are fictional demonstration data. */
export function createDemoState(now = new Date()): WorkspaceState {
  const today = localDate(now, "UTC");
  const timestamp = now.toISOString();
  const tomorrow = DateTime.fromISO(today, { zone: "UTC" }).plus({ days: 1 }).toISODate()!;
  const yesterday = DateTime.fromISO(today, { zone: "UTC" }).minus({ days: 1 }).toISODate()!;
  const agent = (id: string, name: string, description: string, color: string, initials: string, summary: string, pinned = false): Agent => ({
    id, name, description, color, initials, status: "updated", summary, pinned, unread: 0, lastActiveAt: timestamp,
    resourceIds: [], workflowIds: [], messages: [{ id: `${id}-welcome`, role: "assistant", content: `${summary} This is a synthetic demo; no external accounts have been read.`, createdAt: timestamp }],
  });
  const task = (id: string, title: string, estimateMinutes: number, fields: Partial<Task> = {}): Task => ({
    id, title, status: "open", priority: "P1", plannedDate: today, estimateMinutes, notes: "Fictional demo task.", sourceIds: [], carryoverCount: 0, updatedAt: timestamp, ...fields,
  });
  const state: WorkspaceState = {
    version: 1, today,
    settings: { timezone: "UTC", workingHoursStart: "09:00", workingHoursEnd: "17:00", rolloverEnabled: true, mode: "demo" },
    permissions: { gmailRead: true, gmailFull: false, driveRead: true, driveFull: false, driveWrite: false, calendarRead: false, calendarWrite: false, docsWrite: false, draft: true, send: false, bulkSend: false },
    tasks: [
      task(stableId("task", "demo-project-notes", "line-0"), "Review the project outline", 45, { priority: "P0", dueDate: today, dueTime: "12:00", agentId: "agent-work", sourceIds: ["demo-project-notes"] }),
      task(stableId("task", "demo-session-notes", "line-0"), "Prepare for the design session", 30, { dueDate: today, agentId: "agent-learning", sourceIds: ["demo-session-notes"] }),
      task(stableId("task", "demo-session-notes", "line-1"), "Write up the research session", 45, { dueDate: tomorrow, agentId: "agent-learning", sourceIds: ["demo-session-notes"] }),
      task(stableId("task", "demo-project-notes", "line-1"), "Finish the launch checklist", 60, { plannedDate: yesterday, dueDate: yesterday, carryoverCount: 1, agentId: "agent-work", splittable: true, sourceIds: ["demo-project-notes"] }),
      task("task-demo-inbox", "Review the weekly newsletter draft", 20, { agentId: "agent-comms", priority: "P2" }),
      task("task-demo-waiting", "Follow up on the room booking", 15, { status: "waiting", nextActionDate: tomorrow, needsInput: "Confirm the preferred room and attendee count.", agentId: "agent-personal" }),
      task("task-demo-finished", "Collect reference documents", 20, { status: "done", completedAt: timestamp, agentId: "agent-work" }),
    ],
    events: [{ id: "event-demo-checkin", title: "Project check-in", start: `${today}T10:30:00.000Z`, end: `${today}T11:00:00.000Z`, calendarId: "demo-primary", status: "confirmed", sourceIds: [] },
      { id: "event-demo-lunch", title: "Lunch break", start: `${today}T12:30:00.000Z`, end: `${today}T13:15:00.000Z`, calendarId: "demo-primary", status: "confirmed", sourceIds: [] }],
    plan: [],
    resources: [
      { id: "demo-folder", name: "Example workspace", kind: "folder", modifiedAt: timestamp, mode: "demo", url: "https://example.com/resources", bound: false },
      { id: "demo-project-notes", name: "Project notes", kind: "document", parentId: "demo-folder", modifiedAt: timestamp, mode: "demo", url: "https://example.com/resources/project-notes", role: "reference", bound: true, content: "Task: Review the project outline\nTask: Finish the launch checklist" },
      { id: "demo-session-notes", name: "Learning sessions", kind: "document", parentId: "demo-folder", modifiedAt: timestamp, mode: "demo", url: "https://example.com/resources/sessions", role: "reference", bound: true, content: "Session: Design principles\nSession: Research methods" },
      { id: "demo-weekly-output", name: "Weekly summary", kind: "document", parentId: "demo-folder", modifiedAt: timestamp, mode: "demo", url: "https://example.com/resources/weekly-summary", role: "output", bound: true, content: "Synthetic weekly summary." },
      { id: "demo-recipient-sheet", name: "Example recipients", kind: "spreadsheet", parentId: "demo-folder", modifiedAt: timestamp, mode: "demo", url: "https://example.com/resources/recipients", bound: false, content: "email,name\nalex@example.com,Alex\ncasey@example.com,Casey" },
    ],
    agents: [agent("agent-work", "Work", "Projects, deadlines and your daily plan.", "#7569e8", "W", "Your project outline is due today.", true),
      agent("agent-learning", "Learning", "Turn learning notes into useful next steps.", "#cb864d", "L", "Two sessions have distinct follow-up tasks.", true),
      agent("agent-comms", "Communications", "Review drafts and manage deliberate outreach.", "#5a9d82", "C", "One draft is ready for review."),
      agent("agent-personal", "Personal", "Keep track of the small things.", "#5e91c4", "P", "The room booking is waiting until tomorrow.")],
    workflows: [{ id: "workflow-demo-morning", name: "Morning plan", intent: "Roll over unfinished tasks and plan my day", agentId: "agent-work", enabled: true, version: 1, mode: "automatic", trigger: "daily", query: "", actions: ["rollover", "plan"], resourceIds: [], schedule: "08:00", timezone: "UTC" }],
    drafts: [{ id: "draft-demo-newsletter", to: "alex@example.com", subject: "Example project update", body: "Hi Alex,\n\nHere is the fictional weekly project update.\n\nThanks!", status: "draft", mode: "demo", updatedAt: timestamp }],
    campaigns: [], recipes: [],
    runs: [{ id: "run-demo-source", title: "Synthetic task prepared", description: "The fictional project outline task is linked to its example source. No model or external API was called.", status: "succeeded", createdAt: timestamp, taskId: stableId("task", "demo-project-notes", "line-0"), agentId: "agent-work", mode: "demo", modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0, sourceIds: ["demo-project-notes"] },
      { id: "run-demo-plan", title: "Demo plan prepared", description: "Synthetic tasks were placed around example calendar events with ten-minute buffers.", status: "succeeded", createdAt: timestamp, agentId: "agent-work", mode: "demo", modelCalls: 0, tokens: 0, apiCalls: 0, writes: 0, cacheHits: 0, sourceIds: [] }],
    scans: [],
    connections: [{ provider: "google", connected: false, configured: false, label: "Google is not connected" }, { provider: "model", connected: false, configured: false, label: "Deterministic demo — no model connected" }],
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, apiCalls: 0, cacheHits: 0, deterministicActions: 0, estimatedCostUsd: 0, dailyBudgetUsd: 5 },
    processedKeys: [],
  };
  state.agents[0].resourceIds = ["demo-project-notes", "demo-weekly-output"];
  state.agents[0].workflowIds = ["workflow-demo-morning"];
  state.agents[1].resourceIds = ["demo-session-notes"];
  state.plan = generatePlan(state).blocks;
  return state;
}
