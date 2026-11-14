# Plan Chains

## Purpose

The plan chains domain manages execution topology, branch allocation, pull requests, worker environments, Spec Writer side worktrees, reviewer worktrees, and cleanup claims.

## Domain Terms

- **Plan wave**: an ordered unit of implementation, design, or testing in a plan.
- **Wave dependency**: the optional `dependsOn` field of a plan wave. It is an array of integers with at most one entry. `[k]` means that the wave builds on wave `k` and continues on its branch. `[]` means that the wave is independent and starts its own branch and pull request. An omitted field means that the wave depends on the previous wave. Wave 1 has no parent dependency.
- **Wave flags**: the optional booleans of a plan wave: `design`, `test`, `spec`, `feature` and `reshape`.
- **Feature wave**: an implementation wave with `feature: true`. It adds new behaviour. Its review runs the native-design check. A wave that is neither `test` nor `design` is an implementation wave.
- **Reshape wave**: an implementation wave with `reshape: true`. It is the make-native wave of a big feature. `feature` and `reshape` never mark a test wave or a design wave.
- **Chain**: an ordered sequence of waves from a head wave to a tip wave.
- **Chain head**: a plan wave with no parent dependency.
- **Chain tip**: a plan wave that has no successor wave.
- **Stacked chain**: a chain whose head has the optional `stackOn: k` field. Its task branch and pull request build on the task branch of wave `k`'s chain.
- **Plan base**: the base branch that a stacked or branch-based chain is fixed to. The server derives it, and `null` means the project default.
- **Task branch**: the Git branch created for a plan chain.
- **Worker environment**: the managed worktree environment assigned to a worker thread.
- **Spec wave**: a plan wave marked `spec: true` that a test, design, or skipped-specs rule does not exclude.
- **Side-lane Spec Writer**: a planned `spec-writer` row on a spec wave. Every row in its `replaces:` ancestry is also a `spec-writer`. It runs in parallel with the wave worker, in its own side worktree.
- **Implementation lane**: every other worker row. This includes worker, designer, and tester rows. It also includes a `spec-writer` that replaced a worker, designer, or tester.
- **Side worktree**: a private managed worktree on a `bb/` side branch cut from the task branch. A side-lane Spec Writer uses it.
- **Fold**: the push of the docs commits of a side-lane Spec Writer onto the task branch. The push is fast-forward only.
- **Fold base**: the task branch commit that the Spec Writer rebased onto before the successful fold push.
- **Fold head**: the commit that the fold push wrote to the task branch. `Fold: none` means that the writer changed nothing, and Fold base equals Fold head.
- **Chain owner**: the latest implementation-lane row of a chain. A live row wins over a finished row.
- **Pending writer**: a spec wave that has no Spec Writer row, or whose latest Spec Writer row is not ready, not idle after a ready report, and not complete.
- **Legacy plan**: an earlier plan where each wave received an independent branch.
- **Legacy wave**: a stored wave without a `feature` key. Its review keeps the native-design check and the reshape sentences.
- **Pinned review**: a review round bound to a specific pull request commit SHA.
- **Unpinned review**: a review round without a readable commit SHA.
- **Cleanup claim**: a persistent record in `cleanup_environment_claims` that assigns an environment action to one thread.
- **Repair target**: a worker thread that a reviewer covers. An open target is a repair target with work still open.
- **Loose target**: an open target that is not in a legacy stack.
- **Reject streak**: the rejection count that a reviewer row carries as `reject_streak`.
- **Rung**: the advice level (fix, consult, or stop) that `ledger.rung` returns for a reject streak.
- **Raw chain**: the chain that `chainOf` finds in the wave list with absent waived test waves included.
- **Code row**: a worker row in the implementation lane, not on a design wave, with kind `worker` or no kind. A Spec Writer, a Tester, and a Designer are never code rows.
- **Rejection**: the newest `request_changes` verdict of a chain, when no later verdict exists. Its time is the verdict time.
- **Fix**: the newest code row of a chain that Chief created after the rejection.
- **Spec Writers of this task**: the Spec Writers in the `replaces:` chain of a task row, plus the side-lane writers on the waves of its chain. `taskWriters` returns them.
- **Retest debt**: the duty to rerun the tests after a fix. A chain owes it when a fix exists and nothing discharges it.
- **Evidence-only tester**: a Tester that Chief delegates with `evidenceOnly: true`. It runs commands that already exist, compares the results, writes no test, and makes no commit.

## Ownership and Entry Points

Seven modules own the plan chains domain:

1. `src/plan/waveSchedule.ts` owns graph traversal, wave relationships, wave absence, the lane predicate `sideLane`, `writerPending`, and the plan base of a chain head (`planBase`).
2. `src/plan/planLifecycle.ts` owns delegation admission, role progression, and waivers.
3. `src/runtime/delegation.ts` owns `startWorker`, which launches workers and Spec Writers. `src/tools/forgeInit.ts` owns forge initialization. `src/runtime/cleanup.ts` owns cleanup steps.
4. `src/plan/planProgress.ts` owns progress checks, review readiness, the release route to the tester, legacy restack rules, and the repair decision after a reviewer verdict.
5. `src/runtime/nextAction.ts` and `src/runtime/completion.ts` own the text of the next call and the completion rules.
6. `src/research/delegationBrief.ts` owns the worker brief. `src/review/reviewStart.ts` owns review launch preparation, brief generation, and environment reuse.
7. `src/review/reviewLedger.ts` owns reviewer tracking, coverage checks, and historical task chain queries.

Callers interact with these entry points:

