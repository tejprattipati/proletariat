# Proletariat product specification

Proletariat brings daily work, connected resources, direct API workflows, and individual agent chats into one easy-to-navigate workspace. Users describe what they want, bind the exact resources once, and let deterministic code perform repeatable operations with visible results and low model usage.

This working specification preserves the existing product requirements in [shared contracts](CONTRACTS.md). Canonical task views, Daily reading, independently connected accounts and read-only Canvas now have implemented paths tested with fictional provider responses. Real Google/Canvas consent, institution-specific coverage and completed ChatGPT inference still require account setup and validation. Requirements below describe intended behavior; the setup and verification documents distinguish implemented checks from outstanding live validation.

## Existing capabilities remain required

- Daily Gmail and Google Calendar reading with freshness, source excerpts, honest coverage, task extraction, planning, estimates, and rollover.
- Independent named chats with selectable agents, task-linked replies, local uploads, and a Drive chooser inside the conversation.
- Direct Gmail, Calendar, Drive, Docs, and Sheets API access. Browse and search Drive, follow folder hierarchy, select files or paste links, then persist exact file, folder, tab, range, calendar, and thread bindings for reuse.
- Full Gmail and Drive scans and bulk email campaigns remain available through explicit capability toggles. Preserve drafting, sending, recipient deduplication, scheduling, pause/resume, and operation receipts; the new task model does not remove them.
- Reusable document recipes, selected destinations, controlled updates, provenance, and truthful partial/unknown-write handling.
- Per-user identity, workspace and credential isolation; explicit service consent; separate read/write/send capabilities; no anonymous private-data access or shared ChatGPT credentials.
- Low usage by design: standard service tier, no acceleration, direct API pagination and caching, deterministic scheduling and updates, incremental synchronization, and model calls only for interpretation or writing that needs them. Report measured usage; do not promise a percentage reduction without a baseline.

Existing implementation uses React/Vite, Express/Node, SQLite, direct Google adapters, encrypted credential storage, and bounded extraction workers. The changes below should extend that architecture. Detailed schemas and endpoint changes require a later coordinated implementation pass; no new endpoints are implied to exist today.

## Canonical tasks and events

The temporary Google Docs task tracker is the migration model. Import each logical task or fixed event once, give it a stable internal ID, and render linked views of that same record. Priority, category, planned-day, and deadline views must not create independent copies that can drift apart.

Records use the verified workspace owner and a stable ID. Tasks carry a title, concise next action, context, estimate, priority, state, categories, planned date, optional deadline, source identities and links, revision and lifecycle history. Fixed calendar events remain separate records with attendance windows. The shared TypeScript schema and domain projections implement this distinction.

| Dimension | Meaning |
| --- | --- |
| Priority | Relative importance; independent of completion or submission state |
| State | Pending, in progress, waiting, blocked, or completed; removal is a retained lifecycle tombstone |
| Planned date | When the user intends to work; movable by planning and rollover |
| Deadline | A hard due date or timestamp supplied by the user or provider; rollover never changes it |
| Categories | Multiple relevant nature/category tags, independent of priority and state |
| Fixed event | A scheduled attendance/time window; separate from work duration and task completion |

Initial categories are School, Clubs, Networking, Insight Programs, Campus Events, Virtual Events, and Personal/Admin. These are useful defaults, not a restriction to recruiting or student use; users may add categories. An item may belong to several categories without duplicating its identity.

For example, a networking email planned for a date appears under Medium priority, Networking, and that planned date. Each representation opens the same detail route and stable ID. Completing it from any view removes it from every active view in one local transaction, while Completed history retains its context, sources, timestamps, and receipts. Removing it similarly removes every active representation and retains history. Restoration reuses the same ID. Multi-client views reconcile to the committed revision rather than retaining stale actionable copies.

Local state and indexes must update atomically. External Google Docs or Calendar mirrors use durable, idempotent operations with visible pending/failed/unknown status; do not claim that a local database transaction also commits an external provider write. Completion does not silently delete a fixed Calendar event or send a message. External effects remain subject to the configured workflow and permissions.

## Daily organization and navigation

Extremely easy navigation is a core product requirement. Provide a home index with direct links to Daily, priority views, categories, dates, chats, resources, and history. A task/event has one direct detail link usable from every view, and source links open the exact bound artifact. Users should not have to find the original chat to understand or execute today's work.

Daily separates these sections:

1. Hard deadlines, ordered by due time, with overdue work clearly distinguished.
2. Planned work, showing next action, estimate, priority, categories, and related deadline without conflating the two dates.
3. Fixed events, showing their actual time windows and attendance context.
4. Waiting and blocked work, showing what is needed, from whom or which source, and the next follow-up when specified.
5. Completed history, outside active execution views, available by date and search.

The execution view stays concise: title, next action, estimate, state, relevant date, and completion/decision control. Detailed notes, attachments, provider status, history, exact receipts, and agent conversation are available in an expandable detail view. Navigation preserves the current filter and links back to the home index.

Rollover changes only unfinished eligible work's planned date, keeps the stable ID, categories, context, estimates, and deadline, and records history. It must not move fixed events, resurrect completed/removed work, or erase waiting/blocked state. Planning fits estimates around fixed events and user availability. Deadline conflicts or work that does not fit are visible rather than silently rescheduled past a deadline.

## Migration and source identity

Use the tracker as a model of organization, not as a permanent collection of separately editable task copies. During migration, map verified duplicate representations to one record and keep their source-location aliases and crosslinks. Do not merge distinct items merely because their titles match. Ambiguous matches require review, with the original context retained.

Provider identity is separate from internal identity. Use an owner-scoped unique key including provider instance/host, connected account, course or resource container, entity kind, and external entity ID where needed. One provider object can have several discovery aliases (for example, an assignment linked from a module and a quiz) while still mapping to one canonical obligation. Preserve the internal ID through refreshes and view changes. Manual records receive their own stable IDs.

Completion/removal tombstones survive repeated imports. Preserve user edits with explicit field ownership or correction overrides instead of replacing them with every provider payload. Retain the latest provider value alongside a conflicting user correction for review. User-controlled categories, priority, planned date, next action, and local completion remain stable unless the user changes them. Provider deadlines and submission facts remain distinguishable from local planning and completion.

## Canvas ingestion

Add an explicitly connected, read-only Canvas source for the signed-in user and the selected institution. No automatic coursework submission is allowed. Credentials remain in that user's protected namespace; reads, jobs, checkpoints, source text, and reports remain isolated. The API and permission setup must be verified against the institution before implementation claims are made.

The user-facing goal is exhaustive discovery of current-course assignments, quizzes, graded discussions, and module obligations accessible to that user. Enumerate current courses and all applicable pages in each source family. Follow provider pagination, retain resumable checkpoints, and resolve module links to their underlying assignment/quiz/discussion identity. Discovering a link is metadata discovery, not proof that the linked content or submission state was read.

Use the effective availability and due dates for the individual user, including applicable section and user overrides. Store the original provider date/time and timezone semantics; distinguish no deadline, date-only planning, and exact deadline timestamps. Do not substitute a base assignment deadline when an applicable user/section override changes it. If the effective value cannot be established, report the gap rather than presenting an invented hard deadline.

Read submission/completion information truthfully. Distinguish not submitted, submitted, pending grading, graded, excused, missing, and unknown when the provider exposes those facts. A submitted item must not appear as outstanding submission work merely because it is awaiting grading. Locally completed work and Canvas submission state are separate facts; a local checkbox must not claim a Canvas submission occurred.

No-submission readings, informational module pages, and gradebook placeholders must not become false overdue work. Classify the underlying requirement before generating an obligation:

- A submit-required assignment, quiz, or graded discussion becomes an actionable obligation using its effective dates and current submission facts.
- A reading or module completion requirement may become planned reading/completion work when an actual requirement is verified; lack of a submission artifact alone is not overdue evidence.
- Informational content, optional items, and gradebook-only placeholders remain source/context records unless an actual obligation is established.
- Locked, inaccessible, unsupported, unresolvable, or ambiguous requirements remain explicitly reported coverage gaps; do not mark them complete or silently drop them from the audit.

## Weekly refresh and reports

After the initial import, run an explicitly enabled weekly incremental refresh in the user's timezone, with a manual refresh control. Reuse known provider IDs, versions, caches, and checkpoints, while reconciling every source family needed for current-course coverage. Changed records update the same canonical item and all date/category/priority views. Keep API work bounded and resumable; model interpretation is a separate opt-in step.

The weekly report is based on durable before/after identity sets and field changes, with a report ID and coverage receipt:

