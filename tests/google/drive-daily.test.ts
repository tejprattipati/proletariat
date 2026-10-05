import { describe, expect, it } from 'vitest';
import { createSyntheticGoogleAdapter } from '../../src/lib/google/synthetic';
import { GoogleIntegration } from '../../src/lib/google/index';
import { permissions, state } from './helpers';
function setup() { const h = createSyntheticGoogleAdapter({ documentText: 'Task: Review fictional provider content' }); const workspace = state(); workspace.permissions = { ...permissions(false), driveRead: true }; h.setPermissions(workspace.permissions); return { ...h, workspace }; }
describe('explicitly selected Drive Daily sources', () => {
  it('reads bound file bodies with stable source IDs and independent provider status', async () => {
    const h = setup(); await h.integration.execute(h.workspace, { type: 'resource.bind', payload: { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit' } });
    await h.integration.execute(h.workspace, { type: 'daily.read' }); const source = h.workspace.daily!.sources[0];
    expect(source).toMatchObject({ provider: 'drive', text: 'Task: Review fictional provider content', resourceId: h.workspace.resources[0].id }); expect(h.workspace.daily!.providers.find(item => item.provider === 'drive')).toMatchObject({ status: 'complete', read: 1, coverage: 'selected' }); expect(h.workspace.daily!.providers.filter(item => item.provider !== 'drive').every(item => item.status === 'not_enabled')).toBe(true);
    await h.integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily!.sources[0].id).toBe(source.id); expect(h.workspace.tasks).toHaveLength(0);
  });
  it('does not read browsed-but-unbound files or files bound to an old account grant', async () => {
    const h = setup(); await h.integration.execute(h.workspace, { type: 'resource.browse' }); await h.integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily!.sources).toEqual([]);
    await h.integration.execute(h.workspace, { type: 'resource.bind', payload: { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit' } }); const tokens = (await h.dependencies.tokenStore.load())!; await h.dependencies.tokenStore.save({ ...tokens, connectionId: 'another-synthetic-grant' }); await h.integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily!.sources).toEqual([]); expect(h.workspace.daily!.providers.find(item => item.provider === 'drive')!.status).toBe('idle');
  });
  it('traverses only an explicitly selected folder and resumes file reads', async () => {
    const h = setup(); await h.integration.execute(h.workspace, { type: 'resource.bind', payload: { url: 'https://drive.google.com/drive/folders/synthetic-folder-1' } });
    await h.integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily!.providers.find(item => item.provider === 'drive')).toMatchObject({ status: 'partial', discovered: 2, read: 0 });
    await h.integration.execute(h.workspace, { type: 'daily.read' }); await h.integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily!.providers.find(item => item.provider === 'drive')).toMatchObject({ status: 'complete', read: 2 }); expect(h.workspace.daily!.sources).toHaveLength(2);
    const listed = h.calls.filter(call => new URL(call.url).pathname.endsWith('/files')); expect(listed).toHaveLength(1); expect(new URL(listed[0].url).searchParams.get('q')).toContain("'synthetic-folder-1' in parents");
  });
  it('retains the checkpoint on failure and clears returned cached content after permission revocation', async () => {
    const h = setup(); await h.integration.execute(h.workspace, { type: 'resource.bind', payload: { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit' } }); let fail = true;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => fail && String(input).includes('docs.googleapis.com') ? new Response('{}', { status: 503 }) : h.dependencies.fetch!(input, init) });
    await integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily!.providers.find(item => item.provider === 'drive')!.status).toBe('failed'); fail = false;
    await integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily!.providers.find(item => item.provider === 'drive')).toMatchObject({ status: 'complete', read: 1 });
    h.setPermissions(permissions(false)); await integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily!.sources).toEqual([]); expect(h.workspace.daily!.providers.find(item => item.provider === 'drive')!.status).toBe('not_enabled');
  });
});
