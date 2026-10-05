import { describe, expect, it } from 'vitest';
import { GoogleIntegration } from '../../src/lib/google/index';
import { DAILY_CACHE_LIMITS, dayBounds } from '../../src/lib/google/daily';
import { createSyntheticGoogleAdapter } from '../../src/lib/google/synthetic';
import { SCOPES } from '../../src/lib/google/oauth';
import { state, permissions } from './helpers';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup(options: Parameters<typeof createSyntheticGoogleAdapter>[0] = {}) { const h = createSyntheticGoogleAdapter(options); const workspace = state(); h.setPermissions(workspace.permissions); return { ...h, workspace }; }
const event = { id: 'synthetic-event', summary: 'Example meeting', description: 'Todo: Bring fictional notes', start: { dateTime: '2026-01-02T10:00:00Z' }, end: { dateTime: '2026-01-02T11:00:00Z' }, updated: '2026-01-01T00:00:00Z' };
describe('Daily authorized provider inputs', () => {
  it('uses DST day bounds rather than assuming 24 hours', () => {
    const spring = dayBounds('2026-03-08', 'America/New_York'); const fall = dayBounds('2026-11-01', 'America/New_York');
    expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(23 * 3600000); expect(Date.parse(fall.end) - Date.parse(fall.start)).toBe(25 * 3600000);
    expect(() => dayBounds('2026-02-30', 'UTC')).toThrow();
  });
  it('populates disconnected status without Google calls or invented tasks', async () => {
    const h = setup(); await h.dependencies.tokenStore.clear();
    const result = await h.integration.execute(h.workspace, { type: 'daily.read' });
    expect(result.state.daily?.providers.map(provider => provider.status)).toEqual(['not_connected', 'not_connected', 'not_connected']); expect(h.calls).toHaveLength(0); expect(result.state.tasks).toHaveLength(0);
  });
  it('reads Calendar independently under read-only scope and binds its returned events', async () => {
    const h = setup({ scopes: [SCOPES.calendarRead] }); h.workspace.permissions = { ...permissions(false), calendarRead: true }; h.setPermissions(h.workspace.permissions);
    const original = h.dependencies.fetch!;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => String(input).includes('/calendar/v3/') ? json({ items: [event], nextSyncToken: 'synthetic-sync' }) : original(input, init) });
    const result = await integration.execute(h.workspace, { type: 'daily.read' });
    expect(result.state.daily?.providers).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'gmail', status: 'not_enabled' }), expect.objectContaining({ provider: 'calendar', status: 'complete', read: 1 })]));
    expect(result.state.daily?.sources[0].text).toContain('Todo: Bring fictional notes'); expect(result.state.events[0].externalId).toBe(event.id); expect(result.state.tasks).toHaveLength(0);
    expect(await h.store.get(`binding:event:${result.state.events[0].id}`)).toBe(true); expect(result.state.runs[0].writes).toBe(0);
  });
  it('requires Calendar write permission before updating a Daily-read event', async () => {
    const h = setup(); h.workspace.permissions.gmailRead = false; h.setPermissions(h.workspace.permissions);
    const original = h.dependencies.fetch!;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => String(input).includes('/calendar/v3/') && (!init?.method || init.method === 'GET') ? json({ items: [event] }) : original(input, init) });
    await integration.execute(h.workspace, { type: 'daily.read' }); h.setPermissions({ ...h.workspace.permissions, calendarWrite: false });
    await expect(integration.execute(h.workspace, { type: 'calendar.upsert', payload: { id: h.workspace.events[0].id, title: 'Changed' }, requestId: 'synthetic-event-edit' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    h.setPermissions(h.workspace.permissions);
    const result = await integration.execute(h.workspace, { type: 'calendar.upsert', payload: { id: h.workspace.events[0].id, title: 'Changed' }, requestId: 'synthetic-event-edit' });
    expect(result.state.events[0].title).toBe('Changed'); expect(result.state.runs[0].writes).toBe(1);
  });
  it('continues Gmail search pages using the exact saved query', async () => {
    const h = setup({ pageSize: 1 });
    await h.integration.execute(h.workspace, { type: 'daily.read', payload: { gmailQuery: 'label:example newer_than:1d' } });
    expect(h.workspace.daily?.providers.find(item => item.provider === 'gmail')).toMatchObject({ status: 'partial', discovered: 1, read: 1, coverage: 'all' });
    const stale = structuredClone(h.workspace);
    await h.integration.execute(stale, { type: 'daily.read', payload: { gmailQuery: 'label:example newer_than:1d' } });
    expect(stale.daily?.providers.find(item => item.provider === 'gmail')).toMatchObject({ status: 'complete', read: 2 });
    expect(stale.daily?.sources.filter(source => source.provider === 'gmail')).toHaveLength(2);
    const lists = h.calls.filter(call => new URL(call.url).pathname.endsWith('/messages'));
    expect(lists.map(call => new URL(call.url).searchParams.get('q'))).toEqual(['label:example newer_than:1d', 'label:example newer_than:1d']); expect(new URL(lists[1].url).searchParams.get('pageToken')).toBe('1');
  });
  it('keeps Calendar results when Gmail fails', async () => {
    const h = setup(); const original = h.dependencies.fetch!;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => String(input).includes('gmail.googleapis.com') ? json({}, 403) : String(input).includes('/calendar/v3/') ? json({ items: [event] }) : original(input, init) });
    await integration.execute(h.workspace, { type: 'daily.read' });
    expect(h.workspace.daily?.providers.find(item => item.provider === 'gmail')).toMatchObject({ status: 'failed', failed: 1 });
    expect(h.workspace.daily?.providers.find(item => item.provider === 'calendar')).toMatchObject({ status: 'complete', read: 1 }); expect(h.workspace.daily?.sources[0].provider).toBe('calendar');
  });
  it('never enumerates the mailbox with selected Gmail coverage and no linked threads', async () => {
    const h = setup(); h.workspace.permissions.gmailFull = false; h.setPermissions(h.workspace.permissions);
    await h.integration.execute(h.workspace, { type: 'daily.read' });
    expect(h.workspace.daily?.providers.find(item => item.provider === 'gmail')).toMatchObject({ status: 'idle', coverage: 'selected', read: 0 }); expect(h.calls.some(call => call.url.includes('/messages'))).toBe(false);
  });
  it('reads only same-grant explicitly linked Gmail threads', async () => {
    const h = setup(); h.workspace.permissions.gmailFull = false; h.setPermissions(h.workspace.permissions);
    h.workspace.drafts.push({ id: 'synthetic-draft', to: 'recipient@example.com', subject: 'Example', body: 'Example', threadId: 'synthetic-thread-1', status: 'draft', mode: 'live', updatedAt: '2026-01-02T00:00:00Z' });
    await h.store.set('binding:draft:synthetic-draft', true);
    await h.integration.execute(h.workspace, { type: 'daily.read' });
    expect(h.workspace.daily?.providers.find(item => item.provider === 'gmail')).toMatchObject({ status: 'complete', read: 1, coverage: 'selected' });
    expect(h.calls.some(call => new URL(call.url).pathname.endsWith('/messages'))).toBe(false);
  });
  it('adopts Calendar sync tokens after the final page and removes cancelled events on delta', async () => {
    const h = setup(); h.workspace.permissions.gmailRead = false; h.setPermissions(h.workspace.permissions);
    const urls: URL[] = [];
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async input => {
      const url = new URL(String(input)); urls.push(url);
      if (url.searchParams.has('syncToken')) return json({ items: [{ id: event.id, status: 'cancelled' }], nextSyncToken: 'synthetic-sync-2' });
      if (url.searchParams.get('pageToken') === 'calendar-next') return json({ items: [], nextSyncToken: 'synthetic-sync-1' });
      return json({ items: [event], nextPageToken: 'calendar-next' });
    } });
    await integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily?.providers[1].status).toBe('partial');
    await integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily?.providers[1].status).toBe('complete');
    await integration.execute(h.workspace, { type: 'daily.read' });
    expect(urls[1].searchParams.get('pageToken')).toBe('calendar-next'); expect(urls[2].searchParams.get('syncToken')).toBe('synthetic-sync-1'); expect(urls[2].searchParams.has('timeMin')).toBe(false); expect(urls[2].searchParams.has('orderBy')).toBe(false);
    expect(h.workspace.events).toHaveLength(0); expect(h.workspace.daily?.sources).toHaveLength(0);
  });
  it('recovers an expired Calendar token using a fresh day read on the next call', async () => {
    const h = setup(); h.workspace.permissions.gmailRead = false; h.setPermissions(h.workspace.permissions); const urls: URL[] = [];
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async input => { const url = new URL(String(input)); urls.push(url); return url.searchParams.has('syncToken') ? json({}, 410) : json({ items: [event], nextSyncToken: 'synthetic-expired' }); } });
    await integration.execute(h.workspace, { type: 'daily.read' }); await integration.execute(h.workspace, { type: 'daily.read' });
    expect(h.workspace.daily?.providers[1].error).toContain('expired');
    await integration.execute(h.workspace, { type: 'daily.read' }); expect(urls[2].searchParams.has('syncToken')).toBe(false); expect(urls[2].searchParams.has('timeMin')).toBe(true); expect(h.workspace.daily?.providers[1].status).toBe('complete');
  });
  it('does not reuse old-account sources or event write bindings after Google account change', async () => {
    const h = setup(); const integration = new GoogleIntegration({ ...h.dependencies, fetch: async input => String(input).includes('/calendar/v3/') ? json({ items: [event] }) : h.dependencies.fetch!(input) });
    await integration.execute(h.workspace, { type: 'daily.read' }); const priorId = h.workspace.daily!.id; const oldEventId = h.workspace.events[0].id;
    const tokens = (await h.dependencies.tokenStore.load())!; await h.dependencies.tokenStore.save({ ...tokens, connectionId: 'synthetic-grant-2' });
    h.workspace.permissions.gmailRead = false; h.workspace.permissions.calendarRead = false; h.setPermissions(h.workspace.permissions);
    await integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily!.id).not.toBe(priorId); expect(h.workspace.daily?.sources).toHaveLength(0);
    await expect(integration.execute(h.workspace, { type: 'calendar.upsert', payload: { id: oldEventId, title: 'Changed' }, requestId: 'old-grant-edit' })).rejects.toMatchObject({ code: 'GOOGLE_GRANT_CHANGED' });
  });
  it('reports snippet-only Gmail response failures honestly', async () => {
    const h = setup(); const original = h.dependencies.fetch!;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => /\/messages\/synthetic-message-/.test(String(input)) ? json({ id: String(input).split('/').at(-1)?.split('?')[0], threadId: 'synthetic-thread', snippet: 'Todo: snippet alone' }) : original(input, init) });
    await integration.execute(h.workspace, { type: 'daily.read' });
    expect(h.workspace.daily?.providers[0]).toMatchObject({ status: 'partial', read: 0, failed: 2 }); expect(h.workspace.daily?.sources).toHaveLength(0);
  });
  it('removes cached Daily content when the current OAuth grant loses its read scope', async () => {
    const h = setup(); const integration = new GoogleIntegration({ ...h.dependencies, fetch: async input => String(input).includes('/calendar/v3/') ? json({ items: [event] }) : h.dependencies.fetch!(input) });
    await integration.execute(h.workspace, { type: 'daily.read' }); expect(h.workspace.daily?.sources.length).toBeGreaterThan(0);
    const token = (await h.dependencies.tokenStore.load())!; await h.dependencies.tokenStore.save({ ...token, scopes: [] });
    const count = h.calls.length; await integration.execute(h.workspace, { type: 'daily.read' });
    expect(h.workspace.daily?.sources).toHaveLength(0); expect(h.workspace.daily?.providers.map(provider => provider.status)).toEqual(['not_enabled', 'not_enabled', 'not_enabled']); expect(h.calls.length).toBe(count);
  });
  it('links partial Daily receipts to the actual source IDs with zero model/write calls', async () => {
    const h = setup({ pageSize: 1 }); await h.integration.execute(h.workspace, { type: 'daily.read' });
    expect(h.workspace.runs[0]).toMatchObject({ status: 'pending', modelCalls: 0, writes: 0, sourceIds: h.workspace.daily!.sources.map(source => source.id) });
  });
  it('bounds Calendar event count and never calls capped coverage complete', async () => {
    const h = setup(); h.workspace.permissions.gmailRead = false; h.setPermissions(h.workspace.permissions);
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async input => {
      const url = new URL(String(input)); const offset = Number(url.searchParams.get('pageToken') ?? 0);
      return json({ items: Array.from({ length: 100 }, (_, i) => ({ ...event, id: `synthetic-event-${offset + i}` })), ...(offset < 500 ? { nextPageToken: String(offset + 100) } : { nextSyncToken: 'must-not-use-capped-token' }) });
    } });
    for (let i = 0; i < 6; i++) await integration.execute(h.workspace, { type: 'daily.read' });
    expect(h.workspace.daily?.sources).toHaveLength(DAILY_CACHE_LIMITS.events); expect(h.workspace.daily?.providers[1]).toMatchObject({ status: 'partial', read: 500, skipped: 100 });
    const index = await h.store.get<string[]>('daily-record-index'); const record = await h.store.get<{ events: unknown[]; calendar: { nextSyncToken?: string } }>(index![0]);
    expect(record?.events).toHaveLength(500); expect(record?.calendar.nextSyncToken).toBeUndefined();
  });
  it('retains at most 30 Daily cache records and truncates long Calendar text visibly', async () => {
    const h = setup(); h.workspace.permissions.gmailRead = false; h.setPermissions(h.workspace.permissions);
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async () => json({ items: [{ ...event, description: 'x'.repeat(50000) }] }) });
    for (let i = 0; i < 32; i++) await integration.execute(h.workspace, { type: 'daily.read', payload: { calendarId: `synthetic-calendar-${i}` } });
    expect((await h.store.get<string[]>('daily-record-index'))?.length).toBe(30); expect(h.workspace.daily?.sources[0].truncated).toBe(true); expect(h.workspace.daily?.providers[1].status).toBe('partial');
  });
});
