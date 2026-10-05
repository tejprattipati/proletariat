import { describe, expect, it } from 'vitest';
import { assignmentSource, submissionState } from '../../src/lib/canvas/classify';
import { assignment } from './helpers';
const context = { prefix: 'canvas:synthetic-owner-account', baseUrl: 'https://canvas.example.com', courseId: '10', courseName: 'Fictional course', accountId: '99', timezone: 'UTC', now: '2026-10-05T12:00:00Z' };
describe('truthful Canvas obligation classification', () => {
  it.each([
    [{ workflow_state: 'unsubmitted' }, 'not_submitted'], [{ workflow_state: 'unsubmitted', missing: true }, 'missing'], [{ workflow_state: 'submitted' }, 'pending_grading'], [{ submitted_at: '2026-01-01T00:00:00Z', workflow_state: 'pending_review' }, 'pending_grading'], [{ workflow_state: 'graded' }, 'graded'], [{ excused: true }, 'excused'], [{ submitted_at: '2026-01-01T00:00:00Z' }, 'submitted'], [{}, 'unknown'],
  ])('classifies %j as %s', (facts, state) => expect(submissionState(facts)).toBe(state));
  it('retains exact provider timestamps while converting display deadlines into the workspace timezone', () => {
    const result = assignmentSource(assignment(), context)!; expect(result.item.dueAt).toBe('2026-10-09T23:59:00-04:00'); expect(result.source.obligations![0]).toMatchObject({ dueDate: '2026-10-10', dueTime: '03:59' });
  });
  it('distinguishes no deadline from an unknown effective deadline', () => {
    expect(assignmentSource(assignment(1, { due_at: null }), context)!.gaps).toEqual([]); expect(assignmentSource(assignment(1, { due_at: undefined }), context)!.gaps).toEqual([expect.stringContaining('effective')]);
  });
  it('does not expose HTML/scripts as source markup', () => {
    const result = assignmentSource(assignment(1, { description: '<script>fakeAttack()</script><p>Fictional reading &amp; notes</p>' }), context)!; expect(result.source.text).toBe('Fictional reading & notes');
  });
  it('classifies LTI/New Quizzes from the provider quiz flag without inventing a classic quiz ID', () => {
    const result = assignmentSource(assignment(1, { is_quiz_assignment: true, submission_types: ['external_tool'] }), context)!; expect(result.item.kind).toBe('quiz'); expect(result.item.aliases).toEqual([result.item.id]); expect(result.source.obligations![0].nextAction).toBe('Complete quiz');
  });

  it('retains a verified effective deadline independently from unknown submission status', () => {
    const result = assignmentSource(assignment(1, { submission: undefined }), context)!; expect(result.item.state).toBe('unknown'); expect(result.source.obligations![0]).toMatchObject({ providerState: 'unknown', dueDate: '2026-10-10', dueTime: '03:59' }); expect(result.gaps).toEqual([expect.stringContaining('submission status is unknown')]);
  });
  it('separates unknown override applicability from unknown completion facts', () => {
    const uncertain = assignmentSource(assignment(1, { only_visible_to_overrides: true, assignment_visibility: undefined, submission: undefined }), context)!;
    expect(uncertain.source.obligations![0]).toMatchObject({ dueDate: '2026-10-10', providerState: 'unknown', requirementState: 'verified', applicabilityState: 'unknown' });
    expect(uncertain.gaps).toContainEqual(expect.stringContaining('applicability'));
    const confirmed = assignmentSource(assignment(1, { only_visible_to_overrides: true, assignment_visibility: ['99'], submission: undefined }), context)!;
    expect(confirmed.source.obligations![0].applicabilityState).toBe('verified'); expect(confirmed.item.version).not.toBe(uncertain.item.version);
  });

  it('encodes an authoritative no-deadline value as two JSON-safe null fields and omits unknown dates', () => {
    const cleared = JSON.parse(JSON.stringify(assignmentSource(assignment(1, { due_at: null }), context)!.source)); expect(cleared.obligations[0]).toMatchObject({ dueDate: null, dueTime: null });
    const unknown = JSON.parse(JSON.stringify(assignmentSource(assignment(1, { due_at: undefined }), context)!.source)); expect(Object.hasOwn(unknown.obligations[0], 'dueDate')).toBe(false); expect(Object.hasOwn(unknown.obligations[0], 'dueTime')).toBe(false);
  });

});