- `chainOf(waves, n)`: returns the complete chain of wave numbers for wave `n`.
- `parentOf(waves, n)`: returns the parent wave number of wave `n`, or null for a chain head.
- `successorOf(waves, n)`: returns the successor wave number of wave `n`, or null for a chain tip.
- `heads(waves)`: returns every chain head in the plan.
- `tips(waves)`: returns every chain tip in the plan.
- `admitDelegation(request)`: admits or rejects a delegation request for a wave. The admission names the lane, `side` or `implementation`.
- `sideLane(row)`: returns true for a side-lane Spec Writer. It is the only lane predicate.
- `chainOwner(planThreadId, chain)`: returns the latest implementation-lane row of a chain. It never returns a side-lane Spec Writer.
- `chainStarted(planThreadId, chain)`: returns any row of a chain, in any lane.
- `planBase(planThreadId, wave)`: returns null, or the plan base of a chain head, with its `unresolved` or `waiting` reason.
- `taskWriters(row, chainIds)`: returns the Spec Writers of this task. It never returns a writer of another plan, another chain, or another unplanned task.
- `specWriters(planThreadId, wave?)`: returns the side-lane Spec Writers, oldest first. `waveWorkers` returns the implementation-lane rows only.
- `writerPending(planThreadId, waves, n)`: returns true when wave `n` is a spec wave with a pending writer.
- `chief_forge_init(params)`: initializes the forge repository branch, pull request, and issue.
- `startWorker(params)`: prepares and launches a worker thread in an environment.
- `restackOf(worker, waves)`: determines whether a legacy wave requires a restack.
- `reviewAdvice(reviewer)`: returns null, or one advice of kind approve, fix, consult, or stop.
  - The advice names the layout: whole plan, single managed worker, or unowned branch.
  - The advice lists the open targets, the legacy stack groups in wave order, and the loose targets.
  - For each target, the advice states whether it is a tester branch and whether it sits on a spec-bearing chain.
  - A tester branch is a tester row or a worker on a test wave.
- `retestDebts(row)`: returns the owed retest debts of every chain that the review of `row` covers, and the debts that Chief waived. Each owed debt names the fix, the outstanding Tester if any, and one route.
- `chainTests(planThreadId, n)`: returns the test waves of the raw chain of wave `n`, head to tip. `chainWaiver(planThreadId, n)` returns the first waiver reason on those test waves.
- `newestVerdictAt(threadIds)`: returns the newest reviewer verdict and its time for a set of worker threads.
- `onSpecChain(row)`: returns true for a plan chain with a Spec Writer on an unbypassed spec wave. It also returns true for an unplanned task chain that holds a Spec Writer.
- `reusableEnvironment(threadId)`: returns the environment of an earlier reviewer if it is available for reuse.
- `cleanupStep(job, eligible)`: executes lifecycle cleanup transitions and records environment claims.

## Flows and States

A plan chain follows this lifecycle:

1. Chief calls `chief_forge_init` for an unstarted chain head.
2. The server initializes the tracking issue, creates the task branch, and creates a draft pull request.
3. Chief calls `chief_delegate` to launch a worker on the chain head.
4. The server creates a managed worktree checkout on the task branch.
5. The head worker executes and reports ready.
6. Chief calls `chief_delegate` for the next wave using `replaces:` referencing the chain owner.
7. The server assigns the existing worker environment, task branch, and pull request.
8. Later waves in the chain repeat this replacement sequence.
9. The chain tip worker reports ready, and Chief starts the plan review.

A spec wave adds a Spec Writer that runs in parallel with the wave worker:

1. Chief delegates the worker without a kind. Chief delegates the Spec Writer with `kind: spec-writer` and no `replaces:`. Either order is legal, and both calls can share one turn.
2. The server launches the Spec Writer in a new side worktree on a `bb/` side branch cut from the task branch. It completes no row and repoints no row.
3. The Spec Writer commits only `docs/` files on its side branch.
4. Before it reports ready, the Spec Writer folds its commits onto the task branch. It runs these steps on a clean tree:
   1. Fetch the task branch and note the commit `U`.
   2. Rebase onto `U` with no autostash. On a conflict, abort the rebase and report blocked.
   3. Check that the diff `U..HEAD` lists only `docs/` paths.
   4. Push `HEAD` to the task branch with a plain push. A rejected push repeats the steps from the fetch.
5. The Spec Writer records Fold base and Fold head, or `Fold: none`.
6. The tester call of the test wave waits until every Spec Writer of the chain reports ready. Then Chief delegates the tester with `replaces:` referencing the chain owner of the parent wave.

Independent chains run in parallel:

1. A planner specifies multiple chain heads with empty dependencies.
2. Chief calls `chief_forge_init` separately for each chain head.
3. Each chain head receives an independent branch, pull request, and worker environment.
4. Each chain proceeds through its waves independently.

Reviewers reuse pinned worktrees across review rounds:

1. Chief starts a pinned review for a completed task.
2. The server searches for the newest earlier pinned reviewer across target task chains.
3. The server reuses that reviewer worktree when the environment is reusable and distinct from any live target worker environment.
4. The reviewer brief instructs the reviewer to checkout the pinned commit detached.
5. The server creates a fresh managed worktree when no eligible earlier reviewer exists.

Shared worktree cleanup coordinates action ownership:

1. Multiple cleanup jobs start for threads that share one worktree environment.
2. Each job proceeds through the archive step.
3. The first job that observes the environment removed claims branch deletion and deletes the branch.
4. Other jobs observe the existing claim, record outcome `worktree shared: branch handled by <owner>`, and advance to storage without an alert.
5. The first job that observes teardown trouble or a stuck state records a claim and creates an alert.
6. Other jobs observe that claim and advance to storage without creating an alert.

## Contracts

### Chain Resource Allocation

- The server assigns exactly one task branch, one pull request, and one implementation worktree to each plan chain. A side-lane Spec Writer adds a private side worktree. It adds no second task branch, review branch, or pull request. Reason: shared environments reduce worktree disk use across dependent waves, and one chain keeps one pull request.
- The server creates a fresh managed worktree for each independent chain head. Reason: independent chains must execute in parallel without shared worktree state.
- `startWorker` reuses the environment of the prior worker when `replaces:` is present. Reason: chain waves share installed dependencies and build outputs.
- `startWorker` checks every non-terminal row on the same branch, except the row in `replaces:`. Reason: git prohibits simultaneous checkouts of one branch in different worktrees.
  - A same-plan implementation-lane row and same-plan side-lane Spec Writers coexist.
  - Side-lane Spec Writers of different waves of one plan coexist.
  - A second live side-lane Spec Writer on one wave is rejected, unless it replaces the first.
  - A second live implementation-lane row is rejected.
  - A holder from another plan, or an unplanned holder, is rejected.
  - Reason: a side worktree checks out its own `bb/` side branch, so it never blocks the task branch.
