import type { Resource } from '../types';
import type { DriveFile, DriveReference, GmailMessage, GoogleDocument, GoogleDocumentTab, GoogleEvent, GoogleStore, Page } from './contracts';
import { SCOPES } from './oauth';
import { GoogleIntegrationError, canonicalDriveUrl, identifier, mimeMessage, stableResourceId } from './security';
import type { RecipeEditPlan } from './template';
import { GoogleTransport, apiUrl } from './transport';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars';
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,parents,trashed,shortcutDetails';
export class GoogleProvider {
  cacheHits = 0;
  constructor(readonly transport: GoogleTransport, private store: GoogleStore, private now = () => new Date()) {}
  async getFile(id: string, fresh = false): Promise<DriveFile> {
    identifier(id);
    await this.transport.authorize([SCOPES.driveRead]);
    const key = `file:${id}`;
    const cached = await this.store.get<{ expiresAt: number; file: DriveFile }>(key);
    if (!fresh && cached && cached.expiresAt > this.now().getTime()) { this.cacheHits++; return cached.file; }
    const file = await this.transport.request<DriveFile>(apiUrl(`${DRIVE}/files/${encodeURIComponent(id)}`, { fields: FILE_FIELDS, supportsAllDrives: true }), [SCOPES.driveRead]);
    if (!file.id || file.trashed) throw new GoogleIntegrationError('RESOURCE_UNAVAILABLE', 'Google resource is missing or trashed.', 404);
    await this.store.set(key, { expiresAt: this.now().getTime() + 60_000, file });
    return file;
  }
  async browse(parentId?: string, query?: string, pageToken?: string): Promise<Page<DriveFile>> {
    const clauses = ['trashed = false'];
    if (parentId) clauses.push(`'${identifier(parentId)}' in parents`);
    if (query) clauses.push(`name contains '${query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
    const result = await this.transport.request<{ files?: DriveFile[]; nextPageToken?: string }>(apiUrl(`${DRIVE}/files`, { q: clauses.join(' and '), pageToken, pageSize: 100, fields: `nextPageToken,files(${FILE_FIELDS})`, supportsAllDrives: true, includeItemsFromAllDrives: true }), [SCOPES.driveRead]);
    return { items: result.files ?? [], nextPageToken: result.nextPageToken };
  }
  async driveCheckpoint(): Promise<string> {
    const result = await this.transport.request<{ startPageToken: string }>(apiUrl(`${DRIVE}/changes/startPageToken`, { supportsAllDrives: true }), [SCOPES.driveRead]);
    return result.startPageToken;
  }
  async driveChanges(pageToken: string): Promise<Page<{ fileId: string; removed?: boolean; file?: DriveFile }>> {
    const result = await this.transport.request<{ changes?: { fileId: string; removed?: boolean; file?: DriveFile }[]; nextPageToken?: string; newStartPageToken?: string }>(apiUrl(`${DRIVE}/changes`, { pageToken, pageSize: 100, fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`, supportsAllDrives: true, includeItemsFromAllDrives: true }), [SCOPES.driveRead]);
    return { items: result.changes ?? [], nextPageToken: result.nextPageToken, checkpoint: result.newStartPageToken };
  }
  async listMessages(pageToken?: string): Promise<Page<{ id: string; threadId: string }>> {
    const result = await this.transport.request<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(apiUrl(`${GMAIL}/messages`, { maxResults: 50, pageToken }), [SCOPES.gmailRead]);
    return { items: result.messages ?? [], nextPageToken: result.nextPageToken };
  }
  async getMessage(id: string, fresh = false): Promise<GmailMessage> {
    identifier(id);
    await this.transport.authorize([SCOPES.gmailRead]);
    const cached = await this.store.get<GmailMessage>(`gmail:${id}`);
    if (cached && !fresh) { this.cacheHits++; return cached; }
    const message = await this.transport.request<GmailMessage>(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, [SCOPES.gmailRead]);
    await this.store.set(`gmail:${id}`, message);
    return message;
  }
  async getThread(id: string): Promise<GmailMessage[]> {
    const result = await this.transport.request<{ messages?: GmailMessage[] }>(`${GMAIL}/threads/${encodeURIComponent(identifier(id))}?format=full`, [SCOPES.gmailRead]);
    for (const message of result.messages ?? []) await this.store.set(`gmail:${message.id}`, message);
    return result.messages ?? [];
  }
  async gmailCheckpoint(): Promise<string> {
    const profile = await this.transport.request<{ historyId: string }>(`${GMAIL}/profile`, [SCOPES.gmailRead]);
    return profile.historyId;
  }
  async gmailChanges(historyId: string, pageToken?: string): Promise<Page<{ id: string; deleted: boolean }>> {
    const result = await this.transport.request<{ history?: { messagesAdded?: { message: { id: string } }[]; messagesDeleted?: { message: { id: string } }[]; labelsAdded?: { message: { id: string } }[]; labelsRemoved?: { message: { id: string } }[] }[]; nextPageToken?: string; historyId?: string }>(apiUrl(`${GMAIL}/history`, { startHistoryId: historyId, pageToken, maxResults: 50 }), [SCOPES.gmailRead]);
    const changed = new Map<string, boolean>();
    for (const item of result.history ?? []) {
      for (const entry of [...(item.messagesAdded ?? []), ...(item.labelsAdded ?? []), ...(item.labelsRemoved ?? [])]) changed.set(entry.message.id, false);
      for (const entry of item.messagesDeleted ?? []) changed.set(entry.message.id, true);
    }
    return { items: [...changed].map(([id, deleted]) => ({ id, deleted })), nextPageToken: result.nextPageToken, checkpoint: result.historyId };
  }
  async createDraft(input: { to: string; subject: string; body: string; threadId?: string; messageId: string }): Promise<string> {
    const result = await this.transport.request<{ id: string }>(`${GMAIL}/drafts`, [SCOPES.draft], { method: 'POST', body: { message: { raw: mimeMessage(input.to, input.subject, input.body, input.messageId), ...(input.threadId ? { threadId: identifier(input.threadId) } : {}) } } });
    return requiredExternalId(result.id);
  }
  async updateDraft(id: string, input: { to: string; subject: string; body: string; threadId?: string; messageId: string }): Promise<string> {
    const result = await this.transport.request<{ id: string }>(`${GMAIL}/drafts/${encodeURIComponent(identifier(id))}`, [SCOPES.draft], { method: 'PUT', body: { id, message: { raw: mimeMessage(input.to, input.subject, input.body, input.messageId), ...(input.threadId ? { threadId: identifier(input.threadId) } : {}) } } });
    return requiredExternalId(result.id);
  }
  async sendDraft(id: string, input: { to: string; subject: string; body: string; threadId?: string; messageId: string }): Promise<string> {
    const result = await this.transport.request<{ id: string }>(`${GMAIL}/drafts/send`, [SCOPES.draft, SCOPES.send], { method: 'POST', body: { id: identifier(id), message: { raw: mimeMessage(input.to, input.subject, input.body, input.messageId), ...(input.threadId ? { threadId: identifier(input.threadId) } : {}) } } });
    return requiredExternalId(result.id);
  }
  async sendMessage(input: { to: string; subject: string; body: string; messageId: string }): Promise<string> {
    const result = await this.transport.request<{ id: string }>(`${GMAIL}/messages/send`, [SCOPES.send], { method: 'POST', body: { raw: mimeMessage(input.to, input.subject, input.body, input.messageId) } });
    return requiredExternalId(result.id);
  }
  async listEvents(calendarId: string, timeMin: string, timeMax: string, pageToken?: string): Promise<Page<GoogleEvent>> {
    const result = await this.transport.request<{ items?: GoogleEvent[]; nextPageToken?: string }>(apiUrl(`${CALENDAR}/${encodeURIComponent(calendarId)}/events`, { timeMin, timeMax, pageToken, maxResults: 100, singleEvents: true, orderBy: 'startTime' }), [SCOPES.calendarWrite]);
    return { items: result.items ?? [], nextPageToken: result.nextPageToken };
  }
  async upsertEvent(calendarId: string, id: string, event: Omit<GoogleEvent, 'id'>, exists: boolean): Promise<string> {
    const base = `${CALENDAR}/${encodeURIComponent(calendarId)}/events`;
    const result = await this.transport.request<GoogleEvent>(apiUrl(exists ? `${base}/${encodeURIComponent(id)}` : base, { sendUpdates: 'none' }), [SCOPES.calendarWrite], { method: exists ? 'PATCH' : 'POST', body: exists ? event : { id, ...event } });
    return requiredExternalId(result.id);
  }
  async copyDocument(sourceId: string, destinationFolderId: string, title: string, runKey: string): Promise<string> {
    const result = await this.transport.request<{ id: string }>(apiUrl(`${DRIVE}/files/${encodeURIComponent(identifier(sourceId))}/copy`, { supportsAllDrives: true, fields: 'id', copyComments: false, ignoreDefaultVisibility: true }), [SCOPES.driveRead, SCOPES.driveWrite, SCOPES.docsWrite], { method: 'POST', body: { name: title, parents: [identifier(destinationFolderId)], appProperties: { proletariatRecipeRun: runKey } } });
    const id = requiredExternalId(result.id);
    if (id === sourceId) throw new GoogleIntegrationError('GOOGLE_WRITE_UNKNOWN', 'Google did not confirm a distinct copied document. The reference will not be edited.', 502);
    return id;
  }
  async applyRecipeEdits(outputId: string, referenceId: string, plan: RecipeEditPlan): Promise<string> {
    if (outputId === referenceId) throw new GoogleIntegrationError('RECIPE_SOURCE_WRITE_DENIED', 'A recipe can only edit its new copy, never the reference document.', 403);
    await this.transport.request(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(identifier(outputId))}:batchUpdate`, [SCOPES.docsWrite, SCOPES.driveWrite], { method: 'POST', body: { writeControl: { requiredRevisionId: plan.revisionId }, requests: plan.requests } });
    return outputId;
  }
  async getDocument(id: string): Promise<GoogleDocument> {
    return this.transport.request<GoogleDocument>(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(identifier(id))}?includeTabsContent=true`, [SCOPES.docsWrite]);
  }
  async writeManagedRange(reference: DriveReference, content: string): Promise<string> {
    if (!reference.namedRangeId) throw new GoogleIntegrationError('MANAGED_RANGE_REQUIRED', 'Bind a managed named range before writing to this document.');
    const document = await this.getDocument(reference.fileId);
    if (!document.revisionId) throw new GoogleIntegrationError('DOCUMENT_REVISION_REQUIRED', 'Google did not return a revision for a safe document write.', 409);
    const tabs = flattenTabs(document.tabs ?? []);
    if (tabs.length > 1 && !reference.tabId) throw new GoogleIntegrationError('DOCUMENT_TAB_AMBIGUOUS', 'Select the document tab before writing.', 409);
    const tab = reference.tabId ? tabs.find(item => item.tabProperties?.tabId === reference.tabId) : tabs[0];
    if (reference.tabId && !tab) throw new GoogleIntegrationError('DOCUMENT_TAB_MISSING', 'The bound document tab no longer exists.', 409);
    const ranges = tab?.documentTab?.namedRanges ?? document.namedRanges ?? {};
    if (!Object.values(ranges).some(group => group.namedRanges?.some(range => range.namedRangeId === reference.namedRangeId))) throw new GoogleIntegrationError('MANAGED_RANGE_MISSING', 'The bound managed range no longer exists in the selected tab.', 409);
    const tabId = tab?.tabProperties?.tabId;
    await this.transport.request(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(reference.fileId)}:batchUpdate`, [SCOPES.docsWrite], { method: 'POST', body: { writeControl: { requiredRevisionId: document.revisionId }, requests: [{ replaceNamedRangeContent: { namedRangeId: reference.namedRangeId, text: content, ...(tabId ? { tabsCriteria: { tabIds: [tabId] } } : {}) } }] } });
    return reference.fileId;
  }
}
export function driveResource(file: DriveFile, now: Date): Resource {
  const kind: Resource['kind'] = file.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : file.mimeType === 'application/vnd.google-apps.document' ? 'document' : file.mimeType === 'application/vnd.google-apps.spreadsheet' ? 'spreadsheet' : file.mimeType === 'application/pdf' ? 'pdf' : 'text';
  return { id: stableResourceId(file.id), providerId: file.id, name: file.name, kind, parentId: file.parents?.[0] ? stableResourceId(file.parents[0]) : undefined, url: canonicalDriveUrl(file.id, kind), modifiedAt: file.modifiedTime ?? now.toISOString(), bound: false, mode: 'live' };
}
function flattenTabs(tabs: GoogleDocumentTab[]): GoogleDocumentTab[] { return tabs.flatMap(tab => [tab, ...flattenTabs(tab.childTabs ?? [])]); }
function requiredExternalId(id: string | undefined): string { if (!id) throw new GoogleIntegrationError('GOOGLE_WRITE_UNKNOWN', 'Google response did not confirm the created resource identifier.', 502); return id; }
