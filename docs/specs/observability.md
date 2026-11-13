# Observability

Observability gives Chief one local ledger for failures, review outcomes and nudges. It can also mirror the failure and review events to Sentry as scrubbed metadata. With no DSN configured, Chief makes no network call and the ledger still records.

Observability also keeps durable completion evidence, writes a daily report of failures, and grades each finished plan in a retro. The retro can propose lessons. Only a lesson that Chief accepts reaches a prompt.

## Terms

| Term | Meaning |
| --- | --- |
| Ledger | The table `chief_events`. One row is one event. |
| Source adapter | A read-only reader of one evidence source. It returns one section of the daily report. |
| Completion snapshot | The row in `chief_completions` and the artifact `completion.diff`. Chief writes both when a worker completes. |
| Retro | The graded review of one finished plan. One row of `chief_retros` is one retro. |
| Judge | The read-only workflow `chief-retro-judge`. It scores threads and handoffs against rubrics. |
| Rubric | A scoring rule. It has labels, and each label has a score. |
| Handoff | One delegation from Chief to a child thread, with the messages it caused. |
| Lesson | A rule in `chief_lessons`. Its status is `proposed`, `accepted` or `retired`. |
| Event | One row with a `kind`, the thread, role and project tags, and an optional short `detail`. |
| DSN | The Sentry project address, from the setting `sentryDsn`. It holds a public key, a host and a project id. |
| Envelope | The body of one Sentry POST: a header line, an item line and the event. |
| Scrub | Replacing each secret in a text with a marker. |
| Fingerprint | The value Sentry uses to group events into one issue. |
| Receipt | The `event_id` of a ledger row. A send happens only when this row exists. |
| Throttle | The rule that one fingerprint sends at most one event in 10 minutes. |

## Baseline: failure records and stats (behaviour at base 277e57f)

### Failure record (`recordFailure` in `src/runtime/alerts.ts`, table `chief_failure_events` in `src/db/migrations.ts`)

- `recordFailure(row, kind, detail)` writes one row for a transient provider failure or a stall. `kind` is `provider`, `stall` or `hard_stall`.
- The primary key is (`source_thread_id`, `active_cycle`, `kind`). The write is `INSERT OR IGNORE`, so one thread cycle and kind gives one row.
- `detail` is `usage_limit` or `connection` for `provider`. It is null for a stall.
- The write does not depend on the alert. The row exists whether or not the alert reached Chief.
- A row without a Chief writes nothing.
- The function never throws. When the write fails, it returns a line that the caller adds to its alert: "This failure could not be recorded for bb chief stats". Reason: the failure still reaches Chief.
- Rows with `legacy=1` were copied once from older `failed:` and `stall:` alerts. They are approximate. Chief never copies `error:` and `report:` keys.
- The plugin seeds `failure_events_since` in `plugin_meta` at startup (`src/runtime/core.ts`). It does not replace an existing value.

### Supervisor stall block (`src/runtime/lifecycle.ts`, `registerLifecycle`)

1. On each supervisor tick, the loop reads every managed row. It skips Chief rows, rows that are not `active`, and rows with no `active_since`.
2. The threshold is the setting `stallMinutes`. A value that is not a positive number gives 15 minutes.
3. A row below the threshold is skipped. A row at twice the threshold or more is a hard stall.
4. A row skips the rest when its alert for this cycle was already sent (`stall_alerted_cycle`, or `stop_alerted_cycle` for a hard stall).
5. Otherwise the loop calls `recordFailure` with `stall` or `hard_stall`, reads the last output and sends the alert with the key `stall:<cycle>` (`:hard` added for a hard stall).
6. When the alert is sent, the loop marks the cycle as alerted.

Reason for step 5: every tick before the send enters this block again. The primary key keeps one row.

### Failed branch (`lifecycle`, `thread.failed` event)

- The branch runs only for a row that has a Chief. It reads the last provider error and classifies it with `transientFailure`.
- A failure with no provider error, or a non-transient error, counts one thread error when the row was not already failed. It sends the alert key `error:<cycle>`. It writes no `chief_failure_events` row.
  Reason: the key `error:` keeps the legacy backfill from copying a non-transient failure. The outbox dedupes the alert per cycle.
- A transient error calls `recordFailure` with `provider` and `usage_limit` or `connection`. For a usage limit it also records a provider cooldown.
- A transient error sends the alert key `failed:<cycle>`. The alert tells Chief to retry the same thread with `bb thread retry` and not to spawn a replacement.

### `bb chief stats` (`chiefStats` in `src/runtime/roster.ts`)

