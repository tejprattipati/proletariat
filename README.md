# proletariat

One workspace for your agents, connected tools, and everyday work. Describe a workflow, connect exact resources, then let ordinary code do the repetitive work.

**Build status:** working hackathon prototype with five screens, a persistent backend/worker, direct Google adapters and a synthetic demo. The combined test suite currently passes 187 tests. Live Google and model credentials are not configured; external operations have been verified with injected provider responses, not a real account.

## Run on your Mac

Requires Node 24 and npm.

```sh
npm ci
npm run dev
```

Open the Vite URL (normally `http://127.0.0.1:5173`). The Express API runs on port 3001. Synthetic demo data initializes automatically and persists in `.data/proletariat.sqlite`. No Google or model credentials are needed for demo mode.

## What the app covers

- Today: actionable task feed, exact result/decision evidence, task-linked replies, deadlines, estimates, planning and rollover.
- Agents: separate conversations attached to shared tasks/resources, with relevant updates surfaced today.
- Resources: folder browsing, search, exact link/ID bindings, document sections and resumable selected/all-source scans.
- Workflows: configurable triggers, permissions and direct Calendar/document actions.
- Document recipes: bind a reference and destination once, then create a native copy with deterministic person/context substitutions and linked output receipts.
- Email: drafts, individual sends and campaigns with recipient deduplication, pause/resume and explicit send controls.
- Activity: source-linked outcomes, sync coverage and API/model usage.

The public demo uses fictional data. Demo sends are simulations. Actual Google operations require the owner's separate OAuth connection, app permission toggles and a live workspace. A broad Google scope does not enable an app action by itself.

## Frontend and backend

The Vite/React frontend is static and can run on GitHub Pages. The Express backend owns credentials, SQLite, external API operations, model calls and the scheduler. `VITE_API_URL` points the Pages frontend at the backend. GitHub Pages never executes server routes.

```sh
npm run typecheck
npm test
npm run build
npm run secrets:check
```

For Pages, set the repository variable `VITE_API_URL` to the deployed backend HTTPS origin and enable GitHub Actions as the Pages source. The workflow builds using `/proletariat/` as its base path. See [deployment setup](docs/DEPLOYMENT.md) for backend hosting, persistence and OAuth requirements.

## Connecting live Google tools

Copy `.env.example` to a private `.env`, supply the server settings, and restart the backend. A deployed instance requires `APP_ACCESS_TOKEN`; enter that key in the frontend's Settings. It is held in memory and must be entered again after a page reload. Public visitors get separate synthetic workspaces and cannot use the owner's Google account.

Configure a Google Web OAuth client for the backend callback, enable the needed APIs, and set a stable `TOKEN_ENCRYPTION_KEY`. Select capabilities in the app before connecting Google. OAuth consent remains a user action. Tokens are encrypted at rest; all runtime state stays in the ignored data directory or the configured persistent volume.

Keep `.env`, tokens, private data, actual messages and exported documents out of Git. Never put secrets in a `VITE_` variable. The repository's public-file checker is one check, not a replacement for reviewing every staged change.

## Chat and model cost

Without model configuration, chat supports coded commands such as “add task: …”, “plan my day”, “sync inbox”, and “create a workflow …”, and reports facts from stored state. The UI labels this behavior. It does not pretend those replies came from a model.

For conversational reasoning, configure `OPENAI_API_KEY`, `OPENAI_MODEL`, and the model's actual input/output prices. The implementation uses the [Responses API tool flow](https://developers.openai.com/api/docs/guides/function-calling). Model actions use the same checked services as buttons and jobs. Permissions cannot be enabled by model output. Bounded context, a turn limit, token ceiling and daily budget reduce uncontrolled usage.

Reading known IDs, browsing folders, repeat synchronization, planning arithmetic, rollover and template operations use ordinary APIs/code. New text interpretation and conversational reasoning may still use model tokens. No percentage-savings claim is made without a matched benchmark.

## Development contracts

See [shared contracts](docs/CONTRACTS.md) for endpoint shapes, action payloads and module ownership. The prototype uses a single backend instance and a single owner connection. Live Drive scans currently index metadata; content extraction and Gmail query selection are being completed in the next integration pass. Unsupported behavior is not silently represented as a successful read. Public multi-user Google OAuth, large-scale campaigns and horizontal scaling require further authentication, storage and operational work.
