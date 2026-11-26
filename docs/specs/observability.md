# Observability

Observability gives Chief one local ledger for failures, review outcomes and nudges. It can also mirror the failure and review events to Sentry as scrubbed metadata. With no DSN configured, Chief makes no network call and the ledger still records.

Observability also keeps durable completion evidence and writes a daily report of failures. Reviewers and advisors can propose lessons. Only a lesson that Chief accepts reaches a prompt.

## Terms

| Term | Meaning |
| --- | --- |
| Ledger | The table `chief_events`. One row is one event. |
| Source adapter | A read-only reader of one evidence source. It returns one section of the daily report. |
| Completion snapshot | The row in `chief_completions` and the artifact `completion.diff`. Chief writes both when a worker completes. |
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
| `tool_error` | `registerChiefTool` in `src/tools/register.ts` | Yes, except for a failed `chief_report` |
| `stall`, `hard_stall` | `recordFailure`, when its insert adds a row | Yes |
| `provider_transient` | `recordFailure` for `provider`, when its insert adds a row | Yes |
| `thread_failed` | The failed branch, when the alert key `error:<cycle>` is new | Yes |
| `blocked` | A blocked report in `src/report/reportIntake.ts` | Yes |
| `request_changes` | A reviewer verdict in `reportIntake.ts`, one row per covered worker | Yes |
| `plan_review_changes` | An advisor `request_changes` on a plan in `reportIntake.ts` | Yes |
| `review_skipped`, `override` | `markComplete` in `src/runtime/completion.ts` | Yes |
| `stopped` | `stopThread` in `completion.ts` | Yes |
| `specs_skipped` | The waive branch of `src/tools/skipSpecs.ts` | Yes |
| `nudge` | `chief_continue` in `src/runtime/delegation.ts`, after the send succeeds | No: local only |

### Columns

`chief_events` has these columns: `id`, `event_id`, `at`, `project_id`, `thread_id`, `role`, `plan_thread_id`, `plan_wave`, `kind` and `detail`.

- `event_id` is a random 32-character hex id. It is unique. It is also the Sentry event id and the receipt.
- `detail` is the scrubbed text, at most 300 characters.
- A `request_changes` row has no detail. The daily report counts these rows for each thread.
- A `nudge` row has the detail `chars=N`. N is the length of the instruction.
- Indexes cover `at`, `plan_thread_id`, and (`thread_id`, `kind`).

### Invariants

- One row exists for each existing dedupe unit. A stall that re-enters every tick gives one `stall` row for each thread and active cycle.
- A transient failure gives one `provider_transient` row for each thread and cycle.
- Events from the report path run inside the report transaction. A rollback of the report removes their rows.
  Reason: the ledger never shows an event for a report that Chief did not accept.
- A failed `chief_report` call records its `tool_error` in the ledger only. The error is never sent to Sentry.
  Reason: the failed call rolled back its report, and a rolled-back report sends nothing on any later macrotask.
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
- The level is `error` for `tool_error`, `stall`, `hard_stall`, `provider_transient` and `thread_failed`. The level is `warning` for `request_changes`, `plan_review_changes`, `review_skipped`, `specs_skipped`, `override` and `stopped`.
- The tags are `kind`, and `role`, `thread_id`, `project_id`, `plan_thread_id` and `plan_wave` when present. A `tool_error` also has the tag `tool`.

### Scrub

- `scrub` replaces each non-empty configured secret literal with `[secret]`.
- `scrub` replaces these patterns with `[redacted]`: URL user information, `sk-` keys, GitHub tokens, Slack tokens, AWS access key ids, `Bearer` values, JWTs, and a key such as `token`, `secret`, `password`, `api_key`, `authorization` or `dsn` followed by `:` or `=` and a value. The key stays.
- `scrub` is idempotent. A 40-character commit SHA and a `thr_` id stay readable.
- `normalize` replaces `thr_` ids with `<id>`, `wfr_` ids with `<run>`, hex runs of 7 or more characters with `<sha>`, and digit runs with `<n>`.

### Plugin warnings

