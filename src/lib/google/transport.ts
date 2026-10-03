import type { GoogleDependencies } from './contracts';
import type { PermissionKey } from '../types';
import { GoogleOAuth, SCOPES } from './oauth';
import { GoogleHttpError, GoogleIntegrationError, requirePermissions } from './security';

const API_HOSTS = new Set(['www.googleapis.com', 'gmail.googleapis.com', 'docs.googleapis.com']);
export class GoogleTransport {
  apiCalls = 0;
  constructor(readonly oauth: GoogleOAuth, private deps: GoogleDependencies) {}
  async authorize(scopes: string[]): Promise<string> {
    if (!this.deps.getPermissions) throw new GoogleIntegrationError('GOOGLE_PERMISSION_READER_REQUIRED', 'Google API access requires current persisted capability permissions.', 503);
    const required = Object.entries(SCOPES).filter(([, scope]) => scopes.includes(scope)).map(([key]) => key as PermissionKey);
    requirePermissions(await this.deps.getPermissions(), ...required);
    return this.oauth.accessToken(scopes);
  }
  async request<T>(url: string, scopes: string[], options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown } = {}): Promise<T> {
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
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; }
    catch { throw new GoogleIntegrationError(mutating ? 'GOOGLE_WRITE_UNKNOWN' : 'GOOGLE_INVALID_RESPONSE', 'Google did not return a verifiable response.', 502); }
  }
}
export function apiUrl(base: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.href;
}
