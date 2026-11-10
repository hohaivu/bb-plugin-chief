# Coordinator

A Coordinator is a Chief that supervises other Chiefs, in any project, instead of managed threads. It wakes only when a child Chief needs the owner or finishes.

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

`server.ts` owns the tools, the lifecycle, the sweep and the configuration. `threadStore.ts` owns the writes to `managed_threads`.

| Entry point | File | Role in this domain |
| --- | --- | --- |
| `chief_coordinate` | `server.ts` | Upgrades a Chief to a Coordinator. |
| `chief_attach` | `server.ts` | Links existing Chiefs to a Coordinator. |
| `chief_spawn` | `server.ts` | Starts a child Chief, in any project when a Coordinator calls it. |
| `chief_escalate` | `server.ts` | Triggers the Need-you alert. |
| `chief_roster` | `server.ts` | Shows the Children block to a Coordinator. |
| `handOver`, `bb chief adopt` | `server.ts` | Refuse to move work to or from a Coordinator. |
| `sweep`, `lifecycle` | `server.ts` | Trigger the Done alert. |
| `bb.agents.configure` | `server.ts` | Gives each kind of Chief its tools and instructions. |
| `setCoordinator`, `linkToCoordinator`, `insert` | `threadStore.ts` | Write the two columns. |

## Baseline (behaviour at base 95aa7df)

At base, no Coordinator exists. Every Chief is independent. This section describes the code paths that the Coordinator changes.

### Store writes (`threadStore.ts`: `insert`, `moveOpenWork`, `completeChief`)

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

### Alerts (`writeAlert`, `deliverAlert`)

- `writeAlert` takes a managed row with a `chief_thread_id`. The key is `<kind>:<detail>`. The dedupe key is `<source thread id>:<key>`.
- `writeAlert` first deletes the undelivered rows of the same source and the same kind, except the new key. Reason: a newer alert supersedes an older alert of the same kind.
- It then runs `INSERT OR IGNORE`. A repeated key adds no row.
- `deliverAlert` sends the message to `target_thread_id` with `senderThreadId` set to the source thread. It uses `queue-if-active` mode.
- A failed send records the error and leaves the row for `retryAlerts`. A retry first checks for the same text in the target's queue and last 50 messages.
- `retryAlerts` skips rows whose target is `complete`, `archived` or `deleted`. It does not filter by project.

### Chief configuration (`bb.agents.configure`, Chief branch)

- A row in state `complete`, `archived` or `deleted` gets no tools and no skills.
- The Chief tools are `chief_consult`, `chief_spawn`, `chief_forge_init`, `chief_delegate`, `chief_roster`, `chief_inspect`, `chief_continue`, `chief_stop`, `chief_review`, `chief_complete`, `chief_owner_approval`, `chief_skip_tests`, `chief_skip_specs`, `chief_escalate` and `chief_sync`.
- The list adds `chief_plan` when planning is on, and `chief_research` when research is on.
- The skills are `["chief"]`.
- The instructions hold the greeting, then the preload line for `claude-code`, then the Chief rules. The project rules come last. Reason: the SDK cuts instructions at 4096 characters.
- The preload line uses `query "+chief"` with `max_results` equal to the tool count.

## Contracts

Each contract has an identifier. Tests and reviews cite it.

### COORD-1 Upgrade

- `chief_coordinate` takes no input. It requires an active Chief caller.
- It makes an active, unlinked Chief that owns no open managed row a Coordinator. The store sets `coordinator=1` in one statement that also checks the conditions. Reason: the check and the write must not split.
- A repeated call returns "Already a Coordinator." and changes nothing.
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
- It returns one result line for each id. A bad id never blocks the other ids.
- The projects of the Chiefs do not matter. Reason: the owner decided that children live in any project.
- It refuses an id that is the caller, is not a Chief row, is complete, archived or deleted, is a Coordinator, or belongs to another Coordinator.
- For an id that is not a Chief row, the line tells the owner to run `bb chief adopt --thread <id>` first.
- An id that already belongs to the caller returns a no-op line.
- The link write is conditional. When it changes no row, the tool reads the row again and reports the reason. Reason: two callers can race.
- One level only: a Coordinator never becomes a child. A Chief has at most one Coordinator.

### COORD-5 Spawn link

- `chief_spawn` accepts an optional `projectId`. Only a Coordinator may pass it. A plain Chief that passes it gets a refusal.
- The tool validates the project before it spawns. A bad id leaves no thread and no row.
- A `todoId` with a `projectId` that differs from the caller's project is refused before the spawn. Reason: todos belong to one project.
- A Chief that a Coordinator spawns gets `coordinator_thread_id` in the same insert. The target project's existing Chief stays untouched.
- For a Coordinator caller, the handoff section says that the Coordinator supervises the child. It says when the Coordinator receives alerts. It says that the owner answers the Need you in the child thread. `brief.md` holds the same text.
- For a Coordinator caller, the result says that the new Chief is linked as a child, shows in the Children block, and alerts the Coordinator.
- For a plain Chief caller, the handoff text, the result text and `brief.md` equal the base text.
- `handOver` carries no link. The successor of a child starts unlinked. The superseded row stays in the Children block with its terminal state.

### COORD-6 Need-you alert

