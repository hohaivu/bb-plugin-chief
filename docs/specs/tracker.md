# Tracker

## Purpose

The tracker domain mirrors Chief work to tasks in an external task tracker. bb Tasks is the first adapter. The domain also carries the owner's answer to a decision from the task back to Chief. The feature is optional and off by default.

## Domain Terms

- **Tracker**: the external system that holds tasks. The setting `tracker` selects it.
- **Adapter**: the one file that knows the commands and words of one tracker. `src/tracker/trackerBbTasks.ts` is the only adapter.
- **Task**: the tracker record that mirrors one unit.
- **Unit**: one piece of Chief work that has one task. A row in `tracker_units` stores it.
- **Root**: the thread that names a unit. For a plan, the root is the oldest planner of its `replaces_thread_id` chain. For unplanned work, the root is the oldest worker of that chain. When that worker shares a `pr_url` or `branch` with an earlier worker of the same project, the root is the root of the oldest such worker.
- **Effective plan**: the newest planner of a plan family with `plan_waves` in the state `ready` or `complete`. If none exists, it is the root planner. A family is the root planner and the planners that revise it.
- **Tip**: the newest worker of an unplanned `replaces:` chain.
- **Receipt**: one remote write that the plugin owes the tracker. A row in `tracker_receipts` stores it. `state IS NULL` means pending. The other states are `sent` and `failed`.
- **Marker**: a line of text that proves an earlier call reached the tracker. A unit marker is `chief-unit:<12 hex>`. A decision marker is `chief-decision:<ref>`. A request marker is `chief-request:<thread id>`.
- **Joined chain**: an unplanned `replaces:` chain whose root comes from earlier work on the same pull request or branch.
- **Decision**: a **Need you** request that Chief posts as a comment on the task.
- **Flag**: the label that shows an open decision on the task.
- **Sync pass**: one run of `sync()`.

## Ownership and Entry Points

| Entry point | File | Role |
| --- | --- | --- |
| `Tracker` interface, `trackerProjects(raw)` | `src/tracker/tracker.ts` | Pure types and the parser of the project map. It does no I/O. It names no tracker. |
| `trackerSelector(deps)(raw)` | `src/tracker/trackerBbTasks.ts` | Maps the setting value to an adapter or `null`. It is the only place that holds the literal `bb-tasks`. |
| `bbTasksTracker(deps)` | `src/tracker/trackerBbTasks.ts` | The adapter. It runs `bb tasks` commands. |
| `createTrackerSync(deps)` with `start`, `attachFiles`, `decide`, `sync` | `src/tracker/trackerSync.ts` | Owns the tables, the unit resolution, the receipts, the status, the flag, and the answer poll. |
| `TRACKER_TABLES` | `src/tracker/trackerSync.ts` | The two table statements. `server.ts` spreads them at the end of `MIGRATIONS`. |
| Settings, hooks, `prMerged`, `answerAlert` | `server.ts` | Compose the parts. They hold no unit rule and no status rule. |
| `trackFiles` adapter | `src/report/reportIntake.ts` | Hands accepted plan files and verdict files to the sync. |

The Chief model never runs tracker commands. Plugin code makes every tracker call.

## Baseline: Behaviour at 310043a

This section describes the code before the tracker. Every path below is trackerless. The sections after it state what this change adds.

Code paths:

- `bb.settings.define` in `server.ts`.
- `startPlan` and `startWorker` in `server.ts`.
- `report()` in `src/report/reportIntake.ts`.
- The `chief_escalate` tool in `server.ts`.
- The supervisor service in `server.ts`.
- `writeAlert`, `deliverAlert`, `alertChief`, `retryAlerts`, and `handOver` in `server.ts`.

### Settings

`bb.settings.define` declares the settings. It has no tracker setting. The code reads a value with `settings.get()` when it needs the value.

### Spawn

- `startPlan` launches a read-only planner and stores a managed row. With `revises`, the row stores `replaces_thread_id`.
- `startWorker` launches a worker and stores a managed row. It stores `plan_thread_id`, `plan_wave`, and `replaces_thread_id` when they apply. After a launch with `replaces:`, it completes the replaced worker as superseded and re-points the review ledger.
- Neither function calls an external service. Only the forge comments reach outside the plugin.

### Report files

