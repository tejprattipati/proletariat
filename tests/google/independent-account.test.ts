import { describe, expect, it } from 'vitest';
import type { VerifiedGoogleIdentity } from '../../src/lib/google/identity';
import { GoogleOAuth } from '../../src/lib/google/oauth';
import { GoogleIntegration } from '../../src/lib/google/index';
import { createSyntheticGoogleAdapter } from '../../src/lib/google/synthetic';
import { permissions, state } from './helpers';
const identity = (subject = 'synthetic-data-subject'): VerifiedGoogleIdentity => ({ subject, email: 'data@example.com', issuer: 'https://accounts.google.com', audience: 'synthetic-client-id', expiresAt: Date.now() + 3600000 });
function accountHarness() {
  const h = createSyntheticGoogleAdapter(); let owner = 'synthetic-app-owner'; let subject = 'synthetic-data-subject'; let tokenExchange = 0;
  const dependencies = { ...h.dependencies, identityVerifier: { verifyIdToken: async () => identity(subject) }, getAuthenticatedSubject: async () => owner, fetch: (async (input, init) => {
    if (String(input).includes('/token')) { tokenExchange++; return new Response(JSON.stringify({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.readonly', id_token: 'synthetic-id-token' })); }
    if (String(input).includes('/revoke')) return new Response('{}');
    return h.dependencies.fetch!(input, init);
  }) as typeof fetch };
  return { ...h, dependencies, oauth: new GoogleOAuth(dependencies), owner(value: string) { owner = value; }, subject(value: string) { subject = value; }, exchanges: () => tokenExchange };
}
describe('independent Google data-account ownership', () => {
  it('allows a different verified data account while rejecting a different app owner before reads', async () => {
    const h = accountHarness(); const start = await h.oauth.begin(permissions()); await h.oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code');
    expect(new URL(start.url).searchParams.get('prompt')).toContain('select_account'); expect(await h.dependencies.tokenStore.load()).toMatchObject({ ownerSubject: 'synthetic-app-owner', subject: 'synthetic-data-subject' });
    const workspace = state(); h.setPermissions(workspace.permissions); const integration = new GoogleIntegration(h.dependencies);
    await integration.execute(workspace, { type: 'resource.browse' }); const count = h.calls.length; h.owner('another-app-owner');
    await expect(integration.execute(workspace, { type: 'resource.browse' })).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH' }); expect(h.calls).toHaveLength(count); expect((await h.oauth.status()).connected).toBe(false);
  });
  it('rejects a changed app owner during callback without saving the selected account', async () => {
    const h = accountHarness(); const prior = await h.dependencies.tokenStore.load(); const start = await h.oauth.begin(permissions()); h.owner('another-app-owner');
    await expect(h.oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code')).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH' }); expect(await h.dependencies.tokenStore.load()).toEqual(prior);
  });
  it('requires refresh consistency with the selected data account, independently of app identity', async () => {
    const h = accountHarness(); const start = await h.oauth.begin(permissions()); await h.oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code');
    let tokens = (await h.dependencies.tokenStore.load())!; await h.dependencies.tokenStore.save({ ...tokens, expiresAt: 0 });
    await expect(h.oauth.accessToken(['https://www.googleapis.com/auth/drive.readonly'])).resolves.toBe('synthetic-new-access'); expect((await h.dependencies.tokenStore.load())?.ownerSubject).toBe('synthetic-app-owner');
    tokens = (await h.dependencies.tokenStore.load())!; await h.dependencies.tokenStore.save({ ...tokens, expiresAt: 0 }); h.subject('another-data-subject');
    await expect(h.oauth.accessToken(['https://www.googleapis.com/auth/drive.readonly'])).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_MISMATCH' });
  });
  it('creates a new grant on account change and invalidates old resource bindings', async () => {
    const h = accountHarness(); const workspace = state(); h.setPermissions(workspace.permissions); const integration = new GoogleIntegration(h.dependencies);
    let start = await integration.oauth.begin(workspace.permissions); await integration.oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code');
    await integration.execute(workspace, { type: 'resource.bind', payload: { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit' } });
    const oldGrant = (await h.dependencies.tokenStore.load())!.connectionId; h.subject('new-data-subject'); start = await integration.oauth.begin(workspace.permissions); await integration.oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code');
    expect((await h.dependencies.tokenStore.load())!.connectionId).not.toBe(oldGrant); await expect(integration.execute(workspace, { type: 'attachment.read', payload: { resourceId: workspace.resources[0].id } })).rejects.toMatchObject({ code: 'GOOGLE_GRANT_CHANGED' });
    await integration.oauth.disconnect(); expect(await h.dependencies.tokenStore.load()).toBeUndefined(); await expect(integration.execute(workspace, { type: 'resource.browse' })).rejects.toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' });
  });
  it('preserves same-account Daily source identity across reconnection while changing grant caches', async () => {
    const h = accountHarness(); const workspace = state(); workspace.permissions = { ...permissions(false), driveRead: true }; h.setPermissions(workspace.permissions); const integration = new GoogleIntegration(h.dependencies);
    const connect = async () => { const start = await integration.oauth.begin(workspace.permissions); await integration.oauth.callback(new URL(start.url).searchParams.get('state')!, start.nonce, 'synthetic-code'); await integration.execute(workspace, { type: 'resource.bind', payload: { url: 'https://docs.google.com/document/d/synthetic-doc-1/edit' } }); await integration.execute(workspace, { type: 'daily.read' }); return workspace.daily!.sources[0].id; };
    const first = await connect(); const grant = (await h.dependencies.tokenStore.load())!.connectionId; const second = await connect(); expect(second).toBe(first); expect((await h.dependencies.tokenStore.load())!.connectionId).not.toBe(grant);
    h.subject('a-different-data-account'); const third = await connect(); expect(third).not.toBe(first);
  });

});
