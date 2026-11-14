# Coordinator

A Coordinator is a Chief that supervises other Chiefs, in any project, instead of managed threads. It wakes on a child's Need you, done, failure, end or stall.

## Terms

| Term | Meaning |
| --- | --- |
| Chief | A thread with `role='chief'` in `managed_threads`. It supervises managed threads in one project. |
| Active Chief | A Chief row whose state is not `complete`, `archived` or `deleted` (`isActiveChief`). |
| Managed row | A row of `managed_threads` with a `chief_thread_id`. The Chief that this id names owns it. |
| Open row | A managed row whose state is not `complete`, `archived` or `deleted`. Ready and blocked rows are open. |
| Coordinator | An active Chief row with `coordinator=1`. It owns no managed row. |
| Child Chief | A Chief row with `coordinator_thread_id` set to its Coordinator. |
| Plain Chief | A Chief row with no `coordinator` flag and no `coordinator_thread_id`. |
| Need-you alert | A lifecycle alert to the Coordinator. A child sends it when the child calls `chief_escalate`. |
| Done alert | A lifecycle alert to the Coordinator. A child sends it when the child finishes all its work. |
| Outbox | The `alert_outbox` table. It stores each alert until its delivery succeeds. |

## Ownership and entry points

Dedicated tool and runtime modules own the tools, the lifecycle, the sweep, the alerts, and configuration. `src/db/threadStore.ts` owns the writes to `managed_threads`.

| Entry point | File | Role in this domain |
| --- | --- | --- |
| `chief_coordinate` | `src/tools/coordinate.ts` | Upgrades a Chief to a Coordinator. |
| `chief_attach` | `src/tools/attach.ts` | Links existing Chiefs to a Coordinator. |
| `chief_spawn` | `src/tools/spawn.ts` | Starts a child Chief in any project when a Coordinator calls it. |
| `chief_escalate` | `src/tools/escalate.ts` | Triggers the Need-you alert. |
| `chief_roster` | `src/tools/roster.ts` | Shows the Children block to a Coordinator. |
| `handOver`, `replaceChief` | `src/runtime/chiefs.ts` | Preserve Coordinator links and handle orphan recovery without moving work across Coordinators. |
| `bb chief adopt` | `src/runtime/cli.ts` | Refuses to move work across Coordinators and adopts registered Chiefs. |
| `sweep` | `src/runtime/sweep.ts` | Triggers state evaluation and done alerts. |
| `lifecycle`, supervisor, orphan recovery | `src/runtime/lifecycle.ts` | Track active cycles, trigger problem alerts, and supervise orphan recovery. |
| `bb.agents.configure` | `src/runtime/host.ts` | Gives each kind of Chief its tools and instructions. |
| Alerts (`alertCoordinator`, `stalledKey`, `stillDue`) | `src/runtime/alerts.ts` | Build, serialize, check freshness, and deliver Coordinator alerts and notices. |
| `setCoordinator`, `linkToCoordinator`, `inheritCoordinator`, `insert` | `src/db/threadStore.ts` | Write Coordinator columns and maintain links. |

## Baseline (behaviour at base 95aa7df)

At base, no Coordinator exists. Every Chief is independent. This section describes the code paths that the Coordinator changes.

### Store writes (`src/db/threadStore.ts`: `insert`, `moveOpenWork`, `completeChief`)

- `insert` writes one row. When the `thread_id` exists, it updates the row in place (`ON CONFLICT`).
- The update keeps `parent_thread_id`, `replaces_thread_id` and `planner_on` when the new value is null. It replaces the other listed columns.
- `insert` has no column for a link between Chiefs.
- `completeChief` sets the state of one row to `complete`.
- `moveOpenWork` sets `chief_thread_id` to the successor for each open row of the previous Chief in the same project.
- Each write reloads the cache, once for each write or once for each `store.batch`.

### Chief resolution (`activeChiefForProject`, `latestChiefForProject`, `owningChief`, `ensureChief`)