`report()` in `src/report/reportIntake.ts` accepts a `chief_report` call. Two steps write files.

- A planner ready report with a plan calls `writePlan`. It writes `plan-<n>.md` for each wave to the artifact folder of Chief.
- A reviewer report with a verdict calls `writeArtifact` with the verdict file `verdict-<seq>.md`. The write is best-effort.
- `alertChief` then writes the outbox row and sends the alert.

`report-intake.md` describes the full order.

### Escalation

`chief_escalate` takes `threadId` and `request`. It checks that the caller is the active Chief and that the thread belongs to it.

1. It finds the target URL: the pull request of the thread, else its issue, else (reviewer) a pull request of a review target, else (planner) the plan issue.
2. With no URL, it returns `No pull request or issue to post on; write the request in chat only.`
3. Otherwise it queues a forge comment through `forgeComments.enqueue`. The key is `escalate:<threadId>:<12 hex of sha1(request)>`. The same request twice posts one comment.
4. It returns `Queued for <url>. Now write the same request in chat under **Need you**.` when the queue accepts the comment.

### Supervisor

The supervisor loop runs every `RECONCILE_INTERVAL_MS` (30 s). One cycle runs these steps in order:

1. `reconcile`, `sweep`, and `checkUnreported`.
2. The stall alerts.
3. The hand-over of the open work of an archived or deleted Chief.
4. `retryAlerts` and `observeCleanup`.
5. `void forgeComments.drain()`.

A thrown error in the cycle logs a warning. The loop continues.

### Alert outbox

- `writeAlert` stores one row in `alert_outbox` with the key `<source thread id>:<key>`. It deletes undelivered rows of the same source and the same kind. The kind is the key segment before the first `:`. Reason: a newer alert supersedes an older undelivered alert of that kind, and other kinds never evict it.
- `deliverAlert` sends the row to the target thread. After an earlier failed attempt, it first checks the queued messages and the last 50 completed items of the target for the same text. Reason: a retry must not duplicate a message that arrived.
- The delivery is at-least-once. A rewritten message or a message older than 50 items can duplicate. The code comment states this limit.
- `retryAlerts` retries undelivered rows older than 60 s in each supervisor cycle.
- `handOver` re-targets undelivered rows from the previous Chief to its replacement. Reason: alerts follow the open work.

## Tracker Behaviour (this change)

### Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `tracker` | `none` | `none` or `bb-tasks`. `bb-tasks` mirrors Chief work to bb Tasks. Off deletes nothing. |
| `trackerProjects` | empty | One line or comma entry for each project, in the form `proj_abc=ABC`. It maps a Chief project to a tracker project. |

- `trackerSelector` trims the value of `tracker`. Only the exact string `bb-tasks` returns an adapter. Any other value returns `null`. Examples: `""`, `BB-TASKS`, `linear`, `undefined`, and a number.
- The selector builds one adapter for each selector and returns that same instance each time. Reason: the adapter caches persist.
- `trackerProjects` splits entries on newlines or commas, trims them, ignores malformed entries, and keeps the last entry of a repeated project.
- The sync reads the settings once at the start of each hook and each pass. A rejected read gives off and logs the error.

### Protocol

`Tracker` in `src/tracker/tracker.ts` is the only interface that the sync knows. All task ids are opaque strings. Only the adapter knows the vocabulary of a tracker.

| Method | Purpose |
| --- | --- |
| `available()` | Reports whether the tracker answers. |
| `findTask(project, marker)` | Returns the id of the task whose description contains the marker, else `null`. |
| `createTask({ project, title, description })` | Creates a task and returns its id. |
| `setStatus(taskId, status)` | Sets one of `planning`, `working`, `review`, `done`. |
| `attachThread(taskId, threadId)`, `detachThread(taskId, threadId)` | Links a thread to the task, or removes the link. |
| `linkPullRequest(taskId, url)` | Records the pull request URL on the task. A second call with the same URL changes nothing. |
| `attachFile(taskId, { name, content })` | Attaches a file to the task. |
| `comments(taskId)` | Returns the comments, oldest first, each as `{ id, byOwner, body, at }`. |
| `postComment(taskId, body)` | Posts the body as given and returns the comment id. It is the only method that posts a comment: decision comments and follow-up request comments. |
| `setDecisionFlag(project, taskId, open)` | Sets or clears the flag. |

