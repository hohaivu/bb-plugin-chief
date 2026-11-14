# Checkout Freshness

## Purpose

The checkout freshness domain keeps Chief's checkout current before a researcher or planner reads it. It also records in each researcher and planner report which commit that reader saw. A reader started on a branch gets its own worktree on that branch, and Chief's checkout is not used.

## Domain Terms

- **Checkout**: the working tree of a git repository. Chief runs in one checkout.
- **Reader**: a researcher or a planner. Both read code and write no code.
- **Default branch**: the `defaultBranch` field of Chief's environment, for example `main`.
- **Fast-forward**: moving HEAD forward to `origin/<default branch>` with `git merge --ff-only`. It never rewrites history.
- **Skip**: a fast-forward that Chief does not do. A skip adds one warning line and never stops the spawn.
- **Primary host**: the host that runs the plugin server. The server runs git only in checkouts on this host.
- **Stage**: one bounded step of the freshness call, for example one SDK read.
- **Stamp**: the `Read at <sha>` text in a reader's report alert and report file.
- **Shares**: a planner shares Chief's checkout when Chief's environment path equals the project source path.
- **Recorded branch**: the `branch` value in a reader's thread row. It is null when the reader started without a branch.
- **Branch reader**: a researcher or planner with a recorded branch. It runs in its own worktree on that branch.

## Ownership and Entry Points

| Entry point | File | Role |
| --- | --- | --- |
| `fastForward`, `commitStamp`, `stampLine` | `src/forge/checkoutSync.ts` | Run git and build the stamp text. |
| `freshenChiefCheckout`, `syncChiefCheckout`, `reportStamp`, `serverCheckout`, `stageRead` | `src/runtime/checkout.ts` | Decide whether to fast-forward and read the stamp. `reportStamp` is an adapter of the report intake. |
| `startResearcher`, `researchRun` | `src/research/research.ts` | Start a researcher and build the tool reply. |
| `startPlan`, `startConsult`, `startPlanConsult` | `src/runtime/delegation.ts` | Start a planner or advisor, in the project default or on a branch. |
| `chief_plan`, CLI `plan` | `src/tools/plan.ts`, `src/runtime/cli.ts` | Build the tool and CLI replies. |
| `report` (`createReportIntake`) | `src/report/reportIntake.ts` | Save a report and deliver the alert. `report-intake.md` describes it. |
| `reportAlert`, `reportFileBody` | `src/report/reportIntake.ts` | Lay out the alert and the report file. |

## Baseline: Behaviour Before the Fast-Forward

This section describes the code before this change. The next sections describe the behaviour after it.

### Researcher start

- `chief_research` from Chief calls `startResearcher` in `src/research/research.ts`.
- `researchPrepare` refuses on the call cap, the researcher model, the cooldown, and the quota. It returns `environmentId`, which can be null.
- `startResearcher` then refuses when `environmentId` is null, because the thread has no reusable environment.
- Every refusal happens before any thread exists.
- The researcher reuses Chief's own environment (`{ type: "reuse" }`). The code has no fallback to a fresh worktree.
  Reason: the researcher reads Chief's working tree.
- The code runs no git command and no freshness step before the spawn.
- `researchRun` returns `Started researcher thread <id> (<title>). It runs the <mode> in your checkout and reports through chief_report; the report arrives as a lifecycle alert. Do not poll: end your turn.`

### Planner start

- `chief_plan` and CLI `plan` both call `startPlan` in `src/runtime/delegation.ts`.
- `startPlan` refuses when planning is off. It then resolves the owning Chief and the revision input.
- The planner launches with `{ type: "project-default" }`. Chief also launches with `project-default`.
  Reason: a planner is read-only work in the project default environment.
- The code runs no git command and no freshness step before the spawn.
- `startPlan` returns `{ threadId, title, projectId }`.
- The `chief_plan` tool returns `Started planner “<title>” in thread <id>. Its ready alert lists the wave schedule and the exact next call.`
- CLI `plan` returns `Started planner “<title>” in <id>.` In `--json` mode it prints the `startPlan` result as JSON.

### Report delivery

1. The report intake (`report`) validates the report and loads the thread row.
2. `store.batch` reserves the report sequence number, saves the report state, and writes a pending alert in one transaction. The pending alert key is `report:<cycle>:pending-<seq>`.
3. `reportAlert` lays out the full alert. A report file is written when the result is long or the alert is clipped.
4. `store.attachReportFiles` attaches the files. `alertChief` delivers the alert.

Reason for the transaction: a crash before the full alert still leaves Chief a pointer.

The alert has no commit stamp. `reportAlert` puts the title line, then `State: <state>`, then the other required lines. `reportFileBody` writes the title, then `State:`, `Next:`, and the other sections.

## Flows and States

### Start on a branch

Chief names a branch with `branch` on `chief_research`, `chief_plan`, or `chief_consult`. The role then runs in a new BB managed worktree based on that branch.