- `startWorker` rejects a delegation when `params.branch` differs from the branch of the prior worker. Reason: replacement workers must remain on the established chain branch.

### Stacked Chain Base

- A plan wave accepts `stackOn: k` only when it heads a chain. `k` is an integer from 1 to n-1, and wave `k` is neither a test wave nor a design wave. Reason: only an implementation wave of another chain gives a base to build on.
- `checkReport` refuses `stackOn` on any other wave, with one error line for each broken rule. Reason: a non-head wave continues the branch of its parent.
- `planBase` derives the base of a chain head in this order. Reason: one owner gives forge, admission, review and completion one value.
  1. A head with `stackOn: k` takes the task branch of the implementation owner of wave `k`'s chain. Until that chain has a task branch, the base is unresolved. Reason: only the implementation lane holds the code of wave `k`, and a side-lane Spec Writer does not count.
  2. Otherwise, a planner with a recorded branch gives that branch to every head. Reason: a plan started on a branch stacks its chains on that branch.
  3. Otherwise the base is `null`, which means the project default. Reason: a plan with no stack and no branch keeps the default base.
- `planBase` reports readiness apart from the base. A stacked head waits while wave `k` has no worker, or its latest worker is not settled. A worker is settled when it is ready, idle after a ready report, or complete. Reason: the stacked chain needs the code of wave `k`, not only its start.
- Once the base resolves, a later unsettled state of wave `k`'s worker sets `waiting` and leaves the base unchanged. Reason: a started chain keeps its branch when wave `k` re-enters a fix round.
- Launch needs a non-null base with no `waiting`. Review and completion use a non-null base whatever the readiness. Reason: launch needs the parent code, and review needs the base that the chain was cut from.
- A stacked chain with a null base skips each check that needs a base, and never reads origin/HEAD. Reason: the default branch lacks the changes of the parent wave, so its diff gives a wrong scope.
- The server never restacks a stacked chain and never retargets its pull request. Reason: a restack rewrites the history of started work. GitHub retargets a pull request only when its base branch is deleted.

### Chain Admission and Delegation

- `admitDelegation` rejects a non-head implementation delegation when `replaces:` is absent. Reason: non-head waves must continue on the existing worktree and branch of the chain.
- `admitDelegation` names `replaces: <chain owner>` when it rejects a non-head wave without a replacement target. Reason: callers must know the latest implementation thread to continue the chain.
- `admitDelegation` rejects an implementation delegation without `replaces:` when any wave in the chain already has an implementation-lane row. Reason: started chains must not allocate duplicate workers or environments.
- `admitDelegation` rejects `kind: tester` on a non-test wave only when the raw chain of that wave has a test wave. This includes an absent waived test wave. The text lists the test waves of that chain. Reason: a Tester of that chain runs on its test wave, and the test wave of another chain does not change this.
- `admitDelegation` admits `kind: tester` on a non-test wave when the raw chain has no test wave. The call needs `replaces:` of the worker whose branch it tests, or a new branch once that worker is complete. Reason: the retest route of a chain with no test wave must be a legal call.
- A later implementation wave is admitted while a Spec Writer is pending. Reason: Spec Writers never gate implementation waves.
- `admitDelegation` rejects a replacement target from another chain of the same plan. Reason: independent chains must not inherit foreign branches or environments.
- `admitDelegation` permits a fresh plan wave 1 delegation with `replaces:` targeting a blocked worker of another plan. Reason: re-planning allows recovery on the blocked worktree.
- `admitDelegation` permits a tester wave to start fresh on a new branch when the tested worker completed. Reason: post-merge testing verifies code after branch deletion.
- `admitDelegation` permits a fresh plan wave 1 delegation to replace a blocked row of another plan. The rule applies to each lane. Reason: re-planning allows recovery on the blocked worktree or side worktree.
- `admitDelegation` refuses a fresh delegation (without `replaces:`) to a chain head with a plan base, while that base waits or is unresolved. Reason: the head must not build before its parent code exists.
- `admitDelegation` refuses a fresh delegation to such a head without `branch`, and it never falls back to the project default. Reason: forge init cuts the branch from the plan base, so admission, forge and review agree on one value.
- `undelegatedHeads` excludes the waiting and unresolved heads, and returns them as `waiting`. Reason: the planner must see why a head does not launch.

### Evidence-Only Tester Brief

An evidence-only tester runs the commands that the mission names, on the commits that the mission names. It returns exit statuses and a base-to-head comparison.

- `chief_delegate` accepts the optional input `evidenceOnly: true`. The CLI flag is `--evidence-only`. Reason: Chief needs one explicit way to ask for run evidence instead of tests.
- `startWorker` refuses `evidenceOnly: true` when the kind that `admitDelegation` resolves is not `tester`. Reason: workers never run tests, and a run of suites on base and head is test running.
  - The refusal text names `kind: tester`.
  - The refusal happens before `managedSpawn.prepare`.
  - Nothing launches, no row is written, and the prior row is not completed or superseded.
- The flag is not stored on the row and `replaces:` does not carry it. A successor of an evidence-only tester gets a normal brief, unless Chief passes the flag again. Reason: each hand-off states its own mode, and no migration is needed.
- Without the flag, `workerBrief` returns the same `prompt`, `brief`, and `reviewerBrief` as before. The same holds when the flag is `false` or the kind is not `tester`. Reason: normal briefs must not change.
- The evidence brief starts with `You are the managed tester for`. Reason: the agent must know its role before it reads the other lines.
- The evidence brief omits these items. Reason: a tester that writes no test needs none of them, and the brief stays short.
  - `## Source of truth for test cases`
  - The `## Spec` block, with its merge-base checks and baseline line.
  - `## Contracts to verify`
  - `## Verify command`
  - `## Test work`
  - The push workflow, the previous-worker line, and the issue and pull request lines.
  - The summary text of the predecessor. The brief gives the report file path, or `bb chief inspect <thread id>`, and the blocker when one exists.
