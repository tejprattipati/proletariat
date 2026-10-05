import { DateTime } from 'luxon';
import type { DailySnapshot, DailySource, PermissionKey, Resource, WorkspaceState } from '../types';
import type { GoogleEvent, GoogleStore } from './contracts';
import { SCOPES } from './oauth';
import { GoogleProvider, driveResource } from './provider';
import { GoogleContentReader } from './content';
import { htmlToText, mailTitle, readMailText } from './mail-content';
import { GoogleHttpError, GoogleIntegrationError, fingerprint, text } from './security';

interface Cursor { pageToken?: string; index: number; complete: boolean; syncToken?: string; nextSyncToken?: string; retry?: boolean; seen: string[]; }
interface CachedEvent extends GoogleEvent { truncated?: boolean; }
interface DailyRecord { snapshot: DailySnapshot; gmail: Cursor; calendar: Cursor; events: CachedEvent[]; drive?: { queue: { resource: Resource; pageToken?: string }[]; seen: string[]; complete: boolean; gaps?: string[] }; }
const MAX_SOURCES = 500;
const MAX_TEXT = 2_000_000;
export const DAILY_CACHE_LIMITS = { events: 500, eventChars: 40_000, calendarChars: 1_000_000, records: 30 } as const;
/** One bounded provider page per invocation. Storage is scoped to the captured OAuth grant. */
export class GoogleDaily {
  constructor(private provider: GoogleProvider, private store: GoogleStore, private assert: (...keys: PermissionKey[]) => Promise<void>, private now = () => new Date(), private reader = new GoogleContentReader(provider, store, now)) {}
  async read(state: WorkspaceState, payload: Record<string, unknown>, grant: string, connected = true, accountIdentity = grant): Promise<DailySnapshot> {
    const bounds = dayBounds(payload.date ?? state.today, state.settings.timezone);
    const query = payload.gmailQuery === undefined ? state.dailyConfig?.gmailQuery ?? 'newer_than:1d' : text(payload.gmailQuery, 'gmailQuery', 1000);
    const calendarId = payload.calendarId === undefined ? state.dailyConfig?.calendarId ?? 'primary' : text(payload.calendarId, 'calendarId', 512);
    const selected: string[] = [];
    if (connected && !state.permissions.gmailFull) for (const draft of state.drafts) if (draft.mode === 'live' && draft.threadId && await this.store.get(`binding:draft:${draft.id}`)) if (!selected.includes(draft.threadId)) selected.push(draft.threadId);
    const driveSelected: Resource[] = [];
    if (connected) for (const resource of state.resources) if (resource.bound && resource.mode === 'live' && resource.providerId && await this.store.get(`binding:resource:${resource.id}`)) driveSelected.push(resource);
    const account = fingerprint(accountIdentity).slice(0, 16);
    const key = `daily:v2:${fingerprint({ date: bounds.date, timezone: bounds.timezone, query, calendarId, selected, driveSelected: driveSelected.map(item => [item.id, item.tabId, item.namedRangeId]), full: state.permissions.gmailFull })}`;
    const now = this.now().toISOString();
    let record = connected ? await this.store.get<DailyRecord>(key) : undefined;
    if (!record) record = { snapshot: { id: `daily-${fingerprint({ key, grant })}`, date: bounds.date, timezone: bounds.timezone, createdAt: now, updatedAt: now, mode: 'live', sources: [], providers: [], taskIds: [], receiptIds: [], summary: '' }, gmail: { index: 0, complete: false, seen: [] }, calendar: { index: 0, complete: false, seen: [] }, events: [] };
    if (state.daily?.id === record.snapshot.id) { record.snapshot.taskIds = state.daily.taskIds; record.snapshot.receiptIds = state.daily.receiptIds; }
    for (const provider of ['gmail', 'calendar'] as const) {
      const cursor = record[provider];
      let status = record.snapshot.providers.find(item => item.provider === provider);
      if (!status) { status = { provider, status: 'idle', discovered: 0, read: 0, skipped: 0, failed: 0 }; record.snapshot.providers.push(status); }
      status.coverage = provider === 'gmail' && !state.permissions.gmailFull ? 'selected' : 'all';
      status.query = provider === 'gmail' ? state.permissions.gmailFull ? query : 'Explicitly linked Gmail threads' : `${calendarId}: ${bounds.start} to ${bounds.end}`;
      if (!connected) { status.status = 'not_connected'; status.error = 'Connect the separate Google server OAuth integration to read this source.'; record.snapshot.sources = record.snapshot.sources.filter(item => item.provider !== provider); continue; }
      const required: PermissionKey[] = provider === 'gmail' ? ['gmailRead', ...(state.permissions.gmailFull ? ['gmailFull' as const] : [])] : ['calendarRead'];
      try { await this.assert(...required); await this.provider.transport.authorize([provider === 'gmail' ? SCOPES.gmailRead : SCOPES.calendarRead]); }
      catch (error) { status.status = 'not_enabled'; status.error = message(error); record.snapshot.sources = record.snapshot.sources.filter(item => item.provider !== provider); continue; }
      if (provider === 'gmail' && !state.permissions.gmailFull && !selected.length) { status.status = 'idle'; status.error = 'Link a Gmail thread explicitly, or enable full mailbox reads. No mailbox enumeration occurred.'; continue; }
      if (cursor.complete) {
        cursor.complete = false; cursor.pageToken = undefined; cursor.index = 0; cursor.seen = [];
        if (provider === 'calendar') { cursor.syncToken = cursor.nextSyncToken; cursor.nextSyncToken = undefined; }
        if (provider === 'calendar' && !cursor.syncToken) record.events = [];
        status.discovered = 0; status.read = 0; status.skipped = 0; status.failed = 0;
      }
      if (cursor.retry) { status.failed = Math.max(0, status.failed - 1); cursor.retry = false; }
      status.status = 'running'; delete status.error;
      const before = structuredClone(record);
      try {
        if (provider === 'gmail') {
          const items = state.permissions.gmailFull ? await this.provider.listMessages(cursor.pageToken, query) : undefined;
          const messages = items ? items.items : await this.provider.getThread(selected[cursor.index]);
          for (const item of messages) {
            await this.assert(...required); status.discovered++;
            try {
              const value = await this.provider.getMessage(item.id);
              const body = await readMailText(this.provider, value);
              const source: DailySource = { id: `google:gmail:${account}:${value.id}`, provider: 'gmail', externalId: value.id, title: mailTitle(value), text: body.text, url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(value.threadId)}`, readAt: now, version: value.historyId ?? fingerprint(body.text), truncated: body.truncated };
              if (this.source(record.snapshot, source)) { status.read++; cursor.seen.push(source.id); if (source.truncated) status.error = 'Some Gmail body text was truncated at the configured extraction bound.'; }
              else { status.skipped++; status.error = 'Daily snapshot reached its source/text bound. Narrow the Gmail query to read the remaining content.'; }
            } catch (error) {
              if (error instanceof GoogleIntegrationError && ['PERMISSION_DENIED', 'GOOGLE_SCOPE_REQUIRED', 'GOOGLE_GRANT_CHANGED', 'GOOGLE_REAUTH_REQUIRED'].includes(error.code)) throw error;
              status.failed++; status.error = message(error);
            }
          }
          if (items) { cursor.pageToken = items.nextPageToken; cursor.complete = !items.nextPageToken; }
          else { cursor.index++; cursor.complete = cursor.index >= selected.length; }
          if (cursor.complete) record.snapshot.sources = record.snapshot.sources.filter(source => source.provider !== 'gmail' || cursor.seen.includes(source.id));
        } else {
          const page = await this.provider.listEvents(calendarId, bounds.start, bounds.end, cursor.pageToken, cursor.syncToken, bounds.timezone);
          for (const event of page.items) {
            await this.assert(...required); status.discovered++;
            const existing = record.events.findIndex(item => item.id === event.id);
            if (event.status === 'cancelled' || !eventOverlaps(event, bounds.start, bounds.end, bounds.timezone)) { record.events = record.events.filter(item => item.id !== event.id); status.skipped++; continue; }
            if (!event.id || event.id.length > 1024 || !event.start || !event.end) { status.failed++; status.error = 'Google returned an event without a stable ID or interval.'; continue; }
            if (existing < 0 && record.events.length >= DAILY_CACHE_LIMITS.events) { status.skipped++; status.error = 'Calendar cache reached 500 events for this day. Coverage remains partial; choose a smaller calendar or review Google Calendar directly.'; continue; }
            const cached = boundedEvent(event);
            const used = record.events.reduce((sum, item) => sum + eventText(item).length, 0) - (existing >= 0 ? eventText(record.events[existing]).length : 0);
            if (used + eventText(cached).length > DAILY_CACHE_LIMITS.calendarChars) { status.skipped++; status.error = 'Calendar cache reached its text bound. Coverage remains partial.'; continue; }
            if (existing >= 0) record.events[existing] = cached; else record.events.push(cached);
            if (cached.truncated) status.error = 'Some Calendar event content was truncated at the configured extraction bound.';
            status.read++;
          }
          cursor.pageToken = page.nextPageToken; cursor.complete = !page.nextPageToken;
          if (cursor.complete && !status.error && !status.failed) cursor.nextSyncToken = page.checkpoint;
          const previousSources = new Map(record.snapshot.sources.filter(source => source.provider === 'calendar').map(source => [source.id, source]));
          record.snapshot.sources = record.snapshot.sources.filter(source => source.provider !== 'calendar');
          for (const event of record.events.filter(item => eventOverlaps(item, bounds.start, bounds.end, bounds.timezone))) {
            const value = eventText(event);
            if (!this.source(record.snapshot, { id: `google:calendar:${account}:${calendarId}:${event.id}`, provider: 'calendar', externalId: event.id, title: event.summary ?? '(Untitled event)', text: value.slice(0, 40_000), url: event.htmlLink, readAt: previousSources.get(`google:calendar:${account}:${calendarId}:${event.id}`)?.version === event.updated ? previousSources.get(`google:calendar:${account}:${calendarId}:${event.id}`)!.readAt : now, version: event.updated ?? fingerprint(value), truncated: event.truncated || value.length > 40_000 })) { status.skipped++; status.error = 'Daily snapshot reached its source/text bound. Calendar content is partial.'; }
          }
        }
        status.status = cursor.complete && !status.failed && !status.error ? 'complete' : 'partial';
        status.lastReadAt = now;
      } catch (error) {
        // Page/cursor effects are atomic. The other provider remains independent.
        Object.assign(record, before);
        const failed = record.snapshot.providers.find(item => item.provider === provider)!;
        failed.status = failed.read ? 'partial' : 'failed'; failed.failed++; failed.error = message(error);
        record[provider].retry = true;
        if (provider === 'calendar' && error instanceof GoogleHttpError && error.status === 410) {
          record.calendar = { index: 0, complete: false, seen: [], retry: true }; record.events = [];
          failed.read = 0; failed.discovered = 0; failed.skipped = 0; failed.failed = 1;
          record.snapshot.sources = record.snapshot.sources.filter(source => source.provider !== 'calendar');
          failed.error = 'Calendar sync token expired. Resume performs a fresh bounded day read.';
        }
      }
      record.snapshot.updatedAt = now;
      await this.save(key, record);
    }
    await this.readDrive(record, driveSelected, account, connected);
    record.snapshot.updatedAt = now;
    record.snapshot.summary = record.snapshot.providers.map(provider => `${provider.provider}: ${provider.status}, ${provider.read} content reads, ${provider.skipped} skipped, ${provider.failed} failed`).join('; ') + '. No model interpretation was performed.';
    if (connected) await this.save(key, record);
    state.daily = structuredClone(record.snapshot);
    if (connected && state.permissions.calendarRead) {
      try {
        await this.assert('calendarRead');
        await this.provider.transport.authorize([SCOPES.calendarRead]);
        const calendar = record.snapshot.providers.find(provider => provider.provider === 'calendar');
        if (calendar?.lastReadAt) {
          const ids = await mergeDailyEvents(state, record.events, calendarId, bounds, account, this.store, calendar.status === 'complete');
          for (const id of ids) await this.store.set(`binding:event:${id}`, true);
        }
      } catch (error) { if (!(error instanceof GoogleIntegrationError && ['PERMISSION_DENIED', 'GOOGLE_SCOPE_REQUIRED', 'GOOGLE_REAUTH_REQUIRED'].includes(error.code))) throw error; }
    }
    return state.daily;
  }
  private async readDrive(record: DailyRecord, selected: Resource[], account: string, connected: boolean): Promise<void> {
    let status = record.snapshot.providers.find(item => item.provider === 'drive');
    if (!status) { status = { provider: 'drive', status: 'idle', discovered: 0, read: 0, skipped: 0, failed: 0, coverage: 'selected', query: 'Explicitly bound files and folder descendants' }; record.snapshot.providers.push(status); }
    if (!connected) { status.status = 'not_connected'; record.snapshot.sources = record.snapshot.sources.filter(item => item.provider !== 'drive'); return; }
    try { await this.assert('driveRead'); await this.provider.transport.authorize([SCOPES.driveRead]); }
    catch (error) { status.status = 'not_enabled'; status.error = message(error); record.snapshot.sources = record.snapshot.sources.filter(item => item.provider !== 'drive'); return; }
    if (!selected.length) { status.status = 'idle'; status.error = 'Bind a Drive file or folder to include its content. No broad Drive enumeration occurred.'; return; }
    if (!record.drive || record.drive.complete) { record.drive = { queue: selected.map(resource => ({ resource })), seen: [], complete: false }; Object.assign(status, { discovered: 0, read: 0, skipped: 0, failed: 0 }); }
    const cursor = record.drive; const before = structuredClone(cursor); const snapshotBefore = structuredClone(record.snapshot);
    delete status.error; status.status = 'running';
    try {
      // One folder page OR one file body per call. Folder descendants inherit only that explicit selection.
      const item = cursor.queue[0];
      if (item.resource.kind === 'folder') {
        const page = await this.provider.browse(item.resource.providerId, undefined, item.pageToken);
        if (page.nextPageToken) item.pageToken = page.nextPageToken; else cursor.queue.shift();
        for (const file of page.items) {
          if (cursor.seen.includes(file.id)) continue;
          if (cursor.seen.length >= 2000 || cursor.queue.length >= 2000) throw new GoogleIntegrationError('DAILY_DRIVE_LIMIT', 'Selected folder exceeded the 2,000-file checkpoint bound. Select a smaller folder.');
          cursor.seen.push(file.id); cursor.queue.push({ resource: driveResource(file, this.now()) }); status.discovered++;
        }
      } else {
        await this.assert('driveRead');
        const result = await this.reader.read(item.resource, { maxChars: 40_000, maxBytes: 5 * 1024 * 1024 });
        if (!this.source(record.snapshot, { id: `google:drive:${account}:${item.resource.providerId}:${item.resource.tabId ?? ''}:${item.resource.namedRangeId ?? ''}`, provider: 'drive', externalId: item.resource.providerId, resourceId: item.resource.id, title: result.name, text: result.text, url: result.url, version: result.contentHash, readAt: this.now().toISOString(), truncated: result.truncated })) throw new GoogleIntegrationError('DAILY_DRIVE_LIMIT', 'Daily content bound reached. Select fewer files.');
        cursor.queue.shift(); status.read++; if (!cursor.seen.includes(item.resource.providerId!)) { cursor.seen.push(item.resource.providerId!); status.discovered++; }
        if (result.truncated) cursor.gaps = [...new Set([...(cursor.gaps ?? []), 'Selected Drive content was truncated at the extraction bound.'])];
      }
      status.lastReadAt = this.now().toISOString(); status.failed = 0; cursor.complete = !cursor.queue.length;
      if (cursor.gaps?.length) status.error = cursor.gaps.join(' ');
      status.status = cursor.complete && !status.error ? 'complete' : 'partial';
    } catch (error) {
      record.drive = before; record.snapshot = snapshotBefore;
      status = record.snapshot.providers.find(item => item.provider === 'drive')!;
      status.status = status.read ? 'partial' : 'failed'; status.failed = 1; status.error = message(error);
    }
  }
  private async save(key: string, record: DailyRecord): Promise<void> {
    const prior = await this.store.get<string[]>('daily-record-index') ?? [];
    const keys = prior.filter(item => item !== key);
    while (keys.length >= DAILY_CACHE_LIMITS.records) { const oldest = keys.shift()!; await this.store.delete(oldest); }
    await this.store.set(key, record);
    await this.store.set('daily-record-index', [...keys, key]);
  }
  private source(snapshot: DailySnapshot, source: DailySource): boolean {
    const index = snapshot.sources.findIndex(item => item.id === source.id);
    const available = MAX_TEXT - snapshot.sources.reduce((sum, item) => sum + item.text.length, 0) + (index >= 0 ? snapshot.sources[index].text.length : 0);
    if (available <= 0 || index < 0 && snapshot.sources.length >= MAX_SOURCES) return false;
    if (source.text.length > available) { source.text = source.text.slice(0, available); source.truncated = true; }
    if (index >= 0) snapshot.sources[index] = source; else snapshot.sources.push(source);
    return true;
  }
}
export function dayBounds(value: unknown, timezone: string) {
  const date = text(value, 'date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new GoogleIntegrationError('INVALID_DATE', 'Daily date must be YYYY-MM-DD.');
  const start = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  if (!start.isValid || start.toISODate() !== date) throw new GoogleIntegrationError('INVALID_TIMEZONE_OR_DATE', 'Choose a valid workspace timezone and date.');
  return { date, timezone, start: start.toISO()!, end: start.plus({ days: 1 }).toISO()! };
}
function eventOverlaps(event: GoogleEvent, start: string, end: string, zone: string): boolean {
  const first = event.start?.dateTime ?? event.start?.date; const last = event.end?.dateTime ?? event.end?.date;
  if (!first || !last) return false;
  return DateTime.fromISO(first, { zone }).toMillis() < Date.parse(end) && DateTime.fromISO(last, { zone }).toMillis() > Date.parse(start);
}
async function mergeDailyEvents(state: WorkspaceState, events: GoogleEvent[], calendarId: string, bounds: ReturnType<typeof dayBounds>, account: string, store: GoogleStore, complete: boolean) {
  const relevant = events.filter(event => eventOverlaps(event, bounds.start, bounds.end, bounds.timezone));
  const sourcePrefix = `google:calendar:${account}:${calendarId}:`;
  const ids: string[] = [];
  if (complete) state.events = state.events.filter(event => !(event.calendarId === calendarId && event.sourceIds.some(id => id.startsWith(sourcePrefix)) && DateTime.fromISO(event.start, { zone: bounds.timezone }).toMillis() < Date.parse(bounds.end) && DateTime.fromISO(event.end, { zone: bounds.timezone }).toMillis() > Date.parse(bounds.start) && !relevant.some(item => item.id === event.externalId)));
  for (const item of relevant) {
    let existing: WorkspaceState['events'][number] | undefined;
    for (const candidate of state.events.filter(event => event.externalId === item.id && event.calendarId === calendarId)) if (await store.get(`binding:event:${candidate.id}`)) { existing = candidate; break; }
    const event = { id: existing?.id ?? `${sourcePrefix}${item.id}`, externalId: item.id, title: item.summary ?? '(Untitled)', start: item.start?.dateTime ?? item.start?.date ?? '', end: item.end?.dateTime ?? item.end?.date ?? '', location: item.location, calendarId, status: item.status === 'tentative' ? 'tentative' as const : 'confirmed' as const, sourceIds: [...new Set([...(existing?.sourceIds ?? []), `${sourcePrefix}${item.id}`])] };
    if (existing) Object.assign(existing, event); else { const index = state.events.findIndex(candidate => candidate.id === event.id); if (index >= 0) state.events[index] = event; else state.events.push(event); }
    ids.push(event.id);
  }
  return ids;
}
function message(error: unknown): string { return error instanceof GoogleIntegrationError ? error.message : 'Google content read failed. Resume from the saved provider checkpoint.'; }

function eventText(event: GoogleEvent): string {
  return `${event.summary ?? '(Untitled event)'}\nStart: ${event.start?.dateTime ?? event.start?.date}\nEnd: ${event.end?.dateTime ?? event.end?.date}${event.location ? `\nLocation: ${event.location}` : ''}${event.description ? `\n${htmlToText(event.description)}` : ''}`;
}
function boundedEvent(event: GoogleEvent): CachedEvent {
  const description = htmlToText(event.description ?? '');
  const cached: CachedEvent = { id: event.id, summary: event.summary?.slice(0, 1000), status: event.status, location: event.location?.slice(0, 1000), description: description.slice(0, DAILY_CACHE_LIMITS.eventChars - 2500), updated: event.updated?.slice(0, 100), htmlLink: event.htmlLink?.slice(0, 2048), start: { dateTime: event.start?.dateTime?.slice(0, 100), date: event.start?.date?.slice(0, 10) }, end: { dateTime: event.end?.dateTime?.slice(0, 100), date: event.end?.date?.slice(0, 10) } };
  cached.truncated = description.length > DAILY_CACHE_LIMITS.eventChars - 2500 || (event.summary?.length ?? 0) > 1000 || (event.location?.length ?? 0) > 1000;
  return cached;
}