- `chiefStats` is read-only. It reads `chief_failure_events` for the threads in scope.
- A `provider` row with `usage_limit` counts as `usageLimit`. Any other `provider` row counts as `connection`. A `hard_stall` row counts as `hardStalls`. Any other row counts as `stalls`.
- Rows with `legacy=1` also count in `failures.approximate`.
- The stats group threads into tasks by plan, or by branch when no plan exists. Each task sums its failure counts, thread errors and busy rejections.
- The notes of the output give the dates from `stats_since` and `failure_events_since`.

## Event ledger

### Ownership and entry points

- `createObserve` in `src/observe/events.ts` owns the ledger. It returns `event`, `toolError` and `warn`, and sits on the context as `ctx.observe`.
- `event(kind, row, detail?)` inserts one row. Callers hand it the thread row for the role, project and plan tags.
- Every detection point calls `event` next to the code it already has. The point does not change its alert text, its alert key or its `chief_failure_events` row.

### Kinds and detection points

| Kind | Detection point | Sent to Sentry |
| --- | --- | --- |
| `tool_error` | `registerChiefTool` in `src/tools/register.ts` | Yes |
| `stall`, `hard_stall` | `recordFailure`, when its insert adds a row | Yes |
| `provider_transient` | `recordFailure` for `provider`, when its insert adds a row | Yes |
| `thread_failed` | The failed branch, when the alert key `error:<cycle>` is new | Yes |
| `blocked` | A blocked report in `src/report/reportIntake.ts` | Yes |
| `request_changes` | A reviewer verdict in `reportIntake.ts`, one row per covered worker | Yes |
| `plan_review_changes` | An advisor `request_changes` on a plan in `reportIntake.ts` | Yes |
| `review_skipped`, `override` | `markComplete` in `src/runtime/completion.ts` | Yes |
| `stopped` | `stopThread` in `completion.ts` | Yes |
| `tests_skipped` | `markComplete` in `completion.ts`, and `src/tools/skipTests.ts` | Yes |
| `specs_skipped` | The waive branch of `src/tools/skipSpecs.ts` | Yes |
| `nudge` | `chief_continue` in `src/runtime/delegation.ts`, after the send succeeds | No: local only |

### Columns

`chief_events` has these columns: `id`, `event_id`, `at`, `project_id`, `thread_id`, `role`, `plan_thread_id`, `plan_wave`, `kind` and `detail`.

- `event_id` is a random 32-character hex id. It is unique. It is also the Sentry event id and the receipt.
- `detail` is the scrubbed text, at most 300 characters.
- A `request_changes` row has the detail `round=N`. N is the streak of rejections for the worker after this verdict.
- A `nudge` row has the detail `chars=N`. N is the length of the instruction.
- Indexes cover `at`, `plan_thread_id`, and (`thread_id`, `kind`).

### Invariants

- One row exists for each existing dedupe unit. A stall that re-enters every tick gives one `stall` row for each thread and active cycle.
- A transient failure gives one `provider_transient` row for each thread and cycle.
- Events from the report path run inside the report transaction. A rollback of the report removes their rows.
  Reason: the ledger never shows an event for a report that Chief did not accept.
- The migration is append only. No earlier entry of `MIGRATIONS` changes.
- A reviewer `approve` writes no `request_changes` row.

## Sentry mirror

### Settings

| Setting | Meaning |
| --- | --- |
| `sentryDsn` | Secret. The project DSN. |
| `sentryAuthToken` | Secret. A Sentry read token with `event:read` and `project:read`. |
| `sentryOrg`, `sentryProject` | Text, default empty. |
| `sentryApiUrl` | Default `https://sentry.io`. |

Secret settings have no default. The code handles an undefined value. The plugin stores a secret setting in a file that only its owner reads. The secret never reaches the database or the frontend.

### Send flow

1. `event` inserts the row inside the caller's transaction.
2. For a kind that is not local only, `event` schedules a send on the next macrotask (`setImmediate`).
3. The scheduled task looks up the row by `event_id`. When the row is absent, the task stops.
4. `send` in `src/observe/sentry.ts` scrubs the message, builds the envelope and posts it. The post does not wait for the response.

### Contracts

- `send` makes no `fetch` call when the DSN is unset, empty or invalid. The ledger row is still inserted.
  Reason: Sentry is optional.
- An invalid DSN gives one warning through the original `bb.log.warn`.
- A ledgered event reaches Sentry only after its row is committed. The receipt check on the next macrotask enforces this.
  Reason: a transaction ends before the next macrotask. A random `event_id` cannot match a later row after a rollback, unlike a rolled-back integer id.
- The first step of `send` is `scrub(message, secrets)`. Every outbound field comes from this scrubbed text or from scrubbed tag values. This includes the fingerprint.
  Reason: a fingerprint built from raw text would leak a secret.
