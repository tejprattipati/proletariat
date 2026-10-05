# proletariat

One workspace for daily tasks, individual AI chats, and connected Google workflows. Select exact resources once; ordinary code handles repeated reads, planning, rollover, templates, and API writes.

This is a hackathon prototype. Google identity sign-in is required before any workspace data or controls load. Each verified Google subject owns separate sessions, workspaces, credentials, jobs, attachments, and ChatGPT registrations. Email matching never links accounts. Old single-owner data is retained separately and is not assigned to a new sign-in.

## Run locally

Requires Node 24 and npm. Copy `.env.example` to a private `.env`, configure Google identity and the encryption key as described in [setup](docs/DEPLOYMENT.md), then:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Google identity login does not grant Gmail, Calendar, or Drive access. Those are separate choices in Connections. Runtime data lives in the ignored `.data` directory.

## Included

- **Daily:** Gmail and Calendar read status, actual source excerpts, explicit task extraction, complete to-do list, and a primary reading conversation.
- **Chats and agents:** independent named conversations, selectable agents, task-linked replies, local PDF/DOCX/text uploads, and an in-chat Drive chooser.
- **Today:** actionable task feed, result evidence, estimates, calendar-aware plans, rollover, and completed-work filtering.
- **Canonical tasks:** one stable record across priority, multiple categories, planned dates and hard deadlines; retained removal/restoration, lifecycle history, provider corrections, and source evidence.
- **Canvas:** explicitly connected read-only inventory, resumable current-course/source-family pagination, submission facts, weekly new-versus-changed reports, and coverage gaps. Configure approved institution origins before connecting.
- **Resources and recipes:** browse/search folders; bind exact files, tabs and managed ranges; copy a reference into a chosen folder with deterministic placeholder substitutions.
- **Email and workflows:** drafts, controlled individual sends and campaigns, selected/full scans, automatic or review workflows, permissions, and durable operation receipts.
- **Connections and appearance:** per-user Google/ChatGPT accounts, independent read/write/send controls, usage records, and muted themes.

Synthetic mode is available only after sign-in. Its operations use fictional data and never send messages. Live service operations require that user's OAuth grant and enabled capabilities. Actual Google writes and ChatGPT inference have not been tested against a real account in this implementation pass.

## ChatGPT plan usage

Each user explicitly authorizes their own app-specific ChatGPT connection. Credentials are encrypted in that user's namespace; the app never reads CLI or desktop auth files. Public chat routes do not use a shared API key. Requests use the standard service tier. Coded commands, repeat synchronization, planning, rollover and deterministic recipes require no model tokens.

The implemented consent callback is local loopback. Complete it on the computer running your backend; this is not yet a universally hosted sign-in flow for arbitrary remote users. The UI disables that flow against a remote backend and explains the limitation. Google sign-in does not automatically authorize or identify a ChatGPT account.

Only a completed streamed response counts as verified inference. Failed, interrupted and quota-limited responses do not trigger returned tool actions. ChatGPT plan/credit limits still apply. The local token ceiling is a preflight guard and records actual usage; the preview API does not support a hard output-token cap. No percentage-savings claim is made without a measured baseline.

## Verification and architecture

```sh
npm test
npm run build
npm run secrets:check
```

React/Vite serves the frontend. Express owns APIs, encrypted OAuth storage, bounded extraction workers, and the scheduler; SQLite persists workspaces and operation journals. Google adapters use direct APIs with source provenance, account/grant isolation, resumable pages and unknown-write reconciliation. See [contracts](docs/CONTRACTS.md) and [Google adapter limits](src/lib/google/README.md).

The [product specification](docs/PRODUCT_SPEC.md) records canonical task and Canvas requirements, including navigation, weekly reports, and acceptance criteria. Implemented paths are validated with fictional provider responses; real account coverage, consent and inference remain unverified. Existing Google workflows and permission controls remain required.

The Pages frontend is https://tejprattipati.github.io/proletariat/. Publishing static assets does not configure Google consent, make the Mac always online, or verify real provider access. Follow the current callback and private configuration checklist in [deployment setup](docs/DEPLOYMENT.md).