| Call | Environment | Freshness call |
| --- | --- | --- |
| `chief_research` with `branch` (Chief only) | Managed worktree on `branch` | None |
| `chief_plan` with `branch`, or a revision with no `branch` of a planner that has a recorded branch | Managed worktree on that branch | None |
| `chief_consult` with `branch` and no `workerThreadId` | Managed worktree on `branch` | None |
| Plan consult with no `branch`, of a planner that has a recorded branch | Managed worktree on the planner's branch | None |

- The launch names a host, a managed worktree, and the base branch. It never reuses Chief's environment and never uses `project-default`.
- The launch stores `branch` in the thread row. The busy check and the report stamp read it.
- The `chief_research` reply says `in a fresh worktree on branch <branch>` in place of `in your checkout`.

### Fast-forward before a spawn

`chief_research`, `chief_plan`, and CLI `plan` call `freshenChiefCheckout` after every refusal check, unless the call names a branch (see Start on a branch). The call returns `null` or one warning line.

1. `serverCheckout` reads Chief's thread, its environment, and the primary host.
2. The server decides whether the reader shares Chief's checkout (see Planner sharing).
3. The server checks for a running reader in the checkout.
4. `fastForward` fetches `origin/<default branch>` and merges it with `--ff-only`.
5. The server spawns the reader. A warning, if any, follows the normal reply text.

`fastForward` runs these checks in order. The first failed check skips.

1. Tracked files have uncommitted changes. Untracked files do not count.
2. `git fetch` fails.
3. HEAD has commits that `origin/<default branch>` does not have.
4. HEAD already equals `origin/<default branch>`. The result is `{ from, to }` with equal values.
5. Fewer than 10 s remain before the merge.
6. `git merge --ff-only --no-overwrite-ignore` fails.

### Planner sharing

Sharing has three values.

| Value | Meaning | Planner call |
| --- | --- | --- |
| yes | Both paths are known and equal. | Continue to the busy check and the fast-forward. |
| no | Both paths are known and differ. | Run no git. Add no warning. |
| unknown | A lookup failed or a path is missing. | Run no git. Add the warning `could not tell whether the planner shares it`. |

A researcher without a `branch` always reads Chief's checkout. The sharing value applies only to a planner call without a `branch`.

### Busy check

A reader is running when it meets all of these conditions:

- It belongs to this Chief.
- Its stored state is not terminal.
- It is a researcher, or it is a planner whose sharing is not `no`.
- Its recorded branch is null.
- Its live status is `active`, `starting`, `stopping`, or `pending`, or the live read fails or times out.

A researcher with live status `ready`, `blocked`, or `idle` does not block. A reader of another Chief never blocks. A reader with a recorded branch never blocks, because it runs in its own worktree.

### Skip causes

Each skip causes one warning line and never stops the reader from starting.

| Cause | Warning reason |
| --- | --- |
| A reader is running | `<role> <id> is still running in it` |
| Tracked uncommitted changes | `it has uncommitted changes` |
| Local commits ahead | `its branch has <n> commit(s) not on origin/<branch>` |
| Fetch failure | `git fetch failed: <text>` |
| Merge failure | `git merge --ff-only failed: <text>` |
| Fewer than 10 s before the merge | `timed out before the merge` |
| Checkout on another host | `the checkout is on a remote host, not the plugin server` |
| Unknown path, thread, or environment | `no environment`, `no checkout path`, or the clipped error |
| Unknown default branch | `default branch unknown` |
| Stage or git timeout | `timed out` |
| Planner sharing unknown | `could not tell whether the planner shares it (<cause>)` |

The warning has this form: `Did not fast-forward your checkout to origin/<branch or "the default branch">: <reason>. The <reader> reads it as it is.`

### Reply text

- The tool reply keeps its existing text first. The warning follows on a new line.
- When the fast-forward succeeds, the checkout is already current, or a planner is confirmed separate, the reply equals the reply before this change.
- `startPlan` adds a `warning` key to its result only when a warning exists. The CLI `--json` output has no new key otherwise.
- CLI `plan` appends the warning to its text the same way.

### Report stamp

The report intake (`report`) calls `reportStamp` for a researcher or planner report. Worker, reviewer, and advisor alerts do not change.

1. `store.batch` commits the report state, the sequence number, and the pending alert.
2. `reportStamp` reads the reporter's own checkout. For a researcher without a branch, this is Chief's checkout.
3. `commitStamp` reads `git rev-parse HEAD`. A failure here omits the stamp.
4. `commitStamp` then reads `git ls-remote origin refs/heads/<compared branch>`. The compared branch is the recorded branch, else the default branch. A failure here drops only the comparison.
5. `reportAlert` puts the stamp line after `State:`, clipped to 160 characters. `reportFileBody` puts it after `State:`.

The stamp text is `Read at <12 hex>`. When `ls-remote` returns a different SHA, the text adds `; <compared branch> is now <12 hex>, so this answer may be stale`.

## Contracts

Each contract carries its reason.

### Fast-forward