- The fingerprint is `[kind, normalize(scrubbed message)]`. `normalize` runs only on text that is already scrubbed.
- Sentry receives only the kind, the role, ids, the tool name and a scrubbed message of at most 300 characters. A tag value has at most 200 characters.
- The event has exactly these keys: `event_id`, `timestamp`, `level`, `platform`, `logger`, `release`, `message`, `tags` and `fingerprint`.
- The code never passes tool parameters, results, summaries, briefs or plan bodies to the ledger or to Sentry.
- The throttle allows one send for each fingerprint in 10 minutes. The map lives in memory, so a plugin reload resets it.
- A failed send, a timeout of 10 seconds or a response that is not 2xx never throws. It warns through the original warn at most once in 10 minutes.
  Reason: the original warn does not feed Sentry, so a failed send cannot recurse.
- The level is `error` for `tool_error`, `stall`, `hard_stall`, `provider_transient` and `thread_failed`. The level is `warning` for `request_changes`, `plan_review_changes`, `review_skipped`, `tests_skipped`, `specs_skipped`, `override` and `stopped`.
- The tags are `kind`, and `role`, `thread_id`, `project_id`, `plan_thread_id` and `plan_wave` when present. A `tool_error` also has the tag `tool`.

### Scrub

- `scrub` replaces each non-empty configured secret literal with `[secret]`.
- `scrub` replaces these patterns with `[redacted]`: URL user information, `sk-` keys, GitHub tokens, Slack tokens, AWS access key ids, `Bearer` values, JWTs, and a key such as `token`, `secret`, `password`, `api_key`, `authorization` or `dsn` followed by `:` or `=` and a value. The key stays.
- `scrub` is idempotent. A 40-character commit SHA and a `thr_` id stay readable.
- `normalize` replaces `thr_` ids with `<id>`, `wfr_` ids with `<run>`, hex runs of 7 or more characters with `<sha>`, and digit runs with `<n>`.

### Plugin warnings

- A warning from the plugin through `ctx.bb.log.warn` also goes to Sentry as the kind `plugin_warn`, through `ctx.observe.warn`.
- The ledger does not record a plugin warning. The throttle applies to it.
- The Sentry module uses the original warn. A failed send never feeds itself.

### Failed tool calls

- `registerChiefTool` wraps every `chief_*` tool. On a throw, the wrapper calls `ctx.observe.toolError(tool, threadId, projectId, error)` and then rethrows the identical error object.
  Reason: the observer must never replace the error of the tool.
- A throw inside `toolError` is caught and dropped. A success returns the inner result unchanged.
- A Coordinator refusal (`COORDINATOR_REFUSED`) still throws before the tool reads its input. The wrapper records the refusal as a `tool_error`.
- `toolError` records `<tool>: <first line of the message>` as the detail. It never reads parameters or results.

## Completion evidence

### Completion snapshot (`snapshotCompletion` in `src/observe/completionSnapshot.ts`)

- `markComplete` in `src/runtime/completion.ts` calls `snapshotCompletion` for a worker. It awaits the call before `store.markComplete`.
  Reason: `store.markComplete` writes `cleanup_approved_at`, which queues cleanup. Cleanup clears thread storage, so the evidence must exist first.
- The snapshot never throws and never refuses a completion. It has a deadline of 30 seconds.
- The snapshot finds the head in this order:
  1. With a `pr_url`, `prHead` gives the branch, the head SHA and the base.
  2. Without one, the row `branch` gives `origin/<branch>`, compared with the remote default branch.
- The snapshot runs in the project checkout. It fetches the base and the head, then reads `git diff <base>...<head sha>`.
- The table `chief_completions` has one row for each worker thread. Its columns are `thread_id`, `project_id`, `plan_thread_id`, `pr_url`, `base`, `head_sha`, `diff_state`, `diff_note`, `diff_path`, `brief_path` and `at`.
- The row reuses `pr_url`. Chief adds no second URL column.

| `diff_state` | Meaning |
| --- | --- |
| `ok` | The artifact `completion.diff` holds the whole diff. |
| `truncated` | The diff is longer than 500,000 characters. The artifact holds the first 500,000. |
| `unavailable` | No diff exists. `diff_note` holds a reason, for example "no local checkout" or "head unreadable". |

### Durable brief (`persistBrief` in `src/runtime/artifacts.ts`)

- `persistBrief(threadId, projectId, prompt)` writes two copies of the spawn prompt. Each write fails alone and never fails the spawn.
  - The first copy is `brief.md` in the thread storage. The thread re-reads it after a compaction.
  - The second copy is the Chief artifact `brief.md`, at `<dataDir>/chief/<projectId>/<threadId>/brief.md`.