- `activeChiefForProject` selects the newest Chief row of a project that has no `chief_thread_id` and whose state is not `failed`, `deleted`, `archived` or `complete`.
- `latestChiefForProject` selects the newest Chief row of the project in any state.
- `owningChief` returns the caller when the caller is a Chief. Otherwise it returns the active Chief of the caller's project. It throws when no Chief exists or the Chief is complete.
- `ensureChief` returns the active Chief of a project after it reconciles that Chief. When none lives, it calls `spawnChief` with the latest Chief as `previous`.
- `ensureChief` runs once at a time for each project (`chiefStarts`).

### Spawn and handover (`spawnChief`, `handoffSection`, `createChief`, `handOver`)

- `createChief` calls `spawnChief` with no `previous`. It never hands over.
- `spawnChief` starts a thread in the target project. It gives the thread a title, a prompt and the metadata `role: chief`.
- With a handoff, the prompt ends with `handoffSection`. The section says that the handing-off Chief "keeps no link to you".
- When `previous` exists, `spawnChief` calls `handOver` before it inserts the new row.
- `handOver` runs in one `store.batch`. It completes the previous Chief and moves its open rows. It retargets undelivered outbox rows. It moves its `chief_todos`.
- Reason: a successor must keep the open work, the alerts and the todos.

### `chief_spawn` (execute)

- The tool requires an active Chief caller.
- It validates `todoId` before it spawns. The todo must be an open todo of the caller.
- It starts the new Chief in the caller's project through `createChief`.
- The result says that the new Chief "is not your managed work": it is not in the roster, sends no alerts, and the caller cannot inspect or steer it.
- It writes `brief.md` with the handoff section. It retries up to 3 times and reports a failure in the result.

### `chief_escalate` (execute)

- The input is `threadId`, `request` and optional `merge`.
- The tool requires an active Chief caller. It checks the target through `controlledTarget`.
- Without `merge`, it starts the tracker decision in the background.
- Without a pull request or issue URL, it returns the chat-only line.
- Otherwise it queues one forge comment. The key holds `threadId` and a hash of `request`. The same request queues nothing new.
- The tool posts no alert to any Chief. `tracker.md` and `forge-comments.md` describe the forge parts.

### `bb chief adopt`

- The command reads the registered row. It refuses a row whose role is not `chief`.
- It renames the thread and files it in the Chief section.
- It selects the project's active Chief as `previous`. When `previous` is another thread, it calls `handOver`.
- It then calls `store.insert` with the thread as a Chief row.
- Adopting a registered Chief row rewrites that row in place.

### Chief lifecycle (`lifecycle`, Chief branch)

- On `idle` and `failed` events, `lifecycle` starts `sweep()` first.
- A row in state `complete` ignores every event except `deleted`.
- For a Chief row, `lifecycle` maps the event to a state and calls `recordState`. The states are `active`, `idle`, `failed`, `archived` and `deleted`.
- It then returns. A Chief event sends no alert.

### Sweep and reconcile (`sweep`, `completeAbsorbed`, `reconcileThread`)

- `sweep()` runs one pass at a time. A request during a pass queues exactly one more pass.
- A pass calls `completeAbsorbed`. It completes a supporting row after a fresh `threads.get` shows the row live and not busy.
- `sweep()` runs after each store reload once `pendingReady` is set, on `idle` and `failed` events, and after `reconcile()` in the supervisor loop.
- `reconcileThread` reads the live thread. It records a deleted or archived thread. It moves the thread to the Chief section. It syncs the row state and status with the live thread.
- An unchanged row causes no write and no reload. A changed row writes through `store.syncLive`, which reloads the store and starts the sweep.

### Alerts (`writeAlert`, `insertAlert`, `deliverAlert`)

