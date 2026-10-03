import { randomBytes } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import type { Permissions } from '../src/lib/types';
import { getGoogleIntegration, getGoogleStatus } from '../src/lib/google/index';
import { GoogleIntegrationError, requirePermissions } from '../src/lib/google/security';

export interface GoogleRouterOptions {
  /** Owner/session authentication supplied by the backend, never by request body. */
  authorizeRequest: (request: Request) => boolean | Promise<boolean>;
  getPermissions: () => Promise<Permissions>;
}
interface StartTicket { url: string; nonce: string; expiresAt: number; }
const COOKIE = 'proletariat_google_oauth';

export function createGoogleRouter(options: GoogleRouterOptions): Router {
  const router = Router();
  const tickets = new Map<string, StartTicket>();
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
  router.get('/status', owner, async (_req, res) => { res.json(await getGoogleStatus()); });
  // The first-party start ticket makes OAuth work when the static frontend and API are on different sites.
  // A fetch from Pages cannot rely on a third-party SameSite=Lax cookie being accepted.
  router.post('/authorize', owner, async (_req, res) => {
    const integration = getGoogleIntegration();
    const start = await integration.oauth.begin(await options.getPermissions());
    for (const [key, value] of tickets) if (value.expiresAt <= Date.now()) tickets.delete(key);
    if (tickets.size >= 100) throw new GoogleIntegrationError('OAUTH_ATTEMPT_LIMIT', 'Too many pending Google authorization attempts.', 429);
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { ...start, expiresAt: Date.now() + 60_000 });
    const url = new URL(integration.oauth.config!.redirectUri);
    url.pathname = url.pathname.replace(/\/callback$/, '/authorize');
    if (!url.pathname.endsWith('/authorize')) throw new GoogleIntegrationError('GOOGLE_REDIRECT_INVALID', 'GOOGLE_REDIRECT_URI must end in /api/google/callback.', 503);
    url.search = new URLSearchParams({ ticket }).toString();
    res.json({ url: url.href });
  });
  router.get('/authorize', async (req, res) => {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;
    let start: { url: string; nonce: string };
    if (ticket) {
      const pending = tickets.get(ticket);
      tickets.delete(ticket);
      if (!pending || pending.expiresAt <= Date.now()) throw new GoogleIntegrationError('OAUTH_TICKET_EXPIRED', 'Restart Google authorization from the app.', 403);
      start = pending;
    } else {
      if (!await options.authorizeRequest(req)) throw new GoogleIntegrationError('OWNER_AUTH_REQUIRED', 'Start Google authorization from the authenticated app.', 401);
      start = await getGoogleIntegration().oauth.begin(await options.getPermissions());
    }
    const callback = new URL(getGoogleIntegration().oauth.config!.redirectUri);
    res.cookie(COOKIE, start.nonce, { httpOnly: true, secure: callback.protocol === 'https:', sameSite: 'lax', maxAge: 10 * 60_000, path: callback.pathname });
    res.redirect(302, start.url);
  });
  router.get('/callback', async (req, res) => {
    const integration = getGoogleIntegration();
    const callback = integration.oauth.config ? new URL(integration.oauth.config.redirectUri) : undefined;
    const cookie = (req.get('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
    res.clearCookie(COOKIE, { httpOnly: true, secure: callback?.protocol === 'https:', sameSite: 'lax', path: callback?.pathname ?? '/api/google/callback' });
    if (req.query.error) throw new GoogleIntegrationError('OAUTH_NOT_GRANTED', 'Google authorization was cancelled or denied. No new connection was saved.', 400);
    await integration.oauth.callback(String(req.query.state ?? ''), cookie, String(req.query.code ?? ''));
    res.type('text/plain').send('Google connected. Return to Proletariat and refresh connection status. Your capability toggles still control every operation.');
  });
  router.post('/disconnect', owner, async (_req, res) => { await getGoogleIntegration().oauth.disconnect(); res.json({ connected: false, message: 'Google tokens removed and access revoked.' }); });
  // Optional paginated browsing endpoint. The action contract also supports resource.browse.
  router.get('/resources', owner, async (req, res) => {
    requirePermissions(await options.getPermissions(), 'driveRead');
    const page = await getGoogleIntegration().provider.browse(typeof req.query.parentId === 'string' ? req.query.parentId : undefined, typeof req.query.q === 'string' ? req.query.q.slice(0, 500) : undefined, typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined);
    res.json({ ...page, mode: 'live' });
  });
  return router;
}
let defaultOptions: GoogleRouterOptions | undefined;
export function configureGoogleRouter(options: GoogleRouterOptions): void { defaultOptions = options; }
/** Contract export; fail closed until the lead wires owner auth and persisted permission reads. */
export const googleRouter = createGoogleRouter({
  authorizeRequest: req => defaultOptions?.authorizeRequest(req) ?? false,
  getPermissions: async () => {
    if (!defaultOptions) throw new GoogleIntegrationError('GOOGLE_ROUTER_NOT_CONFIGURED', 'Google router authentication is not configured.', 503);
    return defaultOptions.getPermissions();
  },
});
