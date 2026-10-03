import { describe, expect, it } from 'vitest';
import { GoogleIntegration, isGoogleAction } from '../../src/lib/google/index';
import { createSyntheticGoogleAdapter } from '../../src/lib/google/synthetic';
import { SCOPES } from '../../src/lib/google/oauth';
import { state } from './helpers';

async function harness(options: Parameters<typeof createSyntheticGoogleAdapter>[0] = {}) {
  const fake = createSyntheticGoogleAdapter(options); const workspace = state(); fake.setPermissions(workspace.permissions);
  const source = await fake.integration.execute(workspace, { type: 'resource.bind', payload: { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit' } });
  const folder = await fake.integration.execute(workspace, { type: 'resource.bind', payload: { url: 'https://drive.google.com/drive/folders/synthetic-folder-1' } });
  workspace.recipes = [{ id: 'synthetic-recipe-1', name: 'Example report recipe', referenceResourceId: source.entityId!, destinationFolderId: folder.entityId!, createdAt: '2026-01-02T12:00:00Z' }];
  const payload = { id: 'synthetic-recipe-1', title: 'Example report for Example Person', person: 'Example Person', context: 'Only these fictional supplied facts should be merged.' };
  const run = (requestId = 'synthetic-recipe-run-1') => fake.integration.execute(workspace, { type: 'recipe.run', payload, requestId });
  return { ...fake, workspace, payload, run };
}
describe('native-copy document recipes', () => {
  it('copies the exact source into the chosen folder, personalizes only the new copy, and emits exact provenance', async () => {
    const h = await harness();
    h.workspace.tasks.push({ id: 'synthetic-task-1', title: 'Example document task', status: 'open', priority: 'P1', plannedDate: '2026-01-02', estimateMinutes: 30, notes: '', sourceIds: [], carryoverCount: 0 });
    const result = await h.integration.execute(h.workspace, { type: 'recipe.run', payload: { ...h.payload, taskId: 'synthetic-task-1' }, requestId: 'recipe-with-task' });
    expect(isGoogleAction('recipe.run')).toBe(true);
    const copies = h.calls.filter(call => call.url.includes('/copy?')); expect(copies).toHaveLength(1);
    expect(copies[0].url).toContain('/files/synthetic-doc-1/copy');
    expect(copies[0].body).toMatchObject({ name: h.payload.title, parents: ['synthetic-folder-1'] });
    const edits = h.calls.filter(call => call.url.includes(':batchUpdate')); expect(edits).toHaveLength(1);
    expect(edits[0].url).toContain('/documents/synthetic-copy-1:batchUpdate'); expect(edits[0].url).not.toContain('/documents/synthetic-doc-1:');
    expect(edits[0].body).toMatchObject({ writeControl: { requiredRevisionId: 'synthetic-revision-1' } });
    expect(JSON.stringify(edits[0].body)).toContain(h.payload.context);
    expect(result.entityId).toBe('google:drive:synthetic-copy-1');
    expect(result.state.resources.find(resource => resource.id === result.entityId)).toMatchObject({ parentId: 'google:drive:synthetic-folder-1', role: 'output', bound: true, mode: 'live', url: 'https://docs.google.com/document/d/synthetic-copy-1/edit' });
    expect(result.state.runs[0]).toMatchObject({ status: 'succeeded', modelCalls: 0, tokens: 0, writes: 2, recipeId: 'synthetic-recipe-1', taskId: 'synthetic-task-1', sourceIds: ['google:drive:synthetic-doc-1', 'google:drive:synthetic-folder-1'], changedResourceIds: ['google:drive:synthetic-copy-1'] });
    expect(result.message).toContain('no model calls');
  });
  it('replays an output creation without making another copy or changing the document again', async () => {
    const h = await harness(); const first = await h.run(); const replay = await h.run();
    expect(replay.entityId).toBe(first.entityId); expect(replay.state.runs[0].writes).toBe(0);
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(2);
    expect(h.workspace.resources.filter(resource => resource.providerId === 'synthetic-copy-1')).toHaveLength(1);
  });
  it('rejects a changed request payload before another output can be created', async () => {
    const h = await harness(); await h.run();
    await expect(h.integration.execute(h.workspace, { type: 'recipe.run', payload: { ...h.payload, context: 'Different facts' }, requestId: 'synthetic-recipe-run-1' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(h.calls.filter(call => call.url.includes('/copy?'))).toHaveLength(1);
  });
  it('requires the separate Drive write permission and actual grant', async () => {
    const h = await harness(); h.workspace.permissions.driveWrite = false; h.setPermissions(h.workspace.permissions);
    await expect(h.run()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(0);
    const missingScope = await harness({ scopes: [SCOPES.driveRead, SCOPES.docsWrite] });
    await expect(missingScope.run()).rejects.toMatchObject({ code: 'GOOGLE_SCOPE_REQUIRED' }); expect(missingScope.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it('does not assume arbitrary identifiers or reference-only context permit a destination write', async () => {
    const h = await harness(); h.workspace.resources.find(resource => resource.kind === 'folder')!.bound = false;
    await expect(h.run()).rejects.toMatchObject({ code: 'RECIPE_BINDING_REQUIRED' }); expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it('adds supplied context visibly for a reference with no placeholders', async () => {
    const h = await harness({ documentText: 'An existing styled outline that is retained.' }); const result = await h.run();
    const edit = h.calls.find(call => call.url.includes(':batchUpdate'))!;
    expect(JSON.stringify(edit.body)).toContain('Provided context'); expect(JSON.stringify(edit.body)).toContain(h.payload.context);
    expect(result.message).toContain('Added the supplied context section');
    expect(result.message).not.toContain('Replaced');
  });
  it('stores the copied ID before a personalization read fails and resumes that same copy', async () => {
    const h = await harness(); let failRead = true; const original = h.dependencies.fetch!;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => {
      if (String(input).includes('/documents/synthetic-copy-1?') && failRead) { failRead = false; throw new TypeError('Synthetic read interrupted'); }
      return original(input, init);
    } });
    const action = { type: 'recipe.run', payload: h.payload, requestId: 'resume-copy' };
    const partial = await integration.execute(h.workspace, action);
    expect(partial.state.runs[0].status).toBe('failed'); expect(partial.entityId).toBe('google:drive:synthetic-copy-1');
    expect(await integration.store.get('recipe-output:resume-copy')).toMatchObject({ providerId: 'synthetic-copy-1' });
    const resumed = await integration.execute(h.workspace, action);
    expect(resumed.state.runs[0].status).toBe('succeeded'); expect(resumed.entityId).toBe(partial.entityId);
    expect(h.calls.filter(call => call.url.includes('/copy?'))).toHaveLength(1);
  });
  it.each(['timeout', 'denied'] as const)('retains the output URL and never blindly retries a %s personalization write', async documentWriteFailure => {
    const h = await harness({ documentWriteFailure }); const first = await h.run(); await h.run();
    expect(first.state.runs[0].status).toBe(documentWriteFailure === 'timeout' ? 'unknown' : 'failed'); expect(first.message).toContain('https://docs.google.com/document/d/synthetic-copy-1/edit');
    expect(h.calls.filter(call => call.url.includes('/copy?'))).toHaveLength(1); expect(h.calls.filter(call => call.url.includes(':batchUpdate'))).toHaveLength(1);
  });
  it('marks a lost copy response unknown and never creates a replacement automatically', async () => {
    const h = await harness({ copyFailure: 'timeout' }); const first = await h.run(); await h.run();
    expect(first.state.runs[0].status).toBe('unknown'); expect(first.entityId).toBeUndefined(); expect(h.calls.filter(call => call.url.includes('/copy?'))).toHaveLength(1);
  });
  it('cannot write a recipe plan onto the source document', async () => {
    const h = await harness();
    await expect(h.integration.provider.applyRecipeEdits('synthetic-doc-1', 'synthetic-doc-1', { revisionId: 'synthetic', requests: [], replacements: 0, appendedContext: false, appendedPerson: false })).rejects.toMatchObject({ code: 'RECIPE_SOURCE_WRITE_DENIED' });
  });
});