- `writeAlert` takes a managed row with a `chief_thread_id`. The key is `<kind>:<detail>`. The dedupe key is `<source thread id>:<key>`.
- `writeAlert` first deletes the undelivered rows of the same source and the same kind, except the new key. Reason: a newer alert supersedes an older alert of the same kind.
- It then delegates to `insertAlert`. A repeated key adds no row.
- `deliverAlert` sends the message to `target_thread_id` with `senderThreadId` set to the source thread. It uses `queue-if-active` mode.
- A failed send records the error and leaves the row for `retryAlerts`. A retry first checks for the same text in the target's queue and last 50 messages.
- `retryAlerts` skips rows whose target is `complete`, `archived` or `deleted`. It does not filter by project.
- Contract COORD-11 defines the durable outbox delivery rules after this baseline.

### Chief configuration (`bb.agents.configure`, Chief branch)

- A row in state `complete`, `archived` or `deleted` gets no tools and no skills.
- The base list is `chief_consult`, `chief_spawn`, `chief_forge_init`, `chief_delegate`, `chief_roster`, `chief_inspect`, `chief_continue`, `chief_stop`, `chief_review`, `chief_complete`, `chief_owner_approval`, `chief_skip_tests`, `chief_skip_specs`, `chief_escalate` and `chief_sync`.
- The list adds `chief_plan` when planning is on, and `chief_research` when research is on.
- A plain Chief also gets `chief_coordinate` and `chief_attach`. A plain Chief has 19 tools with planning and research on. A child Chief has 17. A Coordinator has 3.
- The skills are `["chief"]`.
- The instructions hold the greeting, then the preload line for `claude-code`, then the Chief rules. The project rules come last. Reason: the SDK cuts instructions at 32,768 characters.
- The preload line is `select:` followed by the exact `mcp__bb-bridge__` names of the row's tools, in the host's selected order.

## Contracts

Each contract has an identifier. Tests and reviews cite it.

### COORD-1 Upgrade

- `chief_coordinate` accepts an optional `goal` parameter (at most 4,000 characters). It requires an active Chief caller.
- On success with `goal`, it writes `brief.md` containing `## Coordinator brief` and the owner request verbatim. Reason: the intent of the owner survives compaction.
- If writing `brief.md` fails, the tool appends the error to its output, and the upgrade stands.
- It makes an active, unlinked Chief that owns no open managed row a Coordinator. The store sets `coordinator=1` in one statement that also checks the conditions. Reason: the check and the write must not split.
- A repeated call returns "Already a Coordinator." and changes nothing. It writes no file.
- A child Chief gets a refusal that names its Coordinator.
- A Chief that owns any open row gets a refusal that lists the row ids. Ready and blocked rows count as open.
- Open todos do not block the upgrade. They stay with the Coordinator.
- The upgrade renames the thread: a leading `Chief ·` becomes `Coordinator ·`, and the rest of the title stays. The row title changes in the same statement.
- The success text says that the upgrade is one-way, that the Coordinator runs no managed threads, and how to attach, spawn and read the roster.
- No tool, CLI command or SQL statement clears `coordinator`. Reason: the owner decided that the upgrade is one-way.

### COORD-2 Purity

- A Coordinator receives exactly `chief_roster`, `chief_spawn` and `chief_attach`.
- These tools refuse a Coordinator at execution time: `chief_plan`, `chief_consult`, `chief_delegate`, `chief_forge_init`, `chief_review`, `chief_inspect`, `chief_continue`, `chief_stop`, `chief_complete`, `chief_owner_approval`, `chief_skip_tests`, `chief_skip_specs`, `chief_escalate`, `chief_sync` and `chief_research`.
- The CLI commands `plan`, `consult`, `delegate` and every managed-Chief command that acts on a target refuse a Coordinator in the same way.
- The refusal text says that the tool is not available to a Coordinator and names the roles that it does not run. It tells the caller to ask the child Chief that owns the work.
- `chief_report` keeps its own rejection. `chief_log` still returns "Not part of a plan run." A repeated `chief_coordinate` still returns "Already a Coordinator."
- `activeChiefForProject` and `latestChiefForProject` never select a Coordinator. Reason: project-level routing, `bb chief start` and `ensureChief` must not land on a Coordinator or supersede it.
- `chiefCountForProject` still counts Coordinators. It only numbers titles.
- `bb chief start` in the project of a Coordinator starts a plain Chief there.

