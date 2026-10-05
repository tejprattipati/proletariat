import type { GoogleDependencies } from './contracts';
import type { PermissionKey } from '../types';
import { GoogleOAuth, SCOPES } from './oauth';
import { GoogleHttpError, GoogleIntegrationError, requirePermissions } from './security';

const API_HOSTS = new Set(['www.googleapis.com', 'gmail.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com']);
interface RequestOptions { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown; maxResponseBytes?: number; }
export class GoogleTransport {
  apiCalls = 0;
  constructor(readonly oauth: GoogleOAuth, private deps: GoogleDependencies) {}
  async authorize(scopes: string[]): Promise<string> {
    if (!this.deps.getPermissions) throw new GoogleIntegrationError('GOOGLE_PERMISSION_READER_REQUIRED', 'Google API access requires current persisted capability permissions.', 503);
    const required = Object.entries(SCOPES).filter(([, scope]) => scopes.includes(scope)).map(([key]) => key as PermissionKey);
    requirePermissions(await this.deps.getPermissions(), ...required);
    return this.oauth.accessToken(scopes);
  }
  async request<T>(url: string, scopes: string[], options: RequestOptions = {}): Promise<T> {
    const response = await this.response(url, scopes, options);
    if (response.status === 204) return undefined as T;
    let bytes: Uint8Array;
    try { bytes = await boundedResponse(response, options.maxResponseBytes ?? 10 * 1024 * 1024); }
    catch (error) { if (options.method && options.method !== 'GET') throw new GoogleIntegrationError('GOOGLE_WRITE_UNKNOWN', 'Google received a write but its response could not be read. Reconcile before retrying.', 502); throw error; }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
    catch { throw new GoogleIntegrationError(options.method && options.method !== 'GET' ? 'GOOGLE_WRITE_UNKNOWN' : 'GOOGLE_INVALID_RESPONSE', 'Google did not return a verifiable response.', 502); }
  }
  async bytes(url: string, scopes: string[], maxBytes = 8 * 1024 * 1024): Promise<Uint8Array> {
    return boundedResponse(await this.response(url, scopes, {}), maxBytes);
  }
  private async response(url: string, scopes: string[], options: RequestOptions): Promise<Response> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !API_HOSTS.has(target.hostname) || target.username || target.password || target.port) throw new GoogleIntegrationError('INVALID_API_TARGET', 'Invalid Google API target.');
    const token = await this.authorize(scopes);
    const method = options.method ?? 'GET';
    const mutating = method !== 'GET';
    let response: Response;
    this.apiCalls++;
    try {
      response = await (this.deps.fetch ?? fetch)(target, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(30000), redirect: 'error' });
    } catch { throw new GoogleIntegrationError(mutating ? 'GOOGLE_WRITE_UNKNOWN' : 'GOOGLE_NETWORK_ERROR', mutating ? 'Google may have received this write. Reconcile its outcome before trying again.' : 'Google could not be reached.', 502); }
    // No implicit refresh-and-replay, transport retries, or mutation retries.
    if (!response.ok) throw new GoogleHttpError(response.status, mutating && (response.status >= 500 || response.status === 408));
    return response;
  }
}
export async function boundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new GoogleIntegrationError('INVALID_READ_LIMIT', 'Google response limit must be between 1 byte and 16 MiB.');
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > maxBytes) { await response.body?.cancel(); throw new GoogleIntegrationError('GOOGLE_CONTENT_TOO_LARGE', 'Google content exceeds the configured read limit.', 413); }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > maxBytes) { await reader.cancel(); throw new GoogleIntegrationError('GOOGLE_CONTENT_TOO_LARGE', 'Google content exceeds the configured read limit.', 413); }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof GoogleIntegrationError) throw error;
    throw new GoogleIntegrationError('GOOGLE_NETWORK_ERROR', 'Google response was interrupted before the content was read.', 502);
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export function apiUrl(base: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.href;
}
