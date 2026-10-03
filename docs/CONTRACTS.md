# Shared implementation contracts

This is a Vite React static frontend for GitHub Pages plus a separate Express/Node backend and worker. All development is on the user's Mac. All fixtures are fictional. Never copy private research, real messages, tokens, or personal resource IDs into this repository.

## File ownership

- Lead: project config, `src/main.tsx`, `src/lib/client.ts`, `src/lib/types.ts`, `src/lib/server/`, `server/index.ts`, worker, docs, public-file checks, final integration.
- UI: `src/App.tsx`, `src/styles.css`, `src/components/`. Do not edit shared types without coordination. Use `getWorkspace`, `act`, `chat`, `api` and `API_BASE` from `src/lib/client.ts` rather than hardcoding same-origin calls.
- Domain/tests: `src/lib/domain/`, `tests/domain/`. Export `createDemoState(now?: Date): WorkspaceState` from `fixtures.ts`; export `applyAction(state: WorkspaceState, action: ActionRequest, now?: Date): ActionResult` from `actions.ts`. Pure functions, no database/network calls.
- Google/backend: `src/lib/google/`, `server/google-router.ts`, `tests/google/`. Export `getGoogleStatus(): Promise<Connection>` and `executeGoogleAction(state: WorkspaceState, action: ActionRequest): Promise<ActionResult>` from `src/lib/google/index.ts`. Export an Express `googleRouter` from `server/google-router.ts`, mounted at `/api/google`, with OAuth authorize/callback/disconnect routes. Tokens are encrypted and persisted outside Git. Never read existing ChatGPT/browser credentials.

## Browser contract

`GET /api/workspace` returns `WorkspaceState` directly. `POST /api/action` accepts `ActionRequest` and returns `{state, message, entityId?}`. `POST /api/chat` accepts `{agentId, message}` and returns the same shape. Non-2xx responses return `{error, code?}`. Use these endpoints, not localStorage as the source of truth. The lead creates these Express routes and persists state in SQLite via Node's built-in `node:sqlite`. Vite proxies `/api` to port 3001 in development. Pages builds use `VITE_API_URL` for the separate backend origin. GitHub Pages serves no backend routes or credentials.

Actions (all payloads are JSON objects):

- `task.create`: title, notes?, estimateMinutes?, priority?, dueDate?, plannedDate?, agentId?. `task.update`: id plus changed fields. `task.delete`: id.
- `plan.generate`: date?. `plan.rollover`: date (target local date). `settings.update`: changed Settings fields.
- `permissions.update`: changed boolean permission fields. `demo.reset`: no payload.
- `usage.update`: dailyBudgetUsd (nonnegative number). Workflow create/update also accepts mode and enabled.
- `agent.create`: name, description. `agent.update`: id, pinned?, name?, description?.
- `workflow.create`: name?, intent, agentId?, actions?, resourceIds?, draftIds?, campaignIds?, query?, trigger?, schedule?, timezone?, mode?, enabled?. `workflow.update`: id plus fields. `workflow.run`: id, confirmed? (true after the user explicitly runs a review-mode workflow). Email workflows bind existing reviewed draft/campaign IDs; no inferred recipients.
- `resource.bind`: id?, url?, role?, name?, tabId?, namedRangeId?. `resource.unbind`: id. `resource.browse`: parentId?, q? (UI can filter demo resources itself).
- `sync.run`: provider? (`gmail` or `drive`). `scan.start`: provider, coverage (`selected` or `all`). `scan.pause`: id. `scan.resume`: id.
- `draft.create`: to, subject, body, threadId?. `draft.update`: id plus fields. `draft.send`: id.
- `campaign.create`: name, subject, body, recipients (array of `{email,name?}`), scheduledAt?, ratePerMinute?. `campaign.start/pause/resume/cancel`: id.
- `calendar.upsert`: id?, title, start, end, location?, calendarId?. `calendar.read`: calendarId?, start, end, pageToken?. `docs.write`: resourceId, content.

Domain owns synthetic versions of every action, strict permission checks, idempotency via requestId/processedKeys, deterministic plan/rollover, workflow interpretation from supported keywords, and campaign transitions. Demo actions never call Google. Use example.com addresses and fabricated file IDs. Enabled broad scans must have visible coverage/progress. Disabling send/bulk blocks execution even after queue creation.

