import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Connection, Permissions } from '../types';
import type { GoogleConfig, GoogleDependencies, GoogleTokens } from './contracts';
import { GoogleIntegrationError } from './security';

export const SCOPES = {
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  draft: 'https://www.googleapis.com/auth/gmail.compose',
  send: 'https://www.googleapis.com/auth/gmail.send',
  driveRead: 'https://www.googleapis.com/auth/drive.readonly',
  driveWrite: 'https://www.googleapis.com/auth/drive',
  calendarWrite: 'https://www.googleapis.com/auth/calendar.events',
  docsWrite: 'https://www.googleapis.com/auth/documents',
} as const;
export function scopesForPermissions(permissions: Permissions): string[] {
  const scopes: string[] = [];
  if (permissions.gmailRead) scopes.push(SCOPES.gmailRead);
  if (permissions.draft) scopes.push(SCOPES.draft);
  if (permissions.send) scopes.push(SCOPES.send);
  if (permissions.driveRead) scopes.push(SCOPES.driveRead);
  if (permissions.driveWrite) scopes.push(SCOPES.driveWrite);
  if (permissions.calendarWrite) scopes.push(SCOPES.calendarWrite);
  if (permissions.docsWrite) scopes.push(SCOPES.docsWrite);
  return [...new Set(scopes)];
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleConfig | undefined {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REDIRECT_URI: redirectUri } = env;
  if (!clientId && !clientSecret && !redirectUri) return undefined;
  if (!clientId || !clientSecret || !redirectUri) throw new GoogleIntegrationError('GOOGLE_NOT_CONFIGURED', 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI together.', 503);
  const url = new URL(redirectUri);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.hash || url.search) throw new GoogleIntegrationError('GOOGLE_CONFIG_INVALID', 'OAuth redirect must be HTTPS (or HTTP loopback), with no credentials, query, or fragment.', 503);
  return { clientId, clientSecret, redirectUri };
}
interface OAuthAttempt { epoch: string; verifier: string; nonceHash: string; scopes: string[]; expiresAt: number; }
interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; }
export class GoogleOAuth {
  private refresh?: Promise<GoogleTokens>;
  private activeGrant = new AsyncLocalStorage<string>();
  readonly config?: GoogleConfig;
  private fetcher: typeof fetch;
  private now: () => Date;
  constructor(private deps: GoogleDependencies) { this.config = deps.config ?? configFromEnv(); this.fetcher = deps.fetch ?? fetch; this.now = deps.now ?? (() => new Date()); }
  async status(): Promise<Connection> {
    if (!this.config) return { provider: 'google', connected: false, configured: false, label: 'Google is not configured' };
    try {
      const token = await this.deps.tokenStore.load();
      const connected = !!token && (!!token.refreshToken || token.expiresAt > this.now().getTime());
      return { provider: 'google', configured: true, connected, label: connected ? 'Google connected (server OAuth)' : 'Google connection required', scopes: token?.scopes };
    } catch { return { provider: 'google', configured: true, connected: false, label: 'Google token storage unavailable', error: 'Check encrypted token storage and reconnect.' }; }
  }
  async begin(permissions: Permissions): Promise<{ url: string; nonce: string }> {
    const config = this.requireConfig();
    const scopes = scopesForPermissions(permissions);
    if (!scopes.length) throw new GoogleIntegrationError('NO_SCOPES_SELECTED', 'Enable the Google capabilities to authorize before connecting.');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const epoch = randomUUID();
    await this.deps.store.set('oauth-epoch', epoch);
    await this.deps.store.set<OAuthAttempt>(`oauth:${state}`, { epoch, verifier, nonceHash: hash(nonce), scopes, expiresAt: this.now().getTime() + 10 * 60_000 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent', state, code_challenge: hash(verifier), code_challenge_method: 'S256' }).toString();
    return { url: url.href, nonce };
  }
  async callback(state: string, nonce: string, code: string): Promise<void> {
    const config = this.requireConfig();
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(state) || !/^[A-Za-z0-9_-]{40,100}$/.test(nonce) || !code || code.length > 4096) throw new GoogleIntegrationError('OAUTH_STATE_INVALID', 'OAuth callback state is invalid.', 403);
    const attempt = await this.deps.store.get<OAuthAttempt>(`oauth:${state}`);
    if (!attempt || attempt.epoch !== await this.deps.store.get('oauth-epoch') || attempt.expiresAt <= this.now().getTime() || !equal(attempt.nonceHash, hash(nonce))) throw new GoogleIntegrationError('OAUTH_STATE_INVALID', 'OAuth callback expired or does not match this browser.', 403);
    // Atomic durable claim prevents callback replay even with concurrent requests.
    const claim = await this.deps.store.reserveOperation(`oauth-consume:${state}`, hash(nonce));
    if (!claim.created) throw new GoogleIntegrationError('OAUTH_STATE_USED', 'OAuth callback has already been used.', 403);
    await this.deps.store.delete(`oauth:${state}`);
    const result = await this.tokenRequest({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: attempt.verifier });
    if (attempt.epoch !== await this.deps.store.get('oauth-epoch')) throw new GoogleIntegrationError('OAUTH_STATE_INVALID', 'Google authorization was superseded or disconnected.', 403);
    // Do not carry a refresh token across authorization: the user could have selected a different account.
    await this.deps.tokenStore.save(this.tokens(result, undefined, attempt.scopes));
  }
  async disconnect(): Promise<void> {
    await this.deps.store.set('oauth-epoch', randomUUID());
    const token = await this.deps.tokenStore.load();
    // Always remove local access, even when Google revocation is temporarily unavailable.
    await this.deps.tokenStore.clear();
    if (!token) return;
    try {
      const response = await this.fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.refreshToken ?? token.accessToken }), signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new Error('revoke failed');
    } catch { throw new GoogleIntegrationError('GOOGLE_REVOCATION_UNCONFIRMED', 'Local Google tokens were deleted. Google revocation was not confirmed; remove access in Google Account permissions.', 502); }
  }
  withGrant<T>(grant: string, run: () => Promise<T>): Promise<T> { return this.activeGrant.run(grant, run); }
  async storageGrantId(): Promise<string> { return this.activeGrant.getStore() ?? this.grantId(); }
  async grantId(): Promise<string> {
    const token = await this.deps.tokenStore.load();
    if (!token?.connectionId) throw new GoogleIntegrationError('GOOGLE_REAUTH_REQUIRED', 'Reconnect Google to establish an isolated authorization grant.', 401);
    return token.connectionId;
  }
  async accessToken(scopes: string[]): Promise<string> {
    this.requireConfig();
    let token = await this.deps.tokenStore.load();
    if (!token) throw new GoogleIntegrationError('GOOGLE_NOT_CONNECTED', 'Connect Google before using live integrations.', 401);
    if (this.activeGrant.getStore() && token.connectionId !== this.activeGrant.getStore()) throw new GoogleIntegrationError('GOOGLE_GRANT_CHANGED', 'The Google connection changed during this operation. Start again from the current connection.', 409);
    if (!scopes.every(scope => token!.scopes.includes(scope))) throw new GoogleIntegrationError('GOOGLE_SCOPE_REQUIRED', 'Reconnect Google to grant the required capability.', 403);
    if (token.expiresAt <= this.now().getTime() + 60000) {
      if (!this.refresh) this.refresh = this.refreshTokens(token).finally(() => { this.refresh = undefined; });
      token = await this.refresh;
    }
    if (!scopes.every(scope => token!.scopes.includes(scope))) throw new GoogleIntegrationError('GOOGLE_SCOPE_REQUIRED', 'The refreshed grant is missing a required capability.', 403);
    if (this.activeGrant.getStore() && token.connectionId !== this.activeGrant.getStore()) throw new GoogleIntegrationError('GOOGLE_GRANT_CHANGED', 'Google authorization changed during token refresh.', 409);
    return token.accessToken;
  }
  private requireConfig(): GoogleConfig { if (!this.config) throw new GoogleIntegrationError('GOOGLE_NOT_CONFIGURED', 'Google OAuth server configuration is missing.', 503); return this.config; }
  private async refreshTokens(previous: GoogleTokens): Promise<GoogleTokens> {
    if (!previous.refreshToken) throw new GoogleIntegrationError('GOOGLE_REAUTH_REQUIRED', 'Reconnect Google to renew access.', 401);
    const config = this.requireConfig();
    const result = await this.tokenRequest({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: previous.refreshToken, grant_type: 'refresh_token' });
    const token = this.tokens(result, previous, previous.scopes);
    const current = await this.deps.tokenStore.load();
    if (!current || current.connectionId !== previous.connectionId) throw new GoogleIntegrationError('GOOGLE_GRANT_CHANGED', 'Google authorization changed during token refresh.', 409);
    await this.deps.tokenStore.save(token);
    return token;
  }
  private async tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    let response: Response;
    try { response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15000), redirect: 'error' }); }
    catch { throw new GoogleIntegrationError('GOOGLE_AUTH_UNAVAILABLE', 'Google token exchange could not be completed. Try connecting again.', 502); }
    if (!response.ok) throw new GoogleIntegrationError('GOOGLE_REAUTH_REQUIRED', 'Google authorization was not accepted. Reconnect Google.', 401);
    try { return await response.json() as TokenResponse; } catch { throw new GoogleIntegrationError('GOOGLE_AUTH_INVALID_RESPONSE', 'Google returned an invalid token response.', 502); }
  }
  private tokens(result: TokenResponse, previous: GoogleTokens | undefined, requested: string[]): GoogleTokens {
    if (!result.access_token || !Number.isFinite(result.expires_in) || !result.scope && !previous) throw new GoogleIntegrationError('GOOGLE_AUTH_INVALID_RESPONSE', 'Google did not return a verifiable token grant.', 502);
    // Granted scope, not requested scope, is authoritative when consent is partially granted.
    return { connectionId: previous?.connectionId ?? randomUUID(), accessToken: result.access_token, refreshToken: result.refresh_token ?? previous?.refreshToken, expiresAt: this.now().getTime() + result.expires_in! * 1000, scopes: result.scope?.split(/\s+/).filter(Boolean) ?? requested };
  }
}
function hash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function equal(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