- Cleanup clears only the thread storage. The artifacts survive.
  Reason: the retro grades from the artifact brief and from `chief_completions`, not from storage that cleanup clears.

## Source adapters

Each adapter reads one evidence source and returns a section: `{name, status, note, items}`. The status is `ok`, `skipped`, `unavailable` or `error`. An item has a time, an optional thread id, a kind, an optional count and a text.

| Adapter | Source | Report content |
| --- | --- | --- |
| `chiefEvents` | The ledger rows in the window. | One item for each group of rows. |
| `bbThreads` | `bb.sdk.threads.events.list` for each thread with `updated_at >= since`. It reads the types `provider/error`, `system/error`, `provider/warning`, the watchdog and `thread/compacted`, and tool calls whose status is not `completed`. | Counts and 3 excerpts. At most 300 events for each thread, newest first. |
| `bbLogs` | `<dataDir>/logs/server*.log` and `host-daemon*.log` (pino JSON), `<dataDir>/logs/cli-errors.jsonl`, and `<dataDir>/plugins/chief/logs/plugin.log*`. | Server and daemon lines with level 50 or higher. Lines with level 40 or higher that hold `[plugin:chief]`. Every cli-errors line. The warn lines of plugin.log. |
| `claudeCode` | `${CLAUDE_CONFIG_DIR ?? ~/.claude}/projects/<dir>/<providerThreadId>.jsonl` | Error tool results, compactions and token totals. |
| `pi` | `<dataDir>/pi-bridge-sessions/<providerThreadId>.jsonl` | Tool results with `isError`, and token totals. |
| `agy` | `~/.gemini/antigravity-acp/conversations/<providerThreadId>.db`, through the agy reader. | Step counts, error counts and excerpts. |
| `sentry` | `GET <sentryApiUrl>/api/0/projects/<org>/<project>/issues/?query=is:unresolved lastSeen:-24h&sort=date&limit=50`, with the Bearer token. | Issues of kind `new` when `firstSeen >= since`, else `recurring`. |

- The provider thread id comes from the newest `thread/identity` event (`data.providerThreadId`) of the thread.
- The threads in scope are the `store.all()` rows with `updated_at >= since`.
- `sentry` is `skipped` and makes no `fetch` when the token, the org or the project is unset. `sentryIssuesForTag(tag, value, days)` reuses the same call for the retro.
- A missing provider file gives the note "not on this machine" for that thread.
  Reason: the plugin reads provider files on the plugin server only. Other hosts show this note.

### Contracts

- Every adapter is read-only. No adapter writes, renames or deletes under `~/.claude`, `~/.gemini`, `<dataDir>/pi-bridge-sessions` or `<dataDir>/logs`.
  Reason: these files belong to other programs.
- Chief opens SQLite only with `-readonly` and `mode=ro`.
- A file with an mtime before `since` is never opened.
- Every text passes through `scrub` and is clipped to 300 characters.
- An adapter returns at most 200 items. It groups items by `normalize(scrubbed text)` and keeps a count.
- A throw in one adapter gives the section status `error`. Every other section is still written.
- A source that is missing or unsupported says so in its section. It never reads as healthy.

### agy history reader (`src/observe/agyHistory.ts`)

- `readAgySteps(dbPath, limit)` runs `sqlite3 -readonly -json` on the table `steps` through `execFile` with a timeout. The columns are `idx`, `step_type`, `status`, `error_details` and `step_payload`.
- Steps with `status` 6 or 7 are error steps. The reader adds a printable error excerpt for them.
- `decodeFields(buf)` is a protobuf wire walk without a schema. It reads at most 8 levels of nesting. It returns the printable UTF-8 leaves of 4 or more characters.
  Reason: no `.proto` file is published. The reader knows only tool names, tool arguments and text.
- A malformed payload gives no texts for that step and never throws.
- The reader reports these states:

| State | Condition |
| --- | --- |
| `skipped` | The `sqlite3` command is missing. |
| not on this machine | The db file is missing. |
| `unavailable` | The db has zero rows and a `-wal` file next to it. |
| `ok` | The db has rows, or it has zero rows and no `-wal` file. |

  Reason for `unavailable`: a live WAL returns no rows through `mode=ro`. An empty read must not look like a healthy history.
- The `agy` adapter and the retro bundle both use this reader.

## Daily report

`runDailyReport` in `src/observe/report.ts` builds one report each day and alerts Chief. `buildDailyReport` builds the text. The schedule is `bb.background.schedule("daily-report", "0 8 * * *")`, which is 08:00 server-local time.