`server.ts` selects the adapter at the composition seam. The sync receives `Tracker | null`. Replacing bb Tasks needs one new adapter file, one import in `server.ts`, and the text of the `tracker` setting.

### The bb Tasks adapter

`bbTasksTracker` runs `bb tasks <args> --json` with `BB_CLI` or `bb`, a 30 s timeout, and the server `PATH`. Its environment is `process.env` without `BB_THREAD_ID` and `BB_PROJECT_ID`, for every call. A nonzero exit, or `{"ok":false,"error":{code,message}}` on stdout, throws `Error("<code>: <message>")`.

| Method | bb Tasks command |
| --- | --- |
| `available` | `status`. A success gives true. The adapter caches both outcomes for 5 min. |
| `findTask` | `list --project <P> --search <marker>`. It picks the first task whose `description` contains the marker. |
| `createTask` | `create --project <P> --title <t> --description <d>`. The task `id` is a ULID. |
| `setStatus` | `update <id> --status`. The map is planning to `todo`, working to `in_progress`, review to `in_review`, done to `done`. |
| `attachThread`, `detachThread` | `attach <id> --thread <t>`, `detach <id> --thread <t>`. |
| `linkPullRequest` | `show <id>`. If the description lacks the URL, `update <id> --description` adds the line `Pull request: <url>`. |
| `attachFile` | Writes the content to a temporary folder on the plugin server. It runs `attachment add <id> --file <path> --name <name>`. It removes the folder in `finally`. |
| `comments` | `show <id>`. A comment of `kind` `user` has `byOwner` true. |
| `postComment` | `comment <id> --body <body> --author Chief`. It never passes `--notify`. |
| `setDecisionFlag` | Open: ensure the label `needs-decision` exists in the project, then `update <id> --add-label needs-decision`. Closed: `update <id> --remove-label needs-decision`. The adapter caches the label check for each project. |

Reasons:

- The adapter removes the thread identity from the environment. A comment with no thread identity is a plain user comment. Tasks then has no agent reply of Chief to notify.
- Bodies and descriptions go inline as arguments. The only file is an attachment. It comes from the plugin server, and Tasks reads it on the server machine.

### Unit of work

A unit is one root. `trackerSync` resolves the root of a row. It walks every chain with loop protection.

| Row | Root |
| --- | --- |
| Planner | The oldest planner of its `replaces_thread_id` chain. |
| Worker with `plan_thread_id` | The root of that planner. |
| Unplanned worker | The oldest row of its `replaces_thread_id` chain. If that row shares a `pr_url` or `branch` with an earlier worker of the same project, the root of the oldest such worker. The state of the earlier worker does not matter. |
| Advisor with `plan_thread_id` | The root of that planner. |
| Advisor with `worker_thread_id` | The root of that worker. |
| Reviewer | The root of the worker of its first review target, else of its `worker_thread_id`. |
| Branch-only reviewer, advisor-only consult, researcher, Chief | None (`null`). |

A row with no root has no task. Escalation and verdicts on it post nothing.

**Planned unit.** The root is a planner. A planner cannot revise a revision, so the family has one level.

- Threads: the family planners, the workers whose `plan_thread_id` is in the family, and the joined chains.
- Phase `finished`: `planDone` is true for the effective plan and the tip of every joined chain is `complete`.
- Phase `working`: some worker has `plan_thread_id` equal to the effective plan, or the tip of a joined chain is not `complete`.
- Phase `planning`: all other cases.

**Unplanned unit.** The root is a worker.

- Threads: the whole `replaces:` chain and the joined chains. The tip is the newest worker of a chain.
- Phase `finished`: the tip of the root chain and the tip of every joined chain are `complete`.
- Phase `working`: all other cases. A completed, replaced predecessor never finishes the unit.

A thread is superseded when another thread of the unit replaces it. The pull request URLs of a unit are the distinct non-null `pr_url` values of its workers.

### Mirroring

