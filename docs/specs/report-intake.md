# Report Intake

## Purpose

The report intake accepts every `chief_report` call from a managed thread and publishes the result. It owns the order of the steps for all roles: worker, planner, reviewer, advisor, and researcher.

## Domain Terms

- **Report**: one `chief_report` call. It has a state (`ready`, `blocked`, `active`, `idle`, or `failed`) and optional fields such as `result`, `verdict`, `findings`, `fails`, `lesson`, and `plan`.
- **Row**: the `managed_threads` record of the reporting thread.
- **Pending row**: a row built from spawn metadata when the thread has no stored row yet. It is a candidate until the report validates.
- **Seq and rev**: `report_seq` counts reports of a row. `result_rev` counts replacements of the stored result.
- **Required state**: everything that the transaction commits (see the flow below).
- **Optional work**: everything after the transaction. It reads or writes files, or reads the checkout.
- **Outbox**: the `alert_outbox` table. An alert stays there until Chief receives it.
- **Pending alert**: a short alert that the transaction writes. Its key is `report:<cycle>:pending-<seq>`.
- **Verdict file**: `verdict-<seq>.md`. It holds the full report of a reviewer verdict.
- **Report file**: `report-<seq>.md`. It holds the full text of a long or clipped report.
- **Stamp**: the `Read at <sha>` text of a researcher or planner report. `checkout-freshness.md` defines it.

## Ownership and Entry Points

| Entry point | File | Role |
| --- | --- | --- |
| `createReportIntake(adapters).report(threadId, params, callerProjectId)` | `reportIntake.ts` | Owns the order of acceptance and publication. Resolves to whether Chief received the alert now. `false` means the alert waits in the outbox. |
| `checkReport`, `reportAlert`, `verdictFileBody`, `reportFileBody` | `reportIntake.ts` | Pure helpers. They validate a report and lay out the alert and the files. |
| `chief_report` handler and adapters | `server.ts` | Calls the intake one time. Provides the adapters. |

The adapters are:

- the thread store and the review ledger
- the artifact writer
- the alert outbox write and the alert delivery
- the forge comment content and the plan log
- the Next line, the recorded commands, and the checkout stamp

The `chief_lessons` write belongs to the intake.

Until the code move of this change, the same steps run in `report()` in `server.ts`. The Baseline section describes that code.

## Baseline: Behaviour at 2351b05

This section describes the code at commit 2351b05. The Target section states what this change keeps and what it moves.

Code paths:

- `report()` in `server.ts` (lines 3123 to 3300).
- `writeAlert` in `server.ts` (lines 2825 to 2842).
- `enqueueVerdictComments` and `enqueueBlockedComment` in `server.ts` (lines 2938 to 2978).
- `checkReport`, `reportAlert`, `verdictFileBody`, and `reportFileBody` in `reportIntake.ts`.

This section covers acceptance and publication. It does not cover the alert layout budgets. `checkout-freshness.md` covers the stamp line.

### Flow

1. **Look up.** `report()` loads the row, or a pending row from spawn metadata.
2. **Check eligibility.** It refuses when no row exists, or the role is `chief`. The message is `chief_report is available only in managed worker, planner, reviewer, and advisor threads.`
3. It refuses when the stored row state is `complete`, `archived`, or `deleted`. The message is `Managed thread <id> is <state> and can no longer report.`
4. **Decode.** A `plan` string that starts with `[` and parses as an array becomes that array. A `fails` string and a `findings` string go through `JSON.parse`. A string that does not parse stays a string, and `checkReport` refuses it.
5. **Validate.** `checkReport` returns one line for each failed rule. One error lists all lines: `chief_report was not saved; fix all of these and call it once more:`, then `- <line>` for each line.
6. **Insert.** When the row was only a pending row, the code inserts it now.
7. **Write the plan.** A planner ready report with a plan trims each wave body. `writePlan` writes `plan-<n>.md` for each wave. A write failure throws and refuses the report. The inserted pending row stays.
8. **Mirror the plan.** When the planner has a Chief, `writePlan` writes a copy under Chief's thread storage. A failure logs `Could not mirror <id>'s plan into Chief's storage: <error>` and adds no inline plan lines.
9. **Merge fails.** An entry in `fails` replaces a stored entry with the same scope and text. The code drops repeated entries within the report and stamps each new entry with the time. It keeps the newest 12 entries.
10. **Trim findings.** The code trims `file`, `message`, and `fix` of each finding.
11. **Commit.** One `store.batch` transaction runs the steps below in order.
12. **Build the Next line.** `nextAction(current, true)`, else `waveWaitLine(current)`, else the researcher line, else the inspect line.
13. **Read recorded commands.** Only a worker ready report does this step.
14. **Write the verdict file.** Only a reviewer report with a verdict does this step. It is best-effort.
15. **Read the stamp.** Only a researcher or planner report does this step.
16. **Lay out the alert.** `reportAlert` builds the alert. The first pass decides whether the report is long or clipped.
17. **Write the report file** when the rules in the Pointer table require it.
18. **Attach the files.** `store.attachReportFiles` runs one time for each accepted report.
19. **Deliver.** `alertChief` writes the outbox row and sends the alert.