| Section | Content |
| --- | --- |
| Sources | A table of name, status, item count and note for each adapter. |
| Sentry | New and recurring issues, or the reason that Sentry is not available. |
| Scorecard | The counts for each ledger kind in the last 24 hours and the 24 hours before. Review rounds are the highest `round=N` of each worker task. |
| Completion evidence | The completions in the window whose `diff_state` is not `ok`, with their notes. |
| Recurring patterns | Patterns that occur 2 or more times. The top 15. |
| Threads with failures | The threads that have the most failure items. |
| Logs | The items of the `bbLogs` adapter. |
| Triage | A last line that tells Chief to plan any fix as normal work (`chief_plan`). |

The retro adds the sections in "Report sections from the retro".

- The report has at most 60,000 characters. When it is longer, the builder cuts whole items from the end of the longest section.
- The builder scrubs the whole report.
- The run first deletes the `chief_events` rows older than 90 days. Reason: the ledger stays bounded. The delete runs even when no Chief exists.
- With no active Chief for the setting `chiefProject`, the run logs one info line. It writes no file and no outbox row.
- Otherwise the run writes `reports/daily-<date>.md` in the storage of that Chief. It then sends one alert with the key `daily:<date>`.
- A second run on the same date gives the same path and no second outbox row.
- The alert text has the path, then the counts of new Sentry issues, recurring patterns, blocked workers, stalls and review rounds of 2 or more. It ends with the triage line.
- The run never throws. A failure logs a warning, and the next day runs again.
- `alertSelf` in `src/runtime/alerts.ts` sends the alert. When the source of an alert equals its target, `deliverAlert` sends it without `senderThreadId`. When they differ, the alert still carries `senderThreadId = source_thread_id`.
  Reason: a thread cannot message itself as its own sender.

## Retro grader

The retro scores a finished plan. A read-only judge grades the threads of the plan and the handoffs between Chief and each child. The plugin then aggregates the scores, stores them and writes `retro.md`. It never edits a prompt, a skill or code.

### Eligibility

A planner gets one `chief_retros` row when all of these hold:

- The planner is complete, and its `updated_at` is at or after `retros_since`.
- The planner is not superseded. A superseded planner completes through `completeSuperseded`, and its waves never ran.
- The plan has at least one complete worker.
- The plan has an active Chief.

The plugin seeds `retros_since` in `plugin_meta` at startup with `INSERT OR IGNORE` (`src/runtime/core.ts`). The seed is not in a migration.
Reason: a plan that completed before the plugin first ran with this feature gets no retro, and there is no backfill.

### State machine

`retroTick(now)` in `src/observe/retro.ts` runs every 10 minutes (`bb.background.schedule("retro", "*/10 * * * *")`). One tick runs at a time. The tick does nothing when the setting `retroJudge` is off. The default is on.

| From | Event | To |
| --- | --- | --- |
| no row | Claim. `INSERT OR IGNORE` of a planner that is eligible. | `pending`, `attempts=0`, `next_at=now` |
| `pending` | Start. `next_at <= now`. At most 2 starts for each tick. The row first gets `attempts+1` and `run_id=NULL`. | `running` with a `run_id`, when the run launches |
| `pending` | A bundle error or a launch error. | `pending` with `next_at=now+10 min`, or `failed` when `attempts >= 3` |
| `running` | The run status cannot be read. | `running` with `last_error` |
| `running` | The run failed, was stopped, or is older than 2 hours. The tick stops an old run first. | `pending` with `run_id=NULL` and `next_at=now+10 min`, or `failed` when `attempts >= 3` |
| `running` | The run succeeded. | Collect, then `done` |

- The primary key `plan_thread_id` makes the claim exclusive. Two overlapping ticks never create two rows or start two runs. A second tick on unchanged data inserts nothing.
- Every retry is a new run with a new `run_id`.
- The state `failed` sends one alert with the key `retro-failed:<planId>`.
- The row stores `rubric_version`, `attempts`, `next_at`, `started_at`, `last_error` and the `path` of `retro.md`.

### Evidence bundle

The bundle is written as Chief artifacts `retro/<planId>/…` under the Chief thread. Each file has at most 120,000 characters. Every line is scrubbed.

- The judged threads are the planner, the rows with the `plan_thread_id`, and their reviewers and advisors.
  - The judge scores at most 8 threads. Threads with a failure, a block, a nudge or a `request_changes` event come first. Then one thread for each role.
  - The bundle names every dropped thread.
- For each thread, the bundle keeps the first 400 events and the last 1,200 events. It marks the gap as `[events seq a..b omitted]`. Each line starts with `#<seq>`.
  - The bundle always keeps every `userMessage`, every tool call whose status is not `completed`, and the final `chief_report` call.
  - Expired outputs show as `[output expired]`. A failed event read gives the header `[events unavailable: reason]`.
