import { describe, expect, it } from 'vitest';
import { explicitCandidates } from '../../src/lib/server/daily';
import { ingestTaskCandidates } from '../../src/lib/domain/tasks';
import { projectTasks } from '../../src/lib/domain/projections';
import { applyAction } from '../../src/lib/domain/actions';
import { state } from '../google/helpers';
import { assignment, finish, harness, json } from './helpers';
describe('Canvas canonical domain handoff', () => {
  it('retains a verified past deadline but prevents definite-overdue claims and work blocks for unknown submission', async () => {
    const h = harness(url => url.pathname.endsWith('/assignments') ? json([assignment(1, { due_at: '2026-10-01T17:00:00Z', submission: undefined })]) : undefined);
    const result = await finish(h.integration); const workspace = state(); workspace.today = '2026-10-05';
    const next = ingestTaskCandidates(workspace, explicitCandidates(result.snapshot.sources, workspace.today));
    expect(next.tasks).toHaveLength(1); expect(next.tasks[0]).toMatchObject({ dueDate: '2026-10-01', providerDueDate: '2026-10-01', providerState: 'unknown' });
    const views = projectTasks(next); expect(views.deadlines.map(task => task.id)).toEqual([next.tasks[0].id]); expect(views.waiting.map(task => task.id)).toEqual([next.tasks[0].id]); expect(views.overdue).toEqual([]);
    expect(applyAction(next, { type: 'plan.generate', payload: { date: next.today } }).state.plan).toEqual([]);
  });
  it('preserves the canonical task tombstone through a repeated provider sweep', async () => {
    const h = harness(); const result = await finish(h.integration); let workspace = state(); workspace.today = '2026-10-05';
    workspace = ingestTaskCandidates(workspace, explicitCandidates(result.snapshot.sources, workspace.today)); const id = workspace.tasks[0].id;
    workspace = applyAction(workspace, { type: 'task.delete', payload: { id } }).state;
    const refresh = await finish(h.integration); workspace = ingestTaskCandidates(workspace, explicitCandidates(refresh.snapshot.sources, workspace.today));
    expect(workspace.tasks).toHaveLength(1); expect(workspace.tasks[0].id).toBe(id); expect(workspace.tasks[0].removedAt).toBeTruthy(); expect(projectTasks(workspace).active).toEqual([]); expect(refresh.report.newItems).toEqual([]);
  });
  it('clears a verified provider deadline through JSON while retaining the canonical ID and history', async () => {
    let dueAt: string | null | undefined = '2026-10-09T17:00:00Z';
    const h = harness(url => url.pathname.endsWith('/assignments') ? json([assignment(1, { due_at: dueAt })]) : undefined); let workspace = state(); workspace.today = '2026-10-05';
    const initial = await finish(h.integration); workspace = ingestTaskCandidates(workspace, explicitCandidates(JSON.parse(JSON.stringify(initial.snapshot.sources)), workspace.today)); const id = workspace.tasks[0].id;
    dueAt = null; const refresh = await finish(h.integration); const sources = JSON.parse(JSON.stringify(refresh.snapshot.sources)); expect(sources[0].obligations[0]).toMatchObject({ dueDate: null, dueTime: null });
    workspace = ingestTaskCandidates(workspace, explicitCandidates(sources, workspace.today)); expect(workspace.tasks[0].id).toBe(id); expect(workspace.tasks[0].dueDate).toBeUndefined(); expect(workspace.tasks[0].dueTime).toBeUndefined(); expect(workspace.tasks[0].providerDueDate).toBeUndefined(); expect(workspace.tasks[0].providerDueTime).toBeUndefined(); expect(workspace.taskHistory!.some(entry => entry.action === 'source_updated' && entry.before?.dueDate === '2026-10-09' && !entry.after?.dueDate)).toBe(true);
  });
  it('preserves a user deadline override on an authoritative provider clear and retains dates on partial reads', async () => {
    let dueAt: string | null | undefined = '2026-10-09T17:00:00Z';
    const h = harness(url => url.pathname.endsWith('/assignments') ? json([assignment(1, { due_at: dueAt })]) : undefined); let workspace = state(); workspace.today = '2026-10-05';
    const initial = await finish(h.integration); workspace = ingestTaskCandidates(workspace, explicitCandidates(initial.snapshot.sources, workspace.today)); const id = workspace.tasks[0].id;
    dueAt = undefined; const partial = await finish(h.integration); workspace = ingestTaskCandidates(workspace, explicitCandidates(JSON.parse(JSON.stringify(partial.snapshot.sources)), workspace.today)); expect(workspace.tasks[0].dueDate).toBe('2026-10-09'); expect(workspace.tasks[0].providerDueDate).toBe('2026-10-09');
    workspace = applyAction(workspace, { type: 'task.update', payload: { id, dueDate: '2026-10-15', dueTime: '18:00' } }).state;
    dueAt = null; const cleared = await finish(h.integration); workspace = ingestTaskCandidates(workspace, explicitCandidates(JSON.parse(JSON.stringify(cleared.snapshot.sources)), workspace.today)); expect(workspace.tasks[0]).toMatchObject({ id, dueDate: '2026-10-15', dueTime: '18:00' }); expect(workspace.tasks[0].providerDueDate).toBeUndefined(); expect(workspace.tasks[0].providerDueTime).toBeUndefined();
  });

});