### Transaction steps

The transaction runs these steps in order:

1. `reserveReport` stores the report columns, adds 1 to `report_seq`, and clears `report_path`.
2. An advisor ready or blocked report marks the row advised. When the advisor has a plan thread, the first advice resolves the plan review. `approved` means a ready report with verdict `approve`. Any other advice means `changes`.
3. A planner ready report with a plan sets the plan review. The review is `required` when the row has no `replaces_thread_id`, and either the plan has more than one non-test wave or `complex` is true. Otherwise the review is null. When the planner replaces a planner with review `changes`, the replaced planner completes.
4. An advisor or reviewer ready report with a `lesson` inserts one `chief_lessons` row. The row holds the project, the text, the reporting thread, the reviewed worker, the time, and the role.
5. `ledger.recordVerdict` adds 1 to `reject_streak` for `request_changes` and sets it to 0 for `approve`. A reviewer report with a verdict also inserts one `reviewer_verdicts` row for each covered target. A reviewer without targets inserts one row from the row's own worker and head.
6. A reviewer ready report with a verdict enqueues forge comments (one for each covered pull request). A worker blocked report enqueues one blocked comment. `forge-comments.md` describes them.
7. When the row has a Chief, the code writes the pending alert. It has the title, the state, and the report number. It adds up to 300 characters of `summary` or `result`. The last line is `The full alert could not be built; run chief_inspect <id>.`
8. A worker in a plan with `fails` appends one `FAIL` entry for each fail to the plan log.

### What the report stores

| Role and state | Stored in addition to the common columns |
| --- | --- |
| Any ready report | `verdict` (null when the report sends none). Other states store a null verdict. |
| Planner ready with a plan | `plan_waves`: path, contracts, title, and the flags `dependsOn`, `design`, `test`, `spec`, `baseline` for each wave. |
| Worker or reviewer with `fails` | The merged `fails` JSON. A report without `fails` keeps the stored value. |
| Reviewer | `findings` JSON. Every reviewer report replaces it. A report without findings clears it. |
| Ready with `regression` true and verdict `request_changes` | `regression` is 1. |

### Alert and file rules

| Case | Pointer line | Report file |
| --- | --- | --- |
| Reviewer verdict, verdict file written, result long or alert clipped | `Full report: <verdict path>` | None |
| Reviewer verdict, verdict file written, otherwise | None | None |
| Reviewer verdict, verdict file write failed | `Full report: could not write verdict-<seq>.md (see the plugin log)` | None |
| No reviewer verdict, result over 800 characters or alert clipped, write works | `Full report: <report path>` | Written |
| No reviewer verdict, result over 800 characters or alert clipped, write fails | `Full report: could not write report-<seq>.md (see the plugin log)` | None |
| No reviewer verdict, short and not clipped | None | None |

A failed file write logs a `warn` line: `Could not write <id>'s verdict file: <error>` or `Could not write <id>'s report file: <error>`.

A reviewer report with a verdict, a written verdict file, and a result shows a preview of the result in the alert. The alert also names `bb chief inspect <id>`.

The Next line has these texts:

- Researcher: `Research is advisory: use its findings, check anything doubtful against the code, and note any failures or timeout it reports. Nothing to review or complete.`
- Last choice: `Inspect live evidence with chief_inspect and choose: continue, review, complete, or escalate to the user.`

The final alert key is `report:<cycle>:<first 16 hex of the sha1 of the alert text>`. It has the same `report:` kind as the pending alert. `writeAlert` deletes undelivered alerts of the same source and kind with another key. So the final alert evicts the pending alert while Chief has not received it.

`alertChief` resolves `true` when Chief receives the alert now and `false` when the send fails. A failed send stays in the outbox for a retry.

### Baseline contracts

Each contract carries its reason.

