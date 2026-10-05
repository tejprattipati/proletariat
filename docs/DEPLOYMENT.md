# Deployment and account setup

Current target: free Mac backend with SQLite, plus a static Vite frontend. No paid hosting, trial credits, new OAuth grants, or live provider mutations were created in this implementation pass. The previous Pages publication predates the current identity and Daily changes.

## Required private configuration

Use `.env.example`. Never put client secrets, tokens, uploaded files, or actual messages into Git, chat, or `VITE_` variables.

1. Choose a Google Cloud project and configure a Web OAuth client. For local use register both `http://127.0.0.1:3001/api/identity/callback` and `http://127.0.0.1:3001/api/google/callback`. For a hosted backend register its exact HTTPS counterparts. The frontend return URL is separate.
2. Set `GOOGLE_IDENTITY_CLIENT_ID`, `GOOGLE_IDENTITY_CLIENT_SECRET`, `GOOGLE_IDENTITY_REDIRECT_URI`, and `FRONTEND_URL`. Identity requests only `openid email profile`. Any verified Google subject can sign in; there is no single-email allowlist. The signing keys, issuer, audience, expiry and nonce are verified before a session is established.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` together for Workspace service consent. They may use the same Cloud client, with the separate callback above. Enable the Gmail, Drive, Calendar, Docs and Sheets APIs that will be used. Identity login alone retains no Google data-access token.
4. Set a stable private `TOKEN_ENCRYPTION_KEY` containing 32 random bytes encoded as base64. Keep it across restarts; replacing it makes existing encrypted tokens unreadable. Choose a stable private `DATA_DIR` and back it up consistently with SQLite's WAL.
5. Set `CORS_ORIGIN` to exact frontend origins and `FRONTEND_URL` to the exact controlled frontend return URL. Return URLs are never accepted from a request parameter.

Google External Testing consent limits sign-in to configured test users until the project is published; the application itself accepts any verified Google account. Public access to restricted Gmail/Drive scopes can require Google verification. Do not describe the hackathon setup as unrestricted production OAuth.

## Session and user isolation

Google identity uses a first-party OAuth launch ticket, state/nonce/PKCE, an HttpOnly callback cookie, and a one-use browser-bound handoff. The application session is stored under a hash on the backend and expires after 12 hours. Browser JavaScript holds its opaque session token only in memory; an HttpOnly session cookie supports reloads where browser cookie policy permits. OAuth credentials are never returned to the browser.

Tasks, messages, attachments, permissions, Google tokens, Google operation journals, ChatGPT registrations and job keys are scoped to the verified Google issuer/subject. Different subjects with the same email remain different users. Signed-out requests and legacy owner keys cannot access operational routes. Legacy single-owner rows are not silently migrated to any newly signed-in account.

Google service consent verifies the independently selected data account and binds that grant to the initiating app owner. The data account may differ from the app login. Reauthorization isolates caches by grant and removes prior Google source context from active model inputs. Local uploads remain. Background work executes in its owner's user context and rechecks current permissions. The current runtime uses one process; horizontal replicas need distributed locks and durable OAuth handoff storage before use.

## ChatGPT connection

After Google sign-in, each user selects **Continue with ChatGPT** on their own local backend. The app uses OpenAI's public-client dynamic registration with PKCE and a loopback callback; it needs no client secret or API key. The user reviews and grants plan usage privately. Account mappings and rotating tokens remain separate per Google user and ChatGPT registration. Matching email addresses never establish authorization.

The callback must open on the backend computer. The present UI disables local plan consent against a remote API origin. A public Pages frontend does not turn this into a hosted multi-user ChatGPT authorization service; remote users should run their own local backend. A later hosted flow requires a separately supported deployment design, not borrowing the host owner's CLI credentials.

Inference goes to the public Responses endpoint with the user's app-owned grant, `store:false`, streaming, and standard service tier. Only supported application functions are exposed; no shell, browser-session scraping, MCP credential reuse or priority/fast setting is added. Actual completed inference remains unverified until a user connects and sends a message. Plan/credit limits remain controlled in ChatGPT settings.

Sources: [OpenAI registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [account/session handling](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [inference and streaming](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Free hosting and publication

The existing free setup runs a Mac backend on loopback through a temporary Cloudflare tunnel, with GitHub Pages as the frontend. Preserve existing user processes. Keep the Mac awake: scheduled work runs only while the server is running. A replaced tunnel changes the origin, so update both Google callbacks, the frontend's `VITE_API_URL`, and the backend origin configuration.

Before publication, run `npm test`, `npm run build`, `npm run secrets:check`, review the diff, and verify the deployed commit. Unauthenticated Pages visitors must see only the identity shell, and the API must return 401 for operational routes. Do not enable shared public multi-user access before isolation tests pass. Browser and actual OAuth consent checks are still required; mocked tests do not prove live account access.

The earlier automatic approval review rejected sending an owner bearer key through the public tunnel. That test was never performed. The new session system does not reuse that owner key. No paid provider has been provisioned.

## Current backend and consent checklist

On 2026-10-05 the app backend was started at 127.0.0.1:3002 and a new free tunnel at https://besides-ccd-lately-relay.trycloudflare.com. Local/public health passed; identity was unconfigured and anonymous workspace access returned401. This temporary URL lasts only while that tunnel process runs. The Pages workflow now builds against this public URL rather than the stale repository variable.

For this hosted run, register these exact Google Web OAuth redirect URIs:

- https://besides-ccd-lately-relay.trycloudflare.com/api/identity/callback
- https://besides-ccd-lately-relay.trycloudflare.com/api/google/callback

Privately configure GOOGLE_IDENTITY_CLIENT_ID, GOOGLE_IDENTITY_CLIENT_SECRET, GOOGLE_IDENTITY_REDIRECT_URI, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, TOKEN_ENCRYPTION_KEY and DATA_DIR. FRONTEND_URL is https://tejprattipati.github.io/proletariat/ and CORS_ORIGIN is https://tejprattipati.github.io. The current private hosted config already has the encryption/frontend/CORS fields but no Google OAuth client credentials. Choose an existing project/Web client or authorize creation; no project/client is provisioned by this implementation pass. Enable Gmail, Drive, Calendar, Docs and Sheets APIs as needed, configure consent audience/test accounts, and start with read-only scopes. Write/send scopes require separate explicit consent and app toggles.

App identity, Google data account and ChatGPT registration are independently selected and owned by the app session. The Google data account may differ from the app's Google login; account emails are never used for authorization or linking. Reconnecting the same verified provider account retains canonical task corrections/completion; switching accounts removes old raw provider context, pauses jobs and archives that account's task records privately.

ChatGPT plan sharing uses the official public-client registration and HTTP127.0.0.1 loopback callback. This requires the browser to run on the backend computer; the app currently disables initiation against a remote backend. For local consent use the local runtime/setup values and register the corresponding Google loopback callbacks. An arbitrary HTTPS callback is not a supported replacement for this plan-sharing route. A separately provisioned website identity client does not by itself grant ChatGPT plan inference. No OpenAI API key or desktop/CLI credential copying is required. The OpenAI-hosted login UI controls Google/social login choices and account eligibility; the app does not force a Google login parameter. See [official registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [website identity](https://developers.openai.com/siwc/website), and [ChatGPT login methods](https://help.openai.com/en/articles/4936824-can-i-change-how-i-log-into-my-account-authentication-method).

For Canvas, set CANVAS_ALLOWED_ORIGINS privately to the exact HTTPS institution origins. A signed-in user supplies their Canvas token in the protected connection form, where the provider self profile verifies that independently selected account. The token is encrypted per app owner and never returned by status APIs. Only reads are implemented; weekly reading defaults off and coursework submission is unavailable. Institution-specific token availability and real source coverage still need user/provider verification. Never include migration snapshots, coursework, mail, Drive content or tokens in the public repository.
