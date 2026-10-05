import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { Permissions } from '../src/lib/types';
import { getGoogleIntegration, type GoogleIntegration } from '../src/lib/google/index';
import type { GoogleSignIn, VerifiedGoogleIdentity } from '../src/lib/google/identity';
import { GoogleIntegrationError, requirePermissions } from '../src/lib/google/security';

export interface GoogleRouterOptions {
  /** Owner/session authentication supplied by the backend, never by request body. */
  authorizeRequest: (request: Request) => boolean | Promise<boolean>;
  getPermissions: (request?: Request) => Promise<Permissions>;
  /** Required with sign-in: resolve a user-owned adapter from the verified server session. */
  getIntegration?: (request: Request) => GoogleIntegration | Promise<GoogleIntegration>;
  bindPublicCallback?: (state:string,ticket:string)=>void;
  /** Lead supplies its opaque server session. No app access is granted by a query/email parameter. */
  signIn?: { service: GoogleSignIn; establishSession: (identity: VerifiedGoogleIdentity, request: Request, response: Response) => Promise<void>; redirectAfterSignIn?: string };
}
interface StartTicket { url: string; nonce: string; expiresAt: number; integration: GoogleIntegration; }
const COOKIE = 'proletariat_google_oauth';

export function createGoogleRouter(options: GoogleRouterOptions): Router {
  const router = Router();
  const tickets = new Map<string, StartTicket>();
  const integrationFor = async (request: Request) => {
    if (options.getIntegration) {
      const integration = await options.getIntegration(request);
      if (options.signIn && !integration.oauth.subjectBound) throw new GoogleIntegrationError('GOOGLE_USER_ISOLATION_REQUIRED', 'Google sign-in data adapters must verify their signed-in subject.', 503);
      return integration;
    }
    if (options.signIn) throw new GoogleIntegrationError('GOOGLE_USER_ISOLATION_REQUIRED', 'Sign-in requires user-owned Google adapters and durable storage before Google data access is enabled.', 503);
    return getGoogleIntegration();
  };
  const owner: RequestHandler = async (req, _res, next) => {
    try {
      if (!await options.authorizeRequest(req)) throw new GoogleIntegrationError('OWNER_AUTH_REQUIRED', 'Owner authentication is required for Google integration.', 401);
      next();
    } catch (error) { next(error); }
  };
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.get('/signin', async (_req, res) => {
    if (!options.signIn) throw new GoogleIntegrationError('GOOGLE_SIGNIN_NOT_CONFIGURED', 'Google sign-in and the server session hook must be configured.', 503);
    const start = await options.signIn.service.begin();
    const callback = new URL(options.signIn.service.config.redirectUri);
    res.cookie('proletariat_google_signin', start.browserNonce, { httpOnly: true, secure: callback.protocol === 'https:', sameSite: 'lax', maxAge: 600_000, path: callback.pathname });
    res.redirect(302, start.url);
  });
  router.get('/signin/callback', async (req, res) => {
    if (!options.signIn) throw new GoogleIntegrationError('GOOGLE_SIGNIN_NOT_CONFIGURED', 'Google sign-in and the server session hook must be configured.', 503);
    const callback = new URL(options.signIn.service.config.redirectUri);
    const cookie = (req.get('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith('proletariat_google_signin='))?.slice('proletariat_google_signin='.length) ?? '';
    res.clearCookie('proletariat_google_signin', { httpOnly: true, secure: callback.protocol === 'https:', sameSite: 'lax', path: callback.pathname });
    if (req.query.error) throw new GoogleIntegrationError('GOOGLE_SIGNIN_DENIED', 'Google sign-in was cancelled or denied.', 403);
    const identity = await options.signIn.service.callback(String(req.query.state ?? ''), cookie, String(req.query.code ?? ''));
    await options.signIn.establishSession(identity, req, res);
    if (options.signIn.redirectAfterSignIn) res.redirect(303, options.signIn.redirectAfterSignIn);
    else res.type('text/plain').send('Google sign-in verified. Return to the application.');
  });
  router.get('/status', owner, async (req, res) => { res.json(await (await integrationFor(req)).oauth.status()); });
  // The first-party start ticket makes OAuth work when the static frontend and API are on different sites.
  // A fetch from Pages cannot rely on a third-party SameSite=Lax cookie being accepted.
  router.post('/authorize', owner, async (req, res) => {
    const integration = await integrationFor(req);
    const start = await integration.oauth.begin(await options.getPermissions(req));
    for (const [key, value] of tickets) if (value.expiresAt <= Date.now()) tickets.delete(key);
    if (tickets.size >= 100) throw new GoogleIntegrationError('OAUTH_ATTEMPT_LIMIT', 'Too many pending Google authorization attempts.', 429);
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { ...start, integration, expiresAt: Date.now() + 60_000 });
    options.bindPublicCallback?.(new URL(start.url).searchParams.get('state')!,ticket);
    const url = new URL(integration.oauth.config!.redirectUri);
    url.pathname = url.pathname.replace(/\/callback$/, '/authorize');
    if (!url.pathname.endsWith('/authorize')) throw new GoogleIntegrationError('GOOGLE_REDIRECT_INVALID', 'GOOGLE_REDIRECT_URI must end in /api/google/callback.', 503);
    url.search = new URLSearchParams({ ticket }).toString();
    res.json({ url: url.href });
  });
  router.get('/authorize', async (req, res) => {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;
    let start: { url: string; nonce: string };
    let integration: GoogleIntegration;
    if (ticket) {
      const pending = tickets.get(ticket);
      tickets.delete(ticket);
      if (!pending || pending.expiresAt <= Date.now()) throw new GoogleIntegrationError('OAUTH_TICKET_EXPIRED', 'Restart Google authorization from the app.', 403);
      start = pending; integration = pending.integration;
    } else {
      if (!await options.authorizeRequest(req)) throw new GoogleIntegrationError('OWNER_AUTH_REQUIRED', 'Start Google authorization from the authenticated app.', 401);
      integration = await integrationFor(req);
      start = await integration.oauth.begin(await options.getPermissions(req));
    }
    const callback = new URL(integration.oauth.config!.redirectUri);
    res.cookie(COOKIE, start.nonce, { httpOnly: true, secure: callback.protocol === 'https:', sameSite: 'lax', maxAge: 10 * 60_000, path: callback.pathname });
    res.redirect(302, start.url);
  });
  router.get('/callback', async (req, res) => {
    const integration = await integrationFor(req);
    const callback = integration.oauth.config ? new URL(integration.oauth.config.redirectUri) : undefined;
    const cookie = (req.get('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
    res.clearCookie(COOKIE, { httpOnly: true, secure: callback?.protocol === 'https:', sameSite: 'lax', path: callback?.pathname ?? '/api/google/callback' });
    if (req.query.error) throw new GoogleIntegrationError('OAUTH_NOT_GRANTED', 'Google authorization was cancelled or denied. No new connection was saved.', 400);
    await integration.oauth.callback(String(req.query.state ?? ''), cookie, String(req.query.code ?? ''));
    res.type('text/plain').send('Google connected. Return to Proletariat and refresh connection status. Your capability toggles still control every operation.');
  });
  router.post('/disconnect', owner, async (req, res) => { await (await integrationFor(req)).oauth.disconnect(); res.json({ connected: false, message: 'Google tokens removed and access revoked.' }); });
  // Optional paginated browsing endpoint. The action contract also supports resource.browse.
  router.get('/resources', owner, async (req, res) => {
    requirePermissions(await options.getPermissions(req), 'driveRead');
    const page = await (await integrationFor(req)).provider.browse(typeof req.query.parentId === 'string' ? req.query.parentId : undefined, typeof req.query.q === 'string' ? req.query.q.slice(0, 500) : undefined, typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined);
    res.json({ ...page, mode: 'live' });
  });
  return router;
}
let defaultOptions: GoogleRouterOptions | undefined;
export function configureGoogleRouter(options: GoogleRouterOptions): void { defaultOptions = options; }
/** Contract export; fail closed until the lead wires owner auth and persisted permission reads. */
export const googleRouter = createGoogleRouter({
  authorizeRequest: req => defaultOptions?.authorizeRequest(req) ?? false,
  getIntegration: async req => {
    if (defaultOptions?.signIn) throw new GoogleIntegrationError('GOOGLE_USER_ISOLATION_REQUIRED', 'Use createGoogleRouter with user-owned adapters for sign-in sessions.', 503);
    if (defaultOptions?.getIntegration) return defaultOptions.getIntegration(req);
    return getGoogleIntegration();
  },
  getPermissions: async req => {
    if (!defaultOptions) throw new GoogleIntegrationError('GOOGLE_ROUTER_NOT_CONFIGURED', 'Google router authentication is not configured.', 503);
    return defaultOptions.getPermissions(req);
  },
});