| Event | Tracker effect |
| --- | --- |
| `chief_plan` with no `revises` | Creates the unit. Task status `planning`. The planner is attached. |
| `chief_plan` with `revises` | No new task. The planner is attached to the task of the root. |
| `chief_delegate` with no plan and no `replaces`, on no earlier work | Creates the unit. Task status `working`. The worker is attached. |
| `chief_delegate` with no plan and no `replaces`, on the pull request or branch of earlier work | No new task. One request comment on the existing task. The worker is attached. The status follows the phase: back to `working`, then review, then done. |
| A delegated worker | Attached to the task of its unit. |
| A replaced thread | Detached after the attach of its successor is `sent`. |
| A pull request URL on a worker | Linked to the task. |
| A planner ready report with a plan | The plan files are attached. |
| A reviewer verdict with a written verdict file | `verdict-<seq>.md` is attached to the unit of the reviewed worker. |
| `chief_escalate` without `merge` | A decision comment and the flag. |
| Unit `finished`, with a pull request | Status `review`. Status `done` when every pull request is merged. |
| Unit `finished`, no pull request | Status `done`. |

A unit that is `done` and gets a new fix worker moves back to `working`, because the sync derives the status from local rows on each pass. A pull request closed with no merge leaves the task in `review`.

Chief posts no comment except decision comments and follow-up request comments. A change request on a pull request is the same work, so one pull request gets one task. The plugin posts no milestone, plan summary, verdict, or completion comment. It creates no subtask.

The request comment has this layout:

```
**Follow-up request** (Chief)

<mission, clipped to 4,000>

chief-request:<thread id>
```

### Hooks

Each hook first reads the settings. When the setting selects no adapter, the hook returns and writes nothing. No hook awaits an adapter call. No hook throws. A hook logs an error.

| Hook | Caller | Effect |
| --- | --- | --- |
| `start(row, description)` | `startPlan` (when `revises` is absent), `startWorker` (no `replaces`, no plan) | Finds the root. If the project is unmapped, returns. Otherwise `INSERT OR IGNORE` the unit. Title: the row title without the `Plan · ` prefix. Description: the mission, clipped to 4,000 characters, then a blank line and the unit marker. When the unit of the root already exists and the root is not the row, the `thread` receipt carries the request comment. When the unit does not exist, the hook creates it under the earlier root and posts no comment. |
| `attachFiles(row, files)` | `trackFiles` in `src/report/reportIntake.ts` | If the unit does not exist or its create failed, returns. Otherwise inserts one `file` receipt for each file, with ref `<source thread id>:<name>` and the content as payload. |
| `decide(row, request)` | `chief_escalate` | See Decisions. |
| `sync()` | The supervisor, after `forgeComments.drain()` | The reconcile pass. |

`trackFiles` runs after the `store.batch` commit of the report and before `alertChief`. It changes neither the text of the alert nor its timing.

### Tables

`MIGRATIONS` ends with `TRACKER_TABLES`. The list is append-only.

- `tracker_units`: root, project, tracker project, title, description, marker, `task_id`, `create_state`, `create_attempts`, `status`, `flagged`, `merge_checked_at`, `last_error`.
- `tracker_receipts`: root, `kind` (`thread`, `unthread`, `pr`, `file`, `decision`, `answer`), `ref`, `payload`, `state`, `attempts`, `last_error`, `result`, `answered_at`. The primary key is root, kind, and ref.

The marker of a unit is `chief-unit:` plus the first 12 hex characters of the sha1 of the root id. It is the last line of the task description.

### Reconcile pass

`sync()` is single-flight for the whole pass. A call during a pass sets a rerun flag, and the loop runs one more pass. `sync()` never rejects.

1. Read the settings. If no adapter is selected, return. If `available()` is false, return.
2. **Create.** For each unit with no `task_id` and no `create_state`:
   1. Add 1 to `create_attempts` before the call.
   2. If earlier attempts exist, call `findTask` with the marker first.
   3. If no task exists, call `createTask`.
   4. On success, store `task_id` and set `create_state` to `sent`.
   5. On failure, store `last_error`. At 5 attempts, set `create_state` to `failed`, set the pending receipts of the unit to `failed` with no payload, and log one warning.
3. **Reconcile.** For each unit with a `task_id`:
   1. Insert the desired receipts with `INSERT OR IGNORE`: a `thread` receipt for each unit thread, an `unthread` receipt for each superseded thread, and a `pr` receipt for each pull request URL.
   2. Process the pending receipts, oldest first. An `unthread` runs only after its `thread` receipt is `sent`.
   3. Push the status when it differs from the stored status.
   4. Push the flag when it differs from the stored flag.
   5. Poll for answers.

