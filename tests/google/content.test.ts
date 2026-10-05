import { describe, expect, it } from 'vitest';
import { GoogleIntegration } from '../../src/lib/google/index';
import { createSyntheticGoogleAdapter } from '../../src/lib/google/synthetic';
import { SCOPES } from '../../src/lib/google/oauth';
import { boundedResponse } from '../../src/lib/google/transport';
import { readMailText } from '../../src/lib/google/mail-content';
import { GoogleReadCache } from '../../src/lib/google/cache';
import { MemoryGoogleStore } from '../../src/lib/google/storage';
import { state } from './helpers';

function setup(options: Parameters<typeof createSyntheticGoogleAdapter>[0] = {}) {
  const h = createSyntheticGoogleAdapter(options); const workspace = state(); h.setPermissions(workspace.permissions);
  return { ...h, workspace, bind: () => h.integration.execute(workspace, { type: 'resource.bind', payload: { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit' } }) };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
describe('bounded source content and provenance', () => {
  it('reads a bound document with read-only Drive grant and no Docs write permission', async () => {
    const h = setup({ scopes: [SCOPES.driveRead], documentText: 'Task: Review example\n' });
    h.workspace.permissions.docsWrite = false; h.setPermissions(h.workspace.permissions);
    const bound = await h.bind(); const result = await h.integration.execute(h.workspace, { type: 'attachment.read', payload: { resourceId: bound.entityId } });
    expect(result.state.attachments?.[0]).toMatchObject({ id: result.entityId, origin: 'drive', status: 'ready', content: 'Task: Review example\n', mode: 'live', resourceId: bound.entityId });
    expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    expect(h.workspace.runs[0]).toMatchObject({ modelCalls: 0, writes: 0, sourceIds: [bound.entityId] });
  });
  it('rejects unbound or former-grant files before reading content', async () => {
    const h = setup(); await h.integration.execute(h.workspace, { type: 'resource.browse' });
    const resource = h.workspace.resources.find(item => item.kind === 'document')!;
    await expect(h.integration.execute(h.workspace, { type: 'attachment.read', payload: { resourceId: resource.id } })).rejects.toMatchObject({ code: 'ATTACHMENT_RESOURCE_REQUIRED' });
    await h.bind(); const previous = (await h.dependencies.tokenStore.load())!;
    await h.dependencies.tokenStore.save({ ...previous, connectionId: 'synthetic-other-grant' });
    const count = h.calls.length;
    await expect(h.integration.execute(h.workspace, { type: 'attachment.read', payload: { resourceId: resource.id } })).rejects.toMatchObject({ code: 'GOOGLE_GRANT_CHANGED' });
    expect(h.calls.length).toBe(count);
  });
  it('rechecks permission before a cached content read', async () => {
    const h = setup(); await h.bind(); const resource = h.workspace.resources[0];
    await h.integration.contentReader.read(resource); const count = h.calls.length;
    h.setPermissions({ ...h.workspace.permissions, driveRead: false });
    await expect(h.integration.contentReader.read(resource)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(h.calls.length).toBe(count);
  });
  it('limits attachments to 40,000 characters with an honest truncation flag', async () => {
    const h = setup({ documentText: 'x'.repeat(45000) }); await h.bind();
    await h.integration.execute(h.workspace, { type: 'attachment.read', payload: { resourceId: h.workspace.resources[0].id } });
    expect(h.workspace.attachments?.[0].content).toHaveLength(40000); expect(h.workspace.attachments?.[0].truncated).toBe(true);
  });
  it('reads the stable selected Docs named range only', async () => {
    const h = setup({ documentText: 'Selected extra' });
    await h.integration.execute(h.workspace, { type: 'resource.bind', payload: { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit?tab=t.synthetic', namedRangeId: 'synthetic-range-1' } });
    const result = await h.integration.contentReader.read(h.workspace.resources[0]); expect(result.text).toBe('Selected ');
  });
  it('rejects a missing document tab instead of reading another tab', async () => {
    const h = setup(); await h.bind(); h.workspace.resources[0].tabId = 't.missing';
    await expect(h.integration.contentReader.read(h.workspace.resources[0])).rejects.toMatchObject({ code: 'DOCUMENT_TAB_MISSING' });
  });
  it('reads selected Sheet cells with a read-only grant', async () => {
    const h = setup({ scopes: [SCOPES.driveRead] });
    await h.integration.execute(h.workspace, { type: 'resource.bind', payload: { url: 'https://docs.google.com/spreadsheets/d/synthetic-sheet-1/edit#gid=0' } });
    const result = await h.integration.contentReader.read(h.workspace.resources[0]);
    expect(result.text).toContain('Task: Review fictional sample'); expect(result.metadataOnly).toBe(false); expect(result.tabId).toBe('0');
    expect(h.calls.filter(call => call.url.includes('sheets.googleapis.com'))).toHaveLength(2);
  });
  it('uses bounded Drive media and a shared PDF parser, preserving parser truncation', async () => {
    const h = setup(); const original = h.dependencies.fetch!;
    const integration = new GoogleIntegration({ ...h.dependencies, extractPdfText: async bytes => ({ text: `Task: PDF example ${bytes.length}`, truncated: true }), fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/files/synthetic-pdf')) return url.searchParams.get('alt') === 'media' ? new Response('%PDF-1.7 synthetic') : json({ id: 'synthetic-pdf', name: 'Example.pdf', mimeType: 'application/pdf', size: '18' });
      return original(input, init);
    } });
    const bound = await integration.execute(h.workspace, { type: 'resource.bind', payload: { url: 'https://drive.google.com/file/d/synthetic-pdf/view' } });
    await integration.execute(h.workspace, { type: 'attachment.read', payload: { resourceId: bound.entityId } });
    expect(h.workspace.attachments?.[0]).toMatchObject({ status: 'ready', truncated: true, mimeType: 'application/pdf' });
    expect(h.workspace.attachments?.[0].content).toContain('Task: PDF example');
  });
  it('reads UTF-8 media text and removes active HTML as plain text', async () => {
    const h = setup(); const original = h.dependencies.fetch!;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/files/synthetic-text')) return url.searchParams.get('alt') === 'media' ? new Response('<script>bad()</script><p>Task: Read example &amp; review</p>') : json({ id: 'synthetic-text', name: 'Example.html', mimeType: 'text/html' });
      return original(input, init);
    } });
    const bound = await integration.execute(h.workspace, { type: 'resource.bind', payload: { url: 'https://drive.google.com/file/d/synthetic-text/view' } });
    await integration.execute(h.workspace, { type: 'attachment.read', payload: { resourceId: bound.entityId } });
    expect(h.workspace.attachments?.[0].content).toBe('Task: Read example & review');
  });
  it('reports unsupported file bodies instead of claiming content read', async () => {
    const h = setup(); const original = h.dependencies.fetch!;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => String(input).includes('/files/synthetic-image') ? json({ id: 'synthetic-image', name: 'Example image', mimeType: 'image/png' }) : original(input, init) });
    const bound = await integration.execute(h.workspace, { type: 'resource.bind', payload: { url: 'https://drive.google.com/file/d/synthetic-image/view' } });
    await integration.execute(h.workspace, { type: 'attachment.read', payload: { resourceId: bound.entityId } });
    expect(h.workspace.attachments?.[0].status).toBe('unsupported'); expect(h.workspace.attachments?.[0].content).toBeUndefined();
    expect(h.workspace.attachments?.[0].error).toContain('file contents were not');
  });
  it('rejects oversized streaming media without a content-length header', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.close(); } });
    await expect(boundedResponse(new Response(body), 10)).rejects.toMatchObject({ code: 'GOOGLE_CONTENT_TOO_LARGE' });
  });
  it('marks a write with an unreadable response unknown and never retries it', async () => {
    const h = setup(); const original = h.dependencies.fetch!; let sends = 0;
    const integration = new GoogleIntegration({ ...h.dependencies, fetch: async (input, init) => {
      if (String(input).endsWith('/drafts/send')) { sends++; return new Response('{}', { headers: { 'content-length': '99999999' } }); }
      return original(input, init);
    } });
    const draft = await integration.execute(h.workspace, { type: 'draft.create', payload: { to: 'example@example.com', subject: 'Example', body: 'Example' }, requestId: 'body-response' });
    await integration.execute(h.workspace, { type: 'draft.send', payload: { id: draft.entityId } });
    await integration.execute(h.workspace, { type: 'draft.send', payload: { id: draft.entityId } });
    expect(h.workspace.drafts[0].status).toBe('unknown'); expect(sends).toBe(1);
  });
  it('prefers MIME plain text and never fetches embedded HTML URLs', async () => {
    const h = setup(); const message = { id: 'synthetic-mail', threadId: 'synthetic-thread', payload: { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<script>bad()</script><p>HTML</p>').toString('base64url') } }, { mimeType: 'text/plain', body: { data: Buffer.from('Task: Plain source').toString('base64url') } }] } };
    expect((await readMailText(h.integration.provider, message)).text).toBe('Task: Plain source');
    expect((await readMailText(h.integration.provider, { ...message, payload: { mimeType: 'text/html', body: { data: Buffer.from('<script>bad()</script><p>Task: HTML &amp; example</p><img src="https://example.com/tracker">').toString('base64url') } } })).text).toBe('Task: HTML & example');
    expect(h.calls).toHaveLength(0);
  });
  it('does not count snippets as full Gmail bodies', async () => {
    const h = setup(); await expect(readMailText(h.integration.provider, { id: 'synthetic-mail', threadId: 'synthetic-thread', snippet: 'Task: misleading snippet' })).rejects.toMatchObject({ code: 'GOOGLE_GMAIL_BODY_UNAVAILABLE' });
  });
  it('evicts disposable cache entries by count, bytes and expiry without touching write journals', async () => {
    const store = new MemoryGoogleStore(); let time = 0; const cache = new GoogleReadCache(store, () => new Date(time), 2, 20);
    await store.reserveOperation('send-journal', 'same'); await store.set('binding:resource:example', true);
    await cache.set('one', '11111', 100); await cache.set('two', '22222', 100); await cache.set('three', '33333', 100);
    expect(await cache.get('one')).toBeUndefined(); expect(await cache.get('three')).toBe('33333');
    await cache.set('oversized', 'x'.repeat(30)); expect(await cache.get('oversized')).toBeUndefined();
    time = 101; expect(await cache.get('three')).toBeUndefined();
    expect(await store.get('binding:resource:example')).toBe(true); expect((await store.reserveOperation('send-journal', 'same')).created).toBe(false);
  });
});
