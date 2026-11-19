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
- **Implementation wave**: a plan wave that is not `design: true`.
- **Turn**: one active cycle of a managed row. `active_cycle` counts the turns of the row.
- **No-report alert**: a lifecycle alert with the key `noreport:<cycle>`. It says that a turn ended without `chief_report`.
- **Report signal**: an outbox row whose dedupe key starts with `<thread>:report:<cycle>:`. The intake writes it for each accepted report, of any state.

## Ownership and Entry Points

| Entry point | File | Role |
| --- | --- | --- |
| `createReportIntake(adapters).report(threadId, params, callerProjectId)` | `src/report/reportIntake.ts` | Owns the order of acceptance and publication. Resolves to whether Chief received the alert now. `false` means the alert waits in the outbox. |
| `checkReport`, `reportAlert`, `verdictFileBody`, `reportFileBody` | `src/report/reportIntake.ts` | Pure helpers. They validate a report and lay out the alert and the files. |
| `sectionOf`, `contractsOf`, `checkPlan` | `src/report/reportIntake.ts` | Pure helpers. `sectionOf` reads a named Markdown section. `checkPlan` validates a planner plan, including the refusal of a `test` key. |
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
- `checkReport`, `reportAlert`, `verdictFileBody`, and `reportFileBody` in `src/report/reportIntake.ts`.

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
3. A planner ready report with a plan sets the plan review to null only when the review is unset or `required`. A `required` review is stale when no advisor runs for the plan. A decided review (`approved` or `changes`) is kept. Reason: owner decision. The advisor is an opt-in consult that Chief starts, not a gate, so the plugin never requires a review. When the planner replaces a planner with review `changes`, the replaced planner completes.
   - The intake refuses a planner ready report while an advisor for that plan is running. It checks before the plan files are written and again before `reserveReport`. The advisor is running when its row has no advised report and its state is busy. The refusal says to wait for the advisor's report. Reason: a replacement plan must not drop the review gate of a running advisor. The intake checks again at the state write, because an advisor can launch while the plan files are written.
4. An advisor or reviewer ready report with a `lesson` inserts one `chief_lessons` row. The row holds the project, the text, the reporting thread, the reviewed worker, the time, and the role. The row has the status `proposed`, so no prompt contains it until Chief accepts it. `observability.md` describes the lesson lifecycle.
5. `ledger.recordVerdict` no longer changes `reject_streak`. A reviewer report with a verdict also inserts one `reviewer_verdicts` row for each covered target. A reviewer without targets inserts one row from the row's own worker and head. The plugin reads and writes no test field.
6. A reviewer ready report with a verdict enqueues forge comments (one for each covered pull request). A worker blocked report enqueues one blocked comment. `forge-comments.md` describes them.
7. When the row has a Chief, the code writes the pending alert. It has the title, the state, and the report number. It adds up to 300 characters of `summary` or `result`. The last line is `The full alert could not be built; run chief_inspect <id>.`
8. A worker in a plan with `fails` appends one `FAIL` entry for each fail to the plan log.

### What the report stores

| Role and state | Stored in addition to the common columns |
| --- | --- |
| Any ready report | `verdict` (null when the report sends none). Other states store a null verdict. |
| Planner ready with a plan | `plan_waves`: path, contracts, title, and the flags `dependsOn`, `design`, `spec`, `baseline`, `feature`, `reshape` for each wave. An array plan stores `feature` and `reshape` as booleans on every wave. A string plan stores neither. `checkReport` refuses a non-boolean `design`, `spec`, `feature` or `reshape`, and refuses a `dependsOn` that is not an array of at most one earlier wave number. It also refuses `feature` or `reshape` true together with `design` true. |
| Worker or reviewer with `fails` | The merged `fails` JSON. A report without `fails` keeps the stored value. |
| Reviewer | `findings` JSON. Every reviewer report replaces it. A report without findings clears it. |
| Ready with `regression` true and verdict `request_changes` | `regression` is 1. |

The `chief_report` input has no `testsPassed` field, and no rule reads one. The column `tests_passed` stays in the database as a legacy column that nothing writes. Reason: the gate passes on the fix run's ready report, so no test field decides. A chat fix completes on a ready report plus a clean docs inspection (`src/runtime/completion.ts`). Reason: the report is the worker's evidence.

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

- Researcher: `Research is advisory: use its findings, check anything doubtful against the code, and note any failures or partial answers it reports. Nothing to review or complete.`
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
  - The advisor or reviewer lesson, tagged with its role, with the status `proposed`. The report alert adds the line `Proposed lesson <id>: bb chief lesson accept <id> --reason "…" (or retire)`.
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

### Alert content

`reportAlert` decides which lines the alert shows. The report file keeps the full text.

- A worker ready alert lists only the failed recorded commands. A failed command has an exit status that is not null and not 0. Reason: successful commands used about half of the alert.
  - The header stays `Recorded (last N commands): K non-zero exit`. N counts all recorded commands.
  - The alert lists no line for a command with exit 0 or a null exit.
  - When the alert leaves out a recorded command, the alert counts as clipped. The intake writes `report-<seq>.md` with every command and adds the `Full report:` line. Reason: Chief reads the successful commands in the report file.
