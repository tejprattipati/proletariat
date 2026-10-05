import type { ActionRequest, ActionResult, Connection, Permissions, WorkspaceState } from '../types';
import type { DriveFile, GoogleDependencies, GoogleTokens } from './contracts';
import { GoogleIntegration } from './index';
import { SCOPES } from './oauth';
import { MemoryGoogleStore } from './storage';

/** Fictional data only. This adapter never uses the real fetch implementation. */
export const SYNTHETIC_DRIVE_FILES: DriveFile[] = [
  { id: 'synthetic-folder-1', name: 'Example project', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01T12:00:00Z', parents: ['root'] },
  { id: 'synthetic-doc-1', name: 'Example managed notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-01-01T12:00:00Z', parents: ['synthetic-folder-1'] },
  { id: 'synthetic-sheet-1', name: 'Example tracker', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-01-01T12:00:00Z', parents: ['synthetic-folder-1'] },
];
export interface SyntheticOptions { now?: () => Date; pageSize?: number; sendFailure?: 'timeout' | 'server' | 'denied'; copyFailure?: 'timeout'; documentWriteFailure?: 'timeout' | 'denied'; documentText?: string; scopes?: string[]; }
export function createSyntheticGoogleAdapter(options: SyntheticOptions = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const store = new MemoryGoogleStore();
  const now = options.now ?? (() => new Date('2026-01-02T12:00:00Z'));
  let tokens: GoogleTokens | undefined = { connectionId: 'synthetic-grant-1', accessToken: 'synthetic-token-not-valid', refreshToken: 'synthetic-refresh-not-valid', expiresAt: now().getTime() + 3600_000, scopes: options.scopes ?? Object.values(SCOPES) };
  let currentPermissions: Permissions | undefined;
  let draftSequence = 0;
  const copiedFiles = new Map<string, DriveFile>();
  const drafts = new Map<string, unknown>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ url: url.href, method, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const page = <T>(items: T[], field: string) => {
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const size = options.pageSize ?? 2;
      return json({ [field]: items.slice(offset, offset + size), ...(offset + size < items.length ? { nextPageToken: String(offset + size) } : {}) });
    };
    if (url.pathname.endsWith('/changes/startPageToken')) return json({ startPageToken: 'synthetic-drive-checkpoint-1' });
    if (url.pathname.endsWith('/changes')) return json({ changes: [], newStartPageToken: 'synthetic-drive-checkpoint-2' });
    if (url.pathname.endsWith('/files')) {
      const query = url.searchParams.get('q') ?? '';
      const parent = query.match(/'([\w-]+)' in parents/)?.[1];
      return page(SYNTHETIC_DRIVE_FILES.filter(file => !parent || file.parents?.includes(parent)), 'files');
    }
    if (url.pathname.endsWith('/copy') && method === 'POST') {
      if (options.copyFailure === 'timeout') throw new TypeError('Synthetic copy response lost');
      const input = body as { name: string; parents: string[] };
      const id = `synthetic-copy-${copiedFiles.size + 1}`;
      copiedFiles.set(id, { id, name: input.name, parents: input.parents, mimeType: 'application/vnd.google-apps.document', modifiedTime: now().toISOString() });
      return json({ id });
    }
    if (url.pathname.includes('/drive/v3/files/')) {
      const file = SYNTHETIC_DRIVE_FILES.find(item => url.pathname.endsWith(`/${item.id}`)) ?? copiedFiles.get(url.pathname.split('/').at(-1)!);
      return file ? json(file) : json({ error: 'Synthetic missing file' }, 404);
    }
    if (url.pathname.endsWith('/profile')) return json({ historyId: 'synthetic-gmail-history-1' });
    if (url.pathname.endsWith('/history')) return json({ history: [], historyId: 'synthetic-gmail-history-2' });
    if (url.pathname.endsWith('/messages') && method === 'GET') return page([{ id: 'synthetic-message-1', threadId: 'synthetic-thread-1' }, { id: 'synthetic-message-2', threadId: 'synthetic-thread-2' }], 'messages');
    if (/\/messages\/synthetic-message-/.test(url.pathname)) return json({ id: url.pathname.split('/').at(-1), threadId: 'synthetic-thread-1', snippet: 'Fictional example message', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'sender@example.com' }], body: { data: Buffer.from('Fictional text for adapter tests.').toString('base64url') } } });
    if (/\/threads\/synthetic-thread-/.test(url.pathname)) return json({ messages: [{ id: 'synthetic-message-1', threadId: url.pathname.split('/').at(-1), snippet: 'Fictional example', payload: { mimeType: 'text/plain', body: { data: Buffer.from('Fictional selected thread text.').toString('base64url') } } }] });
    if (url.pathname.endsWith('/drafts') && method === 'POST') { const id = `synthetic-draft-${++draftSequence}`; drafts.set(id, body); return json({ id }); }
    if (/\/drafts\/synthetic-draft-/.test(url.pathname) && method === 'PUT') { const id = url.pathname.split('/').at(-1)!; drafts.set(id, body); return json({ id }); }
    if (url.pathname.endsWith('/send')) {
      if (options.sendFailure === 'timeout') throw new TypeError('Synthetic connection lost after dispatch');
      if (options.sendFailure === 'server') return json({ error: 'Synthetic uncertain upstream failure' }, 503);
      if (options.sendFailure === 'denied') return json({ error: 'Synthetic denied' }, 403);
      return json({ id: 'synthetic-accepted-message' });
    }
    if (url.hostname === 'sheets.googleapis.com') return url.pathname.includes('/values/') ? json({ values: [['Task: Review fictional sample', 'Example only']] }) : json({ sheets: [{ properties: { sheetId: 0, title: 'Example', gridProperties: { rowCount: 2, columnCount: 2 } } }] });
    if (url.hostname === 'docs.googleapis.com' && method === 'GET') return json({ documentId: url.pathname.split('/').at(-1), revisionId: 'synthetic-revision-1', tabs: [{ tabProperties: { tabId: 't.synthetic' }, documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: options.documentText ?? '{{title}}\nPrepared for {{person}}\n{{context}}\n' } }] } }] }, namedRanges: { managed: { namedRanges: [{ namedRangeId: 'synthetic-range-1', ranges: [{ startIndex: 1, endIndex: 10, tabId: 't.synthetic' }] }] } } } }] });
    if (url.hostname === 'docs.googleapis.com' && method === 'POST') {
      if (options.documentWriteFailure === 'timeout') throw new TypeError('Synthetic write response lost');
      if (options.documentWriteFailure === 'denied') return json({ error: 'Synthetic write denied' }, 403);
      return json({ documentId: url.pathname.split('/').at(-1)?.split(':')[0], replies: [{}] });
    }
    if (url.pathname.includes('/calendar/v3/')) return method === 'GET' ? json({ items: [] }) : json({ id: (body as { id?: string })?.id ?? url.pathname.split('/').at(-1) });
    throw new Error(`Unmocked synthetic request: ${url.pathname}. No network request was made.`);
  };
  const dependencies: GoogleDependencies = { config: { clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-placeholder', redirectUri: 'http://127.0.0.1:3001/api/google/callback' }, tokenStore: { async load() { return structuredClone(tokens); }, async save(value) { tokens = structuredClone(value); }, async clear() { tokens = undefined; } }, store, fetch: fetcher, now, getPermissions: async () => { if (!currentPermissions) throw new Error('Synthetic permissions have not been initialized.'); return structuredClone(currentPermissions); } };
  const integration = new GoogleIntegration(dependencies);
  return {
    synthetic: true as const,
    calls, store: integration.store, rawStore: store, dependencies, integration,
    setPermissions(permissions: Permissions) { currentPermissions = structuredClone(permissions); },
    async getGoogleStatus(): Promise<Connection> { return { provider: 'google', connected: false, configured: false, label: 'Synthetic Google adapter · no OAuth or Google network connection' }; },
    async executeGoogleAction(state: WorkspaceState, action: ActionRequest): Promise<ActionResult> {
      if (state.settings.mode !== 'demo') throw new Error('Synthetic adapter only accepts demo mode; never silently replaces live integration.');
      const copy = structuredClone(state);
      currentPermissions = structuredClone(state.permissions);
      copy.settings.mode = 'live';
      for (const collection of [copy.resources, copy.drafts, copy.campaigns, copy.scans]) for (const item of collection) item.mode = 'live';
      const result = await integration.execute(copy, action);
      result.state.settings.mode = 'demo';
      for (const collection of [result.state.resources, result.state.drafts, result.state.campaigns, result.state.scans, result.state.runs, result.state.attachments ?? []]) for (const item of collection) item.mode = 'demo';
      if (result.state.daily) result.state.daily.mode = 'demo';
      result.message = `Synthetic demo: ${result.message}`;
      // Mock HTTP traffic is exposed in calls, never counted as real Google usage or writes.
      result.state.usage.apiCalls = state.usage.apiCalls;
      result.state.usage.cacheHits = state.usage.cacheHits;
      if (result.state.runs[0]) Object.assign(result.state.runs[0], { description: result.message, apiCalls: 0, writes: 0, cacheHits: 0 });
      return result;
    },
  };
}
