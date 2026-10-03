import type { Permissions, WorkspaceState } from '../../src/lib/types';
export function permissions(enabled = true): Permissions { return { gmailRead: enabled, gmailFull: enabled, driveRead: enabled, driveFull: enabled, driveWrite: enabled, calendarWrite: enabled, docsWrite: enabled, draft: enabled, send: enabled, bulkSend: enabled }; }
export function state(): WorkspaceState {
  return { version: 1, today: '2026-01-02', settings: { timezone: 'UTC', workingHoursStart: '09:00', workingHoursEnd: '17:00', rolloverEnabled: false, mode: 'live' }, permissions: permissions(), tasks: [], events: [], plan: [], resources: [], agents: [], workflows: [], drafts: [], campaigns: [], runs: [], scans: [], connections: [], usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, apiCalls: 0, cacheHits: 0, deterministicActions: 0, estimatedCostUsd: 0, dailyBudgetUsd: 5 }, processedKeys: [] };
}
