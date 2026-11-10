# Forge Comments

## Purpose

The forge comments domain publishes task events on GitHub pull requests and issues or GitLab merge requests and issues.

## Domain Terms

- **Forge**: a web platform for source code control and review, such as GitHub or GitLab.
- **Target**: the web address of a pull request, an issue, or a merge request.
- **Dedupe key**: a unique string identifier for a comment event.
- **Marker**: a hidden HTML comment that holds a cryptographic hash of the dedupe key.
- **Outbox**: a local database table that stores comments until publication completes.

## Ownership and Entry Points

The module `src/forge/forgeComments.ts` owns the comment outbox and the forge adapters. It owns the table text, database queries, attempt counters, marker scans, retry timers, give-up rules, and background drains.

Callers in `server.ts` use two entry points from `src/forge/forgeComments.ts`:

1. `createForgeComments(deps).enqueue(input)` queues a comment for delivery.
2. `forgeComments.drain()` triggers a background processing pass from the supervisor cycle without awaiting completion.

The module declares the `ForgeAdapter` interface for platform operations:

- `post(target, body)`: sends a comment to the forge.
- `hasMarker(target, marker)`: checks if a comment with the exact marker string exists on the target.
- `login(target)`: returns the username of the authenticated user for the forge host.

The function `cliAdapters(env)` provides production adapters for `gh` and `glab`. Test suites provide fake adapters.

Callers in `server.ts` construct comment content for task events:

- `enqueueVerdictComments`: creates review verdict comments on covered pull requests.
- `enqueueBlockedComment`: creates blocked status comments on pull requests or issues.
- `enqueueCompletionComment`: creates completion comments on tracking issues or pull requests.
- `chief_escalate`: creates escalation comments that mention the repository owner. The tool takes an optional `merge`. The forge **Need you** comment is unchanged by it. See `tracker.md`. Without a `threadId`, the tool posts nothing on the forge. See `coordinator.md`.

## Flows and States

Comment rows move through three states in the `forge_comments` table:

- **Pending**: `posted_at IS NULL AND gave_up_at IS NULL`.
- **Posted**: `posted_at IS NOT NULL AND gave_up_at IS NULL`.
- **Given up**: `gave_up_at IS NOT NULL AND posted_at IS NULL`.

A comment moves through this lifecycle:

1. A caller invokes `enqueue` with a key, a thread row, a target URL, comment text, and an optional mention flag.
2. The module parses the target URL.
3. If the URL is missing or invalid, the module logs information and stops.
4. The module inserts a row with zero attempts into `forge_comments` and queues a microtask drain.
5. The drain selects up to 20 pending rows, ordered from oldest to newest by creation time.
6. The drain skips rows tried within the last 25 seconds in the current instance.
7. For each eligible row, the module increments the attempt counter in SQLite before any network call.
8. If the prior attempt counter exceeds zero, the module scans the target for the exact marker string.
9. If the scan finds the marker, the module sets `posted_at` and skips the post.
10. If the marker is absent, the module resolves the owner mention and posts the comment body.
11. When the post succeeds, the module records `posted_at` and clears `last_error`.
12. When an attempt fails, the module classifies the failure as permanent or transient.
13. If the failure is permanent or the attempt counter reaches 5, the module records `gave_up_at`.
14. If the attempt counter reaches 5 after transient failures, the module alerts Chief.

## Contracts

### Non-blocking Callers and Local Record Completion

- `enqueue` returns a boolean status immediately without awaiting network calls. Reason: comment delivery is optional secondary publication.
- `enqueue` writes no row and returns `false` when target URL parsing fails. Reason: invalid target addresses have no destination on a forge.
- `enqueue` defers an alert to Chief through a microtask when the row insert throws. Reason: deferred alerts prevent writes into caller transactions that can roll back.
- Caller tool operations complete normally when an adapter call hangs or rejects. Reason: core workflow progress must never depend on remote forge responsiveness.
- A rolled-back caller transaction writes no row and sends no comment. Reason: uncommitted task events must not appear on external platforms.

### Table Persistence and Migration Index

- `MIGRATIONS` retains the exact `FORGE_COMMENTS_TABLE` definition at zero-based index 114. Reason: the host platform hashes migration statements by array index.
- The module exports `FORGE_COMMENTS_TABLE` matching the byte literal from base commit c8a0d76. Reason: hash mismatches prevent plugin startup.

