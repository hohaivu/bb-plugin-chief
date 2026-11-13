# Observability

Observability gives Chief one local ledger for failures, review outcomes and nudges. It can also mirror the failure and review events to Sentry as scrubbed metadata. With no DSN configured, Chief makes no network call and the ledger still records.

## Terms

| Term | Meaning |
| --- | --- |
| Ledger | The table `chief_events`. One row is one event. |
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

## Related decisions

- [Sentry through a direct envelope, no SDK](../decisions/2026-11-13-sentry-envelope-no-sdk.md)