- `chief_escalate` accepts an optional `threadId`. Its description says to omit `threadId` only when no managed thread concerns the request yet.
- Every call by a child Chief alerts its Coordinator, on the forge path, the chat-only path and the path without `threadId`.
- With a `threadId`, the tool validates the target as before. It then alerts, before it looks for a URL.
- Without a `threadId`, the tool posts nothing on the forge and starts no tracker decision. It returns the chat-only line.
- The alert key holds a hash of the request. One child and one request give one alert. A different request gives one more alert.
- The alert message names the child, its project and the request. It says that the owner answers in the child thread and that the Coordinator must not answer or relay it.
- A Coordinator alert never deletes another pending outbox row. Reason: the key is a once-only receipt, not a same-kind replacement.
- The result of `chief_escalate` equals the base result for the same input. An alert failure never fails the call.

### COORD-7 Done alert

- A child is done when all of these conditions hold:
  1. The child row is a linked, non-terminal Chief in state `idle`.
  2. Its Coordinator is an active Coordinator.
  3. The child owns no open managed row.
  4. The child owns no open todo. A todo that waits on an `after:` condition counts as open.
  5. The child owns at least one complete managed row.
- The sweep evaluates each linked child at the end of each pass. The Chief branch of `lifecycle` evaluates the child after it records `idle`.
- Reconciliation reaches the check through the store reload, which starts the sweep.
- The alert key holds the id of the latest completed row. A repeated idle, sweep or reconcile adds no row. A new completed round alerts again.
- A planner that completes in a later sweep still produces exactly one alert. Reason: the check runs after `completeAbsorbed` settles.
- Attaching a Chief that is already idle and done produces one alert.
- Nothing else alerts a Coordinator. A child's activity, failure, archive, delete and routine progress send no alert.

### COORD-8 Roster

- `chief_roster` from a Coordinator shows a Children block. It has one entry for each linked child, in any project.
- Each entry holds the title, the id, the project id, the state and the Pending block of that child.
- The whole output keeps the existing 6000-character clip. Each child entry is clipped to share that space.
- With no children, the roster says to attach Chiefs with `chief_attach` or to start one with `chief_spawn`.
- The Coordinator's own todos follow the block.
- The roster of a plain Chief equals the base output for the same state.

### COORD-9 Configure

| Row | Tools | Skills | Preload `max_results` |
| --- | --- | --- | --- |
| Coordinator | `chief_roster`, `chief_spawn`, `chief_attach` | none | 3 |
| Plain Chief | The base list plus `chief_coordinate` | `chief`, `coordinator` | Tool count |
| Child Chief | The base list | `chief` | Tool count |

- The Coordinator greeting says that the Coordinator supervises child Chiefs in any project, not managed threads.
- The Coordinator instructions replace the Chief rules. They say that the Coordinator never edits code, never plans, delegates, reviews or completes, and attaches only Chiefs that the owner names.
- They say that the Coordinator starts new work as a child with `chief_spawn`. They say that a Need-you alert is information and the owner answers in the child.
- They say that a done alert means: check `chief_roster` and tell the owner about progress across children.
- They say that the Coordinator shares facts with a child only through `bb thread tell`, and ends its turn after it acts. It never polls children.
- The project rules appear last, and only when a project `chief.md` exists. The built-in rules never appear. Reason: they tell a Chief to continue and complete managed work.
- A child Chief gets one more instruction line before the rules. It names the Coordinator and tells the child to call `chief_escalate` before each Need you. It tells the child to omit `threadId` when no managed thread concerns the request.
- The instructions fit the 4096-character cut, with the rules last.
- Every other instruction of a plain Chief equals the base text.

### COORD-10 Migrations

- Two `ALTER TABLE managed_threads ADD COLUMN` statements follow the last existing migration (`...TRACKER_TABLES`).
  1. `coordinator INTEGER`: 1 for a Coordinator, null or 0 for a plain Chief.
  2. `coordinator_thread_id TEXT`: on a child row, the id of its Coordinator.
- No existing migration changes or moves. Reason: the host hashes each statement by its index.
- A database that exists before the change keeps its rows. Their two new columns are null.
- `chief_thread_id` never holds the link. Reason: it means "managed work of this Chief".

## Invariants

- A Coordinator has `role='chief'`. No new role exists. Reason: a new role would need a rebuild of the `managed_threads` role check.
- No write assigns a managed row to a Coordinator.
- A Chief has at most one Coordinator, and a Coordinator is never a child.
- The upsert in `insert` never clears `coordinator` or an existing `coordinator_thread_id`.
- A Coordinator alert only adds one outbox row. It never deletes another pending row.
- A Coordinator alert failure never fails the tool or the lifecycle event that caused it. The outbox retries the alert.
- The same event, repeated, adds no second alert.

## Trade-offs

- The first `configure` call for a just-spawned child can run before its insert. It then sees a plain Chief and offers `chief_coordinate` for one turn. The store predicates in COORD-1 and COORD-4 keep this safe.
- The done check scans linked children on every sweep pass. It writes only through `INSERT OR IGNORE` and does not reload the store.
- Cross-project delivery uses a child thread as `senderThreadId` for a Coordinator in another project. The same path serves an alert within one project.

## Related decisions

- [Coordinator stays a Chief row with two nullable columns](../decisions/2026-11-10-coordinator-stays-chief-row.md)
