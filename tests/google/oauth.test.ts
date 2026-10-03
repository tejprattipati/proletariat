import { describe, expect, it, vi } from 'vitest';
import { GoogleOAuth, SCOPES, scopesForPermissions, configFromEnv } from '../../src/lib/google/oauth';
import { MemoryGoogleStore } from '../../src/lib/google/storage';
import type { GoogleTokens } from '../../src/lib/google/contracts';
import { permissions } from './helpers';

const config = { clientId: 'synthetic-client', clientSecret: 'synthetic-placeholder', redirectUri: 'http://127.0.0.1:3001/api/google/callback' };
function harness(response: Record<string, unknown> = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: SCOPES.driveRead }) {
  let token: GoogleTokens | undefined;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } }));
  const store = new MemoryGoogleStore();
  const tokenStore = { async load() { return token; }, async save(value: GoogleTokens) { token = value; }, async clear() { token = undefined; } };
  const oauth = new GoogleOAuth({ config, tokenStore, store, fetch: fetcher, now: () => new Date('2026-01-02T12:00:00Z') });
  return { oauth, fetcher, tokenStore, store };
}
describe('OAuth boundaries', () => {
  it('requests only enabled scopes with offline access, state and PKCE', async () => {
    const h = harness(); const flags = permissions(false); flags.driveRead = true;
    const start = await h.oauth.begin(flags); const url = new URL(start.url);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('scope')).toBe(SCOPES.driveRead);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).not.toBe(start.nonce);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('binds callbacks to the browser and consumes state exactly once', async () => {
    const h = harness(); const start = await h.oauth.begin(permissions()); const state = new URL(start.url).searchParams.get('state')!;
    await expect(h.oauth.callback(state, 'x'.repeat(43), 'synthetic-code')).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect(h.fetcher).not.toHaveBeenCalled();
    await h.oauth.callback(state, start.nonce, 'synthetic-code');
    expect((await h.tokenStore.load())?.scopes).toEqual([SCOPES.driveRead]);
    await expect(h.oauth.callback(state, start.nonce, 'synthetic-code')).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const body = h.fetcher.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('code_verifier')).toBeTruthy();
  });
  it('invalidates authorization begun before disconnect', async () => {
    const h = harness(); const start = await h.oauth.begin(permissions()); await h.oauth.disconnect();
    await expect(h.oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code')).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('does not reuse a refresh token after authorization of a potentially different account', async () => {
    const h = harness({ access_token: 'synthetic-new-access', expires_in: 3600, scope: SCOPES.driveRead });
    await h.tokenStore.save({ accessToken: 'synthetic-old-access', refreshToken: 'synthetic-old-refresh', expiresAt: 1, scopes: [SCOPES.driveRead] });
    const start = await h.oauth.begin(permissions());
    await h.oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code');
    expect((await h.tokenStore.load())?.refreshToken).toBeUndefined();
  });
  it('honors partial grants and rejects missing permissions before an API call', async () => {
    const h = harness(); const start = await h.oauth.begin(permissions());
    await h.oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code');
    await expect(h.oauth.accessToken([SCOPES.send])).rejects.toMatchObject({ code: 'GOOGLE_SCOPE_REQUIRED' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it('shares a refresh and preserves its previous refresh token', async () => {
    const h = harness({ access_token: 'synthetic-refreshed', expires_in: 3600, scope: SCOPES.driveRead });
    await h.tokenStore.save({ accessToken: 'synthetic-old', refreshToken: 'synthetic-preserve', expiresAt: 1, scopes: [SCOPES.driveRead] });
    expect(await Promise.all([h.oauth.accessToken([SCOPES.driveRead]), h.oauth.accessToken([SCOPES.driveRead])])).toEqual(['synthetic-refreshed', 'synthetic-refreshed']);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect((await h.tokenStore.load())?.refreshToken).toBe('synthetic-preserve');
  });
  it('requests Drive write scope only for the explicit new-file capability', () => {
    const flags = permissions(false); flags.docsWrite = true;
    expect(scopesForPermissions(flags)).toEqual([SCOPES.docsWrite]);
    flags.driveWrite = true;
    expect(scopesForPermissions(flags)).toContain(SCOPES.driveWrite);
  });
  it('does not equate full scan toggles with OAuth permission to read', () => {
    const flags = permissions(false); flags.driveFull = true; flags.gmailFull = true; flags.bulkSend = true;
    expect(scopesForPermissions(flags)).toEqual([]);
  });
  it('fails closed for incomplete configuration and nonlocal HTTP redirects', () => {
    expect(configFromEnv({})).toBeUndefined();
    expect(() => configFromEnv({ GOOGLE_CLIENT_ID: 'synthetic' })).toThrow();
    expect(() => configFromEnv({ GOOGLE_CLIENT_ID: 'synthetic', GOOGLE_CLIENT_SECRET: 'synthetic', GOOGLE_REDIRECT_URI: 'http://example.com/callback' })).toThrow();
  });
});