The desired status:

| Phase | Pull requests | Status |
| --- | --- | --- |
| `planning` | any | planning |
| `working` | any | working |
| `finished` | none | done |
| `finished` | some | review, then done when every pull request reports merged |

- `prMerged(url, projectId)` asks the forge. It runs at most every 5 min for each unit, and only while the stored status is `review`. A `null` answer changes nothing.
- A failed status push keeps the stored status and retries in the next pass. The code warns once for each unit and desired status in memory.

**Receipt rules.**

- The sync adds 1 to `attempts` before each call.
- On success, the receipt becomes `sent` with a `result`, and its payload becomes NULL.
- On failure, the sync stores `last_error`.
- At 5 attempts, the receipt becomes `failed`, its payload becomes NULL, and the code logs a warning. The sync never alerts Chief.
- A `failed` receipt never counts as done.
- A `thread` receipt with a payload first posts its request comment, then attaches the thread. On a retry, the sync first looks for a comment with the marker `chief-request:<thread id>` and posts nothing if it exists.
- A `decision` receipt with earlier attempts first looks for a comment with its marker. If the comment exists, the receipt becomes `sent` with that comment id, and the sync posts nothing.

### Decisions and answers

`decide(row, request)` runs in `chief_escalate`.

1. It returns when `merge` is true, when the row has no unit, or when the create of the unit failed.
2. The ref is the first 12 hex characters of the sha1 of the request.
3. In one transaction, it counts the decision receipts of the unit. N is that count plus 1. It inserts one `decision` receipt with the payload `{ concernedThreadId, number: N, body }`.

The body has this layout:

```
**Decision #N** (Chief)

<request, clipped to 12,000>

Answer with a comment; start it with #N when several decisions are open.

chief-decision:<ref>
```

The same request on the same unit twice inserts no second receipt. Chief posts one comment.

**Flag.** The flag is a desired state. It is open when some `decision` receipt is `sent` and has no `answered_at`. A flag failure retries alone in the next pass. The sync never posts the comment again, and the flag never blocks the answer step.

**Answer poll.** The sync polls only for a unit that has a `sent` decision with no `answered_at`. It polls at most once in 60 s for each unit, with a clock in memory.

1. Read `comments(task)`.
2. Keep the comments that satisfy all conditions: `byOwner` is true, the body has no `chief-decision:` and no `chief-request:`, no `answer` receipt has the comment id, and the comment came after the oldest open decision comment.
3. For each candidate in order, find the open decisions. These are `sent` and unanswered decisions whose comment came before the candidate.
4. If the body starts with `#N` that names an open decision, that decision matches.
5. Otherwise, if exactly one decision is open, that decision matches.
6. Otherwise, the comment is unmatched.

For each candidate, one `db.transaction` does these steps:

1. Insert the `answer` receipt. The ref is the comment id. The state is `sent`. The result is the decision ref or null.
2. Set `answered_at` on the matched decision.
3. Call `answerAlert`.

After the commit, the sync runs `void deliver(key)`.

| Case | Alert key | Alert source | Alert text |
| --- | --- | --- | --- |
| Matched | `decision-<ref>:answer` | The concerned thread of the decision | Names the decision number and the task title, quotes the comment (4,000 characters), and says to treat it as the answer to that **Need you** request. |
| Unmatched | `tracker-<12 hex of sha1(comment id)>:comment` | The root | Names the open decision numbers and carries the comment. |

- `answerAlert` writes one outbox row for the live Chief of the source thread. The live Chief is the `chief_thread_id` of the source if that Chief is active, else the active Chief of the project. It returns the key. It returns null when no live Chief exists. A null throws inside the transaction. The transaction rolls back and the next poll retries.
- The alert text contains no tracker command. A repeated observation of the same comment inserts nothing and sends no alert.

**Reasons.**

- The plugin poll is the only path from an owner answer to Chief. It does not depend on the Tasks Notify setting. See the decision note.
- The answer receipt and the alert commit together. A crash cannot record an answer without its alert, or send an alert with no record.
- Each alert key has its own kind: one per decision and one per comment. The same-kind eviction of `writeAlert` never drops one answer for another.
- The existing outbox carries the alert. Its retry and the re-targeting of `handOver` apply. A hand-off sends an undelivered answer to the replacement Chief.

