import type { ActionRequest, ActionResult, Campaign, Connection, Draft, PermissionKey, Resource, Run, WorkspaceState } from '../types';
import type { GoogleDependencies, GoogleStore, OperationRecord } from './contracts';
import { GoogleContentReader } from './content';
import { GoogleDaily } from './daily';
import { GoogleOAuth } from './oauth';
import { GoogleProvider, driveResource } from './provider';
import { runGoogleRecipe } from './recipes';
import { GoogleScans, requireScan } from './scans';
import { GoogleHttpError, GoogleIntegrationError, canonicalDriveUrl, content, email, fingerprint, googleId, identifier, requireLive, requirePermissions, resolveDriveReference, text } from './security';
import { ScopedGoogleStore } from './storage';
import { GoogleTransport } from './transport';

export * from './contracts';
export { GoogleSignIn, signInConfigFromEnv } from './identity';
export type { VerifiedGoogleIdentity, GoogleIdentityVerifier, GoogleSignInConfig, GoogleSignInDependencies } from './identity';
export { GoogleIntegrationError, resolveDriveReference } from './security';
export { EncryptedFileTokenStore } from './storage';
export { SCOPES, scopesForPermissions, configFromEnv } from './oauth';

const GOOGLE_ACTIONS = new Set(['resource.browse', 'resource.bind', 'sync.run', 'scan.start', 'scan.pause', 'scan.resume', 'draft.create', 'draft.update', 'draft.send', 'campaign.start', 'campaign.resume', 'calendar.upsert', 'calendar.read', 'docs.write', 'recipe.run', 'daily.read', 'attachment.read']);
export function isGoogleAction(type: string): boolean { return GOOGLE_ACTIONS.has(type); }
let configured: GoogleIntegration | undefined;
let resolver: (()=>GoogleIntegration) | undefined;
export function configureGoogleIntegrationResolver(resolve:()=>GoogleIntegration) { resolver=resolve; }
export function configureGoogleIntegration(dependencies: GoogleDependencies): GoogleIntegration { resolver=undefined;configured = new GoogleIntegration(dependencies); return configured; }
export function getGoogleIntegration(): GoogleIntegration {
  if(resolver)return resolver();
  if (!configured) throw new GoogleIntegrationError('GOOGLE_NOT_CONFIGURED', 'Google server integration, encrypted token storage, and durable operation storage must be configured.', 503);
  return configured;
}
export async function getGoogleStatus(): Promise<Connection> { return resolver||configured ? getGoogleIntegration().oauth.status() : { provider: 'google', connected: false, configured: false, label: 'Google is not configured' }; }
export async function executeGoogleAction(state: WorkspaceState, action: ActionRequest): Promise<ActionResult> { return getGoogleIntegration().execute(state, action); }