### COORD-3 Ownership

- A Coordinator never owns a managed row.
- `handOver` throws before any write when the previous or the next row is a Coordinator.
- `bb chief adopt` of a Coordinator fails before it updates the thread, calls `handOver` or calls `store.insert`. The previous Chief of the project stays active and keeps its work.
- Adopting a child Chief keeps its link. The `insert` upsert never clears `coordinator`. It keeps an existing `coordinator_thread_id`.
- Reason: every alert, stall, sweep and roster path treats a managed row as work of a Chief.

### COORD-4 Attach

- `chief_attach` takes 1 to 20 thread ids. Only an active Coordinator may call it.
- Every plain Chief has the tool, so a Chief that `chief_coordinate` upgrades can attach without a restart. The handler refuses any caller that is not an active Coordinator. Reason: BB applies tools only when it builds a session.
- It returns one result line for each id. A bad id never blocks the other ids.
- The projects of the Chiefs do not matter. Reason: the owner decided that children live in any project.
- It refuses an id that is the caller, not a Chief row, a Coordinator, or linked to another live Coordinator. It also refuses complete, archived, or deleted Chiefs.
- A child whose previous Coordinator is in a terminal state (complete, archived, or deleted) can be taken over. The conditional write replaces the link to that terminal Coordinator.
- For an id that is not a Chief row, the line tells the owner to run `bb chief adopt --thread <id>` first.
- An id that already belongs to the caller returns a no-op line.
- In the same store batch, an idle-done child receives a delivered done receipt (`baselineDone`), so attach sends no done alert. Reason: avoid alert storms when attaching finished work.
- After the batch, each successfully attached child receives one `coordinator-attached:<id>` notice (`alertSelf`). The notice instructs the child to escalate and explains how to treat a tell message. Reason: a running child learns its new rules on its next turn.
- The link write is conditional. When it changes no row, the tool reads the row again and reports the reason. Reason: two callers can race.
- One level only: a Coordinator never becomes a child. A Chief has at most one Coordinator.

### COORD-5 Spawn link

- `chief_spawn` accepts an optional `projectId`. Only a Coordinator may pass it. A plain Chief that passes it gets a refusal.
- The tool validates the project before it spawns. A bad id leaves no thread and no row.
- A `todoId` with a `projectId` that differs from the caller's project is refused before the spawn. Reason: todos belong to one project.
- A Chief that a Coordinator spawns gets `coordinator_thread_id` in the same insert. The target project's existing Chief stays untouched.
- For a Coordinator caller, the handoff section says that the Coordinator supervises the child. It names Need you, done, fail, end, and stall alerts. It says that the owner answers the Need you in the child thread. `brief.md` holds the same text.
- For a Coordinator caller, the result says that the new Chief is linked as a child, shows in the Children block, and alerts the Coordinator.
- For a plain Chief caller, the handoff text, the result text and `brief.md` equal the base text.
- Work handed over from a child stays with that child's live Coordinator.
- `handOver` (`store.inheritCoordinator`), `spawnChief` (with `previous`), and `bb chief adopt` give the successor the link of the previous child when that Coordinator is live.
- A successor is compatible only when it has no live link or shares the same live Coordinator (`compatibleSuccessor`).
- `handOver` and `bb chief adopt` refuse an incompatible pair before any write. Reason: two Coordinators can have children in one project, and work must never switch Coordinators silently.
- Orphan recovery starts a dedicated successor (`replaceChief`) instead of reusing a Chief of another Coordinator.
- An unlinked project Chief that receives work from an orphan becomes a child of that Coordinator.
- The superseded row stays in the Children block with its terminal state.

### COORD-6 Need-you alert