- The first line of `## Wave` in an evidence brief names the wave number and total, and drops `Implement only this wave's plan file.`. Reason: the tester implements no plan file.
- `## Git workflow` renders only when the call has a branch. It has one line: fetch the task branch, then fast-forward to it, and report blocked on a failure. Reason: the tester reads the folded docs and code of the task.
- `## Evidence work` orders the tester to follow these rules. Reason: a run is evidence only when the commit, the state, and the exit status are known.
  - Write no test. This brief overrides the `chief-role-tester` skill.
  - Commit nothing, push nothing, and edit no tracked file.
  - Never use stash, autostash, or another worktree.
  - Record `git rev-parse HEAD` as `Head commit` before any run.
  - Run base commits with `git switch --detach <base>` on a clean tree. Afterwards, `git switch -` returns to the head and HEAD must equal `Head commit`.
  - After each switch, reinstall dependencies when the lockfile differs, and reset any database or state that the suites write.
  - Run each command alone, and record `echo exit=$?` right after it. Use `set -o pipefail` before a pipe. Record the pass count of each file.
  - A ready report lists base and head side by side for each command, with commit, exit status, and pass counts. It explains every difference. Reason: an unexplained difference is a regression.
  - Before the report, HEAD equals `Head commit` and `git status --porcelain` prints nothing.
  - A blocked report names the command, its exit status, and an output excerpt. It recommends `kind: tester` for a wrong test and `kind: worker` for product code.
- When Chief gives no constraints, each blocking finding that has a structured `fix` becomes one constraint. Reason: the fix is the constraint, and Chief need not restate it.
  - `Constraints` lists the fix as `<file>:<line>: <fix>`, and not `None stated.`.
  - The fix text and the finding message each appear once in the prompt. The finding then omits its `(fix: …)` suffix.
  - `reviewerBrief` carries the same `Constraints`.
  - Constraints that Chief gives win. The fixes then stay with their findings.
  - A nit fix never moves.
- The findings section keeps one guidance line instead of four. The line orders the tester to verify each finding first, and to list a finding that does not hold under `## Disputed findings`. Reason: the evidence brief must stay short.
- The line `Read the verdict file in full.` appears only when the call attaches a verdict file path. An evidence tester without findings gets no findings section and no verdict line. Reason: the line must not point to a file that does not exist.
- A plan-linked evidence brief keeps the `## Deviations from plan` line. Reason: report intake refuses a plan-linked ready report without that heading.
- The example brief of 13,996 bytes renders at 5,000 UTF-8 bytes or fewer. The plugin never clips the mission, constraints, findings, or prompt to reach this size. Reason: a clipped obligation can hide a required step.
- A ready evidence-only tester discharges retest debt like any ready Tester. Reason: its run repeats the tests.

### Spec Writer Side Lane

- The default kind of a spec wave first hand-off is `worker`. A Spec Writer needs an explicit `kind: spec-writer`. Reason: the Worker builds from the plan and from the specs that existed before this plan, so the writer is opt-in.
- `admitDelegation` admits a first Spec Writer on a spec wave when all of these conditions hold. Reason: the writer needs the same branch and pull request as the worker.
  - The call has `kind: spec-writer` and no `replaces:`.
  - The wave is a head wave, or the chain owner of the parent wave is ready, idle after a ready report, or complete.
  - The wave has no live side-lane Spec Writer.
  - The call carries the branch and pull request of the chain. A different branch is rejected.
- The call order of the Spec Writer and the worker does not matter. Writer first never makes the worker `replaces:` the writer. Reason: the two rows are in different lanes.
- `startWorker` launches a first side-lane Spec Writer with a managed worktree whose base branch is the task branch. It completes no row and repoints no row. Reason: the writer must never take over the implementation worktree.
- `replaces:` a side-lane Spec Writer with `kind: spec-writer` is a docs repair. The new writer reuses the side worktree and completes the old writer. Reason: a repair keeps the fold history of the side branch.
- `replaces:` a side-lane Spec Writer with another kind is rejected, and the text names the chain owner. Reason: a product repair belongs to the implementation lane.
- A worker or designer may replace a ready writer only when the wave has no implementation-lane row. Reason: this legacy hand-off covers a head Spec Writer that ran before its worker.
- A `spec-writer` that replaced a worker, designer, or tester is in the implementation lane, and its hand-off stays normal. A `spec-writer` without a plan is never in the side lane. Reason: no data migration is needed.
- A test wave delegation is rejected while a spec wave of its chain has a pending writer. The text names each pending writer, or the wave that has no writer. Reason: the Tester derives tests from the committed docs.
- The tester call has `replaces:` referencing the chain owner of the parent wave. Reason: the tester continues the implementation worktree.
- `planProgress` returns a `waitWriters` step when the parent implementation row reports ready while a writer is pending. It returns the exact tester call when the last writer reports ready. Reason: Chief must not call a tester that admission rejects.
- A ready report and an idle thread after a ready report count the same for both triggers. Reason: the thread convention is the same in every ready check.
- The plan review is rejected while a spec wave has a pending writer. The review step names an implementation chain tip. Reason: the review must see the folded docs.
- A side-lane Spec Writer is a separate review target. `fixRound` never puts it in a legacy stack. It always lists the writer as a loose target. Reason: the writer shares the task branch, so it is not a stacked branch.
- A side-lane Spec Writer completes with a covering approve, `skipReview`, or `override`. An implementation-lane `spec-writer` keeps the rejection, except on a waived test wave. Reason: a side writer has its own report and fold head.
- `chief_skip_specs` is rejected after the wave has any `spec-writer` row. It works while only the worker exists. Reason: it only bypasses a Spec Writer that Chief never delegated.
- A spec waiver waives the planned Spec delta only. It does not block an incidental docs correction. Reason: a waiver and a docs repair are different decisions.
- A side-lane Spec Writer folds with a plain fast-forward push and never force-pushes. Reason: a force-push can erase the commits of the worker.
- The Spec Writer takes its content from the `## Spec delta` of the wave only. It reads code only to check a name or path that the delta states. Reason: the planner already read the code, and a second read costs tokens and can give a second, conflicting reading.
- The planner names the code path of each delta item as file and symbol. Reason: the writer does not read code to find it.
- Before the fold, the Spec Writer may check each identifier that its docs name with `git grep` at HEAD. The writer lists a missing name under `## Unverified names` and does not wait for the worker. Reason: the writer runs in parallel, so the code of the worker may not exist yet.
- The Spec Writer model is the per-machine `spec-writer` pick in Chief settings. Without a pick, it uses the Worker pick (`MODEL_FALLBACK` in `src/core/roles.ts`). Reason: a cheaper model can apply a precise delta.
- An implementation-lane agent that reuses the chain worktree first requires a clean tree, fetches the task branch, and fast-forwards to it. It reports blocked when the fast-forward fails. Reason: the folded docs must be in the checkout before the agent reads files.
- A Tester checks that the Fold head of each listed Spec Writer is an ancestor of its HEAD. Reason: the Tester must test against the folded docs.
- The Reviewer scopes a side-lane writer by Fold base to Fold head. `Fold: none` means an empty scope. A docs commit inside a fold range is not drift in the range of a worker. Reason: the fold commits land in the task branch while the worker runs.
- A worker or designer on a spec wave treats the plan as its source of truth, and pre-plan specs can be stale. Reason: the Spec Writer records the change in parallel.