- For each thread, the bundle also holds its brief, its `chief_completions` row, the stat of `completion.diff`, its ledger events and its agy provider summary.
  The brief comes from the artifact `brief.md`. It never comes from thread storage.
  Reason: cleanup clears the thread storage and removes the environment. The bundle must still work after that.
- The handoff bundle holds at most 8 handoffs. It has two sides.
  - The Chief side holds the Chief events between the creation of the planner and the completion of the plan. These are the user messages, the `chief_*` tool calls that name a plan thread, and the `bb thread tell` commands to one.
  - The child side holds the exact brief, the first 40 events, every question and blocked report, the alerts of the child, its nudges, and each `request_changes` round with the findings.
  - A handoff with a missing side is marked `counterpart unavailable`.
- The plugin computes the observed counts for each handoff: nudges, blocks, review rounds, brief characters, alert characters and estimated tokens. The judge never computes them.

### Judge workflow

- `RETRO_SCRIPT` is an inline workflow named `chief-retro-judge`. It reads only `args`. It never interpolates text into code.
- The workflow runs in parallel one `agent()` for each judged thread and one communication `agent()` for the handoff bundle. The total is at most 9 calls, capped by `budget().maxAgentCalls`.
- The workflow uses the model setting of the investigate research mode.
- `runWorkflowCli` in `src/research/workflowCli.ts` runs, polls and stops the workflow. The research survey and investigate paths use the same function. The function keeps its arguments, its environment, its timeout and its error mapping.
- Each agent returns scores with labels, reasons and evidence references of the form `thr_x#seq`. It may also return one lesson.
- The prompt says: return lesson null unless all four filing conditions hold. No change is a valid result.

### Collect

One owner collects a successful run. The collect step is idempotent.

1. Parse the result with `zod`, then validate it. Each rule below drops or downgrades the item that breaks it.
   - A per-thread result whose `threadId` was not requested is dropped.
   - A thread has at most one result. Duplicates are dropped and noted.
   - A scorer appears at most once, and only for a role that the rubric covers.
   - A label must be in its rubric.
   - A missing applicable rubric counts as `insufficient_evidence`.
   - A handoff `threadId` must be in the handoff set.
   - A thread with no valid score is `insufficient`. It is never `pass`.
2. Keep a lesson only when all of these hold:
   - The thread or handoff that it came from has the status `fail`.
   - Every field is non-empty, and `existingInstruction` is null.
   - Every evidence reference names a `#seq` that exists in the bundle.
   - The surface is in `SURFACES`.
3. Write `retro/<planId>/retro.md`. A repeat run overwrites it.
4. In one transaction:
   1. Upsert the `chief_scores` rows.
   2. `INSERT OR IGNORE` the proposed lessons.
   3. `UPDATE chief_retros` to `done` and set `path`, where `state='running'` and the `run_id` matches.
   4. Insert the alert `retro:<planId>`.
5. After the commit, deliver the alert.

- When the update in step 4 changes no row, the transaction rolls back. Another collector won.
  Reason: a second collect must change nothing.
- A failed write of `retro.md` leaves the row `running`. The next tick retries within the 2-hour bound.
- A failed delivery goes to the alert outbox retry.
- A second collect of the same run gives the same `chief_scores` rows, one lesson for each `proposal_key`, one outbox row and `state='done'`.
- The alert text is: `Retro for plan “<title>”: <path>. <f>/<n> threads failed, <i> insufficient. <k> proposed lessons (bb chief lessons --status proposed; accept or retire with a reason).`
- `retro.md` holds:
  - a table of thread, role, the label and raw score of each scorer, overall and status
  - a table of handoff, label, observed counts, judge-attributed signals and evidence
  - the reasons
  - the Sentry issues tagged with the `plan_thread_id`, from `sentryIssuesForTag`
  - the summary of the plan ledger events
  - the state of the completion evidence
  - the proposed lessons and the dropped lessons, each dropped lesson with its reason

## Rubrics and scoring

`src/observe/rubrics.ts` holds the rubrics. It is the one source of truth for both the judge prompt and the aggregation.

- `RUBRIC_VERSION` names the version of the rubric set. Chief stores every score with its version.
- `renderRubric(r)` writes a rubric as a YAML `labels:` block, an `Assess:` list and a rule for the reason (1 to 3 sentences that cite specifics).
- Every rubric has the label `insufficient_evidence`, with no score.
- The design follows the `skill-doctor` skill of warpdotdev/common-skills at commit `8792394ff1b655e0af451b8fabb68ef0cfcbd208` (MIT licence). The wording is adapted to Chief. The code keeps the attribution comment.