- `chief_escalate` accepts an optional `threadId`. Its description says to omit `threadId` only when no managed thread concerns the request yet.
- Every call by a child Chief alerts its Coordinator, on the forge path, the chat-only path and the path without `threadId`.
- The alert precedes every early return.
- With a `threadId`, the tool validates the target before sending the alert.
- Without a `threadId`, the tool posts nothing on the forge and starts no tracker decision. It returns the chat-only line.
- The dedupe key is `<child>:coordinator-need-you:<sha1(request)[:12]>:<child.active_cycle>`. Reason: a repeated question in a new turn delivers a new alert after the owner answers.
- Rows written before this format (`<child>:coordinator-need-you:<sha12>`) remain deliverable while the child stays linked to that live Coordinator.
- The alert message names the child, its project, and the request clipped to 600 characters. It appends `PR: <url>` when the concerned thread has a URL. It states that the owner answers in the child thread.
- The message omits instructions to not answer or relay because Coordinator instructions already enforce that rule.
- A Coordinator alert never deletes another pending outbox row, except older undelivered done rows of the same child. Reason: the key is a once-only receipt.
- The result of `chief_escalate` equals the base result for the same input. An alert failure never fails the call.

### COORD-7 Done alert

- A child is done when all of these conditions hold:
  1. The child row is a linked, non-terminal Chief in state `idle`.
  2. Its Coordinator is an active Coordinator.
  3. The child owns no open managed row.
  4. The child owns no open todo. A todo that waits on an `after:` condition counts as open.
  5. The child owns at least one complete managed row.
- The sweep and every Chief lifecycle state write evaluate done through `alertCoordinator(row, { kind: "state" })`.
- Reconciliation reaches the check through the store reload, which triggers the sweep.
- The alert key is `<child>:coordinator-done:<newest complete owned row id>`.
- A repeated idle, sweep, or reconcile adds no row. A new completed round alerts again.
- A planner that completes in a later sweep still produces exactly one alert. Reason: the check runs after `completeAbsorbed` settles.
- The alert message carries an outcome of at most 300 characters. The outcome lists the newest 3 completed owned row titles (clipped to 80 characters) and PR URLs.
- Inserting a new done alert evicts older undelivered done rows of the same child. Reason: a newer completion outcome replaces older undelivered done messages.

### COORD-8 Roster

- `chief_roster` from a Coordinator shows a Children block listing non-terminal linked children in any project.
- Each entry holds the title, thread id, project id, state, and Pending block of that child.
- Each entry appends ` · needs the owner since <ISO>` when the child is idle and a need-you alert exists for its current active cycle.
- When closed children exist, the Children block appends `closed: N`.
- The whole output keeps the 6,000-character clip. Each live child entry receives a share of 4,000 characters divided by the count of live children.
- With no children, the roster instructs how to attach or spawn Chiefs.
- The Coordinator's own todos follow the block.
- Each child entry and the Coordinator's own block collapse the todos of other, ended or no Chiefs into one count line, as `work-list.md` states. `includeOthers: true` expands all of them. Reason: a Chief reads its own work first.
- The roster of a plain Chief equals the base output for the same state.

### COORD-9 Configure

| Row | Tools | Skills | Preload names |
| --- | --- | --- | --- |
| Coordinator | `chief_roster`, `chief_spawn`, `chief_attach` | none | 3 |
| Plain Chief | The base list plus `chief_coordinate` and `chief_attach` | `chief`, `coordinator` | Tool count (19 with planning and research on) |
| Child Chief | The base list | `chief` | Tool count (17 with planning and research on) |