- The Next line keeps up to 1,200 characters. A longer line is clipped and counts as clipped. Reason: the old limit of 400 cut the route in the middle of a sentence.
- A planner ready alert lists each plan file one time. Reason: one path for each wave is enough, and the report file keeps both lists.
  - When the mirror to Chief's storage worked, the alert shows the inline-vis lines, wave 1 first, and no `Wave n of N:` line.
  - When the mirror failed, the alert shows the `Wave n of N: <path>` lines.

### Section helper

`sectionOf` reads one Markdown section of a plan body. It has no fence rule, so a heading inside a fenced code block still counts as a heading. `contractsOf` uses it. Reason: `contractsOf` output is stored and must not change for any body.

- `sectionOf` matches the first heading of any level from 1 to 6 whose text starts with the name. It ignores case and leading spaces or tabs. Reason: `contractsOf` already matched these headings, and its output must not change for any body.
- `sectionOf` returns the text after the heading line up to the next heading of the same or a higher level, or to the end. Reason: a deeper heading stays in the section, so a nested `###` does not cut a contract list.
- `sectionOf` does not trim the text. The first content line keeps its indentation. Reason: indentation carries list depth.
- `sectionOf` returns undefined when no heading matches. Reason: the caller reports a missing heading, and an empty section returns an empty string, so the two cases stay apart.
- `contractsOf(body)` returns the trimmed legacy text for `Contracts to verify`, or undefined when that text is empty. Reason: existing callers keep their output.

### Test key refusal

`checkPlan` refuses a plan wave whose `test` key is `true` or `false`. The refusal says: `plan wave N: test waves are gone; a wave carries its own tests and Verify command. Drop test.` Reason: each implementation wave carries its own tests, so a test wave adds no work.

Invariants:

- The refusal runs only at planner ready-report intake. Admitted plans are never checked again. Reason: plans already admitted stay valid.
- A `test` value that is not a boolean, such as `null`, fails the report schema first. The schema refuses it before `checkPlan` runs, so this refusal never names it. Reason: the schema accepts only a boolean or no key.

## Turn End and BB Notices

This section covers what Chief hears when a managed thread ends a turn. The intake writes the report alert. The `lifecycle` handler in `src/runtime/lifecycle.ts` writes the no-report alert.

### Parent notifications

- `launch` in `src/research/managedSpawn.ts` starts each managed thread with BB parent notifications `stuck`. No caller setting overrides it. Reason: the report alert replaces BB's `completed` notice, which BB sent for each report, 26 of 26 in one Chief timeline.
- BB still sends Chief the failed, interrupted and needs-attention notices. Reason: the plugin does not replace these notices.
- Chief threads have no parent, so the setting does not apply to them. Reason: Chief spawns outside `launch`.
- The pr-agent review helper keeps `--parent-notifications off`. Reason: its spawn in `src/review/prAgent.ts` is outside `launch`, and this change leaves it unchanged.
- A thread spawned before this change keeps `auto`, and its `completed` notice, until it is replaced. Reason: the plugin does not update live threads.
- Under `stuck`, the managed header says that results reach Chief only through `chief_report`. The header forbids `bb thread tell` for results, although BB's guide asks for it under `stuck`. Reason: a tell would duplicate the report alert, and the plugin does not process tells.

### Finished-without-report alert

The handler sends the alert in this order:

1. BB sends `thread.idle` for a managed thread. `lifecycle` records the new state first.
2. When the new state is `idle` and the row has a Chief, `lifecycle` checks the turn for a report signal.
3. With no report signal, `lifecycle` sends Chief one no-report alert with the key `noreport:<cycle>`.
4. The handler continues its existing path.

Contracts:

- A turn with a report signal sends no no-report alert. Reason: Chief already received the report alert. This includes an `active` report while the thread waits for the owner.
- The alert needs the state `idle` after the event. Ready, blocked and complete rows keep their state and send nothing. Reason: a ready or blocked report answers the turn.
- The alert names the role, title and thread id. Reason: Chief finds the thread from the alert alone.
- The alert quotes the last assistant text, clipped to 400 characters. When the event has no text, the alert quotes the thread output. When the thread output is also empty, the alert shows `(none available)`. Reason: the last message shows Chief why the turn ended.
- The alert tells Chief to inspect the thread with `chief_inspect`, then continue it for its report or decide. Reason: the next step needs the live evidence.
- Repeated idle events in one turn send one alert. Reason: the key carries the cycle.
- A new turn that ends without a report sends a new alert. Reason: the key carries the new cycle.
- A Chief row, a row without a Chief, and an event other than `idle` send no no-report alert. Reason: only managed work of a Chief reports to it, and failure has its own alert.
- `stillDue` in `src/runtime/alerts.ts` drops a retried no-report alert. It drops the alert when the row is not `idle` or its cycle changed. Reason: Chief must not hear about a turn that the thread continued or reported later.
- The supervisor reconcile path sends no no-report alert. Reason: this change adds the alert to the idle event only.

## Out of Scope

- The alert layout budgets, except the content rules in Alert content. `checkout-freshness.md` covers the stamp line.
- The forge comment content builders, the alert outbox, and the artifact writer. They stay in `server.ts` as adapters.
- The `configure` lesson read.
- The `chief_report` input schema.

## Related

- `forge-comments.md`: the comments that the transaction enqueues.
- `checkout-freshness.md`: the stamp in researcher and planner reports.
- `plan-chains.md`: the plan waves and the review ledger.
- `tracker.md`: the tracker sync that receives the plan and verdict files.
