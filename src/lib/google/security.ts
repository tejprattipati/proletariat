import { createHash } from 'node:crypto';
import type { PermissionKey, Permissions, WorkspaceState } from '../types';
import type { DriveReference } from './contracts';

export class GoogleIntegrationError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'GoogleIntegrationError'; }
}
export class GoogleHttpError extends GoogleIntegrationError {
  constructor(status: number, public uncertain = false) {
    super(status === 401 ? 'GOOGLE_REAUTH_REQUIRED' : status === 403 ? 'GOOGLE_SCOPE_OR_ACCESS_DENIED' : 'GOOGLE_API_ERROR',
      `Google returned HTTP ${status}. ${status === 401 ? 'Reconnect Google.' : status === 403 ? 'Check granted scopes and resource access.' : 'The operation did not return a confirmed success.'}`, status);
  }
}
export function requirePermissions(permissions: Permissions, ...keys: PermissionKey[]): void {
  const missing = keys.filter(key => permissions[key] !== true);
  if (missing.length) throw new GoogleIntegrationError('PERMISSION_DENIED', `Enable permission: ${missing.join(', ')}.`, 403);
}
export function requireLive(state: WorkspaceState): void {
  if (state.settings.mode !== 'live') throw new GoogleIntegrationError('LIVE_MODE_REQUIRED', 'Google actions require live mode. Demo actions belong to the synthetic domain adapter.');
}
export function text(value: unknown, field: string, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new GoogleIntegrationError('INVALID_INPUT', `${field} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
}
export function content(value: unknown, field: string, max = 1_000_000): string {
  if (typeof value !== 'string' || value.length > max) throw new GoogleIntegrationError('INVALID_INPUT', `${field} must be a string of at most ${max} characters.`);
  return value;
}
export function identifier(value: unknown, field = 'id'): string {
  const result = text(value, field, 512);
  if (!/^[a-zA-Z0-9_.:@-]+$/.test(result)) throw new GoogleIntegrationError('INVALID_ID', `${field} is invalid.`);
  return result;
}
export function email(value: unknown): string {
  const result = text(value, 'email', 254);
  if (!/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(result)) throw new GoogleIntegrationError('INVALID_EMAIL', 'Provide a single valid recipient email address.');
  return result;
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function googleId(...parts: string[]): string { return `p${fingerprint(parts).slice(0, 40)}`; }
export function stableResourceId(providerId: string): string { return `google:drive:${identifier(providerId)}`; }

/** Parse known Google links without fetching arbitrary user-controlled URLs. */
export function resolveDriveReference(input: string): DriveReference {
  let url: URL;
  try { url = new URL(input); } catch { throw new GoogleIntegrationError('INVALID_GOOGLE_URL', 'Provide a full Google Drive, Docs, or Sheets URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['drive.google.com', 'docs.google.com'].includes(url.hostname)) throw new GoogleIntegrationError('INVALID_GOOGLE_URL', 'Only HTTPS links on drive.google.com or docs.google.com are supported.');
  const match = url.pathname.match(/^\/(?:document|spreadsheets|presentation|file)\/(?:u\/\d+\/)?d\/([\w-]+)/) ?? url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/);
  const fileId = match?.[1] ?? (['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null);
  if (!fileId) throw new GoogleIntegrationError('INVALID_GOOGLE_URL', 'This link does not identify a supported Google file or folder.');
  const hash = new URLSearchParams(url.hash.slice(1));
  return { fileId: identifier(fileId), tabId: url.searchParams.get('tab') ?? hash.get('tab') ?? hash.get('gid') ?? url.searchParams.get('gid') ?? undefined, namedRangeId: url.searchParams.get('namedRangeId') ?? hash.get('namedRangeId') ?? undefined };
}
export function canonicalDriveUrl(fileId: string, kind: string, tabId?: string): string {
  const id = encodeURIComponent(identifier(fileId));
  if (kind === 'folder') return `https://drive.google.com/drive/folders/${id}`;
  if (kind === 'document') return `https://docs.google.com/document/d/${id}/edit${tabId ? `?tab=${encodeURIComponent(tabId)}` : ''}`;
  if (kind === 'spreadsheet') return `https://docs.google.com/spreadsheets/d/${id}/edit${tabId ? `#gid=${encodeURIComponent(tabId)}` : ''}`;
  return `https://drive.google.com/file/d/${id}/view`;
}
export function mimeMessage(to: string, subject: string, body: string, messageId?: string): string {
  const recipient = email(to);
  if (/\r|\n/.test(subject) || subject.length > 998) throw new GoogleIntegrationError('INVALID_HEADER', 'Subject must be one line, at most 998 characters.');
  if (body.length > 1_000_000) throw new GoogleIntegrationError('INVALID_INPUT', 'Message body exceeds one million characters.');
  const headers = [`To: ${recipient}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
  if (messageId) headers.push(`Message-ID: <${identifier(messageId)}@proletariat.invalid>`);
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${Buffer.from(body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''}\r\n`).toString('base64url');
}
