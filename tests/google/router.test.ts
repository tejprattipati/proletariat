import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGoogleRouter, googleRouter } from '../../server/google-router';
import { configureGoogleIntegration } from '../../src/lib/google/index';
import { createSyntheticGoogleAdapter } from '../../src/lib/google/synthetic';
import { GoogleSignIn } from '../../src/lib/google/identity';
import { permissions } from './helpers';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); });
async function appBase(defaultRouter = false) {
  const fake = createSyntheticGoogleAdapter(); fake.setPermissions(permissions()); configureGoogleIntegration(fake.dependencies);
  const app = express(); app.use(express.json());
  app.use('/api/google', defaultRouter ? googleRouter : createGoogleRouter({ authorizeRequest: req => req.get('authorization') === 'Bearer synthetic-owner-session', getPermissions: async () => permissions() }));
  app.use((error: { status?: number; code?: string; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message, code: error.code }); });
  const server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/google`, fake };
}
describe('owner-gated OAuth router', () => {
  it('fails closed on authorize, status and disconnect without backend authentication', async () => {
    const { base, fake } = await appBase();
    for (const [path, method] of [['/authorize', 'POST'], ['/authorize', 'GET'], ['/disconnect', 'POST'], ['/status', 'GET'], ['/resources', 'GET']]) {
      const response = await fetch(base + path, { method }); expect(response.status).toBe(401);
    }
    expect(fake.calls).toHaveLength(0);
  });
  it('makes a one-time first-party start URL then sets an HttpOnly cookie before the Google redirect', async () => {
    const { base, fake } = await appBase();
    const prepared = await fetch(base + '/authorize', { method: 'POST', headers: { Authorization: 'Bearer synthetic-owner-session' } });
    expect(prepared.status).toBe(200); const body = await prepared.json() as { url: string };
    const ticket = new URL(body.url).searchParams.get('ticket'); expect(ticket).toBeTruthy();
    const started = await fetch(`${base}/authorize?ticket=${ticket}`, { redirect: 'manual' });
    expect(started.status).toBe(302); expect(started.headers.get('location')).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    const cookie = started.headers.get('set-cookie'); expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax'); expect(cookie).toContain('Path=/api/google/callback');
    expect(started.headers.get('referrer-policy')).toBe('no-referrer');
    const replay = await fetch(`${base}/authorize?ticket=${ticket}`, { redirect: 'manual' }); expect(replay.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });
  it('rejects a forged callback before a token exchange', async () => {
    const { base, fake } = await appBase();
    const response = await fetch(`${base}/callback?code=synthetic-code&state=${'a'.repeat(43)}`, { headers: { Cookie: `proletariat_google_oauth=${'b'.repeat(43)}` } });
    expect(response.status).toBe(403); expect(fake.calls).toHaveLength(0);
  });
  it('exposes no token material through connection status', async () => {
    const { base } = await appBase(); const response = await fetch(base + '/status', { headers: { Authorization: 'Bearer synthetic-owner-session' } });
    expect(response.status).toBe(200); const body = await response.text(); expect(body).not.toContain('synthetic-token'); expect(body).not.toContain('synthetic-refresh'); expect(body).not.toContain('synthetic-client-placeholder');
  });
  it('resolves authenticated users to separate Google adapter/token stores', async () => {
    const first = createSyntheticGoogleAdapter(); const second = createSyntheticGoogleAdapter();
    first.setPermissions(permissions()); second.setPermissions(permissions());
    const app = express(); app.use('/api/google', createGoogleRouter({ authorizeRequest: req => ['synthetic-user-a', 'synthetic-user-b'].includes(req.get('authorization') ?? ''), getPermissions: async () => permissions(), getIntegration: req => req.get('authorization') === 'synthetic-user-a' ? first.integration : second.integration }));
    const server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/google`;
    await fetch(base + '/resources', { headers: { Authorization: 'synthetic-user-a' } }); expect(first.calls).toHaveLength(1); expect(second.calls).toHaveLength(0);
    await fetch(base + '/resources', { headers: { Authorization: 'synthetic-user-b' } }); expect(first.calls).toHaveLength(1); expect(second.calls).toHaveLength(1);
    await second.dependencies.tokenStore.clear();
    const firstStatus = await (await fetch(base + '/status', { headers: { Authorization: 'synthetic-user-a' } })).json();
    const secondStatus = await (await fetch(base + '/status', { headers: { Authorization: 'synthetic-user-b' } })).json();
    expect(firstStatus.connected).toBe(true); expect(secondStatus.connected).toBe(false);
  });
  it('blocks sign-in data routes when user-owned integration resolution is missing', async () => {
    const h = createSyntheticGoogleAdapter(); h.setPermissions(permissions());
    const service = new GoogleSignIn({ config: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret-placeholder', redirectUri: 'http://127.0.0.1:3001/api/google/signin/callback' }, store: h.rawStore, fetch: h.dependencies.fetch });
    const app = express(); app.use('/api/google', createGoogleRouter({ authorizeRequest: () => true, getPermissions: async () => permissions(), signIn: { service, establishSession: async () => undefined } }));
    app.use((error: {status?:number;code?:string}, _req:express.Request, res:express.Response, _next:express.NextFunction) => {res.status(error.status ?? 500).json({code:error.code});});
    const server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/google`;
    const response = await fetch(base + '/status'); expect(response.status).toBe(503); expect((await response.json()).code).toBe('GOOGLE_USER_ISOLATION_REQUIRED');
    const started = await fetch(base + '/signin', {redirect:'manual'}); expect(started.status).toBe(302); const location = new URL(started.headers.get('location')!); expect(location.searchParams.get('scope')).toBe('openid email');
    expect(started.headers.get('set-cookie')).toContain('HttpOnly'); expect(h.calls).toHaveLength(0);
  });
  it('rejects a resolved personal adapter when sign-in requires a subject-bound user adapter', async () => {
    const h = createSyntheticGoogleAdapter(); h.setPermissions(permissions());
    const service = new GoogleSignIn({ config: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret-placeholder', redirectUri: 'http://127.0.0.1:3001/api/google/signin/callback' }, store: h.rawStore, fetch: h.dependencies.fetch });
    const app = express(); app.use('/api/google', createGoogleRouter({ authorizeRequest: () => true, getPermissions: async () => permissions(), getIntegration: () => h.integration, signIn: { service, establishSession: async () => undefined } }));
    app.use((error: {status?:number;code?:string}, _req:express.Request, res:express.Response, _next:express.NextFunction) => {res.status(error.status ?? 500).json({code:error.code});});
    const server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); }); servers.push(server);
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/google/resources`);
    expect(response.status).toBe(503); expect((await response.json()).code).toBe('GOOGLE_USER_ISOLATION_REQUIRED'); expect(h.calls).toHaveLength(0);
  });
  it('exports a router which denies access until explicitly configured', async () => {
    const { base } = await appBase(true); const response = await fetch(base + '/authorize', { method: 'POST', headers: { Authorization: 'Bearer synthetic-owner-session' } }); expect(response.status).toBe(401);
  });
});