### Docs Ownership

Only a Spec Writer changes `docs/`. The sections above define the lanes. This section defines who may change docs, how the plugin attributes a docs commit, and when `skipReview` refuses.

- A worker, designer, or tester never changes `docs/`, on any plan wave or on unplanned work. Reason: the owner gives docs to the Spec Writer.
- A worker or designer brief states the rule and its route. A needed docs change goes under `## Docs needed` in the ready result, and Chief delegates a Spec Writer. Reason: a needed change must reach the owner of docs.
- A tester brief states the rule only. Its route lives in the `chief-role-tester` skill, which the brief orders the tester to follow. Reason: a tester brief carries no worker-only block, and the route keeps one owner.
- `admitDelegation` admits an implementation-lane Spec Writer on any non-design wave. The writer replaces the chain owner. The wave can be a non-spec wave, a waived spec wave, a test wave, or a spec wave whose prior row is the worker. Reason: every non-design wave needs a legal docs route, and the chain owner holds the checkout.
- `admitDelegation` rejects a Spec Writer that replaces a row other than the chain owner. The text names the call that replaces the owner. Reason: a second row on the checkout would break the single implementation owner.
- `admitDelegation` rejects a Spec Writer on a design-only wave. The text names the successor wave and the call for it. Reason: a design wave changes no repository files, so its docs need goes to the successor wave.
- Such a writer shares the chain worktree and never completes on its own. It is not a retest fix. Reason: its worker, or a tester rerun, follows it.
- On unplanned work, a Spec Writer is opt-in, with or without `replaces:`. Without `replaces:` it is a separate docs task on its own branch. Reason: unplanned work has no wave graph to route by.
- Every Spec Writer commit carries the trailer `Chief-Spec-Writer: <thread id>`. A rebase keeps it. Reason: on a shared task branch, a docs commit must be attributable.
- `taskWriters` is the one definition of the Spec Writers of this task. The reviewer and the `skipReview` check both use it. Reason: one provenance rule, and no writer of another task counts.
- Every review renders the docs-ownership rule and the writer ids. A docs commit is in scope when its trailer names a Spec Writer of this task, or when it lies inside a reported range (Base commit to Head commit, or Fold base to Fold head). Reason: legacy writers have ranges but no trailers.
- Any other docs commit is blocking in review. The exception is a commit that a later Spec Writer of this task lists under `## Adopted docs commits`, when the final docs are correct. Reason: history is append-only, so only an accountable correction cures a violation.
- A missing trailer means unknown ownership. It does not prove that a non-writer made the commit. Reason: legacy Spec Writer commits have no trailer.
- Every review keeps every earlier Spec Writer report in its context, on spec and non-spec chains. Other earlier rows stay capped at four. Reason: the range of a legacy writer must reach the reviewer.
- `chief_complete` with `skipReview` reads the pushed head of the task. With a pull request, it reads the PR head SHA against the PR base. Without one, it reads freshly fetched `origin/<branch>` against `origin/HEAD`, or against `origin/<plan base>` for a stacked or branch-based plan wave. It never reads a local task ref. Reason: a stale local ref must never count as a clean check.
- `skipReview` is refused when a non-merge docs commit has no trailer, or a trailer that names no Spec Writer of this task. The text lists the commits and three routes: `chief_review`, a Spec Writer correction first, or `override`. Reason: `skipReview` has no reviewer.
- A writer correction after the offending commit leaves `skipReview` refused. Reason: history is append-only, and the cure is a review or an `override`.
- When the check cannot run, `skipReview` proceeds and the `chief_complete` reply says `docs/ check skipped: <reason>`. The causes are no local checkout, a remote host, an unreadable pull request, no task branch, a failed fetch, or the 20 second deadline. An unresolved plan base is another cause. Reason: Chief decided to fail open with an explicit note.
- The check does not run on an approve or an `override`. Reason: an approve had the reviewer rule, and an override is Chief's stated decision.
- `docsCommits` in `src/review/impactSlice.ts` reads the history and never throws. A failure returns a skip reason.

### Brief Contents

`workerBrief` in `src/research/delegationBrief.ts` renders the brief of every kind. `admitDelegation` in `src/plan/planLifecycle.ts` fills the source list for the brief. The "prior row" is the row that a delegation replaces.