- A refusal by eligibility or validation writes nothing. A pending row is not inserted. Reason: the code comment says a row from spawn metadata is only a candidate until the report validates.
- The code decodes JSON strings of `plan`, `fails`, and `findings` before validation. Reason: some planners send the wave array JSON-encoded, and a string plan reads as one flat wave.
- A planner plan write failure refuses the report after the pending row insert. Reason: not stated in the code.
- One transaction holds the report columns, the review marks, the lesson, the verdict rows, the counter, the forge comments, and the pending alert. Reason: a crash before the full alert still leaves Chief a pointer.
- `report_seq` is reserved in the transaction. Reason: the file names of each report never collide.
- The ledger writes run only inside `store.batch`. Reason: `inBatch` throws `A review ledger write must run inside store.batch.` otherwise.
- `reject_streak` counts consecutive `request_changes` verdicts. An `approve` resets it. Reason: the code comment says `active_cycle` counts every resume, so a resumed reviewer must not look like a deadlock.
- The verdict file is best-effort. A failed write never erases the stored verdict. Reason: the verdict is in the database either way.
- A reviewer with a verdict never gets a report file. Reason: the verdict file is the full report.
- The stamp read starts after the transaction. Reason: the state, the seq, and the pending alert are already committed.
- The mirror to Chief's storage is best-effort. Reason: `inline-vis` resolves paths against the rendering thread.
- `attachReportFiles` always runs. It is guarded by `report_seq`, and `report_path` is also guarded by `result_rev`. Reason: a slow write never attaches its path to a newer report, nor to a result that `chief_complete` replaced. A report without a verdict still clears the previous `verdict_path`.
- The final alert key shares the `report:` kind. Reason: the final alert evicts the undelivered pending alert.

## Target: Behaviour After This Change

The code of `report()` moves into `createReportIntake`. The behaviour stays the same. The `chief_report` handler in `server.ts` makes one call: `intake.report(...)`. `server.ts` has no function that sequences report steps.

### Contracts

Each contract carries its reason.

- A report refused by validation or eligibility writes nothing. This covers every `checkReport` line, a `chief` caller, and a `complete`, `archived`, or `deleted` row. A pending row is not inserted. Reason: a refusal must change nothing.
- The intake decodes JSON strings of `plan`, `fails`, and `findings` before validation. Reason: the validation reads the decoded value.
- The intake stores accepted findings with `file`, `message`, and `fix` trimmed. Reason: not stated in the code.
- One transaction holds these writes. Reason: a crash before the full alert still leaves Chief a pointer.
  - The report columns with seq and rev.
  - The advisor and planner review marks.
  - The advisor or reviewer lesson, tagged with its role.
  - The verdict rows and the reject counter.
  - The forge comment rows.
  - The pending alert.
- After the commit, the intake runs these steps in order. Reason: the required result must not depend on optional work.
  1. The Next line.
  2. The recorded commands.
  3. The verdict file.
  4. The stamp.
  5. The report file.
  6. The guarded attach.
  7. The delivery.
- A reviewer verdict has `verdict-<seq>.md` as its full report. The intake never writes `report-<seq>.md` for it. Reason: its verdict file is the full report.
- The attach is guarded by `report_seq`, and `report_path` also by `result_rev`. The attach always runs. Reason: see the baseline contract.

- After the commit, the intake hands accepted plan files and verdict files to the tracker sync (`trackFiles`). The call runs before the delivery and never delays or changes the alert. See `tracker.md`.

### Invariants

- Required state commits before the optional work after the transaction. Reason: the required result must not depend on optional work.
- A missing verdict file never erases the stored verdict. Reason: the verdict rows commit first.
- Review ledger writes run only inside the `store.batch` of the intake. Reason: the ledger refuses a write outside a batch.
- The intake is the only writer of `chief_lessons` in a report. Reason: the thread store keeps only `managed_threads`.
- A failed optional step changes only the alert text and the attached paths. It never removes a committed row. Reason: the required rows are already committed before optional work begins, so an optional failure cannot roll them back.

### Trade-offs

- The planner plan files run before the transaction. A failed plan write refuses the report after the intake inserted a pending row.
- The best-effort mirror to Chief's storage also runs before the transaction. It stays there because this change does not change timing.
- Both are exceptions to the rule that required state commits before optional work. Reason: the change moves code and keeps timing.

## Out of Scope

- The alert layout budgets. `checkout-freshness.md` covers the stamp line.
- The forge comment content builders, the alert outbox, and the artifact writer. They stay in `server.ts` as adapters.
- The `configure` lesson read.
- The `chief_report` input schema.

## Related

- `forge-comments.md`: the comments that the transaction enqueues.
- `checkout-freshness.md`: the stamp in researcher and planner reports.
- `plan-chains.md`: the plan waves and the review ledger.
- `tracker.md`: the tracker sync that receives the plan and verdict files.
