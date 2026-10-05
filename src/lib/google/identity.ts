import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import type { GoogleConfig, GoogleStore } from './contracts';
import { GoogleIntegrationError } from './security';
import { boundedResponse } from './transport';

export interface VerifiedGoogleIdentity { subject: string; email: string; issuer: 'https://accounts.google.com'; audience: string; expiresAt: number; }
export interface GoogleIdentityVerifier { verifyIdToken(token: string, nonce?: string): Promise<VerifiedGoogleIdentity>; }
export interface GoogleSignInConfig extends GoogleConfig {}
export interface GoogleSignInDependencies { config: GoogleSignInConfig; store: GoogleStore; fetch?: typeof fetch; now?: () => Date; }
interface Attempt { verifier: string; browserNonceHash: string; nonce: string; expiresAt: number; }
const CERTS = 'https://www.googleapis.com/oauth2/v1/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const CALLBACK_PATH = '/api/google/signin/callback';
export function signInConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleSignInConfig | undefined {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_SIGNIN_REDIRECT_URI: redirectUri } = env;
  if (!redirectUri) return undefined;
  if (!clientId || !clientSecret || !redirectUri) throw new GoogleIntegrationError('GOOGLE_SIGNIN_NOT_CONFIGURED', 'Google sign-in requires a private client ID/secret, sign-in callback.', 503);
  return validateConfig({ clientId, clientSecret, redirectUri });
}
/** Identity-only login. It never persists Google API access/refresh tokens or requests data scopes. */
export class GoogleSignIn implements GoogleIdentityVerifier {
  readonly config: GoogleSignInConfig;
  private fetcher: typeof fetch;
  private now: () => Date;
  private certificates?: { keys: Record<string, string>; expiresAt: number };
  private loading?: Promise<Record<string, string>>;
  private verifier = new google.auth.OAuth2();
  constructor(private deps: GoogleSignInDependencies) { this.config = validateConfig(deps.config); this.fetcher = deps.fetch ?? fetch; this.now = deps.now ?? (() => new Date()); }
  async begin(): Promise<{ url: string; browserNonce: string }> {
    const now = this.now().getTime();
    const attempts = await this.deps.store.get<{ key: string; expiresAt: number }[]>('signin-attempt-index') ?? [];
    const active = [];
    for (const item of attempts) { if (item.expiresAt <= now) await this.deps.store.delete(item.key); else active.push(item); }
    if (active.length >= 100) throw new GoogleIntegrationError('OAUTH_ATTEMPT_LIMIT', 'Too many pending sign-in attempts.', 429);
    const state = randomBytes(32).toString('base64url'); const browserNonce = randomBytes(32).toString('base64url'); const nonce = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
    const key = `signin:${state}`; const expiresAt = now + 600_000;
    await this.deps.store.set<Attempt>(key, { verifier, nonce, browserNonceHash: hash(browserNonce), expiresAt });
    await this.deps.store.set('signin-attempt-index', [...active, { key, expiresAt }]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code', scope: 'openid email', access_type: 'online', include_granted_scopes: 'false', prompt: 'select_account', state, nonce, code_challenge: hash(verifier), code_challenge_method: 'S256' }).toString();
    return { url: url.href, browserNonce };
  }
  async callback(state: string, browserNonce: string, code: string): Promise<VerifiedGoogleIdentity> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browserNonce) || !code || code.length > 4096) throw denied('Sign-in callback is invalid.');
    const key = `signin:${state}`; const attempt = await this.deps.store.get<Attempt>(key);
    if (!attempt || attempt.expiresAt <= this.now().getTime() || !equal(attempt.browserNonceHash, hash(browserNonce))) throw denied('Sign-in expired or does not match this browser.');
    const claim = await this.deps.store.reserveOperation(`signin-consume:${state}`, hash(browserNonce));
    if (!claim.created) throw denied('Sign-in callback was already used.');
    await this.deps.store.delete(key);
    let response: Response;
    try { response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: this.config.clientId, client_secret: this.config.clientSecret, redirect_uri: this.config.redirectUri, grant_type: 'authorization_code', code_verifier: attempt.verifier }) }); }
    catch { throw new GoogleIntegrationError('GOOGLE_SIGNIN_UNAVAILABLE', 'Google sign-in could not be completed. Start sign-in again.', 502); }
    if (!response.ok) throw denied('Google did not accept this sign-in code.');
    let idToken: unknown;
    try { idToken = (JSON.parse(new TextDecoder().decode(await boundedResponse(response, 64 * 1024))) as { id_token?: unknown }).id_token; }
    catch { throw denied('Google did not return a verifiable sign-in response.'); }
    if (typeof idToken !== 'string') throw denied('Google did not return an identity token.');
    return this.verifyIdToken(idToken, attempt.nonce);
  }
  async verifyIdToken(token: string, nonce?: string): Promise<VerifiedGoogleIdentity> {
    if (typeof token !== 'string' || token.length > 16_384) throw denied('Google identity token is invalid.');
    const segments = token.split('.'); if (segments.length !== 3 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) throw denied('Google identity token is invalid.');
    let header: { alg?: string; kid?: string };
    try { header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8')); } catch { throw denied('Google identity token is invalid.'); }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200) throw denied('Google identity signature is invalid.');
    const keys = await this.keys();
    if (!keys[header.kid]) throw denied('Google identity signing key is unavailable. Start sign-in again.');
    let payload;
    try {
      // Google's maintained verifier checks RSA signature, issuer, audience and token lifetime.
      const ticket = await this.verifier.verifySignedJwtWithCertsAsync(token, keys, this.config.clientId, ISSUERS, 3600);
      payload = ticket.getPayload();
    } catch { throw denied('Google identity signature or token claims could not be verified.'); }
    const nowSeconds = this.now().getTime() / 1000;
    if (!payload || !ISSUERS.includes(payload.iss) || payload.aud !== this.config.clientId || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds || !Number.isFinite(payload.iat) || payload.iat > nowSeconds + 60 || payload.exp - payload.iat > 3600 || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw denied('Google identity token claims are invalid.');
    const claims = payload as typeof payload & { nonce?: string; azp?: string };
    if (claims.azp && claims.azp !== this.config.clientId || nonce !== undefined && (typeof claims.nonce !== 'string' || !equal(hash(claims.nonce), hash(nonce)))) throw denied('Google identity does not match this sign-in attempt.');
    if (payload.email_verified !== true || typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) || payload.email.length > 254) throw denied('Google did not verify this account email.');
    // Issuer + subject identifies the user. Email is a verified display attribute, not an authorization link.
    return { subject: payload.sub, email: payload.email.trim().toLowerCase(), issuer: 'https://accounts.google.com', audience: this.config.clientId, expiresAt: payload.exp * 1000 };
  }
  private async keys(): Promise<Record<string, string>> {
    if (this.certificates && this.certificates.expiresAt > this.now().getTime()) return this.certificates.keys;
    if (!this.loading) this.loading = (async () => {
      let response: Response;
      try { response = await this.fetcher(CERTS, { redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { throw new GoogleIntegrationError('GOOGLE_SIGNIN_UNAVAILABLE', 'Google identity signing keys are temporarily unavailable.', 503); }
      if (!response.ok) throw new GoogleIntegrationError('GOOGLE_SIGNIN_UNAVAILABLE', 'Google identity signing keys are temporarily unavailable.', 503);
      let keys: Record<string, string>;
      try { keys = JSON.parse(new TextDecoder().decode(await boundedResponse(response, 1024 * 1024))) as Record<string, string>; } catch { throw denied('Google returned invalid signing keys.'); }
      if (!keys || Array.isArray(keys) || Object.keys(keys).length > 20 || !Object.values(keys).every(value => typeof value === 'string' && value.length <= 16_384)) throw denied('Google returned invalid signing keys.');
      const maxAge = Number(response.headers.get('cache-control')?.match(/(?:^|[, ])max-age=(\d+)/i)?.[1] ?? 300);
      this.certificates = { keys, expiresAt: this.now().getTime() + Math.min(3600, Math.max(0, maxAge)) * 1000 };
      return keys;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
}
function validateConfig(config: GoogleSignInConfig): GoogleSignInConfig {
  if (!config.clientId || !config.clientSecret) throw new GoogleIntegrationError('GOOGLE_SIGNIN_NOT_CONFIGURED', 'Set a valid Google OAuth client privately.', 503);
  let url: URL; try { url = new URL(config.redirectUri); } catch { throw new GoogleIntegrationError('GOOGLE_CONFIG_INVALID', 'Google sign-in callback is invalid.', 503); }
  if (url.pathname !== CALLBACK_PATH || url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new GoogleIntegrationError('GOOGLE_CONFIG_INVALID', `Google sign-in callback must use HTTPS (or HTTP loopback) and end in ${CALLBACK_PATH}.`, 503);
  return { ...config };
}
function hash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function equal(left: string, right: string): boolean { return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
function denied(message: string): GoogleIntegrationError { return new GoogleIntegrationError('GOOGLE_SIGNIN_DENIED', message, 403); }