- A worker or tester brief renders `## Contracts to verify` as a pointer to that section of its plan file. The pointer names the plan file path. The brief still orders the agent to keep every item and to confirm each one with evidence. It also says that the reviewer checks the same list. Reason: the brief already orders a full read of the plan file, so an inline copy doubled the text.
- The reviewer brief keeps its full-plan read order and its inline contracts preview. Reason: the reviewer checks the contracts against the plan.
- A Spec Writer brief and an evidence-only brief have no `## Contracts to verify`.
- A Spec Writer brief lists one `Wave n of N: <plan path>` line for each wave of the chain under `## Read-only context`. It lists the approved-design line when one exists. It adds the contracts of its own wave only, clipped at 3,000 characters. Reason: the contracts of the other waves belong to their workers and to the Tester. The writer can read each plan file.
- A planned tester brief lists one `Wave n of N: <plan path>` line for each wave of the chain under `## Source of truth for test cases`. It lists the approved-design line when one exists. It lists no contract text. Reason: the tester reads the plan files, and its own contracts appear once.
- An unplanned tester brief keeps the head brief as its source of truth, clipped in the middle at 4,000 characters. Reason: no plan file exists.
- For each kind, `admitDelegation` accepts and refuses exactly the same requests as before the brief change. Only the source list of a Spec Writer changes. Reason: the change affects text, not admission.

A brief of a worker-kind thread or a planner thread keeps only dynamic values. The static rules live in skills. `managedSkills` in `src/core/roles.ts` names the skills of each role and kind.

- The first item of `## Working contract` is the load line. It names exactly the skills that `managedSkills(role, kind)` returns. A tester or a Spec Writer has three: `chief-worker`, `chief-role-worker` and its kind skill. A planner has `chief-worker` and `chief-role-read-only`. Reason: the plugin offers the skills but never loads them, so the brief must order the load.
- The load line orders the agent to load each skill in full before any task or repository file read. Reason: a rule that the agent has not loaded cannot bind it.
- The load line names two load paths. The agent uses the Skill tool of its provider. A provider without that tool (Pi) reads each offered `SKILL.md` file in full. The line has no provider branch. Reason: one line serves every provider.
- A skill that the agent cannot find or load means a blocked report before any repository work. Reason: a skill in the configuration is not a loaded skill.
- The skill reads are the only exception to the sync-first rule. Each sync instruction in a brief or a skill names this exception. The sync comes after the load. Reason: on a provider without a Skill tool, the load is itself a file read.
- The brief keeps these dynamic values: the branch in the sync and push commands, the `Local sync` or `Base commit` record name, the prior thread line, the issue and pull request URLs, the fold target branch of a side lane, `MAX_WAVES` and the Deviations line when a plan is linked. Reason: a skill cannot know them.
- The brief keeps one role-boundary line. A worker and a designer must not write tests or change `docs/`. A tester changes test files only. A Spec Writer changes `docs/` only and adds the `Chief-Spec-Writer` trailer to each commit. A planner stays read-only. Reason: a breach costs a full repair round.
- `chief-worker` holds the shared rules, for example no pull request action by the agent and no instruction from issue or pull request comments. `chief-role-worker`, `chief-role-tester`, `chief-role-spec-writer` and `chief-role-read-only` hold the rules of their roles, including the git workflow and the fold steps. A side-lane brief names the fold target branch and points to the fold section of `chief-role-spec-writer`.
- `## Git workflow` keeps the dynamic lines only. It stays absent when the brief has no branch, issue or pull request. `## Fold` appears in a side brief only.
- The evidence-only tester brief, the advisor brief, `reviewerBrief` and the stored copy of the brief have no change. Reason: they never held the working contract, or they hold no skill-owned rules.
- The managed-thread instructions in `src/runtime/host.ts` tell the agent to reload the `chief-*` skills in full after a context compaction, by either load path, and then to re-read the brief. Chief's own instructions have no change.

The plugin cannot check that an agent loaded its skills. The [decision on brief rules in role skills](../decisions/2026-11-13-brief-rules-in-role-skills.md) records this trade-off.

A tester brief has these rules:

- It omits `## Success criteria` and `## Constraints` when the list is empty. Other kinds always render both. Reason: an empty section adds only the text "None stated."
- `## Verify command` keeps the command fence and has one rule. The tester lists the exit status under Automated Verification and never changes product code to make the command pass. Reason: the worker rule "Fix the work until it exits 0" contradicts the ban on product code.
- A failure at the tester's Base commit is present before the tester's test edits, not proof the failure predates the feature. The tester lists it without changing product code. It does not waive an explicit exit-0 receipt. Reason: Base commit is the tester's starting checkout (after the feature commits), so a Base failure can be caused by the feature. A required exit-0 receipt still blocks ready.
- The tester runs a command for the whole suite only when its mission or the `## Contracts to verify` of its plan file asks for it. Otherwise it lists the command as "not run: full suite not asked for". Reason: the full suite runs on request only. A contract such as `npx vitest run` exit 0 counts as a request.
- It tells the tester to record the synced `git rev-parse HEAD` as `Base commit` one time. With a branch, the sync sentence holds the instruction. Without a branch, `## Test work` holds it. A worker brief records it as `Local sync`. Reason: one commit needs one record.
- `## Test work` holds the one procedure for a test that fails because product code is wrong. It recommends `chief_delegate (... kind: worker)`. The `## Spec` block points to that procedure for code that contradicts the docs. Reason: two procedures for one failure conflict.
- The `## Spec` block keeps the route for wrong docs: report blocked and recommend `kind: spec-writer`. Reason: only a Spec Writer changes docs.
- `## Predecessor's last report` gives the Head commit of the prior row and the `git diff --name-only <base>..<head>` command when a Base commit is found. It also gives the path of the full report. It never quotes the summary, the blocker, or the recommendation. Reason: the tester needs the commit and the full report, not the narrative of the prior row.
- When the prior report names no Head commit, the section says so and orders the tester to read the full report. Reason: the full report holds the facts that the section omits.
- The tester rules come from the `chief-role-tester` skill. The working contract keeps the test-files-only boundary: the tester never changes product code or `docs/`. It omits the user-journey wording, the `## Docs needed` route, and the re-plan line. Reason: those lines belong to workers.
- No brief renders the refactor oracle rule. The `chief-role-tester` skill holds it. Reason: the rule applies to the tester role, so the skill owns it once.

### Retest Debt