- A warning from the plugin through `ctx.bb.log.warn` also goes to Sentry as the kind `plugin_warn`, through `ctx.observe.warn`.
- The ledger does not record a plugin warning. The throttle applies to it.
- `ctx.observe.warn` takes no warning text. Sentry receives the fixed code `plugin_warn` as the message and as the fingerprint. The event has no tags that come from the warning.
  Reason: warning text can hold code, prompts, scripts, arguments or stderr, with or without a command marker. `scrub` removes secrets, not code.
- All plugin warnings share this fingerprint. The 10-minute throttle sends at most one of them in each window.
- The full warning text stays in the local log.
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

- `launch` in `src/research/managedSpawn.ts` starts `persistBrief` and does not wait for it.
- The spawn result never waits for the brief.
  Reason: a fresh environment can take seconds to become available.
- `persistBrief(threadId, projectId, prompt)` writes two copies of the spawn prompt independently.
  - The first copy is `brief.md` in the thread storage. The thread re-reads it after a compaction.
  - The second copy is the Chief artifact `brief.md`, at `<dataDir>/chief/<projectId>/<threadId>/brief.md`.
- Each copy retries while bb answers HTTP 409 "Thread environment is unavailable".
- The retry waits 1, 2, 4, 8, 15 and 30 seconds (at most 7 attempts, about 60 s).
- Chief does not retry any other error.
- After the last attempt, the copy logs a warning and is not retried. Only a reload while the retries run replays it.
- `persistBrief` never fails the spawn.
- `persistBrief` records the brief in the Chief DB table `pending_briefs` (`thread_id`, `project_id`, `prompt`, `at`) before any copy starts.
  Reason: the retries last about 60 s. A reload in that window would otherwise drop the brief.
- `persistBrief` removes the row after both copies settle. A copy settles when it lands or fails for good.
- If recording or removing the row fails, `persistBrief` logs a warning. It still attempts both copies and never rejects. A row that stays is replayed by a later generation.
- A generation is one plugin instance. `bb plugin reload` starts a new generation and disposes the old one.
- A disposed generation does not remove its rows. The next generation replays them.
- The `brief-replay` background service (`server.ts`) calls `resumeBriefs` (`src/runtime/artifacts.ts`) once per generation. It restarts `persistBrief` for each row and does not wait for the writes. Then it waits until BB aborts it.
  Reason: BB starts services only after the old generation is disposed. A replay in the plugin factory could miss a row that the old generation writes late, or the old generation could delete a row that the replay reads.
- Trade-off: the outbox replays after activation instead of flushing on dispose. Dispose cannot wait about 60 s, and the bb handle is stale after dispose. A replay rewrites an existing copy with the same content. `atomicWrite` is remove-then-move, not a concurrency fence, so generations avoid overlap by ordering, not locking.
- The Chief artifact copy goes to the host of the project (`projectHostId`). It does not ask bb for the storage location of the thread.
  Reason: the storage location is unavailable while the environment provisions, and the copy must still be written.
- Trade-off: the artifact copy uses the host of the project, not the host of the thread. On a single-host setup they are the same machine.
- `artifactDir` in `src/runtime/artifacts.ts`: when the caller names the host, Chief does not ask bb for the storage location of the thread.
- Cleanup clears only the thread storage. The artifacts survive.
  Reason: the artifact brief and the completion snapshot are the durable evidence, and they must outlive cleanup.
- Every Chief artifact goes through `atomicWrite` in `src/runtime/artifacts.ts`. The write replaces an existing file at the same path.
  1. `atomicWrite` writes the text to `<path>.tmp-<uuid>`.
  2. It moves the tmp file to the path.
  3. When the move fails with a message that matches `/already exists/i`, it removes the destination file and moves once more.
  4. Any other move error, or a failure of the second move, removes the tmp file and throws the error.
- The code finds an existing destination by the text of the host message. When the host changes that text, an overwrite fails with an error and loses no data.
- The replace is remove then move. A reader can see the file missing for a short time.
- A failed second move loses the old version. The caller sees the error and retries.

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
- `sentry` is `skipped` and makes no `fetch` when the token, the org or the project is unset.
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
- The `agy` adapter uses this reader.

## Daily report

`runDailyReport` in `src/observe/report.ts` builds one report each day and alerts Chief. `buildDailyReport` builds the text. The schedule is `bb.background.schedule("daily-report", "0 8 * * *")`, which is 08:00 server-local time.

