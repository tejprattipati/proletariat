# Deployment and setup

Prepared 2026-10-03 against `docs/CONTRACTS.md`. These files are deployment scaffolding, not evidence of a running deployment. Provider login, paid resources, repository grants, Google credentials and account consent have not been performed. Only synthetic fixtures are authorized for validation.

## Current decision: $0 demo hosting

**The user has not approved paid hosting. Use the Mac backend with its local SQLite database and a Cloudflare Quick Tunnel for the hackathon demo.** This keeps the current implementation and uses no trial credits or existing paid subscription. `render.yaml` is an optional paid alternative, not the selected deployment.

Run the existing server/worker on the Mac and keep `DATA_DIR` at a stable private absolute path. The worker already starts with the server, runs once at startup, and ticks every minute. State survives application restarts; scheduled work runs only while the Mac and server are awake. An open lid, power and reliable Internet are needed during remote demos. This provides persistent local data, not independent always-online hosting.

Cloudflare Quick Tunnels expose localhost over HTTPS without an account or owned domain. They last for the tunnel process, change hostname when recreated, allow 200 in-flight requests, provide no uptime guarantee, and do not support SSE. The current app uses JSON requests, so SSE is not required. [Quick Tunnel setup](https://try.cloudflare.com/), [current limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

| Option checked | Persistence / scheduling | Decision |
| --- | --- | --- |
| Mac + Quick Tunnel | SQLite persists on Mac; current worker runs while awake; public HTTPS available during the demo | **Recommended now:** no database or worker rewrite, no hosting account/payment |
| Cloudflare Workers Free + D1 + Cron | Persistent hosted DB and scheduled invocations; 100,000 requests/day, 10 ms CPU/invocation, five cron triggers/account; D1 includes 5 GB total storage, 5 million rows read/day and 100,000 rows written/day | Best $0 cloud follow-up; not a drop-in deployment |
| Render Free web + its free Postgres | Web sleeps after 15 idle minutes, cold start about one minute; local SQLite is lost on restart/sleep; no free persistent disk; free Postgres expires after 30 days | Does not meet this app's durable, non-trial requirement |
| GitHub Actions as scheduler | Scheduled runs can be delayed/dropped and are disabled after 60 inactive days in public repos; a separate persistent database is still needed | Not a reliable substitute for the app worker |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing and enforced free limits](https://developers.cloudflare.com/d1/platform/pricing/), [Render Free](https://render.com/docs/free), [GitHub schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

The free Cloudflare cloud route would require an async D1 storage adapter, atomic database claims/version checks replacing process-local locks, a scheduled handler replacing `setInterval`, and persisted OAuth start tickets replacing the in-memory map. `node:sqlite` is explicitly a non-functional Workers stub; merely enabling Node compatibility does not fix it. Keep work batches inside the free CPU/subrequest limits, and make quota exhaustion a visible stop rather than upgrading. D1 free quotas reject further queries when exhausted. [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [D1 quota behavior](https://developers.cloudflare.com/d1/platform/pricing/)

### Minimal demo setup after coordination

1. Install the official `cloudflared` binary on the selected Mac (not present in the inspected PATH). Coordinate public exposure with the parent; no account, billing plan or provider credential is required for Quick Tunnel. Start in synthetic mode with model calls disabled.
2. Start the existing backend from the project directory with `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3001`, `CORS_ORIGIN=https://tejprattipati.github.io`, and a stable private `DATA_DIR`. Supply any owner/encryption keys privately only after authorization. Example non-secret runtime setup:

   ```sh
   DATA_DIR="$HOME/Library/Application Support/Proletariat" \
   NODE_ENV=production HOST=127.0.0.1 PORT=3001 \
   CORS_ORIGIN=https://tejprattipati.github.io npm start
   ```

3. In another terminal, run `cloudflared tunnel --url http://127.0.0.1:3001`. Do not add the tunnel's email authentication option: its interactive gate is incompatible with the Pages API client. Preserve the app's own owner authentication.
4. Set the Pages build's `VITE_API_URL` to the generated HTTPS origin and rebuild Pages. Test JSON/CORS and synthetic persistence through that actual public URL. Keep both processes alive during the demo.
5. For approved **owner-only Google testing on this Mac**, use the stable registered Web-client callback `http://localhost:3001/api/google/callback` and that same `GOOGLE_REDIRECT_URI`. The adapter's first-party ticket navigation then opens localhost on the owner's Mac, sets the cookie and returns there after consent; the tunnel still serves the Pages API. This avoids changing OAuth registration whenever the tunnel restarts. It does not support connecting Google from another person's device. For remote OAuth instead, register the exact tunnel HTTPS callback and update it on every tunnel hostname change. No live OAuth test is authorized by this document.
6. When the Mac/tunnel is offline, the public frontend should explicitly report that its backend is unavailable. A small optional lead-owned runtime backend-URL setting would avoid rebuilding Pages after each new tunnel URL; do not silently switch to an unrelated demo state.

No free service can remove the Google app credentials/consent step. Keep the model disabled for an entirely $0 demo; the current adapter has no verified free model entitlement. Paid Render or a full serverless migration is unnecessary for the immediate demo.

## Optional paid Render alternative — not approved

If the user later explicitly chooses paid independent hosting, use **one paid Render Node web service with a 1 GB persistent disk**, running the Express API and scheduled worker in the same instance. Keep the frontend on GitHub Pages. The worker must persist due jobs/checkpoints; a timer alone is not a durable queue.

The published base price is **$7/month for `0.5c-512mb` plus $0.25/month for a 1 GB disk**. Budget for metered bandwidth/build overages and any model usage separately; this estimate is not a spending cap. Confirm the displayed checkout total before provisioning. [Render pricing](https://render.com/pricing)

Render disks belong to one service instance and are unavailable at build/pre-deploy time. A separate worker or cron service cannot mount the API's SQLite disk. Disk deployments have a brief outage. Perform SQLite initialization/migrations at runtime, before accepting traffic. [Persistent disks](https://render.com/docs/disks)

If independent worker deployment or multiple API instances becomes necessary, first migrate the shared state, outbox and job leases to Postgres; then use Render web + cron/worker + managed Postgres in the same region. Render cron uses UTC, requires an exiting command and has a $1 monthly minimum. [Cron jobs](https://render.com/docs/cronjobs) Use the database's internal URL and disable unnecessary external database access. [Postgres connections](https://render.com/docs/postgresql-creating-connecting)

Railway is a reasonable fallback if an already-approved account exists: Hobby starts at $5/month including $5 usage, with overages; volume-backed services are available, and hosted cron runs cannot be closer than five minutes. It does not remove the Google consent or browser-session requirements. No Railway/Render account availability was established in this task. [Railway pricing](https://docs.railway.com/pricing/plans), [volumes](https://docs.railway.com/volumes), [cron](https://docs.railway.com/cron-jobs)

## Required integration before deployment

The deployment specialist owns only this document, Dockerfile, `.dockerignore` and `render.yaml`. Read-only integration checks confirmed `DATA_DIR`, `APP_ACCESS_TOKEN`, `TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` in the developing server/adapter. The lead must still confirm the health endpoint, worker entry and final browser configuration.

| Contract | Required behavior |
| --- | --- |
| `npm start` | Starts Express **and** the durable scheduled worker; only one scheduler owner. |
| `HOST`, `PORT` | Bind to `0.0.0.0` and the provided port; the manifest uses `3001`. |
| `DATA_DIR` | Store SQLite, WAL/SHM files, encrypted refresh tokens, session state, idempotency records and checkpoints beneath this path. No fallback to `/tmp` or an ephemeral directory. |
| `GET /api/health` | Public, read-only, minimal JSON; return success only after DB initialization; no personal data or secret values. |
| Worker status | Expose a protected heartbeat/last-success status; report stale workers even if HTTP is healthy. |
| Shutdown/restart | Handle SIGTERM, stop claiming jobs, persist in-flight state, close SQLite and recover overdue work on restart. |
| Public access | Authenticate the owner before every private read/write and Google connect route; isolate or disable shared demo mutations. CORS is not authentication. |

Render requires a public web service to bind `0.0.0.0` and supports the `PORT` environment variable. [Web service requirements](https://render.com/docs/web-services)

## GitHub Pages, CORS and session contract

The Pages build uses `VITE_API_URL=https://<assigned-backend-host>` and `GITHUB_PAGES=true`. The public Pages URL includes `/proletariat/`; its **origin does not**. CORS must allow only the exact frontend origin, e.g. `https://<github-owner>.github.io`, plus explicit development origins in development. Separate the full frontend return URL from that origin.

The developing server uses `Authorization: Bearer <APP_ACCESS_TOKEN>` for the owner and `X-Workspace-ID` for isolated synthetic workspaces. The client must supply those headers as appropriate. Keep the owner key private, manually entered and in memory; never put it in a `VITE_` variable, URL, localStorage or public fixture. Rotate it after the demo. This single-owner scheme avoids dependence on cross-site API cookies; it is not multi-user sign-in.

The initial client also uses `credentials: "include"`. With that setting, return the exact allowed origin, `Access-Control-Allow-Credentials: true`, and `Vary: Origin`; handle OPTIONS and allow `Content-Type`, `Authorization` and `X-Workspace-ID` as needed. A wildcard origin cannot be used with credentialed requests. Validate Origin on mutations and, for any cookie-authenticated mutation, a session-bound CSRF token; use HTTPS, Secure/HttpOnly host-only cookies. [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)

**The default `github.io` → `onrender.com` pairing is cross-site.** `SameSite=None; Secure` alone does not make it reliable: Safari blocks third-party cookies. Verify Google OAuth browser-binding cookies are established during a first-party backend visit, not only by a cross-site fetch. If moving from the current manually entered owner key to automatic sessions, choose one of these options. [WebKit cookie behavior](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)

1. If an owned domain is already available, use Pages at `app.<owned-domain>` and the backend at `api.<owned-domain>`. Keep exact-origin credentialed CORS and CSRF protection; use a backend host-only Secure/HttpOnly session cookie. DNS changes require coordination and authorization.
2. Without a domain, use short-lived **application session tokens in memory** for API requests. After backend Google OAuth, return only an expiring, single-use application handoff code to the allowlisted frontend URL; bind redemption to a browser-generated verifier/challenge and login state. Redeem it by POST, remove it from the address bar immediately, and use `Authorization: Bearer` thereafter. Re-authenticate via top-level backend navigation on reload/expiry, optionally using a first-party backend session cookie. No Google token, client secret, refresh token, or long-lived application bearer belongs in URLs or browser storage. This requires client/server work; it is not implemented by this manifest. See [OAuth security guidance](https://www.rfc-editor.org/rfc/rfc9700.html).

For either option, bind OAuth state to the browser transaction, verify it once with a short expiry, validate OIDC issuer/audience/nonce when used for login, enforce the allowed owner, and reject arbitrary return URLs. Do not connect live Google data to an anonymously accessible shared workspace.

## Google setup: one coordinated authorization bundle

At action time, obtain authorization for the named project/account and exact scopes before making any changes:

1. Select an existing approved Google Cloud project, or authorize creation of one. Enable **Gmail API, Google Drive API, Google Calendar API and Google Docs API**. This is project setup, not mailbox access. [Enable APIs](https://developers.google.com/workspace/guides/enable-apis)
2. Configure Google Auth Platform branding/support contact and audience. For the hackathon, keep an External app in **Testing** and add only explicitly authorized test accounts. Use synthetic content; a public frontend does not require opening OAuth to the public. [Consent configuration](https://developers.google.com/workspace/guides/configure-oauth-consent)
3. Create an OAuth **Web application** client. Register the exact backend callback `https://<assigned-backend-host>/api/google/callback` only after confirming that route with the Google adapter. Register `http://localhost:3001/api/google/callback` separately for local use if needed. The callback is not a GitHub Pages URL. Store the client secret only in the backend environment. [Create credentials](https://developers.google.com/workspace/guides/create-credentials)
4. Review the feature-to-scope mapping below with the user. Request only enabled feature scopes, using incremental consent. Route OAuth through the backend authorization-code flow with `access_type=offline`; encrypt the returned refresh token before persistence. Refresh responses may omit a refresh token: retain the existing token for that same account/grant; never carry it across an unverified account change. [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
5. The user authorizes the app at Google's consent screen. Missing scopes or revoked grants must disable the affected feature visibly. Workspace organization policy can block approval and may require its administrator.

| Feature | Candidate scope; request only after approval |
| --- | --- |
| Identify/login owner | `openid email profile` (request only identity fields actually needed) |
| Read/sync Gmail; reconcile uncertain sends | `https://www.googleapis.com/auth/gmail.readonly` |
| Create/manage Gmail drafts and send them | `https://www.googleapis.com/auth/gmail.compose`; it already includes sending, so `gmail.send` is redundant for this flow |
| App-created or explicitly app-authorized Drive files and Docs | `https://www.googleapis.com/auth/drive.file`; pasting any file ID does not itself grant this per-file authorization |
| Optional broad Drive reading | `https://www.googleapis.com/auth/drive.readonly` |
| Optional edits to existing Docs not covered by `drive.file` | `https://www.googleapis.com/auth/documents`; enforce bound-output restrictions in the app despite the scope's breadth |
| Read/create/update Calendar events | `https://www.googleapis.com/auth/calendar.events` (use owned-only or read-only variants if the enabled feature permits) |

Gmail read/compose and broad Drive read scopes are restricted; avoid `https://mail.google.com/` and full Drive write access for these features. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Docs scopes](https://developers.google.com/workspace/docs/api/auth), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)

External Testing refresh tokens for these API scopes expire after **seven days**; expect re-consent. [Token expiry](https://developers.google.com/identity/protocols/oauth2) General-public production access to restricted data can require verification and an annual external security assessment unless an exception applies. That is a later launch gate, not something a deployment or public repo completes. [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

## Secrets and execution controls

Use the lead's final `.env.example` names and confirm any additions before launch. Configure private values directly in the host environment, never in the repo, Pages build, chat, or logs:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`; frontend origin/return URL using the lead's final names.
- `APP_ACCESS_TOKEN`: a strong random owner key. `TOKEN_ENCRYPTION_KEY`: a stable base64-encoded 32-byte key (the current storage module validates this size). Both remain private and must not change on restart. Implement a key-version migration before rotating encryption keys; replacing one blindly loses access to existing ciphertext.
- Optional `OPENAI_API_KEY`, `OPENAI_MODEL`, `MAX_DAILY_MODEL_TOKENS`, `MODEL_INPUT_USD_PER_MILLION`, `MODEL_OUTPUT_USD_PER_MILLION`, plus a user-approved daily dollar budget. The current model adapter requires positive pricing values before it considers itself configured. Keep model-disabled synthetic mode for the $0 demo. Enforce atomic durable budgets, output-token/request/time limits and concurrency limits; refuse work before exceeding the budget. Never let model output bypass action permissions.
- Sending, bulk sending and live writes remain disabled until separately approved. Google scope consent does not itself authorize a campaign.

Use durable outbox uniqueness for `(campaign, recipient, content/version)`, immutable per-attempt message identifiers, and transactions/leases to prevent duplicate claiming. Persist `sending` before the network call. A timeout/crash after dispatch becomes `unknown`, never automatically `pending`: reconcile using Gmail message lookup and the stable RFC Message-ID; if still unresolved, pause for review. Message-ID lookup is evidence, not an exactly-once delivery guarantee. [Gmail send API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [message filtering](https://developers.google.com/workspace/gmail/api/guides/filtering)

Persist sync checkpoints per provider/account; commit processed results before advancing the cursor. Recover Gmail expired history with full sync, Calendar invalid sync tokens with full sync, and Drive through persisted page tokens. Resume bounded pages on restart with backoff, rate limits and a permission check before every write. [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync), [Calendar sync](https://developers.google.com/workspace/calendar/api/guides/sync), [Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes) Plan/rollover keys must include the user's IANA timezone and local target date, so a restart or DST boundary cannot run the same rollover twice.

## Paid alternative deployment sequence — only after a new explicit decision

1. Lead completes and validates the contracts above, especially authentication, origin handling, data paths and worker startup. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run secrets:check` locally with synthetic fixtures.
2. At the provider action, ask for the **Render account/workspace, selected-repository grant, and spending approval** (base estimate $7.25/month plus separately approved overages). Do not assume an installed CLI or connected ChatGPT Google account grants the app credentials. Connect only the intended repository; parent/lead owns browser interaction.
3. After approval, create a Blueprint from `render.yaml`. It defines paid resources, one instance, manual deploys and a disk mounted at `/var/data`. Confirm the selected region is acceptable and the final price. [Blueprint fields](https://render.com/docs/blueprint-spec)
4. Set the server's finalized origin/session/environment values privately. Start with synthetic mode and model/live write operations disabled. Record the assigned HTTPS backend URL; use it for `VITE_API_URL`, OAuth callback and the allowlisted frontend return flow.
5. Lead builds/deploys Pages with the backend origin. Verify allowed/disallowed CORS preflights, owner authentication, CSRF rejection, and session behavior with third-party cookies blocked. Test public synthetic behavior from the actual Pages URL, not just localhost.
6. Restart the backend and redeploy once using synthetic state. Confirm state, job leases, checkpoints, encrypted-token test fixtures and idempotency keys survive. Confirm a killed send attempt resumes as `unknown`; use mocked Google/model transports only, never real sends or personal inbox changes.
7. Configure a SQLite-consistent backup using the SQLite backup API and verify restore into an isolated synthetic DB. Do not copy a live DB file without its WAL or rely on provider disk snapshots as the only database backup. Add private heartbeat/error monitoring and log redaction.
8. Only after the user approves the exact Google/model actions, configure credentials and perform the corresponding consent flow. Live mailbox changes, write tests and send tests are outside this runbook's current authorization.

## Local container alternative

The Dockerfile follows the existing `tsx server/index.ts` entry and retains dev dependencies because `tsx` is currently declared there. Build only after the lead has added `server/` and confirmed its configuration. It runs as the `node` user; a bind-mounted directory must be writable by that container user.

```sh
docker build -t proletariat-backend .
docker volume create proletariat-data
docker run --rm --init --name proletariat-backend -p 127.0.0.1:3001:3001 \
  --mount source=proletariat-data,target=/var/data proletariat-backend
```

This is a local synthetic check, not persistent public hosting. The Node 24 image supports the project's built-in SQLite requirement. No secrets are needed for the demo; do not bake an env file into the image. On the inspected Mac, Node 24.9.0, npm 11.12.1, Git, Docker CLI and SQLite CLI were present; Docker engine availability and provider logins were not inspected.

## Outstanding blockers

- **Free demo:** coordinate installing `cloudflared` and exposing the local API, record the generated URL, and update Pages. No tunnel or provider account was created by this task.
- **Implementation:** `/api/health`, `CORS_ORIGIN`, same-process worker startup and first-party OAuth tickets now exist in the lead's code; verify them from the actual public origin, including persistence after restart. Review all token paths and shutdown behavior before live use.
- **Paid provider:** Render is optional and unapproved. No login/repository grant, paid provisioning or billing action should occur under the current $0 decision.
- **Google:** project choice/API enablement, Web OAuth credentials, exact callback, test accounts and scope consent require authorization. No Google app credentials were inspected or created.
- **Optional model:** choose approved provider/model/budget and privately supply a key; otherwise keep deterministic demo behavior.
- **Optional domain:** same-site cookie approach needs an owned domain and authorized DNS edits; bearer sessions avoid this dependency.

## Verified local demo deployment checkpoint

The implementation lead configured GitHub Pages to use GitHub Actions and installed the official Cloudflare macOS arm64 release locally in the ignored app tools directory. Homebrew was blocked by an unrelated tap-trust issue; no tap settings were changed. The tunnel works with the system DNS resolver (`GODEBUG=netdns=cgo`).

The development frontend/backend remain on ports 5173/3001. A separate hosted demo backend runs on `127.0.0.1:3002`, with a separate SQLite directory and a private owner key. Its configuration is in the ignored `.data/hosted.env`. The public build's repository variable `VITE_API_URL` stores only the tunnel origin, never credentials. The owner key is verified only over local loopback; transmitting it through the public tunnel was not performed. Public checks verified health, exact Pages CORS, isolated synthetic workspaces, and rejection of anonymous private/Google access. Google and model credentials remain unset.

Keep the Mac, backend and tunnel running. A recreated tunnel receives a different URL and requires updating `VITE_API_URL` and rerunning Pages. This is a free temporary hackathon deployment, not an always-online cloud service.