- `fastForward` never throws. Reason: a skip must never stop a spawn.
- `fastForward` moves HEAD forward to `origin/<default branch>` or leaves HEAD unchanged. Reason: the old HEAD must stay an ancestor.
- `fastForward` creates no merge commit, reset, stash, or change to untracked files or other branches. Reason: Chief's checkout may hold work that belongs to the user.
- A second `fastForward` returns `{ from: X, to: X }` and leaves HEAD unchanged. Reason: a repeat call has no effect.
- The server calls `freshenChiefCheckout` after every refusal check. A refused call leaves HEAD unchanged. Reason: a refused call must change nothing.
- The server runs git only in a checkout on the primary host. Reason: the plugin server cannot run git on a remote host.
- A planner call runs no git unless both paths are known and equal. Reason: a failed lookup is not proof of a separate worktree.
- The merge starts only when at least 10 s remain. Reason: a deadline must not kill a merge halfway through a working tree update.
- A merge retry starts only when at least 10 s remain. Each merge attempt needs the full reserve, not only the first. Reason: an under-budget retry can meet the deadline halfway through a working tree update.
- The merge uses `--no-overwrite-ignore`. An ignored untracked file that `origin/<default branch>` adds stays unchanged, and the merge fails as a skip. Reason: git replaces such a file by default, and the user's file is lost.

### Branch start

- A call without `branch` launches with the same environment and freshness calls as before this change. Reason: existing callers must see no change.
- A call with `branch` never calls `freshenChiefCheckout`. Reason: the reader does not read Chief's checkout.
- Only readers that can be in Chief's checkout delay its fast-forward. A reader with a recorded branch never delays it. Reason: that reader runs in its own worktree.
- `chief_consult` with both `workerThreadId` and `branch` is refused before any thread exists. Reason: a worker's worktree and branch belong to the worker.
- `chief_research` with `branch` from a caller other than Chief is refused before any thread exists. Reason: a researcher thread already reads its own worktree.
- The researcher's prompt never contains `branch`. Reason: the researcher's own `chief_research` call would refuse it.
- A `chief_research` call with `runId` ignores `branch`. Reason: not stated in the plan.
- A plan revision with no `branch` inherits the recorded branch of the plan it revises. Reason: the revision plans the same branch as the plan it revises.
- A plan consult with no `branch` uses its planner's recorded branch when it has one. Reason: the advisor reviews the planner's branch.

### Deadlines

- One freshness call has one absolute deadline of 30 s.
- Each read-only SDK lookup runs under `min(5 s, time left)`. A stage with no time left does not start. Reason: one slow lookup must not use the whole budget.
- `gitWithin` bounds each git command. The server awaits each git command until its child process exits.
- No `bounded` or `Promise.race` wraps code that reaches git. Reason: `bounded` abandons the losing call and does not cancel it.
- When `freshenChiefCheckout` returns, no git command that it started is running and none can start later. Reason: the reader must see the final state of the checkout.
- An abandoned SDK lookup has no continuation into git. Reason: the caller already moved on through a rejection.

### Stamp

- `reportStamp` never throws and has no outer deadline wrapper. Reason: a slow `ls-remote` must not remove the local SHA.
- Once `rev-parse HEAD` succeeds, the alert and the report file carry `Read at <sha>`. This holds when `ls-remote` fails or passes the shared 12 s deadline.
- The report intake commits the report state, the sequence number, and the pending alert before the stamp starts. Reason: the required result must not depend on optional enrichment.
- The stamp never changes the report state, the sequence number, or the saved files.
- The stamp line is a required line in `fixedCost` of `reportAlert`. Reason: a long result must not push it out of the alert.
- The stamp adds no database column. Reason: the stamp lives in the alert text and the report file.
- `reportStamp` compares against the reader's recorded branch when it has one, else the environment default branch. Reason: a branch reader's answer concerns the branch it read.

## Trade-offs

- The stamp is taken at report time, not at spawn time. It does not prove what the reader saw earlier in the run.
- "Moved" means a different SHA. It does not mean ancestry or chronology.
- Researchers share Chief's checkout by default. A researcher gets its own worktree only when Chief names a branch (user decision 2026-11-14, stacked-branch work).
- Chief's cleanup does not remove a researcher's branch worktree, because researcher rows are never cleanup-eligible.
- Planner worktrees in projects whose default is a worktree are not fast-forwarded. Only the stamp covers them.
- Path comparison is by string, with no realpath step. A symlinked path that differs as a string reads as a separate checkout. The planner call stays silent, as before this change.
- A concurrent second `chief_research` or `chief_plan` call meets git's own lock. It becomes an ordinary skip warning.
- The fast-forward may add up to about 30 s to a spawn call on a slow network. A normal fetch takes 1 to 2 s.
- The stamp may add up to about 12 s before the full alert. The reporter's `chief_report` call waits for it.
- A checkout switch by Chief during a run makes the stamp show the switched HEAD.
- The merge may still hit its own 10 s git timeout on a very large checkout.

## Out of Scope

- No worktree for each researcher unless Chief names a branch.
- No fast-forward of worker, reviewer, or advisor environments.
- No `origin/HEAD`, `main`, or `master` fallback when the environment has no `defaultBranch`.
- No stamp on the server's `research-unreported` alert.
- No change to the `chief_report` schema.