| Rubric | Applies to | Weight | Labels and scores |
| --- | --- | --- | --- |
| `efficiency` | every thread | 0.25 | `highly_efficient` 1, `mostly_efficient` 0.8, `mostly_inefficient` 0.4, `highly_inefficient` 0.2 |
| `procedure-compliance` | every thread | 0.20 | `fully_compliant` 1, `mostly_compliant` 0.8, `noncompliant` 0.2 |
| `verbosity` | every thread | 0.15 | `proportionate` 1, `verbose` 0.2, `terse` 0.1 |
| `test-redundancy` | tester | 0.15 | `lean` 1, `some_redundancy` 0.6, `redundant` 0.2 |
| `communication` | handoff | 0.25 | `clear` 1, `minor_gaps` 0.7, `costly_gaps` 0.4, `broken` 0.1 |

`efficiency` counts failed and wasted tool calls. `test-redundancy` assesses duplicate coverage, E2E tests where a unit test proves the contract, several tests for one property, a full-suite rerun where a filter would do, and tests that only work around a problem.

### Aggregation

`aggregate(scores)` is a pure function for one thread.

- A score is applicable and valid when its label is not `not_applicable` and not `insufficient_evidence`.
- The curve is `curve(s) = 0.5 + 0.5·s`.
- `overall = Σ w·curve(raw) / Σ w`, over the applicable dimensions that have a score. The weights are renormalized.
  The overall is not the `skill-doctor` overall. Chief omits code quality and skill coverage, because the reviewer owns the code.
- The thread fails when any applicable raw score is below 0.5. A raw score of exactly 0.5 does not fail.
- The status is `fail` when the thread fails. Else the status is `insufficient` when any applicable rubric is missing or `insufficient_evidence`, or when the thread has no scores. Else the status is `pass`.
- `aggregate` returns the raw and the curved values.
- Worked example: `efficiency` 0.8, `procedure-compliance` 1 and `verbosity` 0.2. The thread fails. The curved values are 0.9, 1 and 0.6. The overall is (0.225 + 0.2 + 0.09) / 0.6 = 0.8583.

### Storage

- `chief_scores` has the primary key (`thread_id`, `scorer`, `rubric_version`). Its columns also include `plan_thread_id`, `role`, `label`, `score`, `reason` and `at`.
- `score` is NULL for `not_applicable` and `insufficient_evidence`.
- A trend never averages scores across `rubric_version`.
  Reason: a changed rubric makes the numbers not comparable.

## Communication rubric

The `communication` rubric scores one handoff. The plugin stores the score on the child thread. The rubric covers briefs, plan missions, alerts, nudges and `bb thread tell`.

The judge assesses six signals:

1. A gap in the brief that caused a block or a question.
2. Information that either side asked for twice.
3. Nudges. The plugin observes the count. The judge attributes a cause only with evidence. A legitimate nudge is not waste.
4. Review rounds that an unclear brief caused, not an error of the worker.
5. The size of the handoff, in brief and alert characters. Tokens are an estimate of characters ÷ 4, and the report labels them "estimate".
6. Loss or distortion of the words of the user between the user messages to Chief and the delegated brief or mission.

- The reason cites `threadId#seq` on both sides.
- Observed counts and judge-attributed causes stay separate in `retro.md` and in the daily report.
- A handoff with a missing counterpart gets `insufficient_evidence`. It never gets `clear`.
  Reason: a handoff that the judge cannot see is not proof of a good handoff.
- Chief never calibrates the communication rubric against reviewer verdicts.

## Report sections from the retro

The daily report adds these sections. None of them averages scores across `rubric_version`.

| Section | Content |
| --- | --- |
| Score trend | The last 4 ISO weeks. For each scorer and `rubric_version`: the raw mean, `curve(mean)`, n, and the counts of pass, fail and insufficient. |
| Communication | Seven days. The observed totals (nudges, blocks, review rounds, mean brief characters, mean estimated tokens), then the judge-attributed signal counts, shown apart. |
| Calibration | The judge against the first reviewer verdict. See below. |
| Failed threads | The last 24 hours. For each thread: the role, the failing scorer and the reason. |
| Lessons | See "Lesson effect". |

### Calibration

- The report joins the worker threads that the judge graded at the current version to `reviewer_verdicts` on `worker_thread_id`.
- The verdict is the first row by `id` whose `head_sha` and `worker_report_seq` are both non-null. A row with a null in either column is counted as unbound and excluded.
- The report shows a 2×2 table of the judge status (pass or fail, on the dimensions that are not communication) against the first verdict (`approve` or `request_changes`). It also shows the coverage (bound verdicts ÷ judged workers) and the rate of disagreement.
- Below 10 bound pairs, the report prints `insufficient evidence (n=…)`.
  Reason: a small sample gives a misleading rate.