### Attempt Persistence and Marker Verification

- The module increments `attempts` in SQLite before it invokes any adapter method. Reason: crashes during network calls appear as potential posts on recovery.
- The module posts without a marker scan when prior attempts equal zero. Reason: initial delivery attempts cannot exist on the forge earlier.
- The module scans for `markerFor(dedupe_key)` before posting when prior attempts exceed zero. Reason: earlier interrupted attempts might reach the forge.
- An adapter searches for the marker string verbatim and does not hash the marker string again. Reason: repeated hashing changes the marker text and causes duplicate posts.
- The module treats an incomplete scan or a GitLab scan of 50 full pages as a failed attempt. Reason: incomplete scans cannot check marker absence safely.

### Failure Classification and Termination

- The module classifies `ENOENT`, HTTP 401, 403, 404, and authentication errors as permanent failures. Reason: missing commands and invalid credentials cannot succeed through retries.
- The module records `gave_up_at` immediately on permanent failures without alerting Chief. Reason: missing tools or absent targets need quiet termination.
- The module classifies rate limits, HTTP 429, and other errors as transient failures. Reason: temporary platform limits and network errors can recover later.
- The module marks an unparsable stored target as a permanent failure. Reason: corrupt target strings cannot resolve to valid platform addresses.

### Retry Bounds and Cooldown Clock

- The module stores the retry cooldown timer in process memory. Reason: the database schema contains no retry timestamp column.
- The module skips pending rows tried less than 25 seconds ago during the current pass. Reason: cooldown delays prevent rapid rate limit exhaustion.
- A single process run attempts delivery at most 5 times before it records `gave_up_at`. Reason: bounded attempts prevent infinite processing loops.
- The module alerts Chief exactly once when a row exhausts 5 attempts from transient failures. Reason: Chief must track publication failures that stop retrying.
- The drain pass selects at most 20 pending rows, ordered from oldest to newest by `created_at`. Reason: bounded batches maintain supervisor responsiveness.
- The module never retries a row with `posted_at` or `gave_up_at` set. Reason: terminal rows require no further network calls.

### Single-Flight Drain

- `drain()` runs passes sequentially using a single-flight execution loop. Reason: concurrent passes cause duplicate delivery attempts.
- Enqueue calls during an active pass set a flag that triggers another pass in the loop. Reason: newly added rows receive prompt processing.
- `drain()` never rejects its returned promise. Reason: supervisor cycles must not crash from outbox exceptions.

### Mention Resolution

- The module resolves mentions at post time using the configured owner handle or the adapter login username. Reason: owner identity can change during retry delays.
- The module strips a leading `@` symbol from configured owner handles. Reason: mention formatting expects a plain username.
- The module drops usernames that fail validation against `/^[A-Za-z0-9_.-]+$/`. Reason: malformed usernames corrupt markdown comment formatting.
- The module caches adapter login results in memory per host per instance. Reason: repeated authentication queries waste network quota.

### Content Sanitization and Markers

- The module strips local filesystem paths, thread identifiers, bb commands, and live mentions from text. Reason: internal machine details must not leak to public forges.
- Every comment body ends with a hidden marker holding the SHA-1 hash of its dedupe key. Reason: markers enable crash deduplication without revealing internal thread identifiers.

## Invariants

- Only `src/forge/forgeComments.ts` reads from and writes to the `forge_comments` table. Reason: centralized database access prevents state inconsistencies.
- Only `src/forge/forgeComments.ts` derives comment markers from dedupe keys. Reason: a single derivation prevents mismatched marker algorithms.
- An adapter searches for markers using verbatim string matching. Reason: hashing an incoming marker string breaks deduplication.
- The body of each stored comment ends with its marker comment line. Reason: adapter scans search for this marker in comment bodies.
- Enqueue operations never perform network requests before returning. Reason: callers must not wait on remote forge infrastructure.

## Known Limits

- A process restart clears the in-memory retry clock, so fresh instances retry pending rows on their first pass.
- An attempt interrupted by a crash after incrementing `attempts` can cause a row to make a 6th or later attempt.
- The exhaustion alert message always states "after 5 attempts", even when a row makes a 6th attempt after a restart.
- The system provides at-least-once delivery attempts rather than strict exactly-once delivery.

## Related Decisions

None. The table statement stays in `MIGRATIONS` at index 114 because the host platform hashes migrations by index. A code comment in `server.ts` records this constraint.