A fix after a rejection is the riskiest change, and one review covers the whole plan. For this reason `chief_review` refuses to start while a covered chain owes a tester rerun.

- A chain owes retest debt only when its newest verdict is `request_changes` and a code row exists that Chief created after that verdict. Reason: an approve closes the rejection.
- Writers, Testers, Designers, side-lane rows, and rows on a design wave never create debt. Reason: only a code change invalidates the earlier test result.
- `planProgress` finds the debt from the rows of the chain. It never reads Testers to find it. Reason: a Tester row proves no result.
- A Tester that Chief created after the fix discharges the debt only when it has a ready report. Reason: row creation proves nothing about the tests.
  - A busy, blocked, failed, stopped, or idle Tester without a ready report keeps the debt.
  - A Tester older than the fix never discharges it.
- Three more events discharge the debt:
  - The raw chain has a waived test wave. A waived wave that no worker ran counts too.
  - Chief passed `retestSkipped`, which is stored on the fix.
  - A current review covers the latest report of the fix.
- `retestDebts` adds up every chain of the plan review. `chief_review` on any chain tip is refused while one chain owes. The text names the route of the chain that owes. Reason: one review covers all chains.
- `reviewBlock` checks retest debt last. The order of the other refusals is unchanged. An unplanned worker gets only this check. Reason: the new gate must not hide an older refusal.
- `chief_review` with `retestSkipped` stores the reason on every owed fix in one batch, then starts the review.
  - It stores nothing when another refusal applies.
  - It is refused when no debt is owed, or when `pullRequest` or `branch` is present.
  - The reviewer brief lists each waived retest and says that the reviewer judges those fixes without a rerun.
  - Reason: Chief must record why a rerun was skipped, and one reason covers the whole list.
- Each route names the live owner of the chain. It never names a completed row. Reason: `admitDelegation` and the branch-holder check of `startWorker` must accept the call.
  - A working Tester that owns the chain gives `wait`.
  - A chain with a test wave gives `chief_delegate (wave: <test wave>, replaces: <owner>, kind: tester)`. This includes an implementation-lane writer on the test wave.
  - A chain with no test wave gives a Tester on the wave of the owner.
  - An owner on an earlier wave of a legacy stack gives `restack`. The restacked Tester discharges the debt.
  - An unplanned owner that is a Spec Writer gives a worker hand-off first, because the lane rules forbid a writer-to-Tester hand-off.
- The Tester of the retest hand-off skips the consult and user rungs of `ledger.replacement`. Every other replacement keeps them. Reason: the rerun adds no new rejection and needs no new advice.
- The pre-review advisory stays. After a Tester failure and a code fix, and with no verdict, the ready alert still asks for a Tester. Reason: before a review the rerun is advice, not a gate.
- The migration adds `retest_skipped` to `managed_threads`. Display shows it in the roster, in the thread inspection, and in the Completed comment. `chief_complete` and `tests_skipped` are unchanged.

### Pull Request Pinning

- `admitDelegation` rejects a delegation when `params.prUrl` differs from the pull request URL of the prior worker. Reason: replacement workers on a chain must preserve the established pull request.
- `admitDelegation` accepts `params.prUrl` when the prior worker has no recorded pull request URL. Reason: callers must be able to record a missing pull request URL on replacement.

### Forge Pre-flight Operations

- `chief_forge_init` executes only for a chain head that has no row in any lane and no recorded pull request. Reason: secondary waves and started chains already possess branch and pull request identities.
- `chief_forge_init` rejects any wave that has a parent wave. Reason: only chain heads create pull requests and task branches.
- `chief_forge_init` names the chain head when rejecting a non-head wave. Reason: callers must know which wave opens the pull request for the chain.
- `chief_forge_init` rejects a chain head when its chain already contains a row in any lane, so a chain with only a side-lane Spec Writer counts as started. Reason: started chains must not allocate duplicate forge resources.
- `chief_forge_init` names the chain owner when it rejects a started chain head and an owner exists. Reason: callers must continue started work through replacement.
- `chief_forge_init` includes one section for each wave of the chain in the pull request body. Reason: reviewers inspect contracts for the entire chain in a single pull request.
- `chief_forge_init` includes waived test waves in the pull request body with their recorded waiver reasons. Reason: reviewers must see omitted test coverage and its justification.
- `chief_forge_init` clips wave contracts at 2,000 characters in the pull request body. Reason: bounded bodies prevent forge payload limit rejections.
- `chief_forge_init` clips the planner summary at 1,500 characters in the pull request body. Reason: bounded summaries keep the pull request readable.
- `chief_forge_init` formats the tracking issue body to state one pull request per chain. Reason: the tracking issue text must describe the chain pull request model.
- `chief_forge_init` formats unplanned pull request bodies identically to base commit behavior. Reason: unplanned tasks follow single-task forge conventions without plan chains.
- On a plan wave with a plan base, `chief_forge_init` uses that base when `base` is omitted. Reason: the branch and pull request must match the base that admission and review read.
- `chief_forge_init` refuses an explicit `base` that differs from a non-null plan base, before any forge effect. Reason: an explicit base never sets a second base for the chain.
- `chief_forge_init` refuses a stacked head while its plan base waits or is unresolved. Its text names the reason and offers no explicit base. Reason: an explicit base never bypasses the readiness rule.
- On a plan wave without a plan base, and on unplanned work, `chief_forge_init` keeps a free explicit `base`. Reason: only a stacked or branch-based chain fixes its base.

### Review Worktree