### Lesson effect

- Proposed lessons that wait for a decision, grouped by surface. A lesson that comes from 2 or more distinct plans in 14 days is recurring, and the report lists it first.
- The counts of accepted and retired lessons.
- For each lesson accepted in the last 30 days: the pass rate of the judged threads in the 14 days before and after `decided_at`, with n. When either side has fewer than 5 threads, the report shows "too few (n<5)".
- The daily alert adds the line `<k> proposed lessons awaiting decision`.
- The report claims no cause. A pass rate before and after is not proof that a lesson helped.

## Lesson lifecycle

`chief_lessons` is the one store of lessons. A reviewer or advisor report with a `lesson`, and the retro, both write to it.

| Status | Meaning |
| --- | --- |
| `proposed` | A new lesson. No prompt contains it. |
| `accepted` | Chief decided to use it. Prompts contain it. |
| `retired` | Chief decided to stop using it, or rejected it while it was `proposed`. |

- A lesson goes from `proposed` to `accepted`, and from `accepted` to `retired`. A lesson goes from `proposed` to `retired` when Chief rejects it. No other transition exists.
- The migration adds `status` with the default `accepted`. Existing rows stay accepted, so they keep their injection.
- The migration also adds `surface`, `plan_thread_id`, `evidence`, `rubric_version`, `proposal_key`, `decided_at` and `decided_reason`. A unique index covers `proposal_key`. A NULL key is not constrained.
- The report intake (`src/report/reportIntake.ts`) inserts a lesson as `proposed`. Its report alert adds the line `Proposed lesson <id>: bb chief lesson accept <id> --reason "…" (or retire)`.
- The retro inserts a lesson as `proposed`, with `proposal_key = sha1(plan_thread_id, source thread, surface, normalize(rule))`. `INSERT OR IGNORE` gives one lesson for each key.

### Filing bar

The judge may file a lesson only when all four conditions hold. The plugin checks the form of each condition in Collect.

1. An instruction is missing or wrong on a nameable surface.
2. One reusable rule fixes it.
3. The rule would have prevented the failure.
4. The failure recurs, or it is severe.

The judge never files a lesson when the instruction existed and the thread ignored it, for variance, to restate an instruction, or when the fix is code or infrastructure.

`SURFACES` lists every skill directory under `skills/`, plus `planner-prompt`, `worker-brief`, `reviewer-brief`, `tester-brief`, `chief-delegate-brief`, `chief-plan-mission`, `chief-alert-text`, `chief-nudge`, `chief-tell`, `report-contract`, `plugin-code` and `other`. The surface sets the role of the lesson:

| Surface | Lesson role |
| --- | --- |
| `reviewer-brief` | `reviewer` |
| `chief-*` | `chief` |
| every other surface | NULL, so every managed role |

### Injection (`newestLessons` in `src/runtime/host.ts`)

- Both queries add `AND status='accepted'`.
- The 10 newest lessons with `role IS NULL` or `role='advisor'` go to every managed role. The 10 newest with `role='reviewer'` go to reviewers.
- The Chief branch adds the 10 newest accepted lessons with `role='chief'` as the section `## Chief lessons (communication)`. The section has at most 2,000 characters and comes after the rules.
  Reason: the SDK cuts instructions at 32,768 characters, so a cut drops lessons before rules.

### Decision commands (`src/runtime/cli.ts`)

| Command | Effect |
| --- | --- |
| `bb chief lessons [--status proposed\|accepted\|retired] [--project <id>]` | Lists the id, status, role, surface, text and evidence. |
| `bb chief lesson accept <id> --reason "…"` | Moves `proposed` to `accepted`. |
| `bb chief lesson retire <id> --reason "…"` | Moves `proposed` or `accepted` to `retired`. |

- The reason is required. It is not empty and has at most 400 characters.
- Each command sets `decided_at` and `decided_reason`.
- An invalid transition exits with a non-zero code and changes nothing.
- The retro alert and the daily report point to these commands.

### Invariant: Chief never edits itself

- The plugin never edits a prompt, a skill or code.
- The retro writes only these items: `chief_retros`, `chief_scores`, `chief_lessons` rows with status `proposed`, the Chief artifacts `retro/`, the `reports/` of the Chief, and `alert_outbox`.
- A lesson reaches a prompt only after a recorded Chief decision. Reason: a lesson from a judge or a reviewer can be wrong. A durable fix still ships as a reviewed plan.

## Related decisions

- [Sentry through a direct envelope, no SDK](../decisions/2026-11-13-sentry-envelope-no-sdk.md)
- [One gated lesson store](../decisions/2026-11-13-lesson-lifecycle-gate.md)