/** Single-account server integration. Instantiate separately for each account in a multi-user deployment. */
export class GoogleIntegration {
  readonly oauth: GoogleOAuth;
  readonly provider: GoogleProvider;
  readonly store: GoogleStore;
  readonly transport: GoogleTransport;
  readonly contentReader: GoogleContentReader;
  private tail: Promise<unknown> = Promise.resolve();
  private now: () => Date;
  constructor(private deps: GoogleDependencies) {
    if (!deps.tokenStore || !deps.store?.reserveOperation || !deps.store?.finishOperation) throw new GoogleIntegrationError('GOOGLE_STORAGE_REQUIRED', 'Encrypted tokens and durable atomic operations are required.', 503);
    this.now = deps.now ?? (() => new Date());
    this.oauth = new GoogleOAuth(deps);
    this.transport = new GoogleTransport(this.oauth, deps);
    this.store = new ScopedGoogleStore(deps.store, async () => `grant:${await this.oauth.storageGrantId()}`);
    this.provider = new GoogleProvider(this.transport, this.store, this.now);
    this.contentReader = new GoogleContentReader(this.provider, this.store, this.now, deps.extractPdfText);
  }
  execute(state: WorkspaceState, action: ActionRequest): Promise<ActionResult> {
    const run = this.tail.then(async () => {
      requireLive(state);
      if (action.type === 'daily.read' && !(await this.oauth.status()).connected) return this.apply(state, action, false);
      const grant = await this.oauth.grantId();
      return this.oauth.withGrant(grant, () => this.apply(state, action));
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async assert(state: WorkspaceState, ...keys: PermissionKey[]): Promise<void> {
    requirePermissions(state.permissions, ...keys);
    if (this.deps.getPermissions) requirePermissions(await this.deps.getPermissions(), ...keys);
  }
  private requestId(action: ActionRequest): string { return text(action.requestId, 'requestId', 200); }
  private async operation(state: WorkspaceState, key: string, data: unknown, keys: PermissionKey[], write: () => Promise<string>): Promise<OperationRecord & { replayed?: boolean }> {
    if (!this.deps.getPermissions) throw new GoogleIntegrationError('GOOGLE_PERMISSION_READER_REQUIRED', 'Live writes require a callback that reads current persisted permissions.', 503);
    await this.assert(state, ...keys);
    const hash = fingerprint(data);
    const claim = await this.store.reserveOperation(key, hash);
    if (claim.record.fingerprint !== hash) throw new GoogleIntegrationError('IDEMPOTENCY_CONFLICT', 'This operation identifier was already used with different content.', 409);
    if (!claim.created) return { ...claim.record, replayed: true, ...(claim.record.status === 'pending' ? { status: 'unknown' as const, error: 'An earlier attempt has no confirmed result. Reconcile with Google before retrying.' } : {}) };
    let record: OperationRecord;
    try {
      await this.assert(state, ...keys);
      const externalId = await write();
      record = { fingerprint: hash, status: 'accepted', externalId };
    } catch (error) {
      const uncertain = error instanceof GoogleHttpError ? error.uncertain : !(error instanceof GoogleIntegrationError) || error.code === 'GOOGLE_WRITE_UNKNOWN';
      record = { fingerprint: hash, status: uncertain ? 'unknown' : 'failed', error: error instanceof GoogleIntegrationError ? error.message : 'Write outcome is not confirmed. Reconcile before retrying.' };
    }
    // If persistence fails after a write, the durable pending reservation remains. A retry becomes unknown, never a second send.
    await this.store.finishOperation(key, record);
    return record;
  }
  private async apply(state: WorkspaceState, action: ActionRequest, connected = true): Promise<ActionResult> {
    requireLive(state);
    if (!isGoogleAction(action.type)) throw new GoogleIntegrationError('UNSUPPORTED_GOOGLE_ACTION', `Unsupported Google action: ${action.type}`);
    const p = action.payload ?? {};
    const startedCalls = this.transport.apiCalls;
    const startedHits = this.provider.cacheHits;
    const now = this.now().toISOString();
    let entityId: string | undefined;
    let message = '';
    let status: Run['status'] = 'succeeded';
    let writes = 0;
    let receipt: Partial<Run> = {};
    const scans = new GoogleScans(this.provider, this.store, (...keys) => this.assert(state, ...keys), this.now, this.contentReader);
    switch (action.type) {
      case 'daily.read': {
        const daily = await new GoogleDaily(this.provider, this.store, (...keys) => this.assert(state, ...keys), this.now, this.contentReader).read(state, p, connected ? await this.oauth.storageGrantId() : 'disconnected', connected, connected ? await this.oauth.sourceAccountId() : 'disconnected');
        entityId = daily.id; message = daily.summary;
        status = daily.providers.some(item => item.status === 'failed') ? 'failed' : daily.providers.some(item => ['partial', 'running'].includes(item.status)) ? 'pending' : daily.providers.some(item => ['not_connected', 'not_enabled'].includes(item.status)) ? 'conflict' : 'succeeded';
        receipt.sourceIds = daily.sources.map(source => source.id);
        break;
      }
      case 'attachment.read': {
        await this.assert(state, 'driveRead');
        const resource = state.resources.find(item => item.id === p.resourceId);
        if (!resource || !resource.bound || resource.mode !== 'live' || !resource.providerId || resource.kind === 'folder') throw new GoogleIntegrationError('ATTACHMENT_RESOURCE_REQUIRED', 'Select one bound live Google file.');
        await this.requireBinding('resource', resource.id);
        const file = await this.provider.getFile(resource.providerId, true);
        const id = `attachment-${fingerprint({ grant: await this.oauth.storageGrantId(), resourceId: resource.id, tabId: resource.tabId, namedRangeId: resource.namedRangeId })}`;
        const attachment: NonNullable<WorkspaceState['attachments']>[number] = { id, origin: 'drive', resourceId: resource.id, name: file.name, mimeType: file.mimeType, byteSize: file.size ? Number(file.size) : undefined, url: resource.url, status: 'ready', createdAt: now, mode: 'live' };
        try {
          const result = await this.contentReader.read(resource, { maxChars: 40_000, maxBytes: 5 * 1024 * 1024 });
          attachment.content = result.text; attachment.truncated = result.truncated;
          message = `Read selected Google file content${result.truncated ? ' (bounded text is truncated)' : ''}. No model interpretation was performed.`;
        } catch (error) {
          if (error instanceof GoogleIntegrationError && ['PERMISSION_DENIED', 'GOOGLE_SCOPE_REQUIRED', 'GOOGLE_GRANT_CHANGED', 'GOOGLE_REAUTH_REQUIRED'].includes(error.code)) throw error;
          attachment.status = error instanceof GoogleIntegrationError && ['GOOGLE_CONTENT_TYPE_UNSUPPORTED', 'GOOGLE_PDF_PARSER_REQUIRED', 'GOOGLE_TEXT_ENCODING_UNSUPPORTED'].includes(error.code) ? 'unsupported' : 'failed';
          attachment.error = error instanceof GoogleIntegrationError ? error.message : 'Google attachment content could not be extracted.';
          status = 'failed'; message = attachment.error;
        }
        state.attachments ??= []; const existing = state.attachments.findIndex(item => item.id === id);
        if (existing >= 0) state.attachments[existing] = attachment; else state.attachments.push(attachment);
        entityId = id; receipt.sourceIds = [resource.id]; break;
      }
      case 'resource.browse': {
        await this.assert(state, 'driveRead');
        let parentId = typeof p.parentId === 'string' ? p.parentId : undefined;
        if (parentId) parentId = state.resources.find(item => item.id === parentId)?.providerId ?? parentId;
        const query = typeof p.q === 'string' && p.q.trim() ? text(p.q, 'q', 500) : undefined;
        const browseKey = `browse:${parentId ?? 'root'}:${query ?? ''}`;
        const pageToken = typeof p.pageToken === 'string' ? p.pageToken : p.nextPage === true ? await this.store.get<string>(browseKey) : undefined;
        if (p.nextPage === true && !pageToken) { message = 'No more Google Drive resources are available for this folder or search.'; break; }
        const page = await this.provider.browse(parentId, query, pageToken);
        for (const file of page.items) this.mergeResource(state, driveResource(file, this.now()));
        if (page.nextPageToken) await this.store.set(browseKey, page.nextPageToken); else await this.store.delete(browseKey);
        message = `Loaded ${page.items.length} Google Drive resources.${page.nextPageToken ? ' More results are available.' : ''}`;
        break;
      }
      case 'resource.bind': {
        await this.assert(state, 'driveRead');
        const existing = typeof p.id === 'string' ? state.resources.find(item => item.id === p.id) : undefined;
        if (existing?.mode === 'demo') throw new GoogleIntegrationError('MODE_MISMATCH', 'Synthetic resources cannot be bound as live Google resources.');
        const reference = typeof p.url === 'string' ? resolveDriveReference(p.url) : { fileId: existing?.providerId ?? identifier(p.id) };
        let file = await this.provider.getFile(reference.fileId, true);
        if (file.shortcutDetails?.targetId) file = await this.provider.getFile(file.shortcutDetails.targetId, true);
        const resource = driveResource(file, this.now());
        resource.tabId = typeof p.tabId === 'string' ? identifier(p.tabId, 'tabId') : reference.tabId ?? existing?.tabId;
        resource.namedRangeId = typeof p.namedRangeId === 'string' ? identifier(p.namedRangeId, 'namedRangeId') : reference.namedRangeId ?? existing?.namedRangeId;
        if (p.role !== undefined && !['reference', 'output'].includes(String(p.role))) throw new GoogleIntegrationError('INVALID_ROLE', 'Resource role must be reference or output.');
        resource.role = (p.role as Resource['role']) ?? existing?.role ?? 'reference';
        resource.bound = true;
        resource.url = canonicalDriveUrl(file.id, resource.kind, resource.tabId);
        this.mergeResource(state, resource, true);
        await this.store.set(`binding:resource:${resource.id}`, true);
        entityId = resource.id;
        message = 'Bound the verified Google resource by stable file ID.';
        break;
      }
      case 'scan.start':
      case 'sync.run': {
        if (!['gmail', 'drive'].includes(String(p.provider))) throw new GoogleIntegrationError('INVALID_PROVIDER', 'Choose gmail or drive.');
        const provider = p.provider as 'gmail' | 'drive';
        const coverage = action.type === 'sync.run' ? (state.permissions[provider === 'drive' ? 'driveFull' : 'gmailFull'] ? 'all' : 'selected') : p.coverage;
        if (coverage !== 'all' && coverage !== 'selected') throw new GoogleIntegrationError('INVALID_COVERAGE', 'Coverage must be selected or all.');
        const job = await scans.start(state, provider, coverage, action.type === 'sync.run', provider === 'gmail' && typeof p.query === 'string' ? text(p.query, 'query', 1000) : undefined);
        entityId = job.id;
        message = `${provider} ${coverage} coverage: ${job.read} ${provider === 'drive' ? 'file contents read' : 'message bodies read'}; ${job.status}. No model analysis was performed.`;
        break;
      }
      case 'scan.pause': {
        const job = requireScan(state, text(p.id, 'id'));
        if (job.status !== 'completed') job.status = 'paused';
        entityId = job.id; message = 'Scan paused at its saved page boundary.'; break;
      }
      case 'scan.resume': {
        const job = requireScan(state, text(p.id, 'id'));
        await scans.advance(state, job);
        entityId = job.id; message = `Scan ${job.status}: ${job.read} ${job.provider === 'drive' ? 'file contents read' : 'message bodies read'}; no model analysis performed.`; break;
      }
      case 'draft.create':
      case 'draft.update': {
        await this.assert(state, 'draft');
        const requestId = this.requestId(action);
        const existing = action.type === 'draft.update' ? state.drafts.find(item => item.id === p.id) : undefined;
        if (action.type === 'draft.update' && !existing) throw new GoogleIntegrationError('DRAFT_NOT_FOUND', 'Draft was not found.', 404);
        if (existing && (existing.mode !== 'live' || ['accepted', 'unknown', 'queued'].includes(existing.status))) throw new GoogleIntegrationError('DRAFT_NOT_EDITABLE', 'Only unsent live drafts with a known outcome can be edited.', 409);
        const draft: Draft = { id: existing?.id ?? `draft-${googleId(requestId)}`, to: email(p.to ?? existing?.to), subject: text(p.subject ?? existing?.subject, 'subject', 998), body: content(p.body ?? existing?.body, 'body'), threadId: typeof p.threadId === 'string' ? identifier(p.threadId, 'threadId') : existing?.threadId, status: 'draft', mode: 'live', updatedAt: now, externalId: existing?.externalId };
        if (existing && !existing.externalId) throw new GoogleIntegrationError('DRAFT_EXTERNAL_ID_MISSING', 'The Gmail draft identifier is missing. Reconcile its creation first.', 409);
        if (existing) await this.requireBinding('draft', existing.id);
        const input = { to: draft.to, subject: draft.subject, body: draft.body, threadId: draft.threadId, messageId: googleId(draft.id) };
        const result = await this.operation(state, `draft-write:${requestId}`, { ...input, id: draft.externalId }, ['draft'], () => existing ? this.provider.updateDraft(draft.externalId!, input) : this.provider.createDraft(input));
        if (result.status === 'accepted') { draft.externalId = result.externalId; if (!result.replayed) writes++; }
        else { draft.status = result.status === 'failed' ? 'failed' : 'unknown'; status = result.status === 'failed' ? 'failed' : 'unknown'; }
        const index = state.drafts.findIndex(item => item.id === draft.id);
        if (index >= 0) state.drafts[index] = draft; else state.drafts.unshift(draft);
        await this.store.set(`binding:draft:${draft.id}`, true);
        entityId = draft.id; message = result.status === 'accepted' ? 'Gmail draft saved.' : result.error ?? 'Draft outcome requires reconciliation.'; break;
      }
      case 'draft.send': {
        await this.assert(state, 'draft', 'send');
        const draft = state.drafts.find(item => item.id === p.id);
        if (!draft) throw new GoogleIntegrationError('DRAFT_NOT_FOUND', 'Draft was not found.', 404);
        await this.requireBinding('draft', draft.id);
        if (draft.mode !== 'live') throw new GoogleIntegrationError('MODE_MISMATCH', 'Synthetic drafts cannot send real mail.');
        if (draft.status === 'accepted') { entityId = draft.id; message = 'Google previously accepted this draft; it was not sent again.'; break; }
        if (draft.status === 'unknown' || draft.status === 'queued') { entityId = draft.id; status = 'unknown'; message = 'Draft outcome is unknown. Reconcile in Gmail before attempting another send.'; break; }
        if (!draft.externalId) throw new GoogleIntegrationError('DRAFT_EXTERNAL_ID_MISSING', 'Save a confirmed Gmail draft before sending.');
        const result = await this.operation(state, `draft-send:${draft.id}`, { externalId: draft.externalId, to: draft.to, subject: draft.subject, body: draft.body }, ['draft', 'send'], () => this.provider.sendDraft(draft.externalId!, { to: draft.to, subject: draft.subject, body: draft.body, threadId: draft.threadId, messageId: googleId(draft.id) }));
        draft.status = result.status === 'accepted' ? 'accepted' : result.status === 'failed' ? 'failed' : 'unknown';
        draft.updatedAt = now;
        entityId = draft.id; status = result.status === 'accepted' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'unknown';
        writes += result.status === 'accepted' && !result.replayed ? 1 : 0;
        message = result.status === 'accepted' ? 'Google accepted the message. Delivery is not guaranteed.' : result.error ?? 'Send outcome is unknown; reconcile before retrying.';
        break;
      }
      case 'campaign.start':
      case 'campaign.resume': {
        await this.assert(state, 'send', 'bulkSend');
        const campaign = state.campaigns.find(item => item.id === p.id);
        if (!campaign) throw new GoogleIntegrationError('CAMPAIGN_NOT_FOUND', 'Campaign was not found.', 404);
        const result = await this.dispatchCampaign(state, campaign);
        entityId = campaign.id; message = result.message; status = result.status; writes += result.writes; break;
      }
      case 'calendar.upsert': {
        await this.assert(state, 'calendarWrite');
        const requestId = this.requestId(action);
        const existing = typeof p.id === 'string' ? state.events.find(item => item.id === p.id) : undefined;
        if (p.id && !existing) throw new GoogleIntegrationError('EVENT_NOT_FOUND', 'Event was not found.', 404);
        if (existing && !existing.externalId) throw new GoogleIntegrationError('MODE_MISMATCH', 'A synthetic event cannot be updated in Google.');
        const calendarId = typeof p.calendarId === 'string' ? text(p.calendarId, 'calendarId', 512) : existing?.calendarId ?? 'primary';
        if (existing && calendarId !== existing.calendarId) throw new GoogleIntegrationError('CALENDAR_MOVE_UNSUPPORTED', 'Move an event in Google Calendar before changing its bound calendar.', 409);
        const title = text(p.title ?? existing?.title, 'title', 1000);
        const start = dateTime(p.start ?? existing?.start, 'start');
        const end = dateTime(p.end ?? existing?.end, 'end');
        if (Date.parse(end) <= Date.parse(start)) throw new GoogleIntegrationError('INVALID_EVENT_INTERVAL', 'Event end must be later than its start.');
        const externalId = existing?.externalId ?? googleId(requestId);
        const localId = existing?.id ?? `event-${googleId(requestId)}`;
        const location = typeof p.location === 'string' ? p.location.slice(0, 1000) : existing?.location;
        const data = { summary: title, start: { dateTime: start }, end: { dateTime: end }, ...(location ? { location } : {}), extendedProperties: { private: { proletariatId: localId } } };
        if (existing) await this.requireBinding('event', existing.id);
        const result = await this.operation(state, `calendar:${requestId}`, { calendarId, externalId, data }, ['calendarWrite'], () => this.provider.upsertEvent(calendarId, externalId, data, !!existing));
        if (result.status === 'accepted') {
          const event = { id: localId, externalId: result.externalId, title, start, end, calendarId, location, status: 'confirmed' as const, sourceIds: existing?.sourceIds ?? [] };
          if (existing) state.events[state.events.indexOf(existing)] = event; else if (!state.events.some(item => item.id === localId)) state.events.push(event);
          await this.store.set(`binding:event:${localId}`, true);
          if (!result.replayed) writes++; message = 'Google Calendar event saved without attendee notification emails.';
        } else { status = result.status === 'failed' ? 'failed' : 'unknown'; message = result.error ?? 'Calendar write needs reconciliation.'; }
        entityId = localId; break;
      }
      case 'calendar.read': {
        await this.assert(state, 'calendarRead');
        const calendarId = typeof p.calendarId === 'string' ? text(p.calendarId, 'calendarId', 512) : 'primary';
        const start = dateTime(p.start, 'start'); const end = dateTime(p.end, 'end');
        const page = await this.provider.listEvents(calendarId, start, end, typeof p.pageToken === 'string' ? p.pageToken : undefined);
        for (const item of page.items) {
          const existing = state.events.find(event => event.externalId === item.id && event.calendarId === calendarId);
          if (item.status === 'cancelled') { state.events = state.events.filter(event => event !== existing); continue; }
          const event = { id: existing?.id ?? `google:calendar:${calendarId}:${item.id}`, externalId: item.id, title: item.summary ?? '(Untitled)', start: item.start?.dateTime ?? item.start?.date ?? '', end: item.end?.dateTime ?? item.end?.date ?? '', location: item.location, calendarId, status: item.status === 'tentative' ? 'tentative' as const : 'confirmed' as const, sourceIds: existing?.sourceIds ?? [] };
          if (existing) Object.assign(existing, event); else state.events.push(event);
          await this.store.set(`binding:event:${event.id}`, true);
        }
        message = `Read ${page.items.length} Calendar events.${page.nextPageToken ? ' More pages are available through the provider read primitive.' : ''}`; break;
      }
      case 'recipe.run': {
        const result = await runGoogleRecipe(state, action, { provider: this.provider, store: this.store, now: this.now, assert: (...keys) => this.assert(state, ...keys), requireBinding: (kind, id) => this.requireBinding(kind, id), operation: (key, data, keys, write) => this.operation(state, key, data, keys, write) });
        entityId = result.entityId; message = result.message; status = result.status; writes = result.writes; receipt = result.receipt;
        break;
      }
      case 'docs.write': {
        await this.assert(state, 'docsWrite');
        const requestId = this.requestId(action);
        const resource = state.resources.find(item => item.id === p.resourceId);
        if (!resource || !resource.bound || resource.role !== 'output' || resource.kind !== 'document' || resource.mode !== 'live' || !resource.providerId) throw new GoogleIntegrationError('MANAGED_OUTPUT_REQUIRED', 'Choose a bound live Google document with output role.', 403);
        await this.requireBinding('resource', resource.id);
        const output = content(p.content, 'content');
        const reference = { fileId: resource.providerId, tabId: resource.tabId, namedRangeId: resource.namedRangeId };
        const result = await this.operation(state, `docs:${requestId}`, { reference, content: output }, ['docsWrite'], () => this.provider.writeManagedRange(reference, output));
        entityId = resource.id;
        if (result.status === 'accepted') { resource.modifiedAt = now; if (!result.replayed) writes++; message = 'Updated the managed named range; other document content was preserved.'; }
        else { status = result.status === 'failed' ? 'failed' : 'unknown'; message = result.error ?? 'Document write requires reconciliation.'; }
        break;
      }
    }
    const apiCalls = this.transport.apiCalls - startedCalls;
    const cacheHits = this.provider.cacheHits - startedHits;
    state.usage.apiCalls += apiCalls; state.usage.cacheHits += cacheHits;
    state.runs.unshift({ id: `google-run-${googleId(action.requestId ?? now, action.type, String(state.runs.length))}`, title: action.type, description: message, status, createdAt: now, mode: 'live', modelCalls: 0, tokens: 0, apiCalls, writes, cacheHits, sourceIds: entityId ? [entityId] : [], ...receipt });
    if (action.requestId && !state.processedKeys.includes(action.requestId)) state.processedKeys.push(action.requestId);
    return { state, message, entityId };
  }
  private async requireBinding(kind: string, id: string): Promise<void> {
    if (!await this.store.get(`binding:${kind}:${id}`)) throw new GoogleIntegrationError('GOOGLE_GRANT_CHANGED', 'This item belongs to a different or unverified Google connection. Rebind the resource, reread the event, or recreate the draft.', 409);
  }
  private mergeResource(state: WorkspaceState, resource: Resource, binding = false): void {
    const index = state.resources.findIndex(item => item.id === resource.id);
    if (index < 0) state.resources.push(resource);
    else if (binding) state.resources[index] = { ...state.resources[index], ...resource };
    else state.resources[index] = { ...state.resources[index], name: resource.name, modifiedAt: resource.modifiedAt, parentId: resource.parentId };
  }
  private async dispatchCampaign(state: WorkspaceState, campaign: Campaign): Promise<{ message: string; status: 'succeeded' | 'failed' | 'unknown'; writes: number }> {
    if (campaign.mode !== 'live') throw new GoogleIntegrationError('MODE_MISMATCH', 'Synthetic campaigns cannot send real mail.');
    if (['completed', 'cancelled'].includes(campaign.status)) throw new GoogleIntegrationError('CAMPAIGN_NOT_RUNNABLE', 'Completed or cancelled campaigns cannot run.');
    if (!Number.isFinite(campaign.ratePerMinute) || campaign.ratePerMinute < 1 || campaign.ratePerMinute > 60) throw new GoogleIntegrationError('INVALID_CAMPAIGN_RATE', 'Live campaign rate must be between 1 and 60 messages per minute.');
    if (campaign.scheduledAt && (!Number.isFinite(Date.parse(campaign.scheduledAt)) || Date.parse(campaign.scheduledAt) > this.now().getTime())) { campaign.status = 'scheduled'; return { message: 'Campaign is waiting for its scheduled time.', status: 'succeeded', writes: 0 }; }
    const duplicateEmails = new Set<string>();
    for (const recipient of campaign.recipients) {
      const address = email(recipient.email).toLowerCase();
      if (duplicateEmails.has(address)) { if (recipient.status === 'pending') recipient.status = 'excluded'; }
      duplicateEmails.add(address);
    }
    if (campaign.recipients.some(item => item.status === 'unknown')) { campaign.status = 'paused'; return { message: 'Campaign paused: reconcile unknown recipients in Gmail before continuing.', status: 'unknown', writes: 0 }; }
    const recipient = campaign.recipients.find(item => item.status === 'pending');
    if (!recipient) { campaign.status = 'completed'; return { message: 'Campaign completed. Accepted means Google accepted the message, not confirmed delivery.', status: 'succeeded', writes: 0 }; }
    const interval = Math.ceil(60_000 / campaign.ratePerMinute);
    const lastAttempt = await this.store.get<number>(`campaign-last:${campaign.id}`);
    if (lastAttempt !== undefined && this.now().getTime() - lastAttempt < interval) { campaign.status = 'running'; return { message: 'Campaign is waiting for its rate limit interval.', status: 'succeeded', writes: 0 }; }
    const slot = Math.floor(this.now().getTime() / interval);
    const slotClaim = await this.store.reserveOperation(`campaign-slot:${campaign.id}:${slot}`, String(slot));
    if (!slotClaim.created) { campaign.status = 'running'; return { message: 'A worker already reserved this campaign rate interval.', status: 'succeeded', writes: 0 }; }
    await this.store.set(`campaign-last:${campaign.id}`, this.now().getTime());
    const input = { to: recipient.email, subject: campaign.subject, body: campaign.body, messageId: googleId(campaign.id, recipient.id) };
    const result = await this.operation(state, `campaign-send:${campaign.id}:${recipient.id}`, input, ['send', 'bulkSend'], () => this.provider.sendMessage(input));
    recipient.status = result.status === 'accepted' ? 'accepted' : result.status === 'failed' ? 'failed' : 'unknown';
    recipient.externalId = result.externalId; recipient.error = result.error;
    campaign.status = recipient.status === 'unknown' ? 'paused' : campaign.recipients.some(item => item.status === 'pending') ? 'running' : 'completed';
    return { message: result.status === 'accepted' ? 'Google accepted one campaign message; the worker will resume at the configured rate.' : result.error ?? 'Campaign send needs reconciliation.', status: result.status === 'accepted' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'unknown', writes: result.status === 'accepted' && !result.replayed ? 1 : 0 };
  }
}
function dateTime(value: unknown, field: string): string {
  const result = text(value, field, 100);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) throw new GoogleIntegrationError('INVALID_DATETIME', `${field} must be an ISO timestamp with an explicit timezone offset.`);
  return result;
}
