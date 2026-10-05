import { randomUUID } from 'node:crypto';
import type { PermissionKey, Resource, ScanJob, WorkspaceState } from '../types';
import { GoogleContentReader } from './content';
import { readMailText } from './mail-content';
import type { DriveFile, GoogleStore } from './contracts';
import { GoogleProvider, driveResource } from './provider';
import { GoogleHttpError, GoogleIntegrationError, stableResourceId } from './security';

interface ScanCursor {
  strategy: 'full' | 'selected' | 'changes';
  index: number;
  selected: string[];
  pageToken?: string;
  checkpoint?: string;
  sequence: number;
  query?: string;
  readIds?: string[];
  snapshot: { job: ScanJob; upserts: Resource[]; removed: string[] };
}
export class GoogleScans {
  constructor(private provider: GoogleProvider, private store: GoogleStore, private assert: (...keys: PermissionKey[]) => Promise<void>, private now = () => new Date(), private contentReader = new GoogleContentReader(provider, store, now)) {}
  async start(state: WorkspaceState, provider: 'gmail' | 'drive', coverage: 'all' | 'selected', incremental = false, query?: string): Promise<ScanJob> {
    await this.permission(provider, coverage);
    await this.recoverLatest(state, provider);
    const candidates = provider === 'drive' ? state.resources.filter(item => item.mode === 'live' && item.bound && item.providerId).map(item => item.providerId!) : [...new Set(state.drafts.filter(item => item.mode === 'live' && item.threadId).map(item => item.threadId!))];
    const selected: string[] = [];
    for (const id of candidates) {
      const bound = provider === 'drive' ? await this.store.get(`binding:resource:${stableResourceId(id)}`) : (await Promise.all(state.drafts.filter(draft => draft.threadId === id).map(draft => this.store.get(`binding:draft:${draft.id}`)))).some(Boolean);
      if (bound) selected.push(id);
    }
    if (coverage === 'selected' && !selected.length) throw new GoogleIntegrationError('SELECTION_REQUIRED', provider === 'drive' ? 'Bind Google Drive resources before a selected scan.' : 'Selected Gmail scans require explicitly linked draft thread IDs. Enable full mailbox coverage for a broad scan.');
    const storedCheckpoint = incremental && coverage === 'all' && !query ? await this.store.get<string>(`sync:${provider}`) : undefined;
    const strategy = coverage === 'selected' ? 'selected' : storedCheckpoint ? 'changes' : 'full';
    const checkpoint = storedCheckpoint ?? (coverage === 'all' ? await (provider === 'drive' ? this.provider.driveCheckpoint() : this.provider.gmailCheckpoint()) : undefined);
    const job: ScanJob = { id: `scan-${randomUUID()}`, provider, coverage, status: 'queued', discovered: 0, read: 0, analyzed: 0, skipped: 0, failed: 0, createdAt: this.now().toISOString(), mode: 'live', cursor: 'checkpoint:0' };
    state.scans.unshift(job);
    await this.store.set<ScanCursor>(`scan:${job.id}`, { strategy, selected, index: 0, checkpoint, sequence: 0, query, readIds: [], snapshot: { job: structuredClone(job), upserts: [], removed: [] }, ...(strategy === 'changes' && provider === 'drive' ? { pageToken: checkpoint } : {}) });
    await this.advance(state, job);
    return job;
  }
  async advance(state: WorkspaceState, job: ScanJob): Promise<void> {
    if (job.mode !== 'live') throw new GoogleIntegrationError('MODE_MISMATCH', 'Synthetic scan jobs cannot access Google.');
    await this.permission(job.provider, job.coverage);
    if (job.status === 'completed') return;
    const cursor = await this.store.get<ScanCursor>(`scan:${job.id}`);
    if (!cursor) throw new GoogleIntegrationError('SCAN_CHECKPOINT_MISSING', 'Scan checkpoint is unavailable. Start a new scan instead of guessing its position.', 409);
    this.restore(state, cursor, job);
    if (cursor.snapshot.job.status === 'completed' && job.cursor === cursor.snapshot.job.cursor) return;
    await this.store.set(`scan-latest:${job.provider}`, job.id);
    const beforeResources = structuredClone(state.resources);
    const beforeJob = structuredClone(job);
    job.status = 'running';
    try {
      const complete = job.provider === 'drive' ? await this.drive(state, job, cursor) : await this.gmail(job, cursor);
      cursor.sequence++;
      job.cursor = `checkpoint:${cursor.sequence}`;
      if (complete) job.status = 'completed';
      const previous = new Map(beforeResources.map(resource => [resource.id, JSON.stringify(resource)]));
      const remaining = new Set(state.resources.map(resource => resource.id));
      cursor.snapshot = { job: structuredClone(job), upserts: state.resources.filter(resource => previous.get(resource.id) !== JSON.stringify(resource)), removed: beforeResources.filter(resource => !remaining.has(resource.id)).map(resource => resource.id) };
      // Commit each page's effects together with its next cursor. If the caller's workspace commit is interrupted,
      // the next resume/sync replays this snapshot before advancing the provider page.
      await this.store.set(`scan:${job.id}`, cursor);
      if (complete && cursor.checkpoint && job.coverage === 'all' && job.failed === 0 && !cursor.query) await this.store.set(`sync:${job.provider}`, cursor.checkpoint);
    } catch (error) {
      state.resources = beforeResources;
      Object.assign(job, beforeJob, { status: 'failed', failed: beforeJob.failed + 1 });
      // Expired history/change tokens require an explicit full rescan, never an invisible coverage expansion.
      if (error instanceof GoogleHttpError && [404, 410].includes(error.status) && cursor.strategy === 'changes') {
        await this.store.delete(`sync:${job.provider}`);
        throw new GoogleIntegrationError('SYNC_CURSOR_EXPIRED', 'Google incremental history expired. Start a new explicit scan to rebuild coverage.', 409);
      }
      throw error;
    }
  }
  private async recoverLatest(state: WorkspaceState, provider: 'gmail' | 'drive'): Promise<void> {
    const id = await this.store.get<string>(`scan-latest:${provider}`);
    if (!id) return;
    const cursor = await this.store.get<ScanCursor>(`scan:${id}`);
    if (!cursor) return;
    const job = state.scans.find(item => item.id === id);
    if (job?.cursor === cursor.snapshot.job.cursor) return;
    try { await this.permission(provider, cursor.snapshot.job.coverage); }
    catch (error) {
      // Do not expose an uncommitted broad read after its permission was revoked. Rebuild any later full sync.
      if (error instanceof GoogleIntegrationError && error.code === 'PERMISSION_DENIED') { await this.store.delete(`sync:${provider}`); return; }
      throw error;
    }
    this.restore(state, cursor, job);
  }
  private restore(state: WorkspaceState, cursor: ScanCursor, job?: ScanJob): void {
    if (job?.cursor === cursor.snapshot.job.cursor) return;
    for (const resource of cursor.snapshot.upserts) {
      const existing = state.resources.find(item => item.id === resource.id);
      if (existing) Object.assign(existing, { name: resource.name, modifiedAt: resource.modifiedAt, parentId: resource.parentId, content: resource.content });
      else state.resources.push(structuredClone(resource));
    }
    const removed = new Set(cursor.snapshot.removed);
    state.resources = state.resources.filter(resource => !removed.has(resource.id));
    if (job) Object.assign(job, structuredClone(cursor.snapshot.job));
    else state.scans.unshift(structuredClone(cursor.snapshot.job));
  }
  private async permission(provider: 'gmail' | 'drive', coverage: 'all' | 'selected'): Promise<void> {
    await this.assert(provider === 'drive' ? 'driveRead' : 'gmailRead', ...(coverage === 'all' ? [provider === 'drive' ? 'driveFull' as const : 'gmailFull' as const] : []));
  }
  private upsert(state: WorkspaceState, file: Parameters<typeof driveResource>[0]): void {
    const resource = driveResource(file, this.now());
    const index = state.resources.findIndex(item => item.id === resource.id);
    if (index >= 0) state.resources[index] = { ...state.resources[index], name: resource.name, modifiedAt: resource.modifiedAt, parentId: resource.parentId };
    else state.resources.push(resource);
  }
  private async drive(state: WorkspaceState, job: ScanJob, cursor: ScanCursor): Promise<boolean> {
    if (cursor.strategy === 'changes') {
      const page = await this.provider.driveChanges(cursor.pageToken!);
      for (const change of page.items) {
        job.discovered++;
        await this.provider.cache.delete(`file:${change.fileId}`);
        if (change.removed || change.file?.trashed) { state.resources = state.resources.filter(item => item.providerId !== change.fileId); job.skipped++; }
        else if (change.file) await this.readFile(state, job, cursor, change.file, true);
      }
      cursor.pageToken = page.nextPageToken;
      if (page.checkpoint) cursor.checkpoint = page.checkpoint;
      return !page.nextPageToken;
    }
    if (cursor.strategy === 'full') {
      const page = await this.provider.browse(undefined, undefined, cursor.pageToken);
      for (const file of page.items) { job.discovered++; await this.readFile(state, job, cursor, file); }
      cursor.pageToken = page.nextPageToken;
      return !page.nextPageToken;
    }
    // Selected folders include descendants; keep the queue/page token durable so the worker can pause between pages.
    const id = cursor.selected[cursor.index];
    if (!id) return true;
    await this.permission(job.provider, job.coverage);
    const file = await this.provider.getFile(id, true);
    if (!cursor.pageToken) { job.discovered++; await this.readFile(state, job, cursor, file); }
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      const page = await this.provider.browse(id, undefined, cursor.pageToken);
      for (const child of page.items) {
        if (child.mimeType === 'application/vnd.google-apps.folder') { if (!cursor.selected.includes(child.id)) cursor.selected.push(child.id); }
        else { job.discovered++; await this.readFile(state, job, cursor, child); }
      }
      cursor.pageToken = page.nextPageToken;
      if (page.nextPageToken) return false;
    }
    cursor.index++;
    return cursor.index >= cursor.selected.length;
  }
  private async readFile(state: WorkspaceState, job: ScanJob, cursor: ScanCursor, file: DriveFile, fresh = false) {
    await this.permission(job.provider, job.coverage);
    this.upsert(state, file);
    const counts = job as ScanJob & { metadataRead?: number; contentRead?: number; truncated?: number };
    counts.metadataRead = (counts.metadataRead ?? 0) + 1;
    if (file.mimeType === 'application/vnd.google-apps.folder') { job.skipped++; return; }
    if (cursor.readIds?.includes(file.id)) return;
    try {
      const resource = state.resources.find(item => item.providerId === file.id)!;
      const result = await this.contentReader.read(resource, { maxChars: 40_000, fresh });
      resource.content = result.text;
      job.read++; counts.contentRead = (counts.contentRead ?? 0) + 1;
      if (result.truncated) counts.truncated = (counts.truncated ?? 0) + 1;
      (cursor.readIds ??= []).push(file.id);
    } catch (error) {
      if (error instanceof GoogleIntegrationError && ['PERMISSION_DENIED', 'GOOGLE_SCOPE_REQUIRED', 'GOOGLE_GRANT_CHANGED', 'GOOGLE_REAUTH_REQUIRED'].includes(error.code)) throw error;
      if (error instanceof GoogleIntegrationError && ['GOOGLE_CONTENT_TYPE_UNSUPPORTED', 'GOOGLE_PDF_PARSER_REQUIRED'].includes(error.code)) job.skipped++;
      else job.failed++;
    }
  }
  private async readMail(job: ScanJob, message: Parameters<typeof readMailText>[1]) {
    try {
      const result = await readMailText(this.provider, message);
      await this.provider.cache.set(`gmail-content:${message.id}`, { ...result, id: message.id, version: message.historyId, readAt: this.now().toISOString() });
      job.read++;
      const counts = job as ScanJob & { contentRead?: number; truncated?: number };
      counts.contentRead = (counts.contentRead ?? 0) + 1;
      if (result.truncated) counts.truncated = (counts.truncated ?? 0) + 1;
    } catch (error) {
      if (error instanceof GoogleIntegrationError && ['PERMISSION_DENIED', 'GOOGLE_SCOPE_REQUIRED', 'GOOGLE_GRANT_CHANGED', 'GOOGLE_REAUTH_REQUIRED'].includes(error.code)) throw error;
      job.failed++;
    }
  }
  private async gmail(job: ScanJob, cursor: ScanCursor): Promise<boolean> {
    if (cursor.strategy === 'selected') {
      const threadId = cursor.selected[cursor.index];
      if (!threadId) return true;
      const messages = await this.provider.getThread(threadId);
      job.discovered += messages.length;
      for (const message of messages) await this.readMail(job, message);
      cursor.index++;
      return cursor.index >= cursor.selected.length;
    }
    if (cursor.strategy === 'changes') {
      const page = await this.provider.gmailChanges(cursor.checkpoint!, cursor.pageToken);
      for (const change of page.items) {
        await this.permission(job.provider, job.coverage);
        job.discovered++;
        if (change.deleted) { await this.provider.cache.delete(`gmail:${change.id}`); job.skipped++; }
        else await this.readMail(job, await this.provider.getMessage(change.id, true));
      }
      cursor.pageToken = page.nextPageToken;
      // Keep startHistoryId fixed while paging. Adopt the new checkpoint only on the final page.
      if (!page.nextPageToken && page.checkpoint) cursor.checkpoint = page.checkpoint;
      return !page.nextPageToken;
    }
    const page = await this.provider.listMessages(cursor.pageToken, cursor.query);
    for (const message of page.items) {
      await this.permission(job.provider, job.coverage);
      job.discovered++;
      try { await this.readMail(job, await this.provider.getMessage(message.id)); }
      catch (error) {
        if (error instanceof GoogleHttpError && error.status === 404) job.skipped++;
        else throw error;
      }
    }
    cursor.pageToken = page.nextPageToken;
    return !page.nextPageToken;
  }
}

export function requireScan(state: WorkspaceState, id: string): ScanJob {
  const job = state.scans.find(item => item.id === id);
  if (!job) throw new GoogleIntegrationError('SCAN_NOT_FOUND', 'Scan was not found.', 404);
  return job;
}
// Stable provider references are independent of display titles and traversal order.
export const driveScanReference = stableResourceId;
