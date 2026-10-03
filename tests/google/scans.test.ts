import { describe, expect, it } from 'vitest';
import { createSyntheticGoogleAdapter } from '../../src/lib/google/synthetic';
import { GoogleIntegration } from '../../src/lib/google/index';
import { state } from './helpers';

describe('resumable Google indexing', () => {
  it('requires broad scan permission independently from read permission', async () => {
    const h = createSyntheticGoogleAdapter(); const workspace = state(); workspace.permissions.driveFull = false; h.setPermissions(workspace.permissions);
    await expect(h.integration.execute(workspace, { type: 'scan.start', payload: { provider: 'drive', coverage: 'all' } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(h.calls).toHaveLength(0);
  });
  it('persists page position, supports pause/resume, and only checkpoints complete coverage', async () => {
    const h = createSyntheticGoogleAdapter({ pageSize: 1 }); const workspace = state(); h.setPermissions(workspace.permissions);
    const result = await h.integration.execute(workspace, { type: 'scan.start', payload: { provider: 'drive', coverage: 'all' } });
    const job = workspace.scans[0]; expect(job.read).toBe(1); expect(job.status).toBe('running'); expect(await h.store.get('sync:drive')).toBeUndefined();
    await h.integration.execute(workspace, { type: 'scan.pause', payload: { id: result.entityId } }); expect(job.status).toBe('paused');
    await h.integration.execute(workspace, { type: 'scan.resume', payload: { id: job.id } }); expect(job.read).toBe(2);
    await h.integration.execute(workspace, { type: 'scan.resume', payload: { id: job.id } }); expect(job.status).toBe('completed'); expect(job.read).toBe(3); expect(job.analyzed).toBe(0);
    expect(await h.store.get('sync:drive')).toBe('synthetic-drive-checkpoint-1');
    const calls = h.calls.length; await h.integration.execute(workspace, { type: 'sync.run', payload: { provider: 'drive' } });
    expect(h.calls.slice(calls).some(call => call.url.includes('/changes?'))).toBe(true); expect(await h.store.get('sync:drive')).toBe('synthetic-drive-checkpoint-2');
  });
  it('replays a committed scan page when the workspace save was interrupted', async () => {
    const h = createSyntheticGoogleAdapter({ pageSize: 1 }); const workspace = state(); h.setPermissions(workspace.permissions);
    const result = await h.integration.execute(workspace, { type: 'scan.start', payload: { provider: 'drive', coverage: 'all' } });
    const persisted = structuredClone(workspace);
    await h.integration.execute(workspace, { type: 'scan.resume', payload: { id: result.entityId } });
    // The adapter's page/cursor saved, but the caller still has its previous persisted workspace.
    await h.integration.execute(persisted, { type: 'scan.resume', payload: { id: result.entityId } });
    expect(persisted.scans[0].status).toBe('completed'); expect(persisted.scans[0].read).toBe(3);
    expect(persisted.resources.map(resource => resource.providerId).sort()).toEqual(['synthetic-doc-1', 'synthetic-folder-1', 'synthetic-sheet-1']);
  });
  it('recovers the initial page after a crash before the scan job was saved', async () => {
    const h = createSyntheticGoogleAdapter({ pageSize: 1 }); const workspace = state(); h.setPermissions(workspace.permissions);
    await h.integration.execute(workspace, { type: 'scan.start', payload: { provider: 'drive', coverage: 'all' } });
    const restarted = state(); await h.integration.execute(restarted, { type: 'sync.run', payload: { provider: 'drive' } });
    expect(restarted.scans).toHaveLength(2); expect(restarted.resources.some(resource => resource.providerId === 'synthetic-folder-1')).toBe(true);
  });
  it('rechecks broad permission on scan resume', async () => {
    const h = createSyntheticGoogleAdapter({ pageSize: 1 }); const workspace = state(); h.setPermissions(workspace.permissions);
    const result = await h.integration.execute(workspace, { type: 'scan.start', payload: { provider: 'drive', coverage: 'all' } });
    h.setPermissions({ ...workspace.permissions, driveFull: false }); const callCount = h.calls.length;
    await expect(h.integration.execute(workspace, { type: 'scan.resume', payload: { id: result.entityId } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(h.calls).toHaveLength(callCount);
  });
  it('limits selected folder scans to the explicitly bound folder descendants', async () => {
    const h = createSyntheticGoogleAdapter({ pageSize: 1 }); const workspace = state(); workspace.permissions.driveFull = false; h.setPermissions(workspace.permissions);
    await h.integration.execute(workspace, { type: 'resource.bind', payload: { url: 'https://drive.google.com/drive/folders/synthetic-folder-1' } });
    const result = await h.integration.execute(workspace, { type: 'scan.start', payload: { provider: 'drive', coverage: 'selected' } });
    await h.integration.execute(workspace, { type: 'scan.resume', payload: { id: result.entityId } });
    expect(workspace.scans[0].status).toBe('completed');
    const listings = h.calls.filter(call => new URL(call.url).pathname.endsWith('/files'));
    expect(listings.every(call => new URL(call.url).searchParams.get('q')?.includes("'synthetic-folder-1' in parents"))).toBe(true);
  });
  it('requires explicit selected Gmail threads instead of secretly reading the mailbox', async () => {
    const h = createSyntheticGoogleAdapter(); const workspace = state(); workspace.permissions.gmailFull = false; h.setPermissions(workspace.permissions);
    await expect(h.integration.execute(workspace, { type: 'scan.start', payload: { provider: 'gmail', coverage: 'selected' } })).rejects.toMatchObject({ code: 'SELECTION_REQUIRED' });
    expect(h.calls).toHaveLength(0);
    workspace.drafts.push({ id: 'synthetic-draft', ...{ to: 'receiver@example.com', subject: 'Example', body: 'Example' }, threadId: 'synthetic-thread-1', status: 'draft', mode: 'live', updatedAt: '2026-01-02T12:00:00Z' });
    await h.store.set('binding:draft:synthetic-draft', true);
    await h.integration.execute(workspace, { type: 'scan.start', payload: { provider: 'gmail', coverage: 'selected' } });
    expect(h.calls).toHaveLength(1); expect(h.calls[0].url).toContain('/threads/synthetic-thread-1');
  });
  it('uses Gmail history incrementally and forces an explicit rescan on expiration', async () => {
    const h = createSyntheticGoogleAdapter(); const workspace = state(); h.setPermissions(workspace.permissions);
    await h.integration.execute(workspace, { type: 'scan.start', payload: { provider: 'gmail', coverage: 'all' } }); expect(await h.store.get('sync:gmail')).toBe('synthetic-gmail-history-1');
    await h.integration.execute(workspace, { type: 'sync.run', payload: { provider: 'gmail' } }); expect(await h.store.get('sync:gmail')).toBe('synthetic-gmail-history-2');
    const original = h.dependencies.fetch!;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => String(input).includes('/history?') ? new Response('{}', { status: 404 }) : original(input, init) });
    await expect(integration.execute(workspace, { type: 'sync.run', payload: { provider: 'gmail' } })).rejects.toMatchObject({ code: 'SYNC_CURSOR_EXPIRED' }); expect(await h.store.get('sync:gmail')).toBeUndefined();
  });
});