Google adapter handles live resource browse/bind, scan/sync, draft/send, campaign dispatch, calendar upsert and Docs write. Other actions remain domain operations. `executeGoogleAction` receives a cloned state and returns its updated state. It must check permissions independently. Do not record uncertain sends as successful or blindly retry. Unsupported/missing configuration must throw a clear error; never fall back silently to demo.

## UI behavior

Build Today, Agents, Resources, Activity/Campaigns and settings in one cohesive responsive app. UI can use `lucide-react`. Make every visible button functional. Show the mode badge consistently. All broad-read and send capabilities must be present with toggles. Agent chats persist. Today's relevance comes from task/agent state. Resource links resolve directly. Model-free demo responses must be honestly labeled; live model requests require user-provided configuration.

Google authorization: POST `/api/google/authorize` returns `{url}`. Open that URL in the browser: it is a one-time backend launch ticket that establishes a first-party callback cookie, then redirects to Google. GET is a browser redirect, never a JSON endpoint. POST `/api/google/disconnect` disconnects. Both are protected by the lead's owner authorization hook. The callback validates its one-time OAuth state. Settings can expose an Owner access key field using `getOwnerKey()`/`setOwnerKey()` from the client; this key is supplied by the deployment owner, never bundled, and kept in memory only. The client handles isolated demo workspace headers and owner bearer authorization. The UI must not assume that enabling a permission grants an OAuth scope.

## Latest additions: task feed, document recipes, proof

- `Task.needsInput?: string` describes the exact pending decision; `updatedAt?: string`. Completed tasks are excluded from the active feed. Domain may export `rankTaskFeed(state, now?)` for deterministic decision-first/due/recent ordering; retain the existing Task identity.
- `Run.taskId?`, `recipeId?`, `changedResourceIds?`, `changedEventIds?` link receipts to exact work. `sourceIds` remains input provenance, and existing model/token/API counts remain actual run evidence. Do not present generic agent activity as exact task proof.
- `WorkspaceState.recipes?: Recipe[]` (normalize absent values to `[]` for old saved state). Recipe: `{id,name,referenceResourceId,destinationFolderId,agentId?,createdAt}`. Reference and destination are IDs from bound Resource records. The source must be a document; the destination must be a folder.
- `recipe.create`: `{name,referenceResourceId,destinationFolderId,agentId?}`. `recipe.update`: `{id,...changed fields}`. `recipe.run`: `{id,title,context,person?,taskId?}`. Persist the recipe once and reuse it. Demo creates a clearly synthetic new document, preserving the reference text and replacing supported `{{title}}`, `{{context}}`, `{{person}}` placeholders; if there is no context placeholder, append an explicit context section. Never claim copy-only behavior is personalized.
- Live `recipe.run` belongs to the Google adapter: verify bound live reference document and destination folder, require read and write permissions, use native Drive copy into that folder, then bounded Docs template substitutions/context insertion on the NEW file only. Never overwrite the reference. Store the copied document ID before edits so partial failures can reconcile without making another copy. Record exact output resource, taskId and recipeId on the run. Live recipes require the separate `driveWrite` app toggle (default false), requesting the full Drive OAuth scope alongside Docs. A pasted arbitrary file URL is not Picker authorization for `drive.file`. Code restricts writes to a new copy in the explicitly bound destination; actual grant checks remain required.
- `/api/chat` accepts `{agentId,message,taskId?}`. Lead routes the contextual conversation, stores `taskId` on both messages/receipt, and passes task context to the assistant. UI inline reply should use the shared `chat(agentId,message,taskId?)` client, not duplicate the user message through a separate action. Domain may implement `task.reply` for a coded-only note, but it must not imply a model replied. `AgentMessage.taskId?: string` supports filtering the related conversation.
- UI ownership remains App/components/styles. Domain owns recipe simulation/feed helpers and tests. Google owns native-copy implementation/provider tests. Lead owns shared types/client/chat, receipt persistence and dispatch routing.

- Recipe recovery: receipts include `requestId`. `recipe.resume {requestId}` replays the original stored recipe request through the same durable phase journal. It never invents a new copy ID or blindly repeats an unknown edit. A new `recipe.run` is an explicit new document, not a retry. UI should keep/show the original failed run and offer Resume for recoverable partial runs; unknown external effects still require reconciliation.