### Off, unmapped, and unavailable

| State | Effect |
| --- | --- |
| `tracker` is `none`, or the read fails | No `tracker_*` row is written. No tracker process runs. Each `chief_*` result, alert, and forge comment equals the output of 310043a. |
| On, project unmapped | No unit row. No task. |
| On, adapter unavailable | Unit rows may exist. The only tracker call is the cached `available()` check. No task is created. |
| Switched off after use | The code deletes no row. All tracker calls stop. |
| Switched on again | Pending receipts, the status sync, and the answer poll resume. |

The sync does not record events that happen while the tracker is off. It never fills them in later.

The only change of a tool schema is the optional `merge` parameter of `chief_escalate`. `merge: true` means the request only asks permission to merge. The tool then posts no decision. The forge comment and every return string stay as before.

### Failure handling

- No tool and no report awaits an adapter call. A CLI that never resolves blocks none of `chief_plan`, `chief_delegate`, `chief_report`, and `chief_escalate`.
- A tracker error or a database error in a hook or in the sync is logged. It never reaches the caller.
- The sync limits a create and a receipt to 5 attempts. After the last attempt it logs a warning. It never alerts Chief.
- The `chief` skill tells Chief to write each **Need you** request in four labelled parts: **Decide**, **Options**, **Recommend**, **Meanwhile**. The sync posts the request as given and checks nothing.

## Contracts and Invariants

| Contract | Reason |
| --- | --- |
| The Chief model never runs tracker commands. | Plugin code owns every tracker call, so the sync can retry and deduplicate them. |
| Chief posts no tracker comment except decision comments and follow-up request comments. | Not stated in the plan. |
| A merge-only request posts no decision. | Merge permission is not a decision. The review status of the task is the signal. |
| `src/tracker/tracker.ts` and `src/tracker/trackerSync.ts` name no tracker. | One adapter file holds all tracker words, so the adapter is replaceable. |
| Off, unmapped, and unavailable states are no-ops for every tool. | The feature changes no behaviour without opt-in. |
| No tool and no report awaits an adapter call. | An unreachable tracker must not block Chief. |
| A `failed` receipt never counts as done. | A dependent write must not follow a write that did not happen. |
| The sync stores the task id before it processes any receipt of the unit. | A receipt needs a task. A crash after a create must not lose the id. |
| A retry of a create or a decision looks for its marker first. | A call that timed out may have reached the tracker. |
| The sync clears the payload of a receipt in both terminal states. | A file payload must not stay in the database. |
| One `sync()` pass runs at a time. | Two passes would send the same write twice. |
| An owner comment answers at most one decision. | One comment must not close decisions it did not answer. |
| The answer receipt and the answer alert commit in one transaction. | See Answer poll. |
| The plugin poll is the only delivery path of an answer. | Two senders would give Chief two alerts for one answer. |
| Alerts follow hand-offs. | `handOver` re-targets undelivered outbox rows. |

## Known Limits

- An owner comment that is unrelated to the one open decision closes that decision. The alert carries the text. Chief may ask again with reworded text.
- The alert transport is at-least-once, as described in the baseline.
- A project that is unmapped, or a tracker that is off, never gets work from before the switch.
- The status has no `canceled` or `blocked` value.
- The 60 s poll clock lives in memory.
- A reused branch name joins the earlier task, because the branch is a join key.
- A follow-up that Chief routes through a new `chief_plan` gets its own task. A plan has no branch or pull request at plan time.

## Non-goals

- Milestone, plan summary, verdict, and completion comments. Subtasks.
- The native Notify of Tasks for Chief. A second notification subsystem. A stronger delivery guarantee than the outbox.
- A backfill of work from before the tracker was on.
- A second adapter, an adapter registry, and a project fallback from `linkedBbProjectId`.
- A new `chief_*` tool.
- An inbound event subscription and `bb tasks dispatch`.
- Tasks for researcher, consult, or advisor-only work.
- A change to forge comments, roster todos, or merge permission in chat.

## Related

- [Plugin polling owns answers](../decisions/2026-11-09-tracker-answers-plugin-poll.md)
- `report-intake.md`: the hand-off of files to the sync.
- `forge-comments.md`: the forge copy of a **Need you** request.