- The Coordinator greeting states that the Coordinator supervises child Chiefs in any project, not managed threads.
- The Coordinator instructions replace the Chief rules. They state that the Coordinator never edits code, never plans, delegates, reviews or completes, and attaches only Chiefs that the owner names.
- They instruct the Coordinator to call `chief_roster` at the start of every turn and again after any compaction, and re-read `$BB_THREAD_STORAGE/brief.md` when it exists.
- They state that the Coordinator starts new work as a child with `chief_spawn`.
- They explain each alert kind. A Need-you alert is information that the owner answers in the child thread. A done alert carries the child outcome. Failed, ended, or stalled alerts name problems the Coordinator cannot fix.
- For each alert, the Coordinator informs the owner about status across children.
- They state that the Coordinator shares facts with a child only through `bb thread tell`, and ends its turn after it acts. It never polls children.
- The project rules appear last, and only when a project `chief.md` exists. The built-in rules never appear. Reason: they tell a Chief to continue and complete managed work.
- A child Chief gets one instruction line before the rules only while its Coordinator is live. The line names the Coordinator and tells the child to call `chief_escalate` before every Need you (omitting `threadId` when no managed thread concerns it).
- The line instructs the child that a `bb thread tell` from the Coordinator is coordination information, not the decision of the owner.
- The instructions fit the 32,768-character limit, with rules last.
- Every other instruction of a plain Chief equals the base text.

### COORD-10 Migrations

- Two `ALTER TABLE managed_threads ADD COLUMN` statements follow the last existing migration (`...TRACKER_TABLES`).
  1. `coordinator INTEGER`: 1 for a Coordinator, null or 0 for a plain Chief.
  2. `coordinator_thread_id TEXT`: on a child row, the id of its Coordinator.
- No existing migration changes or moves. Reason: the host hashes each statement by its index.
- A database that exists before the change keeps its rows. Their two new columns are null.
- `chief_thread_id` never holds the link. Reason: it means "managed work of this Chief".

### COORD-11 Alert outbox delivery

- `insertAlert` formats each newly stored message as `[<label>]\n<body>` clipped to leave room for the marker, followed by `\n[alert <id>]`.
- The marker identifier `<id>` is the first 10 hexadecimal characters of `sha1(dedupe_key)`.
- The default alert label is `Chief lifecycle alert`.
- Pre-existing outbox rows keep their text without rewriting.
- Retries match older rows that lack a marker by exact message text. Reason: a retry finds its own earlier copy even when BB rewraps the text or another round has identical wording.
- `retryDue` and `pendingAlerts` require a row with attempts `n > 0` to wait `min(30000 * 2^(n - 1), 1800000)` milliseconds after `last_attempt_at`.
- `pendingAlerts` requires a row with zero attempts to wait 60 seconds before batch selection.
- Coordinator rows that contain `:coordinator-` in `dedupe_key` stop retrying after 10 attempts.
- Other alerts retry without an attempt cap. Reason: a worker receives instructions not to report again.
- Rows that backoff or retry caps skip occupy no slot in the 100-row limit of `pendingAlerts`.
- Direct delivery calls in `deliverAlert` enforce the same backoff and attempt cap as `pendingAlerts`.
- `deliverAlert` returns false for a deferred or capped row and sends no message.
- A first delivery attempt is immediate.
- `deliverAlert` increments `attempts` and writes `last_attempt_at` before sending via `threads.send`. Reason: crashes during delivery leave attempt records for subsequent retries.
- On any retry with prior attempts, `deliverAlert` invokes `stillDue` before inspecting target messages.
- `deliverAlert` settles a stale row by setting `delivered_at` and setting `last_error` to start with `stale: ` without sending.
- A worker stall alert is stale once that worker leaves its active cycle.
- When an active retry remains due, `deliverAlert` checks the target queue and the last 50 `userMessage` events for the marker or legacy exact text.
- If the target holds the marker or exact text, `deliverAlert` marks the row delivered and skips sending.
- `MIGRATIONS` in `src/db/migrations.ts` appends `ALTER TABLE alert_outbox ADD COLUMN last_attempt_at INTEGER`. Reason: the host platform hashes migration statements by array index.

### COORD-12 Problem alerts

