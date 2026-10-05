import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { DailySource, SourceObligation } from '../types';
import type { CanvasItem, CanvasSubmissionState } from './contracts';
export type CanvasObject = Record<string, unknown>;
export const object = (value: unknown): CanvasObject => value && typeof value === 'object' && !Array.isArray(value) ? value as CanvasObject : {};
export const objects = (value: unknown): CanvasObject[] => Array.isArray(value) ? value.map(object) : [];
export const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
export function externalId(value: unknown): string | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 || typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? String(value) : undefined; }
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function plainText(value: unknown): string { return (string(value) ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<\/?(?:p|div|br|li|h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); }
export function submissionState(value: unknown): CanvasSubmissionState {
  const submission = object(value);
  if (submission.excused === true) return 'excused';
  if (submission.workflow_state === 'graded') return 'graded';
  if (submission.workflow_state === 'pending_review' || submission.workflow_state === 'submitted' && submission.graded_at == null) return 'pending_grading';
  if (submission.submitted_at != null || submission.workflow_state === 'submitted') return 'submitted';
  if (submission.missing === true) return 'missing';
  if (submission.workflow_state === 'unsubmitted') return 'not_submitted';
  return 'unknown';
}
export interface ClassifyContext { prefix: string; baseUrl: string; courseId: string; courseName: string; accountId: string; timezone: string; now: string; }
export function assignmentSource(raw: CanvasObject, context: ClassifyContext): { source: DailySource; item: CanvasItem; gaps: string[] } | undefined {
  const id = externalId(raw.id); if (!id) return undefined;
  const key = `${context.prefix}:${context.courseId}:assignment:${id}`;
  const aliases = [key]; const quizId = externalId(raw.quiz_id); const discussionId = externalId(object(raw.discussion_topic).id);
  if (quizId) aliases.push(`${context.prefix}:${context.courseId}:quiz:${quizId}`);
  if (discussionId) aliases.push(`${context.prefix}:${context.courseId}:discussion:${discussionId}`);
  const types = Array.isArray(raw.submission_types) ? raw.submission_types.filter((item): item is string => typeof item === 'string') : [];
  const gaps: string[] = []; const state = submissionState(raw.submission);
  const title = (string(raw.name) ?? '(Untitled Canvas assignment)').slice(0, 1000);
  const kind = quizId || raw.is_quiz_assignment === true || types.includes('online_quiz') ? 'quiz' : discussionId || types.includes('discussion_topic') ? 'discussion' : 'assignment';
  const actionable = types.length > 0 && !types.every(type => type === 'none' || type === 'not_graded') && raw.published !== false;
  if (!types.length) gaps.push(`${key}: assignment requirement type is unavailable`);
  if (actionable && state === 'unknown') gaps.push(`${key}: current user's submission status is unknown`);
  if (typeof raw.description !== 'string' && raw.description !== null) gaps.push(`${key}: assignment description content is unavailable`);
  if (types.includes('external_tool') && state === 'unknown') gaps.push(`${key}: external-tool or New Quizzes submission/requirement coverage is unverified`);
  if (raw.locked_for_user === true) gaps.push(`${key}: content is locked for the current user`);
  const applicabilityUnknown = raw.only_visible_to_overrides === true && (!Array.isArray(raw.assignment_visibility) || !raw.assignment_visibility.map(String).includes(context.accountId));
  if (applicabilityUnknown) gaps.push(`${key}: assignment visibility does not establish applicability to this user`);
  let dueAt: string | null | undefined;
  if (raw.due_at === null) dueAt = null;
  else if (typeof raw.due_at === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(raw.due_at) && DateTime.fromISO(raw.due_at, { setZone: true }).isValid) dueAt = raw.due_at;
  else if (actionable) gaps.push(`${key}: effective user/section due date is unavailable or invalid`);
  // The student-scoped endpoint uses override_assignment_dates=true. Never select a base all_dates entry.
  const url = `${context.baseUrl}/courses/${context.courseId}/assignments/${id}`;
  const item: CanvasItem = { id: key, courseId: context.courseId, courseName: context.courseName, kind, externalId: id, title, url, dueAt, unlockAt: string(raw.unlock_at) ?? (raw.unlock_at === null ? null : undefined), lockAt: string(raw.lock_at) ?? (raw.lock_at === null ? null : undefined), state, actionable, aliases, version: '' };
  const text = plainText(raw.description); const source: DailySource = { id: key, provider: 'canvas', externalId: id, title, text: text.slice(0, 40_000), url, readAt: context.now, truncated: text.length > 40_000, obligations: [] };
  if (source.truncated) gaps.push(`${key}: description text was truncated`);
  if (actionable) {
    const fulfilled = ['submitted', 'pending_grading', 'graded', 'excused'].includes(state);
    const deadline = dueAt ? DateTime.fromISO(dueAt, { setZone: true }).setZone(context.timezone) : undefined;
    const obligation: SourceObligation = { itemId: 'obligation', title, categories: ['School'], providerState: state, completed: fulfilled, aliases, nextAction: kind === 'quiz' ? 'Complete quiz' : kind === 'discussion' ? 'Contribute to graded discussion' : 'Complete assignment', notes: `Canvas ${kind}; course: ${context.courseName}. Provider state: ${state}.${dueAt ? ` Effective deadline: ${dueAt}.` : ''}${raw.locked_for_user ? ' Content is locked.' : ''}` };
    obligation.requirementState = 'verified';
    obligation.applicabilityState = applicabilityUnknown ? 'unknown' : 'verified';
    // Verified deadlines are independent of submission facts. Domain suppresses definite-overdue claims for unknown status.
    if (deadline?.isValid) { obligation.dueDate = deadline.toISODate()!; obligation.dueTime = deadline.toFormat('HH:mm'); }
    else if (dueAt === null) { obligation.dueDate = null; obligation.dueTime = null; }
    source.obligations = [obligation];
  }
  item.version = hash({ title, dueAt, unlockAt: item.unlockAt, lockAt: item.lockAt, state, actionable, applicabilityUnknown, text: source.text }); source.version = item.version;
  return { source, item, gaps };
}
