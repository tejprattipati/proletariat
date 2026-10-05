import { describe, expect, it } from 'vitest';
import { CanvasIntegration, verifyCanvasConnection } from '../../src/lib/canvas/index';
import { assignment, finish, harness, json, origin } from './helpers';
describe('read-only Canvas integration', () => {
  it('reads current student courses and follows assignment/course pagination with stable distinct IDs', async () => {
    const h = harness(url => {
      if (url.pathname === '/api/v1/courses') return json(url.searchParams.get('page') === '2' ? [{ id: 11, name: 'Second fictional course' }] : [{ id: 10, name: 'First fictional course' }], 200, url.searchParams.get('page') === '2' ? undefined : `${origin}/api/v1/courses?page=2`);
      if (url.pathname === '/api/v1/courses/10/assignments') return json([assignment(url.searchParams.get('page') === '2' ? 2 : 1)], 200, url.searchParams.get('page') === '2' ? undefined : `${origin}/api/v1/courses/10/assignments?page=2&override_assignment_dates=true`);
      if (url.pathname === '/api/v1/courses/11/assignments') return json([assignment(1)]);
    });
    const result = await finish(h.integration, { maxPages: 1 });
    expect(result.snapshot.status).toBe('complete'); expect(result.report.newItems).toHaveLength(3); expect(new Set(result.snapshot.sources.map(source => source.id)).size).toBe(3);
    const firstCourses = new URL(h.calls.find(call => call.url.includes('/courses?'))!.url); expect(firstCourses.searchParams.get('enrollment_state')).toBe('active'); expect(firstCourses.searchParams.get('enrollment_type')).toBe('student'); expect(h.calls.every(call => call.method === 'GET')).toBe(true); expect(result.modelCalls).toBe(0);
  });
  it('deduplicates proven quiz/discussion/module links without merging equal titles', async () => {
    const h = harness(url => {
      if (url.pathname.endsWith('/assignments')) return json([assignment(1), assignment(2)]);
      if (url.pathname.endsWith('/quizzes')) return json([{ id: 5, assignment_id: 1, title: 'Fictional quiz' }]);
      if (url.pathname.endsWith('/discussion_topics')) return json([{ id: 8, assignment_id: 1 }]);
      if (url.pathname.endsWith('/modules')) return json([{ id: 30 }]);
      if (url.pathname.endsWith('/modules/30/items')) return json([{ id: 40, type: 'Assignment', content_id: 1 }, { id: 41, type: 'Quiz', content_id: 5 }]);
    });
    const result = await finish(h.integration); expect(result.snapshot.sources).toHaveLength(2); expect(result.report.newItems).toHaveLength(2);
    expect(result.report.newItems.find(item => item.externalId === '1')!.aliases).toEqual(expect.arrayContaining([expect.stringContaining(':quiz:5'), expect.stringContaining(':discussion:8'), expect.stringContaining(':module_item:40'), expect.stringContaining(':module_item:41')]));
    expect(result.snapshot.sources[0].obligations![0].aliases).toEqual(expect.arrayContaining([expect.stringContaining(':quiz:5'), expect.stringContaining(':module_item:40')]));
  });
  it('resolves module-only quizzes through their proven assignment identity', async () => {
    const h = harness(url => {
      if (url.pathname.endsWith('/assignments') || url.pathname.endsWith('/quizzes')) return json([]);
      if (url.pathname.endsWith('/modules')) return json([{ id: 30 }]);
      if (url.pathname.endsWith('/modules/30/items')) return json([{ id: 40, type: 'Quiz', content_id: 5 }]);
      if (url.pathname.endsWith('/quizzes/5')) return json({ id: 5, assignment_id: 2 });
      if (url.pathname.endsWith('/assignments/2')) return json(assignment(2, { submission_types: ['online_quiz'], quiz_id: 5 }));
    });
    const result = await finish(h.integration); expect(result.snapshot.status).toBe('complete'); expect(result.report.newItems).toHaveLength(1); expect(result.report.newItems[0]).toMatchObject({ externalId: '2', kind: 'quiz' });
  });
  it('retains the run and baseline through a middle-page failure and resume', async () => {
    let fail = true;
    const h = harness(url => {
      if (url.pathname.endsWith('/assignments')) {
        if (url.searchParams.get('page') === '2') return fail ? json({}, 503) : json([assignment(2)]);
        return json([assignment(1)], 200, `${origin}/api/v1/courses/10/assignments?page=2`);
      }
    });
    const partial = await finish(h.integration); expect(partial.snapshot.status).toBe('partial'); expect(partial.report.exhaustiveBaselineAdvanced).toBe(false);
    expect(partial.snapshot.coverage.find(item => item.family === 'assignments')!.status).toBe('partial'); fail = false;
    const completed = await finish(h.integration, { resume: true }); expect(completed.snapshot.id).toBe(partial.snapshot.id); expect(completed.snapshot.status).toBe('complete'); expect(completed.report.newItems).toHaveLength(2); expect(completed.snapshot.sources).toHaveLength(2);
    const replay = await h.integration.collect({ resume: true }); expect(replay.report.id).toBe(completed.report.id); expect(replay.apiCalls).toBe(0); expect(replay.report.newItems).toHaveLength(2);
  });
  it('separates new already-submitted items from changed deadlines and submission state', async () => {
    let changed = false;
    const h = harness(url => url.pathname.endsWith('/assignments') ? json(changed ? [assignment(1, { due_at: '2026-10-12T12:00:00Z', submission: { workflow_state: 'submitted', graded_at: null, submitted_at: '2026-10-05T10:00:00Z' } }), assignment(2, { submission: { workflow_state: 'graded' } })] : [assignment(1)]) : undefined);
    const initial = await finish(h.integration); changed = true; const refresh = await finish(h.integration);
    expect(initial.report.initial).toBe(true); expect(refresh.report.initial).toBe(false); expect(refresh.report.newItems.map(item => item.externalId)).toEqual(['2']); expect(refresh.report.newItems[0].state).toBe('graded');
    expect(refresh.report.changedItems).toHaveLength(1); expect(refresh.report.changedItems[0].fields).toEqual(expect.arrayContaining(['dueAt', 'state'])); expect(refresh.snapshot.sources.every(source => source.obligations?.[0].completed)).toBe(true);
  });
  it('uses the provider-effective user/section date, never the base override date', async () => {
    const h = harness(url => url.pathname.endsWith('/assignments') ? json([assignment(1, { has_overrides: true, due_at: '2026-10-13T20:00:00-04:00', all_dates: [{ base: true, due_at: '2026-10-09T00:00:00Z' }], overrides: [{ course_section_id: 3, due_at: '2026-10-13T20:00:00-04:00' }] })]) : undefined);
    const result = await finish(h.integration, { timezone: 'America/New_York' }); expect(result.report.newItems[0].dueAt).toBe('2026-10-13T20:00:00-04:00'); expect(result.snapshot.sources[0].obligations![0]).toMatchObject({ dueDate: '2026-10-13', dueTime: '20:00' }); expect(h.calls.find(call => call.url.includes('/assignments?'))!.url).toContain('override_assignment_dates=true');
  });
  it('reports missing submission/effective-date facts without a fabricated overdue task', async () => {
    const h = harness(url => url.pathname.endsWith('/assignments') ? json([assignment(1, { due_at: undefined, submission: undefined, has_overrides: true })]) : undefined);
    const result = await finish(h.integration); expect(result.snapshot.status).toBe('partial'); expect(result.snapshot.sources[0].obligations![0].dueDate).toBeUndefined(); expect(result.snapshot.sources[0].obligations![0].providerState).toBe('unknown'); expect(result.report.coverage.find(item => item.family === 'assignments')!.gaps).toHaveLength(2);
  });
  it('keeps no-submission placeholders contextual and creates deadline-free verified reading work', async () => {
    const h = harness(url => {
      if (url.pathname.endsWith('/assignments')) return json([assignment(1, { submission_types: ['none'], submission: undefined }), assignment(2, { submission_types: ['none'] })]);
      if (url.pathname.endsWith('/modules')) return json([{ id: 30 }]);
      if (url.pathname.endsWith('/modules/30/items')) return json([{ id: 40, type: 'Assignment', content_id: 1, title: 'Required fictional reading', completion_requirement: { type: 'must_view', completed: false } }, { id: 41, type: 'Page', page_url: 'fictional-page', title: 'Optional fictional page' }]);
      if (url.pathname.endsWith('/pages/fictional-page')) return json({ page_id: 9, body: '<p>Fictional optional context</p>' });
    });
    const result = await finish(h.integration); const obligations = result.snapshot.sources.flatMap(source => source.obligations ?? []); expect(obligations).toHaveLength(1); expect(obligations[0].dueDate).toBeUndefined(); expect(obligations[0].nextAction).toContain('Read'); expect(result.snapshot.sources.find(source => source.externalId === '2')!.obligations).toEqual([]);
  });
  it('reports locked/unsupported/ambiguous obligations as coverage gaps', async () => {
    const h = harness(url => {
      if (url.pathname.endsWith('/assignments')) return json([assignment(1, { locked_for_user: true })]);
      if (url.pathname.endsWith('/modules')) return json([{ id: 30, state: 'locked' }]);
      if (url.pathname.endsWith('/modules/30/items')) return json([{ id: 40, type: 'ExternalTool', completion_requirement: { type: 'must_submit' } }]);
      if (url.pathname.endsWith('/quizzes')) return json([{ id: 5, quiz_type: 'assignment' }]);
    });
    const result = await finish(h.integration); expect(result.snapshot.status).toBe('partial'); expect(result.report.coverage.filter(item => item.gaps.length)).toHaveLength(4);
  });
  it('isolates owners and invalidates disconnected/changed grant checkpoints', async () => {
    const h = harness(); await finish(h.integration); h.setOwner('another-owner'); await expect(h.integration.collect({ resume: true })).rejects.toMatchObject({ code: 'CANVAS_OWNER_MISMATCH' });
    h.setOwner('synthetic-app-owner'); h.setCredentials({ ...h.getCredentials()!, connectionId: 'new-synthetic-connection' }); await expect(h.integration.collect({ resume: true })).rejects.toMatchObject({ code: 'CANVAS_CHECKPOINT_MISSING' });
    h.setCredentials(); await expect(h.integration.collect()).rejects.toMatchObject({ code: 'CANVAS_NOT_CONNECTED' });
  });
  it('rejects cross-host pagination and arbitrary connection origins without forwarding tokens', async () => {
    const h = harness(url => url.pathname === '/api/v1/courses' ? json([], 200, 'https://unapproved.example.com/api/v1/courses?page=2') : undefined);
    const result = await finish(h.integration); expect(result.snapshot.status).toBe('failed'); expect(h.calls.every(call => call.url.startsWith(origin))).toBe(true);
    await expect(verifyCanvasConnection({ baseUrl: 'https://unapproved.example.com', token: 'synthetic-token', ownerId: 'owner' }, { allowedOrigins: [origin], fetch: h.dependencies.fetch })).rejects.toMatchObject({ code: 'CANVAS_ORIGIN_DENIED' });
  });
  it('verifies an explicitly selected Canvas account with a GET only', async () => {
    const h = harness(); const verified = await verifyCanvasConnection({ baseUrl: origin, token: 'synthetic-token', ownerId: 'owner' }, { allowedOrigins: [origin], fetch: h.dependencies.fetch }); expect(verified).toEqual({ baseUrl: origin, accountId: '99', accountLabel: 'Fictional student' }); expect(h.calls.map(call => call.method)).toEqual(['GET']);
  });
  it('rejects a token identifying a different account before reading courses', async () => {
    const h = harness(url => url.pathname.endsWith('/profile') ? json({ id: 100 }) : undefined);
    await expect(h.integration.collect()).rejects.toMatchObject({ code: 'CANVAS_ACCOUNT_MISMATCH' }); expect(h.calls).toHaveLength(1);
  });
  it('does not advance an exhaustive baseline or erase unseen records after a failed refresh', async () => {
    let failed = false;
    const h = harness(url => url.pathname.endsWith('/assignments') ? failed ? json({}, 403) : json([assignment(1), assignment(2)]) : undefined);
    const first = await finish(h.integration); failed = true; const partial = await finish(h.integration); expect(partial.report.exhaustiveBaselineAdvanced).toBe(false); const baseline = [...h.values.entries()].find(([key]) => key.endsWith(':baseline'))![1] as { items: Record<string, unknown>; exhaustiveAt: string }; expect(Object.keys(baseline.items)).toHaveLength(2); expect(baseline.exhaustiveAt).toBe(first.snapshot.updatedAt);
    failed = false; const resumed = await finish(h.integration, { resume: true }); expect(resumed.report.newItems).toHaveLength(0);
  });
  it('preserves conflicting provider aliases as a failed segment instead of merging obligations', async () => {
    const h = harness(url => url.pathname.endsWith('/assignments') ? json([assignment(1, { quiz_id: 5 }), assignment(2, { quiz_id: 5 })]) : undefined);
    const result = await finish(h.integration); expect(result.snapshot.status).toBe('failed'); expect(result.snapshot.sources).toEqual([]); expect(result.snapshot.coverage.find(item => item.family === 'assignments')!.error).toContain('conflicting');
  });
  it('keeps effective-date/current-user filters when next links omit them and rejects changed filters', async () => {
    let changed = false;
    const h = harness(url => {
      if (url.pathname.endsWith('/assignments') && !url.searchParams.has('page')) return json([assignment(1)], 200, `${origin}/api/v1/courses/10/assignments?page=2${changed ? '&override_assignment_dates=false' : ''}`);
      if (url.pathname.endsWith('/assignments')) return json([assignment(2)]);
    });
    const first = await finish(h.integration); expect(first.snapshot.status).toBe('complete');
    expect(new URL(h.calls.find(call => call.url.includes('page=2'))!.url).searchParams.get('override_assignment_dates')).toBe('true');
    changed = true; const partial = await finish(h.integration); expect(partial.snapshot.status).toBe('failed'); expect(partial.report.exhaustiveBaselineAdvanced).toBe(false);
  });
  it('counts module links as metadata until their target bodies are read', async () => {
    const h = harness(url => {
      if (url.pathname.endsWith('/modules')) return json([{ id: 30 }]);
      if (url.pathname.endsWith('/modules/30/items')) return json([{ id: 40, type: 'Assignment', content_id: 1 }]);
    });
    const result = await finish(h.integration); expect(result.report.coverage.find(item => item.family === 'module_items')).toMatchObject({ metadataRead: 1, contentRead: 0, submissionRead: 0, read: 0 }); expect(result.report.coverage.find(item => item.family === 'assignments')).toMatchObject({ metadataRead: 1, contentRead: 1, submissionRead: 1, read: 1 });
  });

  it('retains multiple verified requirements sharing a module-only target during queued resolution', async () => {
    const h = harness(url => {
      if (url.pathname.endsWith('/assignments')) return json([]);
      if (url.pathname.endsWith('/modules')) return json([{ id: 30 }]);
      if (url.pathname.endsWith('/modules/30/items')) return json([{ id: 40, type: 'Assignment', content_id: 2, title: 'First reading', completion_requirement: { type: 'must_view', completed: false } }, { id: 41, type: 'Assignment', content_id: 2, title: 'Second verified module requirement', completion_requirement: { type: 'must_mark_done', completed: false } }]);
      if (url.pathname.endsWith('/assignments/2')) return json(assignment(2, { submission_types: ['none'] }));
    });
    const result = await finish(h.integration); expect(result.snapshot.sources).toHaveLength(1); expect(result.snapshot.sources[0].obligations!.map(item => item.itemId).sort()).toEqual(['module_requirement:40', 'module_requirement:41']); expect(result.report.newItems).toHaveLength(2);
  });

});
