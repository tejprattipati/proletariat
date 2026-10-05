import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GoogleSignIn, signInConfigFromEnv } from '../../src/lib/google/identity';
import { MemoryGoogleStore } from '../../src/lib/google/storage';
import { createSyntheticGoogleAdapter } from '../../src/lib/google/synthetic';
import { GoogleIntegration } from '../../src/lib/google/index';
import { GoogleOAuth } from '../../src/lib/google/oauth';
import { state, permissions } from './helpers';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-placeholder', redirectUri: 'http://127.0.0.1:3001/api/google/signin/callback' };
function jwt(changes: Record<string, unknown> = {}, headerChanges: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key', ...headerChanges })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: config.clientId, sub: 'synthetic-subject-1', email: 'one@example.com', email_verified: true, iat: now - 5, exp: now + 1800, nonce: 'synthetic-nonce', ...changes })).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
function harness() {
  const store = new MemoryGoogleStore(); const calls: string[] = []; let token = jwt();
  const service = new GoogleSignIn({ config, store, fetch: async (input) => {
    const url = String(input); calls.push(url);
    return url.endsWith('/certs') ? new Response(JSON.stringify({ 'synthetic-key': publicKey.export({ type: 'spki', format: 'pem' }) }), { headers: { 'cache-control': 'public, max-age=600' } }) : new Response(JSON.stringify({ id_token: token, access_token: 'synthetic-ignored-identity-access' }));
  } });
  return { service, store, calls, setToken(value: string) { token = value; } };
}
describe('verified Google identity and user binding', () => {
  it('accepts distinct verified Google users without authorizing by email equality', async () => {
    const h = harness();
    const first = await h.service.verifyIdToken(jwt(), 'synthetic-nonce');
    const second = await h.service.verifyIdToken(jwt({ sub: 'synthetic-subject-2', email: 'one@example.com' }), 'synthetic-nonce');
    expect(first.subject).not.toBe(second.subject); expect(first.email).toBe(second.email); expect(first.issuer).toBe('https://accounts.google.com'); expect(h.calls).toHaveLength(1);
  });
  it.each([{ iss: 'https://example.com' }, { aud: 'another-client' }, { email_verified: false }, { exp: 1 }, { sub: '' }, { nonce: 'wrong-nonce' }, { azp: 'wrong-client' }])('rejects invalid signed claims %j', async changes => {
    const h = harness(); await expect(h.service.verifyIdToken(jwt(changes), 'synthetic-nonce')).rejects.toMatchObject({ code: 'GOOGLE_SIGNIN_DENIED' });
  });
  it('rejects a modified signature and unsupported algorithms', async () => {
    const h = harness(); const valid = jwt(); const parts = valid.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'pretend-user' })).toString('base64url');
    await expect(h.service.verifyIdToken(parts.join('.'))).rejects.toMatchObject({ code: 'GOOGLE_SIGNIN_DENIED' });
    await expect(h.service.verifyIdToken(jwt({}, { alg: 'none' }))).rejects.toMatchObject({ code: 'GOOGLE_SIGNIN_DENIED' });
  });
  it('uses minimal sign-in scopes and verifies one-time browser state and OIDC nonce', async () => {
    const h = harness(); const start = await h.service.begin(); const url = new URL(start.url);
    expect(url.searchParams.get('scope')).toBe('openid email'); expect(url.searchParams.get('access_type')).toBe('online'); expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    h.setToken(jwt({ nonce: url.searchParams.get('nonce') }));
    const identity = await h.service.callback(url.searchParams.get('state')!, start.browserNonce, 'synthetic-code'); expect(identity.subject).toBe('synthetic-subject-1');
    await expect(h.service.callback(url.searchParams.get('state')!, start.browserNonce, 'synthetic-code')).rejects.toMatchObject({ code: 'GOOGLE_SIGNIN_DENIED' });
    expect(await h.store.get('google:tokens')).toBeUndefined();
  });
  it('rejects forged browser state before token exchange', async () => {
    const h = harness(); const start = await h.service.begin();
    await expect(h.service.callback(new URL(start.url).searchParams.get('state')!, 'x'.repeat(43), 'synthetic-code')).rejects.toMatchObject({ code: 'GOOGLE_SIGNIN_DENIED' }); expect(h.calls).toHaveLength(0);
  });
  it('returns no sign-in configuration when private callback configuration is absent', () => { expect(signInConfigFromEnv({})).toBeUndefined(); });
  it('rejects user-owned data grants belonging to another subject before API access', async () => {
    const h = createSyntheticGoogleAdapter(); const workspace = state(); h.setPermissions(workspace.permissions);
    const integration = new GoogleIntegration({ ...h.dependencies, identityVerifier: { verifyIdToken: async () => ({ subject: 'synthetic-subject-2', email: 'two@example.com', issuer: 'https://accounts.google.com', audience: config.clientId, expiresAt: Date.now() + 3600000 }) }, getAuthenticatedSubject: async () => 'synthetic-subject-1' });
    const token = (await h.dependencies.tokenStore.load())!; await h.dependencies.tokenStore.save({ ...token, subject: 'synthetic-subject-2' });
    await expect(integration.execute(workspace, { type: 'resource.browse' })).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH' }); expect(h.calls).toHaveLength(0);
  });
  it('binds an independently selected verified data account to the application owner', async () => {
    const h = createSyntheticGoogleAdapter(); const original = h.dependencies.fetch!;
    const oauth = new GoogleOAuth({ ...h.dependencies, fetch: async (input, init) => String(input).includes('/token') ? new Response(JSON.stringify({ access_token: 'synthetic-token', expires_in: 3600, scope: 'openid email', id_token: 'synthetic-id-token' })) : original(input, init), identityVerifier: { verifyIdToken: async () => ({ subject: 'synthetic-subject-2', email: 'two@example.com', issuer: 'https://accounts.google.com', audience: config.clientId, expiresAt: Date.now() + 3600000 }) }, getAuthenticatedSubject: async () => 'synthetic-subject-1' });
    const start = await oauth.begin(permissions());
    await oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code');
    expect(await h.dependencies.tokenStore.load()).toMatchObject({ subject: 'synthetic-subject-2', ownerSubject: 'synthetic-subject-1', email: 'two@example.com' });
    expect((await oauth.status()).label).toContain('two@example.com');
  });
});
