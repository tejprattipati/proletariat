import type { CanvasCredentials, CanvasDependencies } from './contracts';
export class CanvasIntegrationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'CanvasIntegrationError'; }
}
export function approvedOrigin(baseUrl: string, allowedOrigins: string[]): string {
  let url: URL; try { url = new URL(baseUrl); } catch { throw new CanvasIntegrationError('CANVAS_ORIGIN_INVALID', 'Canvas must use an approved HTTPS institution origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || url.port && url.port !== '443' || !allowedOrigins.includes(url.origin)) throw new CanvasIntegrationError('CANVAS_ORIGIN_DENIED', 'Configure the selected HTTPS Canvas origin in the backend allowed origins.');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) throw new CanvasIntegrationError('CANVAS_ORIGIN_DENIED', 'Canvas origins must be approved public institution hostnames.');
  return url.origin;
}
export class CanvasTransport {
  apiCalls = 0;
  constructor(private deps: CanvasDependencies, readonly credentials: CanvasCredentials) {}
  async guard(): Promise<void> {
    const current = await this.deps.getCredentials(); const owner = await this.deps.getOwnerId();
    if (!current || current.ownerId !== owner || this.credentials.ownerId !== owner) throw new CanvasIntegrationError('CANVAS_OWNER_MISMATCH', 'Canvas connection does not belong to the current application owner.', 403);
    if (current.connectionId !== this.credentials.connectionId || current.accountId !== this.credentials.accountId || current.baseUrl !== this.credentials.baseUrl || current.token !== this.credentials.token) throw new CanvasIntegrationError('CANVAS_CONNECTION_CHANGED', 'Canvas was disconnected or changed during the read. Restart with the current connection.', 409);
  }
  url(path: string): URL {
    const origin = approvedOrigin(this.credentials.baseUrl, this.deps.allowedOrigins); const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/v1/') || url.username || url.password || url.hash || url.searchParams.has('access_token')) throw new CanvasIntegrationError('CANVAS_PAGE_DENIED', 'Canvas pagination must remain on the approved institution API.');
    return url;
  }
  async get(path: string): Promise<{ data: unknown; next?: string }> {
    await this.guard(); const url = this.url(path); this.apiCalls++;
    let response: Response;
    try { response = await (this.deps.fetch ?? fetch)(url, { method: 'GET', headers: { Authorization: `Bearer ${this.credentials.token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new CanvasIntegrationError('CANVAS_READ_UNAVAILABLE', 'Canvas read did not complete. Resume the saved checkpoint.', 502); }
    await this.guard();
    if (!response.ok) throw new CanvasIntegrationError('CANVAS_READ_DENIED', `Canvas returned HTTP ${response.status}; this segment was not read.`, response.status);
    const limit = 2 * 1024 * 1024; const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (!reader) throw new CanvasIntegrationError('CANVAS_RESPONSE_INVALID', 'Canvas returned no readable JSON body.', 502);
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) throw new CanvasIntegrationError('CANVAS_RESPONSE_LIMIT', 'Canvas page exceeded the 2 MiB read bound.'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    let data: unknown; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CanvasIntegrationError('CANVAS_RESPONSE_INVALID', 'Canvas returned invalid JSON.', 502); }
    const links = response.headers.get('link') ?? ''; let next: string | undefined;
    for (const match of links.matchAll(/<([^>]+)>\s*;\s*rel\s*=\s*"?([^";,\s]+)"?/g)) if (match[2] === 'next') { if (next) throw new CanvasIntegrationError('CANVAS_PAGE_INVALID', 'Canvas returned conflicting next-page links.'); const target = this.url(match[1]);
      if (target.pathname !== url.pathname) throw new CanvasIntegrationError('CANVAS_PAGE_DENIED', 'Canvas pagination changed the source endpoint.');
      for (const name of new Set(url.searchParams.keys())) {
        if (['page', 'per_page', 'cursor'].includes(name)) continue;
        const values = url.searchParams.getAll(name); const nextValues = target.searchParams.getAll(name);
        if (nextValues.length && JSON.stringify(values) !== JSON.stringify(nextValues)) throw new CanvasIntegrationError('CANVAS_PAGE_DENIED', 'Canvas pagination changed the current-user or effective-date filters.');
        if (!nextValues.length) for (const value of values) target.searchParams.append(name, value);
      }
      next = target.href; }
    return { data, next };
  }
}
/** Read-only connection verification. Caller encrypts the explicitly supplied token after this succeeds. */
export async function verifyCanvasConnection(input: { baseUrl: string; token: string; ownerId: string }, options: { allowedOrigins: string[]; fetch?: typeof fetch }): Promise<{ accountId: string; accountLabel: string; baseUrl: string }> {
  const baseUrl = approvedOrigin(input.baseUrl, options.allowedOrigins);
  if (!input.ownerId || !input.token || input.token.length > 4096 || /[\r\n]/.test(input.token)) throw new CanvasIntegrationError('CANVAS_TOKEN_INVALID', 'Supply a Canvas token explicitly through the protected connection endpoint.');
  const credentials = { ...input, baseUrl, connectionId: 'connection-verification', accountId: 'verification' };
  const transport = new CanvasTransport({ ...options, store: { get: async () => undefined, set: async () => {}, delete: async () => {} }, getOwnerId: async () => input.ownerId, getCredentials: async () => credentials }, credentials);
  const { data } = await transport.get('/api/v1/users/self/profile');
  const profile = data as Record<string, unknown>;
  if (!profile || !['string', 'number'].includes(typeof profile.id) || !String(profile.id)) throw new CanvasIntegrationError('CANVAS_IDENTITY_INVALID', 'Canvas did not identify the selected account.', 403);
  return { baseUrl, accountId: String(profile.id), accountLabel: typeof profile.name === 'string' ? profile.name.slice(0, 200) : `Canvas account ${profile.id}` };
}