- `startReview` launches a fresh managed worktree on the pull request branch for the first pinned review of a task. Reason: a new review requires an isolated worktree checkout.
- `startReview` reuses the newest earlier pinned reviewer worktree for a later pinned review of the same task when that reviewer is eligible. Reason: worktree reuse saves disk space and checkout time across review rounds.
- `reusableEnvironment` returns an environment only when the earlier reviewer thread is live, not archived, not active, and has an existing worktree. Reason: reviews must not disrupt active threads or touch deleted environments.
- `startReview` never reuses an environment that matches the live environment identifier of any review target worker. Reason: a reviewer must not mutate or lock the workspace of an active target worker.
- The reviewer brief instructs the reviewer to checkout the pinned commit detached. Reason: detached checkouts avoid local branch divergence during review.
- `startReview` launches a fresh managed worktree when `reusableEnvironment` returns null, rejects, or times out. Reason: review launches must continue without failure when reuse cannot complete safely.
- `startReview` uses the live environment of the worker for an unpinned review. Reason: unpinned reviews run directly in the environment of the worker.
- `startReview` never selects an unpinned review environment for later reviewer reuse. Reason: unpinned reviews record no pinned commit SHA and belong to workers.
- Without a pinned head, the impact slice of a stacked or branch-based plan wave compares against `origin/<plan base>`. When the plan base is unresolved, the slice is skipped. Reason: a stacked chain builds on its parent branch, so only that base gives its own scope.

### Shared Worktree Cleanup

- `cleanupStep` records an action claim in `cleanup_environment_claims` before deleting branches or issuing teardown alerts. Reason: atomic claims elect exactly one owner for each shared worktree action.
- The first cleanup job that observes the worktree environment removed claims and executes branch deletion. Reason: one job must remove the shared branch safely.
- The first cleanup job that observes environment teardown trouble claims and emits a `cleanup-teardown-trouble:alert` alert. Reason: shared teardown failures must produce exactly one alert for the environment.
- The first cleanup job that observes stuck teardown claims and emits a `cleanup-teardown-stuck:alert` alert. Reason: timeout warnings on a shared environment must not trigger duplicate operator alerts.
- A cleanup job transitions to `storage` with outcome `worktree shared: <action> handled by <owner>` when another job owns the claim. Reason: non-owning jobs must complete cleanup without repeating branch or alert actions.
- `cleanupStep` records no claim when teardown discovers that the environment is in use. Reason: an environment in active use retains its branch without claiming permanent deletion rights.
- A cleanup job that later observes the environment destroyed can claim branch deletion after a previous in-use observation. Reason: earlier in-use states do not lock future deletion ownership.
- A single cleanup job on an unshared environment retains existing baseline step transitions, outcomes, and alerts. Reason: cleanup behavior for non-shared environments must not regress.

### Legacy Restack Handling

- `src/plan/planProgress.ts` evaluates restack requirements only for legacy plans where waves have distinct branches. Reason: new chains share a single branch and never require branch restacking.
- `src/runtime/nextAction.ts` words restack instructions only for the legacy stacks that `reviewAdvice` returns. It never groups targets itself. Reason: historical plan graphs in SQLite require backward compatibility.
- The server never instructs new chain workers to restack branches. Reason: all waves in a new chain commit directly to the shared branch.

### Baseline Graph and Schedule Operations

- `parentOf` returns the first explicit dependency or the preceding wave number. Reason: explicit dependencies override sequential defaults.
- `parentOf` returns null when a wave has empty dependencies or index 1. Reason: head waves have no parent dependency.
- `successorOf` returns the first non-absent wave that depends on the specified wave. Reason: graph traversal skips waves that have no execution.
- `chainOf` traverses backward to the head and forward to the tip. Reason: callers require the complete sequence of linked waves.
- `planWavesFor` marks a waived test wave as absent when no worker executed on it. Reason: undelegated waived tests do not participate in active scheduling.

## Invariants

- A task branch hosts at most one active implementation-lane thread, plus at most one side-lane Spec Writer for each spec wave of the same plan. Reason: only one thread checks out the task branch. Each writer uses its own side branch, and its fold is a fast-forward push.
- Every implementation-lane row in a plan chain shares the identical environment identifier, branch name, and pull request URL. Every side-lane Spec Writer shares the branch name and pull request URL, and has its own environment. Reason: chain identity must remain uniform across all wave transitions.
- A replacement worker marks its superseded worker as complete. Reason: superseded workers must release active claims on resources.
- A completed or ready earlier Spec Writer of a spec wave satisfies that wave. Reason: legacy chains that ran the writer first need no migration.
- Exactly one cleanup job owns each action for a shared environment in `cleanup_environment_claims`. Reason: primary key constraints prevent duplicate claim owners.
- A reviewer worktree never hosts review execution on the live environment of an active target worker. Reason: concurrent reviewer execution inside a worker workspace causes file collisions.
- `test/fixtures/legacy-wave-graph-bf73de5.json` decisions remain identical to base commit results. Reason: legacy plan verification contracts require strict regression avoidance.
- Reviewer advice is not permission. Reason: advice is plan-wide wording, and permission is per task.
- `reviewAdvice` takes its rung from the `reject_streak` that the reviewer carries, through `ledger.rung`. Reason: one carried streak gives one answer for the alert, Pending, and the action panel.
- `ledger.replacement` keeps permission for a `replaces:`. It decides from task history, consult timing, and user approval. Reason: permission depends on the task, not on the plan.
- A satisfied consult still shows consult advice. `chief_delegate` decides whether the `replaces:` proceeds. Reason: advice stays plan-wide wording.
- `src/runtime/nextAction.ts` `nextAction` formats the result of `reviewAdvice` and makes no repair decision of its own. Reason: one module reads plan state and reviewer state together, and the server only writes sentences.
- The report alert, `chief_roster` Pending, and the action panel read the same `reviewAdvice` answer. Reason: the three surfaces must never give different advice.
- The task branch and pull request of a stacked or branch-based chain are based on its plan base. They never start from `origin/HEAD`, `main`, or `master`. Reason: the pull request must show only the changes of its own chain.
- A plan with no `stackOn` and a planner with no branch behaves as before. Reason: existing plans must not change.

## Related Decisions

- [Spec Writer runs in parallel on a side worktree](../decisions/2026-11-10-spec-writer-parallel-side-worktree.md)
- [Retest after a fix round gates the review](../decisions/2026-11-10-retest-after-fix-round.md)
- [Only a Spec Writer changes docs](../decisions/2026-11-10-docs-owned-by-spec-writer.md)
- [Stacked chains use a stackOn field](../decisions/2026-11-14-stacked-chains-stackon.md)