| Section | Content |
| --- | --- |
| Sources | A table of name, status, item count and note for each adapter. |
| Sentry | New and recurring issues, or the reason that Sentry is not available. |
| Scorecard | The counts for each ledger kind in the last 24 hours and the 24 hours before. The review count is the number of `request_changes` rows of each thread. |
| Completion evidence | The completions in the window whose `diff_state` is not `ok`, with their notes. |
| Recurring patterns | Patterns that occur 2 or more times. The top 15. |
| Threads with failures | The threads that have the most failure items. |
| Lessons | Proposed lessons that wait for a decision, grouped by surface; a surface with lessons from 2 or more distinct plans in 14 days is recurring and comes first. Then the counts of accepted and retired lessons. |
| Logs | The items of the `bbLogs` adapter. |
| Triage | A last line that tells Chief to plan any fix as normal work (`chief_plan`). |

- The report has at most 60,000 characters. When it is longer, the builder cuts whole items from the end of the longest section.
- The builder scrubs the whole report.
- The run first deletes the `chief_events` rows older than 90 days. Reason: the ledger stays bounded. The delete runs even when no Chief exists.
- With no active Chief for the setting `chiefProject`, the run logs one info line. It writes no file and no outbox row.
- Otherwise the run writes `reports/daily-<date>.md` in the storage of that Chief. It then sends one alert with the key `daily:<date>`.
- A second run on the same date gives the same path and no second outbox row.
- The alert text has the path, then the counts of new Sentry issues, recurring patterns, blocked workers, stalls and threads with 2 or more `request_changes` rows. It ends with the triage line.
- The daily alert adds the count of proposed lessons that wait for a decision.
- The run never throws. A failure logs a warning, and the next day runs again.
- `alertSelf` in `src/runtime/alerts.ts` sends the alert. When the source of an alert equals its target, `deliverAlert` sends it without `senderThreadId`. When they differ, the alert still carries `senderThreadId = source_thread_id`.
  Reason: a thread cannot message itself as its own sender.

## Lesson lifecycle

`chief_lessons` is the one store of lessons. A reviewer or advisor report with a `lesson` writes to it.

| Status | Meaning |
| --- | --- |
| `proposed` | A new lesson. No prompt contains it. |
| `accepted` | Chief decided to use it. Prompts contain it. |
| `retired` | Chief decided to stop using it, or rejected it while it was `proposed`. |

- A lesson goes from `proposed` to `accepted`, and from `accepted` to `retired`. A lesson goes from `proposed` to `retired` when Chief rejects it. No other transition exists.
- The migration adds `status` with the default `accepted`. Existing rows stay accepted, so they keep their injection.
- The migration also adds `surface`, `plan_thread_id`, `evidence`, `rubric_version`, `proposal_key`, `decided_at` and `decided_reason`. A unique index covers `proposal_key`. A NULL key is not constrained. Only older retro rows hold values in `surface`, `plan_thread_id`, `evidence`, `rubric_version` and `proposal_key`.
- The report intake (`src/report/reportIntake.ts`) inserts a lesson as `proposed`. Its report alert adds the line `Proposed lesson <id>: bb chief lesson accept <id> --reason "…" (or retire)`.

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
- The report alert and the daily report point to these commands.

### Invariant: Chief never edits itself

- The plugin never edits a prompt or code.
- A lesson reaches a prompt only after a recorded Chief decision. Reason: a lesson from a reviewer or an advisor can be wrong. A durable fix still ships as a reviewed plan.

## Retired retro data

- `chief_retros`, `chief_scores` and the `retros_since` row of `plugin_meta` remain in the database from earlier versions. No code reads or writes them.
- Lessons that the retro filed (rows with `rubric_version` set) stay ordinary `chief_lessons` rows and follow the same lifecycle.
- Reason: the owner allows no destructive migration.

## Related decisions

- [Sentry through a direct envelope, no SDK](../decisions/2026-11-13-sentry-envelope-no-sdk.md)
- [One gated lesson store](../decisions/2026-11-13-lesson-lifecycle-gate.md)
- [Remove the retro judge](../decisions/2026-11-26-remove-retro-judge.md)