- The supervisor evaluates problem alerts for linked children every 30 seconds using the `stallMinutes` threshold (default 15 minutes).
- `lifecycle` active events for a Chief row increment `active_cycle` and set `active_since` (`store.markActive`).
- Reconcile and lifecycle events check `state !== 'active'` before updating `active_cycle` to prevent duplicate increments.
- A Chief in state `failed` sends a failed alert once per active cycle (`<child>:coordinator-failed:<active_cycle>`).
- A Chief in state `archived` or `deleted` sends an ended alert once per state (`<child>:coordinator-ended:<state>`).
- The stalled alert has two branches and fires at most once per active cycle:
  1. Active branch: the child state is `active`, and `now - active_since >= stallThresholdMs`. Dedupe key: `<child>:coordinator-stalled:<active_cycle>:active`.
  2. Idle branch: the child state is `idle`, owns at least one open managed row or open unblocked todo, no owned open row is busy, no current-cycle need-you exists, and quiet time meets or exceeds `stallThresholdMs`. Dedupe key: `<child>:coordinator-stalled:<active_cycle>:idle`.
- Stalled alerts never fire when an owned row is busy, when a need-you exists for the current cycle, or when no open work remains.
- Each problem alert tells the Coordinator to inform the owner.
- A complete (superseded) child never sends failed, ended, or stalled alerts.

### COORD-12a Retry freshness

- Before delivering a retried alert (`attempts > 0`), `stillDue` verifies the alert against the condition that created it.
- A retried alert is settled as stale (marked delivered with `last_error` starting with `stale:`) and never sent when:
  1. The child row no longer exists or was superseded (`complete`).
  2. The Coordinator link changed or is no longer an active Coordinator.
  3. A fresh condition evaluation produces a different key.
- For stalled alerts, work going busy, a new need-you arrival, new child activity, or a turn change settles the alert as stale.
- An ended alert is historical and remains always due.
- A legacy need-you row (`<child>:coordinator-need-you:<sha12>`) remains due as long as the child remains linked to the same live Coordinator.

### COORD-13 Notices to children

- Notices to children use the label `[Coordinator notice]` and send via `alertSelf` with no sender thread id.
- An attached notice (`<child>:coordinator-attached:<coordinatorId>`) notifies an attached child that a Coordinator now supervises it.
- A gone notice (`<child>:coordinator-gone:<coordinatorId>`) notifies an active child when its Coordinator enters state `archived` or `deleted`.
- A gone notice instructs the child to notify the owner and states that another Coordinator can attach it.
- A retried gone notice settles as stale if another Coordinator attaches the child.
- Coordinator alerts sent to Coordinators use the label `[Coordinator alert]`.

## Invariants

- A Coordinator has `role='chief'`. No new role exists. Reason: a new role would need a rebuild of the `managed_threads` role check.
- No write assigns a managed row to a Coordinator.
- Managed work never moves from one Coordinator's child to another Coordinator's child. Reason: work must not switch Coordinators silently.
- A Chief has at most one Coordinator, and a Coordinator is never a child.
- The upsert in `insert` never clears `coordinator` or an existing `coordinator_thread_id`.
- A Coordinator alert only adds one outbox row. It never deletes another pending row, except an older undelivered done row of the same child.
- A Coordinator alert failure never fails the tool or the lifecycle event that caused it. The outbox retries the alert.
- The same event, repeated, adds no second alert.

## Trade-offs

- The first `configure` call for a just-spawned child can run before its insert. It then sees a plain Chief and offers `chief_coordinate` for one turn. The store predicates in COORD-1 and COORD-4 keep this safe.
- The done check scans linked children on every sweep pass. It writes only through `INSERT OR IGNORE` and does not reload the store.
- Cross-project delivery uses a child thread as `senderThreadId` for a Coordinator in another project. The same path serves an alert within one project.
- Outbox rows in `alert_outbox` are never pruned. Delivered rows serve as once-only receipts for research alerts, thread failure events, done notices, and retro evidence.
- The need-you receipt is tracked per child turn. A child that repeats the same pending Need you in a later turn alerts again. This repetition is accepted over losing a genuine re-ask. The "needs the owner" status clears when the child next becomes active.
- An unlinked project Chief that receives work from an orphaned child becomes that Coordinator's child, keeping its own work.

## Related decisions

- [Coordinator stays a Chief row with two nullable columns](../decisions/2026-11-10-coordinator-stays-chief-row.md)
