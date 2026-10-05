import type { CanvasCoverage, CanvasSnapshot } from '../types';
/** Server only. The lead persists these encrypted in the verified app owner's namespace. */
export interface CanvasCredentials { ownerId: string; connectionId: string; baseUrl: string; token: string; accountId: string; accountLabel?: string; }
export interface CanvasStore { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<void>; }
export interface CanvasDependencies {
  store: CanvasStore;
  getCredentials: () => Promise<CanvasCredentials | undefined>;
  getOwnerId: () => Promise<string>;
  /** Operator-approved HTTPS origins. Never send a token to an unapproved institution. */
  allowedOrigins: string[];
  fetch?: typeof fetch;
  now?: () => Date;
}
export type CanvasFamily = CanvasCoverage['family'];
export type CanvasSubmissionState = 'not_submitted' | 'submitted' | 'pending_grading' | 'graded' | 'excused' | 'missing' | 'unknown' | 'completed' | 'incomplete';
export interface CanvasItem {
  id: string; courseId: string; courseName: string; kind: 'assignment' | 'quiz' | 'discussion' | 'module_requirement';
  externalId: string; title: string; url: string; dueAt?: string | null; unlockAt?: string | null; lockAt?: string | null;
  state: CanvasSubmissionState; actionable: boolean; aliases: string[]; version: string;
}
export interface CanvasChange { id: string; before: CanvasItem; after: CanvasItem; fields: string[]; }
export interface CanvasReport {
  id: string; initial: boolean; newItems: (CanvasItem & { discoveredAfterGap: boolean })[];
  changedItems: CanvasChange[]; coverage: CanvasCoverageDetail[]; exhaustiveBaselineAdvanced: boolean;
}
export interface CanvasCoverageDetail extends CanvasCoverage {
  /** Actual extracted body reads; metadata/link discovery is separate. */
  read: number; metadataRead?: number; contentRead?: number; submissionRead?: number; skipped: number; lastReadAt?: string; lastSuccessfulReadAt?: string; gaps: string[];
}
export interface CanvasReadResult { snapshot: CanvasSnapshot; report: CanvasReport; hasMore: boolean; apiCalls: number; modelCalls: 0; }
export interface CanvasCollectOptions { resume?: boolean; runId?: string; /** 1–10 pages per invocation; defaults to 5. */ maxPages?: number; timezone?: string; }