- **New assignments:** IDs absent from the previous baseline and discovered in this sweep, with course, title, source link, effective deadline, and submission state. Include actionable quizzes/graded discussions as separately identified kinds.
- **Changed deadlines or statuses:** existing IDs with prior and current values, reported separately from new work. Discovery through a new module alias does not make an existing item new.
- **Coverage gaps:** per-course/source-family failures, incomplete pages, unresolved overrides, access limitations, and the last successful read. An incomplete sweep must not claim exhaustive coverage.

Initial import is labeled an initial inventory. Newly discovered does not imply newly published; after an earlier coverage gap, disclose that the item may have existed previously. A resumed sweep retains its baseline and run ID. Report delivery retries reuse the same report identity instead of creating duplicate notifications. Include newly discovered already-submitted items honestly, without adding them to the active submission queue.

Commit each page's applied changes and checkpoint coherently. Preserve correction/completion/removal history through idempotent upserts. Retain per-course successful baselines and failed segments; a partial refresh must not globally advance an exhaustive baseline, erase unseen items, or interpret absence as deletion. Source removal only changes lifecycle after an authoritative reconciliation or explicit user action, and remains auditable.

## Acceptance criteria for future implementation

These are required scenarios, not tests reported as passing in the current implementation.

| Scenario | Expected result |
| --- | --- |
| Complete a Medium-priority Networking email from its planned-day view | The same ID disappears from priority, Networking, all other active category/date views, and active Daily in one local commit; history retains the item and completion receipt |
| Remove a task from its category view | Every active representation disappears; a retained tombstone prevents repeated scans from recreating it |
| Restore a removed task | The original ID returns to its eligible views; history remains intact |
| Move planned date while keeping a deadline | Planned-day membership changes; deadline membership and provider deadline stay unchanged |
| Complete a multi-category task | Every active category representation disappears without leaving an independent copy |
| Refresh a second client after completion | It adopts the committed revision and offers no stale actionable duplicate |
| Repeat the same tracker import or Canvas sweep | No duplicate canonical tasks, events, reports, or completion resets |
| Discover one assignment through assignments, quiz, discussion, and module aliases | All relevant aliases resolve to one canonical obligation where provider linkage proves they are the same object |
| Discover two distinct assignments with identical titles | Separate provider IDs remain separate canonical obligations |
| Apply a section/user override | The user's effective deadline is shown in every due-date view; unresolved applicability is a coverage gap |
| Refresh a submitted item awaiting grading | Submission state is truthful; it is not labeled overdue submission work |
| Read a no-submission reading or gradebook placeholder | It does not become overdue solely because no submission exists; verified reading requirements remain accurately classified |
| Fail on a middle page or inaccessible course | Report partial coverage; resume without duplicates; do not remove unseen records or claim an exhaustive sweep |
| Refresh after a manual priority/category/plan/completion correction | Preserve user corrections and lifecycle; separately record provider changes and conflicts |
| Weekly sweep finds a new ID and a changed deadline on an old ID | New work and changed work appear in separate report sections with source links and coverage |
| Interrupt after applying a page, then resume | The saved page/checkpoint cannot skip obligations or repeat side effects |
| Run ingestion with model access disabled | Deterministic reads, identity reconciliation, mirrors, rollover, and weekly diff reports still work with zero model calls |
| Attempt automatic coursework submission | No such operation is available or executed |
| Fail an external mirror write | Local state stays coherent, external status is visible, and retries use the same operation identity; no false success |

## Team implementation handoff

All build lanes must preserve the existing feature set and treat this as planned work until a separately authorized implementation pass.

- **UI:** home index, direct canonical detail links, priority/category/date mirrors, multi-category controls, concise execution rows, five Daily sections, completed history, and Canvas coverage/new-versus-changed report presentation. No duplicate editable task objects per view.
- **Domain and persistence:** stable canonical identity, independent state/priority/planned date/deadline, atomic lifecycle updates and projection reconciliation, correction ownership, retained tombstones/history, migration aliases, and the cross-view/repeated-scan acceptance scenarios.
- **Integration:** read-only Canvas connection, current-course and source-family pagination, effective user/section dates, truthful submission/requirement classification, stable alias mapping, bounded incremental jobs, coherent page checkpoints, per-course coverage, and weekly baseline/report deduplication. No coursework submission.
- **Lead:** coordinate later shared schemas/actions and ownership before coding; retain account isolation, operation journals, standard tier, and usage evidence. This request does not change credentials or launch provider consent.
