export type Mode = "demo" | "live";
export type PermissionKey = "gmailRead" | "gmailFull" | "driveRead" | "driveFull" | "calendarWrite" | "docsWrite" | "draft" | "send" | "bulkSend";
export type Permissions = Record<PermissionKey, boolean>;
export type TaskStatus = "open" | "in_progress" | "waiting" | "done";
export interface Task { id: string; title: string; status: TaskStatus; priority: "P0" | "P1" | "P2"; plannedDate: string; dueDate?: string; dueTime?: string; estimateMinutes: number; notes: string; agentId?: string; sourceIds: string[]; pinned?: boolean; splittable?: boolean; carryoverCount: number; nextActionDate?: string; completedAt?: string; }
export interface CalendarEvent { id: string; title: string; start: string; end: string; location?: string; calendarId: string; status: "confirmed" | "tentative"; sourceIds: string[]; externalId?: string; }
export interface PlanBlock { id: string; taskId: string; start: string; end: string; pinned: boolean; }
export interface Resource { id: string; name: string; kind: "folder" | "document" | "spreadsheet" | "pdf" | "text"; parentId?: string; url?: string; providerId?: string; tabId?: string; namedRangeId?: string; role?: "reference" | "output"; modifiedAt: string; content?: string; bound?: boolean; mode: Mode; }
export interface AgentMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; entityIds?: string[]; }
export interface Agent { id: string; name: string; description: string; color: string; initials: string; status: "attention" | "running" | "updated" | "quiet"; summary: string; pinned: boolean; unread: number; lastActiveAt: string; resourceIds: string[]; workflowIds: string[]; messages: AgentMessage[]; }
export type WorkflowAction = "extract_tasks" | "plan" | "rollover" | "calendar_upsert" | "docs_write" | "draft" | "send" | "campaign";
export interface Workflow { id: string; name: string; intent: string; agentId: string; enabled: boolean; version: number; mode: "manual" | "review" | "automatic"; trigger: "manual" | "interval" | "daily"; query: string; actions: WorkflowAction[]; resourceIds: string[]; calendarId?: string; schedule?: string; timezone: string; recipientIds?: string[]; draftIds?: string[]; campaignIds?: string[]; lastRunAt?: string; }
export interface Draft { id: string; to: string; subject: string; body: string; threadId?: string; externalId?: string; status: "draft" | "queued" | "accepted" | "unknown" | "failed"; mode: Mode; updatedAt: string; }
export interface CampaignRecipient { id: string; email: string; name: string; status: "pending" | "accepted" | "failed" | "unknown" | "excluded"; externalId?: string; error?: string; }
export interface Campaign { id: string; name: string; subject: string; body: string; status: "draft" | "scheduled" | "running" | "paused" | "completed" | "cancelled"; recipients: CampaignRecipient[]; mode: Mode; createdAt: string; scheduledAt?: string; ratePerMinute: number; }
export interface Run { id: string; title: string; description: string; status: "succeeded" | "pending" | "conflict" | "failed" | "unknown"; createdAt: string; agentId?: string; workflowId?: string; mode: Mode; modelCalls: number; tokens: number; apiCalls: number; writes: number; cacheHits: number; sourceIds: string[]; }
export interface ScanJob { id: string; provider: "gmail" | "drive"; coverage: "selected" | "all"; status: "queued" | "running" | "completed" | "paused" | "failed"; discovered: number; read: number; analyzed: number; skipped: number; failed: number; cursor?: string; createdAt: string; mode: Mode; }
export interface Connection { provider: "google" | "model"; connected: boolean; configured: boolean; label: string; scopes?: string[]; error?: string; }
export interface Usage { modelCalls: number; inputTokens: number; outputTokens: number; apiCalls: number; cacheHits: number; deterministicActions: number; estimatedCostUsd: number; dailyBudgetUsd: number; }
export interface Settings { timezone: string; workingHoursStart: string; workingHoursEnd: string; rolloverEnabled: boolean; mode: Mode; }
export interface WorkspaceState { version: number; today: string; settings: Settings; permissions: Permissions; tasks: Task[]; events: CalendarEvent[]; plan: PlanBlock[]; resources: Resource[]; agents: Agent[]; workflows: Workflow[]; drafts: Draft[]; campaigns: Campaign[]; runs: Run[]; scans: ScanJob[]; connections: Connection[]; usage: Usage; processedKeys: string[]; }
export interface ActionRequest { type: string; payload?: Record<string, unknown>; requestId?: string; }
export interface ActionResult { state: WorkspaceState; message: string; entityId?: string; }
export interface ApiError { error: string; code?: string; }
