import { describe, expect, it, vi } from 'vitest';
import { GoogleIntegration } from '../../src/lib/google/index';
import { createSyntheticGoogleAdapter } from '../../src/lib/google/synthetic';
import { SCOPES } from '../../src/lib/google/oauth';
import { fingerprint } from '../../src/lib/google/security';
import { state, permissions } from './helpers';

function harness(options: Parameters<typeof createSyntheticGoogleAdapter>[0] = {}) {
  const synthetic = createSyntheticGoogleAdapter(options); const workspace = state(); synthetic.setPermissions(workspace.permissions);
  return { ...synthetic, workspace, run: (type: string, payload: Record<string, unknown> = {}, requestId = `synthetic-${type}`) => synthetic.integration.execute(workspace, { type, payload, requestId }) };
}
const draftInput = { to: 'recipient@example.com', subject: 'Fictional example', body: 'Synthetic message body.' };

describe('live Google action boundaries', () => {
  it('never silently runs Google for demo mode', async () => {
    const h = harness(); h.workspace.settings.mode = 'demo';
    await expect(h.run('resource.browse')).rejects.toMatchObject({ code: 'LIVE_MODE_REQUIRED' }); expect(h.calls).toHaveLength(0);
  });
  it('checks permission state and current persisted permission independently', async () => {
    const h = harness(); h.setPermissions(permissions(false));
    await expect(h.run('resource.browse')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(h.calls).toHaveLength(0);
  });
  it('checks granted OAuth scopes before the network', async () => {
    const h = harness({ scopes: [SCOPES.gmailRead] });
    await expect(h.run('resource.browse')).rejects.toMatchObject({ code: 'GOOGLE_SCOPE_REQUIRED' }); expect(h.calls).toHaveLength(0);
  });
  it('rejects mutations when the persisted permission reader is not configured', async () => {
    const h = harness(); const integration = new GoogleIntegration({ ...h.dependencies, getPermissions: undefined });
    await expect(integration.execute(h.workspace, { type: 'draft.create', payload: draftInput, requestId: 'synthetic-request' })).rejects.toMatchObject({ code: 'GOOGLE_PERMISSION_READER_REQUIRED' });
    expect(h.calls).toHaveLength(0);
  });
  it('binds canonical stable resource IDs and retains tab/range/output role', async () => {
    const h = harness(); const result = await h.run('resource.bind', { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit?tab=t.synthetic', namedRangeId: 'synthetic-range-1', role: 'output' });
    expect(result.entityId).toBe('google:drive:synthetic-doc-1');
    expect(result.state.resources[0]).toMatchObject({ providerId: 'synthetic-doc-1', tabId: 't.synthetic', namedRangeId: 'synthetic-range-1', role: 'output', bound: true, mode: 'live' });
    await h.run('resource.browse');
    expect(h.workspace.resources.find(item => item.id === result.entityId)?.bound).toBe(true);
  });
  it('pages resource browsing through the action contract and clears the exhausted cursor', async () => {
    const h = harness({ pageSize: 1 });
    const first = await h.run('resource.browse'); expect(first.message).toContain('More results are available.');
    await h.run('resource.browse', { nextPage: true }, 'page-two');
    const last = await h.run('resource.browse', { nextPage: true }, 'page-three'); expect(last.message).not.toContain('More results are available.');
    expect(h.workspace.resources).toHaveLength(3);
    const count = h.calls.length; await h.run('resource.browse', { nextPage: true }, 'page-four'); expect(h.calls).toHaveLength(count);
  });
  it('caches file metadata without network or model costs', async () => {
    const h = harness();
    await h.integration.provider.getFile('synthetic-doc-1'); await h.integration.provider.getFile('synthetic-doc-1');
    expect(h.calls).toHaveLength(1); expect(h.integration.provider.cacheHits).toBe(1);
  });
  it('creates one draft on an idempotent replay and rejects conflicting content', async () => {
    const h = harness(); const first = await h.run('draft.create', draftInput, 'create-once');
    await h.run('draft.create', draftInput, 'create-once');
    expect(h.workspace.drafts).toHaveLength(1); expect(h.calls).toHaveLength(1); expect(h.workspace.drafts[0].externalId).toBe('synthetic-draft-1');
    await expect(h.run('draft.create', { ...draftInput, subject: 'Changed' }, 'create-once')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(first.entityId).toBe(h.workspace.drafts[0].id);
  });
  it('counts an idempotency replay as zero new Google writes', async () => {
    const h = harness(); await h.run('draft.create', draftInput, 'count-once');
    const replay = await h.run('draft.create', draftInput, 'count-once');
    expect(replay.state.runs[0]).toMatchObject({ writes: 0, apiCalls: 0 });
  });
  it('preserves exact authored body whitespace', async () => {
    const h = harness(); const body = '  Fictional body.\n\n'; await h.run('draft.create', { ...draftInput, body });
    expect(h.workspace.drafts[0].body).toBe(body);
  });
  it('isolates cache and draft bindings when OAuth connects a different grant', async () => {
    const h = harness(); await h.run('draft.create', draftInput); await h.integration.provider.getFile('synthetic-doc-1');
    const previous = (await h.dependencies.tokenStore.load())!;
    await h.dependencies.tokenStore.save({ ...previous, connectionId: 'synthetic-grant-2' });
    await expect(h.run('draft.send', { id: h.workspace.drafts[0].id })).rejects.toMatchObject({ code: 'GOOGLE_GRANT_CHANGED' });
    const count = h.calls.length; await h.integration.provider.getFile('synthetic-doc-1');
    expect(h.calls.length).toBe(count + 1);
  });
  it('denies previously cached reads when their permission is disabled', async () => {
    const h = harness(); await h.integration.provider.getFile('synthetic-doc-1'); h.setPermissions(permissions(false));
    await expect(h.integration.provider.getFile('synthetic-doc-1')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(h.calls).toHaveLength(1);
  });
  it('blocks a previously queued draft after send is disabled', async () => {
    const h = harness(); const draft = await h.run('draft.create', draftInput); h.setPermissions({ ...h.workspace.permissions, send: false });
    await expect(h.run('draft.send', { id: draft.entityId })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(h.calls.filter(call => call.url.endsWith('/send'))).toHaveLength(0);
  });
  it.each(['timeout', 'server'] as const)('marks ambiguous %s sends unknown and never retries, including stale-state recovery', async sendFailure => {
    const h = harness({ sendFailure }); const draft = await h.run('draft.create', draftInput); const snapshot = structuredClone(h.workspace);
    const result = await h.run('draft.send', { id: draft.entityId });
    expect(result.state.drafts[0].status).toBe('unknown'); expect(result.state.runs[0].status).toBe('unknown');
    await h.run('draft.send', { id: draft.entityId }, 'retry-with-new-id');
    const recovered = await h.integration.execute(snapshot, { type: 'draft.send', payload: { id: draft.entityId }, requestId: 'stale-state-retry' });
    expect(recovered.state.drafts[0].status).toBe('unknown');
    expect(h.calls.filter(call => call.url.endsWith('/send'))).toHaveLength(1);
  });
  it('treats a persisted pending send as unknown after a crash', async () => {
    const h = harness(); await h.run('draft.create', draftInput); const draft = h.workspace.drafts[0];
    await h.store.reserveOperation(`draft-send:${draft.id}`, fingerprint({ externalId: draft.externalId, to: draft.to, subject: draft.subject, body: draft.body }));
    await h.run('draft.send', { id: draft.id });
    expect(draft.status).toBe('unknown'); expect(h.calls.filter(call => call.url.endsWith('/send'))).toHaveLength(0);
  });
  it('records a definitive denied send as failed and does not blindly retry it', async () => {
    const h = harness({ sendFailure: 'denied' }); const draft = await h.run('draft.create', draftInput);
    await h.run('draft.send', { id: draft.entityId }); await h.run('draft.send', { id: draft.entityId }, 'retry-denied');
    expect(h.workspace.drafts[0].status).toBe('failed'); expect(h.calls.filter(call => call.url.endsWith('/send'))).toHaveLength(1);
  });
  it('separates Google acceptance from delivery and prevents duplicate sends', async () => {
    const h = harness(); const draft = await h.run('draft.create', draftInput);
    const result = await h.run('draft.send', { id: draft.entityId }); await h.run('draft.send', { id: draft.entityId }, 'again');
    expect(result.message).toContain('Delivery is not guaranteed');
    expect(h.calls.filter(call => call.url.endsWith('/send'))).toHaveLength(1);
  });
  it('refuses unsupported actions instead of silently falling back', async () => { const h = harness(); await expect(h.run('task.create')).rejects.toMatchObject({ code: 'UNSUPPORTED_GOOGLE_ACTION' }); });
});

describe('bounded campaign dispatch', () => {
  function campaign(h: ReturnType<typeof harness>) {
    h.workspace.campaigns.push({ id: 'synthetic-campaign-1', name: 'Synthetic campaign', subject: 'Example', body: 'Example body', status: 'draft', mode: 'live', createdAt: '2026-01-02T12:00:00Z', ratePerMinute: 2, recipients: [{ id: 'r1', email: 'one@example.com', name: 'One', status: 'pending' }, { id: 'r2', email: 'two@example.com', name: 'Two', status: 'pending' }, { id: 'r3', email: 'ONE@example.com', name: 'Duplicate', status: 'pending' }] });
  }
  it('dispatches one recipient, excludes duplicate addresses, and enforces rate spacing', async () => {
    let millis = Date.parse('2026-01-02T12:00:00Z'); const h = harness({ now: () => new Date(millis) }); campaign(h);
    await h.run('campaign.start', { id: 'synthetic-campaign-1' });
    await h.run('campaign.resume', { id: 'synthetic-campaign-1' }, 'next-tick');
    expect(h.calls.filter(call => call.url.endsWith('/send'))).toHaveLength(1);
    expect(h.workspace.campaigns[0].recipients.map(item => item.status)).toEqual(['accepted', 'pending', 'excluded']);
    millis += 30_000; await h.run('campaign.resume', { id: 'synthetic-campaign-1' }, 'next-interval');
    expect(h.workspace.campaigns[0].status).toBe('completed'); expect(h.calls.filter(call => call.url.endsWith('/send'))).toHaveLength(2);
  });
  it('checks send/bulk permission again after campaign creation', async () => {
    const h = harness(); campaign(h); h.setPermissions({ ...h.workspace.permissions, bulkSend: false });
    await expect(h.run('campaign.start', { id: 'synthetic-campaign-1' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(h.calls).toHaveLength(0);
  });
  it('pauses on unknown outcome and never sends the next recipient automatically', async () => {
    const h = harness({ sendFailure: 'timeout' }); campaign(h);
    await h.run('campaign.start', { id: 'synthetic-campaign-1' }); await h.run('campaign.resume', { id: 'synthetic-campaign-1' });
    expect(h.workspace.campaigns[0].status).toBe('paused'); expect(h.workspace.campaigns[0].recipients[0].status).toBe('unknown'); expect(h.calls).toHaveLength(1);
  });
});

describe('managed writes and Calendar stability', () => {
  it('updates a managed named range under an explicit revision, never the whole document', async () => {
    const h = harness(); const bound = await h.run('resource.bind', { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit?tab=t.synthetic', namedRangeId: 'synthetic-range-1', role: 'output' });
    await h.run('docs.write', { resourceId: bound.entityId, content: 'Fictional managed content' }, 'write-once');
    const write = h.calls.find(call => call.method === 'POST' && call.url.includes(':batchUpdate'));
    expect(write?.body).toEqual({ writeControl: { requiredRevisionId: 'synthetic-revision-1' }, requests: [{ replaceNamedRangeContent: { namedRangeId: 'synthetic-range-1', text: 'Fictional managed content', tabsCriteria: { tabIds: ['t.synthetic'] } } }] });
  });
  it('rejects reference-only document writes and does not create arbitrary output ranges', async () => {
    const h = harness(); const bound = await h.run('resource.bind', { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit' });
    await expect(h.run('docs.write', { resourceId: bound.entityId, content: 'Fictional' })).rejects.toMatchObject({ code: 'MANAGED_OUTPUT_REQUIRED' });
    h.workspace.resources[0].role = 'output';
    const result = await h.run('docs.write', { resourceId: bound.entityId, content: 'Fictional' });
    expect(result.state.runs[0].status).toBe('failed'); expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it('refuses ambiguous tabs before a Docs write', async () => {
    const h = harness(); const original = h.dependencies.fetch!;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => String(input).includes('docs.googleapis.com') ? new Response(JSON.stringify({ documentId: 'synthetic-doc-1', revisionId: 'synthetic-revision', tabs: [{ tabProperties: { tabId: 't.first' } }, { tabProperties: { tabId: 't.second' } }] })) : original(input, init));
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: fetcher });
    await expect(integration.provider.writeManagedRange({ fileId: 'synthetic-doc-1', namedRangeId: 'synthetic-range-1' }, 'Synthetic')).rejects.toMatchObject({ code: 'DOCUMENT_TAB_AMBIGUOUS' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('creates stable Calendar IDs, replays without duplication, and disables attendee notifications', async () => {
    const h = harness(); const input = { title: 'Fictional meeting', start: '2026-01-02T13:00:00Z', end: '2026-01-02T14:00:00Z' };
    await h.run('calendar.upsert', input, 'calendar-stable'); await h.run('calendar.upsert', input, 'calendar-stable');
    expect(h.workspace.events).toHaveLength(1); expect(h.workspace.events[0].externalId).toMatch(/^p[0-9a-f]{40}$/);
    expect(h.calls).toHaveLength(1); expect(h.calls[0].url).toContain('sendUpdates=none');
  });
  it('rejects timestamps without a timezone or with backwards intervals', async () => {
    const h = harness();
    await expect(h.run('calendar.upsert', { title: 'Example', start: '2026-01-02T13:00:00', end: '2026-01-02T14:00:00Z' })).rejects.toMatchObject({ code: 'INVALID_DATETIME' });
    await expect(h.run('calendar.upsert', { title: 'Example', start: '2026-01-02T15:00:00Z', end: '2026-01-02T14:00:00Z' })).rejects.toMatchObject({ code: 'INVALID_EVENT_INTERVAL' }); expect(h.calls).toHaveLength(0);
  });
});

describe('honest synthetic adapter', () => {
  it('returns demo flags and explicitly disconnected status without calling Google', async () => {
    const adapter = createSyntheticGoogleAdapter(); const workspace = state(); workspace.settings.mode = 'demo';
    const result = await adapter.executeGoogleAction(workspace, { type: 'resource.browse' });
    expect(result.message).toMatch(/^Synthetic demo:/); expect(result.state.settings.mode).toBe('demo'); expect(result.state.resources.every(item => item.mode === 'demo')).toBe(true); expect(result.state.runs[0].mode).toBe('demo'); expect(result.state.runs[0]).toMatchObject({ apiCalls: 0, writes: 0, modelCalls: 0 });
    expect(await adapter.getGoogleStatus()).toMatchObject({ connected: false, configured: false }); expect(workspace.resources).toHaveLength(0);
  });
  it('cannot substitute for live mode', async () => { await expect(createSyntheticGoogleAdapter().executeGoogleAction(state(), { type: 'resource.browse' })).rejects.toThrow('only accepts demo mode'); });
});
