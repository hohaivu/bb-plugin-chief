# Plan Chains

## Purpose

The plan chains domain manages execution topology, branch allocation, pull requests, worker environments, Spec Writer side worktrees, reviewer worktrees, and cleanup claims.

## Domain Terms

- **Plan wave**: an ordered unit of implementation or design work in a plan.
- **Wave dependency**: the optional `dependsOn` field of a plan wave. It is an array of integers with at most one entry. `[k]` means that the wave builds on wave `k` and continues on its branch. `[]` means that the wave is independent and starts its own branch and pull request. An omitted field means that the wave depends on the previous wave. Wave 1 has no parent dependency.
- **Wave flags**: the optional booleans of a plan wave: `design`, `spec`, `feature` and `reshape`. A `test` key is refused.
- **Feature wave**: an implementation wave with `feature: true`. It adds new behaviour. Its review runs the native-design check. A wave that is not `design` is an implementation wave.
- **Reshape wave**: an implementation wave with `reshape: true`. It is the make-native wave of a big feature. `feature` and `reshape` never mark a design wave.
- **Chain**: an ordered sequence of waves from a head wave to a tip wave.
- **Chain head**: a plan wave with no parent dependency.
- **Chain tip**: a plan wave that has no successor wave.
- **Epic plan**: a plan that a planner makes with `epic: true`. The planner writes one epic issue and implements nothing.
- **Horizontal plan**: a plan that has one contract wave, parallel block waves and one integrate wave.
- **Contract wave**: wave 1 of a horizontal plan. It states the shared types, API, schema or CLI shape.
- **Block wave**: a chain head of a horizontal plan with `dependsOn: []` and `stackOn: 1`. It owns files that no other block owns.
- **Integrate wave**: the last wave of a horizontal plan. Its `dependsOn` names one block wave. It merges the other block branches and runs the system tests.
- **Stacked chain**: a chain whose head has the optional `stackOn: k` field. Its task branch and pull request build on the task branch of wave `k`'s chain.
- **Plan base**: the base branch that a stacked or branch-based chain is fixed to. The server derives it, and `null` means the project default.
- **Task branch**: the Git branch created for a plan chain.
- **Approved design**: the design of a design researcher that the user approved. `chief_plan` binds it to the planner as snapshots. See Approved Design Binding.
- **Worker environment**: the managed worktree environment assigned to a worker thread.
- **Spec wave**: a plan wave marked `spec: true` that a design or skipped-specs rule does not exclude.
- **Side-lane Spec Writer**: a planned `spec-writer` row on a spec wave. Every row in its `replaces:` ancestry is also a `spec-writer`. It runs in its own side worktree.
- **Plan Spec Writer wave**: the highest-numbered spec wave of a plan that no bypass removes. The plan's one side-lane Spec Writer runs on it, after every wave of the plan is ready. `planWriterWave` returns it, or null when the plan has no such wave.
- **Implementation lane**: every other worker row. This includes worker and designer rows. It also includes a `spec-writer` that replaced a worker or designer. A legacy `tester` row counts as a worker.
- **Side worktree**: a private managed worktree on a `bb/` side branch cut from the task branch. A side-lane Spec Writer uses it.
- **Fold**: the push of the docs commits of a side-lane Spec Writer onto the task branch. The push is fast-forward only.
- **Fold base**: the task branch commit that the Spec Writer rebased onto before the successful fold push.
- **Fold head**: the commit that the fold push wrote to the task branch. `Fold: none` means that the writer changed nothing, and Fold base equals Fold head.
- **Chain owner**: the latest implementation-lane row of a chain. A live row wins over a finished row.
- **Pending writer**: a spec wave whose latest Spec Writer row is not ready, not idle after a ready report, and not complete. The plan Spec Writer wave is also pending while it has no Spec Writer row.
- **Legacy plan**: an earlier plan where each wave received an independent branch.
- **Legacy wave**: a stored wave without a `feature` key. Its review keeps the native-design check and the reshape sentences.
- **Pinned review**: a review whose targets are bound to a specific pull request commit SHA. See [review-engine.md](review-engine.md).
- **Unpinned review**: a review whose targets have no readable commit SHA.
- **Cleanup claim**: a persistent record in `cleanup_environment_claims` that assigns an environment action to one thread.
- **Merge proof**: the forge answer that a pull request is merged. Cleanup needs it before it archives a row that has a pull request.
- **Spec Writers of this task**: the Spec Writers in the `replaces:` chain of a task row, plus the side-lane writers on the waves of its chain. `taskWriters` returns them.
- **Heavy command**: a build, a test run, or a simulator, emulator or device run that a worker or designer starts.
- **Slot pool**: one of three independent groups of heavy-command slots: `sim`, `test` and `build`.
- **Slot wrapper**: the host script `chief-heavy-<hash>.sh` that admits a heavy command into a slot of its pool.

## Ownership and Entry Points

Seven modules own the plan chains domain:

1. `src/plan/waveSchedule.ts` owns graph traversal, wave relationships, wave absence, the lane predicate `sideLane`, `writerPending`, and the plan base of a chain head (`planBase`).
2. `src/plan/planLifecycle.ts` owns delegation admission, role progression, and waivers.
3. `src/runtime/delegation.ts` owns `startWorker`, which launches workers and Spec Writers. It also owns `bindDesign` for initial binding and `approvedDesign` for read-only lookup by researcher ID and report sequence. `src/tools/forgeInit.ts` owns forge initialization. `src/runtime/cleanup.ts` owns cleanup steps and the merge cache. `src/forge/cleanup.ts` owns `taskPullRequests`.
4. `src/plan/planProgress.ts` owns progress checks, review readiness, legacy restack rules, and `gateDecision`.
5. `src/runtime/nextAction.ts` and `src/runtime/completion.ts` own the text of the next call and the completion rules. `src/runtime/host.ts` (`chiefCoreRules`) owns the core rule that sends follow-up work to a fresh worker, with its one in-place exception.
6. `src/research/delegationBrief.ts` owns the worker brief. `src/review/reviewStart.ts` owns review launch preparation and brief generation.
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
- `planWriterWave(waves)`: returns the plan Spec Writer wave, or null. It is the single anchor of the plan's one Spec Writer.
- `chief_forge_init(params)`: initializes the forge repository branch, pull request, and issue.
- `chief_plan(params)`: starts a planner. With `researchThreadId`, it binds the approved design. See [Approved Design Binding](#approved-design-binding) for the design inputs and revision rules.
- `bindDesign(researcher, projectId)`: creates missing design and fact snapshots for the researcher's ready report and reuses existing snapshots. It returns both paths and the design text.
- `approvedDesign(researcherId, seq, projectId)`: reads the design and fact snapshots for the plan's stored researcher ID and ready-report sequence. It returns both paths and the design text. It never creates snapshots or reads live `design.md`.
- `startWorker(params)`: prepares and launches a worker thread in an environment.
- `restackOf(worker, waves)`: determines whether a legacy wave requires a restack.
- `newestVerdictAt(threadIds)`: returns the newest reviewer verdict and its time for a set of worker threads.
- `onSpecChain(row)`: returns true for a plan chain with a Spec Writer on an unbypassed spec wave. It also returns true for an unplanned task chain that holds a Spec Writer.
- `cleanupStep(job, eligible)`: executes lifecycle cleanup transitions and records environment claims.
- `publishHeavy(hostId, slots)`: writes the host `slots` file and publishes the slot wrapper. It returns the script path.
- `heavySlotCount(values)`: maps the `heavySlots` setting to a slot count from 1 to 8.
- `heavyScript()`: returns the text of the slot wrapper.

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
9. Chief starts the review gate once, with `chief_review`, after the last wave and every Spec Writer reports ready. See [review-engine.md](review-engine.md).

A plan with spec waves gets one Spec Writer, which runs after the last wave:

1. Chief delegates each wave's worker without a kind.
2. When every wave is ready, the ready alert of the last wave names two routes. Chief takes one of them:
   1. Delegate the plan's Spec Writer: `chief_delegate (planThreadId: <plan id>, wave: <plan Spec Writer wave>, kind: spec-writer)`, with no `replaces:`. The writer runs in steps 3 to 6.
   2. Go without it: `chief_skip_specs (planThreadId: <plan id>, reason)`. The reason goes on every spec wave that has no Spec Writer row. No writer runs.
3. The server launches the Spec Writer in a new side worktree on a `bb/` side branch cut from the task branch. It completes no row and repoints no row.
4. The Spec Writer commits only `docs/` files on its side branch.
5. Before it reports ready, the Spec Writer folds its commits onto the task branch. It runs these steps on a clean tree:
   1. Set `B` to the writer's Base commit, once, before the first attempt.
   2. Fetch the task branch and note the commit `U` and the commit `H` of `HEAD`.
   3. Rebase the writer's own commits (`B..HEAD`) onto `U` with no autostash: `git rebase --no-autostash --onto origin/<branch> $B`. On a conflict, run `git rebase --quit` and report blocked with `Pre-fold head: H`, `B`, `U` and the conflicting paths. The writer does not restore the checkout, and nothing reuses it.
   4. Check that the diff `U..HEAD` lists only `docs/` paths.
   5. Push `HEAD` to the task branch with a plain push. A rejected push sets `B` to this attempt's `U` and repeats the steps from the fetch.
6. The Spec Writer records Fold base and Fold head, or `Fold: none`.
7. `chief_review` refuses to start while the plan's Spec Writer is missing or not settled, or while a legacy writer of another spec wave is not settled. While the plan's Spec Writer has no row, the refusal names the same two routes as the last ready alert. Once every writer reports ready, the review gate starts its reviewer. After the skip route, the review starts once no legacy writer is unsettled. A spec wave that never had a writer never blocks the review.

Independent chains run in parallel:

1. A planner specifies multiple chain heads with empty dependencies.
2. Chief calls `chief_forge_init` separately for each chain head.
3. Each chain head receives an independent branch, pull request, and worker environment.
4. Each chain proceeds through its waves independently.

A designed plan binds its approved design before its first wave:

1. Chief calls `chief_plan` with `researchThreadId`.
2. The server binds the approved design snapshots, or refuses the call before any spawn.
3. The planner brief names both snapshot paths.
4. Chief calls `chief_forge_init`, and the pull request body gets the design block.

An epic plan follows this sequence:

1. Chief calls `chief_plan` with `epic: true`. The server stores it as `plan_epic` on the planner row, and the brief states `Mode: epic`.
2. The epic planner creates the epic with the commands its rules name. By default it runs `gh issue create` for one epic issue and one sub-issue for each slice. It links each slice with native blocking through `gh api`. If a link call fails, it writes `Blocked by #n` or a task list in the epic body and says so in `result`.
3. If the Context names another target, such as a Markdown file, the planner writes the epic there and never commits it. It creates no issue.
4. Each slice is a vertical thin slice with a demo or E2E checkpoint.
5. The planner reports ready with no `plan` and the epic URL, or the file path, in `result`.
6. Chief runs `chief_consult` once. The advisor reads the epic issue or the named file and checks the slices.
7. If the advisor asks for changes, Chief starts one revision with `chief_plan` and `revises`. The revision inherits `plan_epic`, and it gets no review.
8. When the epic is approved, or a revision is ready, Chief tells the user the epic link and completes the planner and the revision. No wave is delegated.
9. A revision reads the epic issue or target named in the original report, and the advisor report. A delivered revision refuses another report, and it refuses another `chief_plan revises`. Reason: its result stands, and Chief completes it.

The epic flow runs one advisor round. The owner chose one second opinion, not a review loop. The code adds no round protocol and no risk register.

A horizontal plan runs in this order:

1. The planner writes wave 1 as the contract wave.
2. Chief delegates wave 1. Its worker builds the shared contract.
3. When wave 1 is ready, each block chain head starts on its own branch, stacked on wave 1.
4. Each block worker edits only its own files and runs build and typecheck only.
5. Chief delegates the integrate wave with `dependsOn` that names one block wave.
6. The integrate worker runs `chief_log`. A block counts as delivered when `chief_log` shows `delivered` for its wave. For each block wave that is not delivered, the integrate worker reports blocked with `waiting on block waves N`. Otherwise it merges the other block branches, wires the blocks and runs the system tests.
7. One review gate follows the integrate wave. Its targets are the latest worker of each wave that is not complete, plus the worker that opened the gate.
8. The first target owns the gate's one fix run. In a horizontal plan, the first target is the integrate worker, because one wave stacks on two or more blocks. Otherwise the targets keep wave order. A wiring defect goes to the integrate worker.
9. A completed block is not a target. Its code is in the integrate head.

The plugin adds no code guard against an early integrate wave. It may start before the other block waves are ready and then reports blocked.

Reviewers never reuse a worktree. Each gate review gets a fresh managed worktree on the pinned commit. See [review-engine.md](review-engine.md) under Reviewer.

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
- `startWorker` reuses the environment of the prior worker when `replaces:` is present and the replaced row is in the implementation lane. A side-lane Spec Writer repair gets a fresh worktree instead (see Spec Writer Side Lane). Reason: chain waves share installed dependencies and build outputs. A side checkout can be stale.
- `startWorker` checks every non-terminal row on the same branch, except the row in `replaces:`. Reason: git prohibits simultaneous checkouts of one branch in different worktrees.
  - A same-plan implementation-lane row and same-plan side-lane Spec Writers coexist.
  - Side-lane Spec Writers of different waves of one plan coexist.
  - A second live side-lane Spec Writer on one wave is rejected, unless it replaces the first.
  - A second live implementation-lane row is rejected.
  - A holder from another plan, or an unplanned holder, is rejected.
  - A Spec Writer delegation ignores a review gate's fix run that is not busy. Reason: the owner chose this rule, because a ready fix run blocked every docs repair.
  - A busy gate fix run still holds the branch for a Spec Writer. Busy means `starting`, `pending`, `active` or `stopping`. Reason: two writable rows must not share one worktree branch.
  - Reason: a side worktree checks out its own `bb/` side branch, so it never blocks the task branch.
- `startWorker` rejects a delegation when `params.branch` differs from the branch of the prior worker. Reason: replacement workers must remain on the established chain branch.

### Stacked Chain Base

- A plan wave accepts `stackOn: k` only when it heads a chain. `k` is an integer from 1 to n-1, and wave `k` is not a design wave. Reason: only an implementation wave of another chain gives a base to build on.
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
- Without a pinned head, the impact slice of a stacked or branch-based plan wave compares against `origin/<plan base>`. When the plan base is unresolved, the slice is skipped. Reason: a stacked chain builds on its parent branch, so only that base gives its own scope.

### Chain Admission and Delegation

- `admitDelegation` rejects a non-head implementation delegation when `replaces:` is absent. Reason: non-head waves must continue on the existing worktree and branch of the chain.
- `admitDelegation` names `replaces: <chain owner>` when it rejects a non-head wave without a replacement target. Reason: callers must know the latest implementation thread to continue the chain.
- `admitDelegation` rejects an implementation delegation without `replaces:` when any wave in the chain already has an implementation-lane row. Reason: started chains must not allocate duplicate workers or environments.
- `admitDelegation` needs an explicit `kind` only when `replaces:` names a Spec Writer (`src/plan/planLifecycle.ts`). Reason: a worker replaces a worker, and only a Spec Writer repair needs the kind to pick its lane.
- `chief_delegate` has no `kind: tester` and no `evidenceOnly` input. Schema validation refuses `kind: tester`, and `--evidence-only` does not exist. A stored row with `kind: tester` reads as a worker. Reason: workers write and run their own tests, so no tester role exists. See [the decision](../decisions/2026-11-19-workers-write-tests.md).
- While a review gate is open, `admitDelegation` admits only the gate's fix run: `chief_delegate (replaces: <gate's first target>, kind: worker)` (`fixAdmission` in `src/runtime/delegation.ts`). It also admits a fix run that replaces a fix run that never reported. Reason: one writable owner holds the gate at a time. See [review-engine.md](review-engine.md) under Fix Run.
- The gate fix run reuses the first target's worktree, branch and pull request. `startWorker` does not supersede that target. The target stays live and completes with the gate. Reason: the open-gate guard, the gate line and the chat-fix order read the target row.
- Replacing another pinned target of an open gate is refused. The text names `replaces: <first target>`. Reason: a gate has one fix run, and it replaces the first target.
- The brief of a gate fix run has a `## Fix run` section. It carries the reviewer verdict and the findings. Reason: the fix run needs the same evidence as the gate.
- `admitDelegation` permits a fresh plan wave 1 delegation to replace a blocked row of another plan. The rule applies to each lane. Reason: re-planning allows recovery on the blocked worktree or side worktree.
- `admitDelegation` refuses a fresh delegation (without `replaces:`) to a chain head with a plan base, while that base waits or is unresolved. Reason: the head must not build before its parent code exists.
- `admitDelegation` refuses a fresh delegation to such a head without `branch`, and it never falls back to the project default. Reason: forge init cuts the branch from the plan base, so admission, forge and review agree on one value.
- `undelegatedHeads` excludes the waiting and unresolved heads, and returns them as `waiting`. Reason: the planner must see why a head does not launch.

### Epic Mode

- `chief_plan` accepts an optional `epic` boolean. Reason: an epic is a planning mode that the user asks for.
- `chief_plan` refuses any supplied `epic` with `revises`, including `epic: false`. Reason: a revision inherits the mode of its original planner, and a caller cannot override it.
- `chief_plan` refuses any supplied `epic` with `branch`, including `epic: false`. Reason: an epic creates no branch, and a caller must omit both. The CLI passes `--epic=false` through as `epic: false`, so the schema refuses it too.
- A revision takes its mode from its original planner only. A revision of an epic planner starts in epic mode without `epic` in the call. Reason: the mode stays fixed across revisions.
- At launch, an effective epic mode refuses `branch`, whether the caller set it or it was inherited. Reason: an inherited epic would otherwise start a named worktree.
- The planner brief states `Mode: epic` and adds an `## Epic mode` section. Reason: the planner must plan the epic and implement nothing.
- `checkReport` refuses a `plan` from an epic planner. Reason: an epic planner has no plan files. Its ready result stands in for them.
- `checkReport` accepts a ready report with no `plan` from an epic planner only. See [report intake](report-intake.md).
- `nextAction` gives an epic planner no forge-init line and no delegate line. Reason: an epic has no waves.
- A refusal or a stall line for an epic planner or epic advisor never offers delegation. An abandoned epic advisor gets a retry or an escalation. Reason: an epic has no waves to delegate.
- A completed epic refuses `chief_consult`, `chief_plan revises` and `chief_continue` with its review outcome. The refusal says the outcome stands and names the next step. Reason: the approved or changed result is final, so a second review or revision must not start.
- `chief_consult` accepts a ready epic planner with no waves. It refuses a task planner with no waves. Reason: the advisor reviews the epic text, and a task planner has no waves to review yet.
- A revision counts as delivered only after its own ready report. Reason: a blocked revision carries no epic to complete.
- A delivered epic revision refuses further reports from its row and further `chief_plan revises` on its original planner. A blocked revision may retry. Reason: the delivered result stands until Chief completes it.
- An epic that a review holds is not replaced by a second ready or blocked report until the review ends. Reason: the reviewed result must stay the one Chief completes.
- When an epic is approved, Chief tells the user the epic link and completes the planner. Reason: the epic issue is the only output.

### Horizontal Shape

- A block chain head has `dependsOn: []` and `stackOn: 1`. Reason: block branches need the contract code of wave 1.
- `planBase` stacks each block chain head on wave 1. Reason: the same rule as any stacked chain head applies (see Stacked Chain Base).
- Block chain heads start together once wave 1 is ready. Reason: the blocks own disjoint files, so they need no order.
- The brief of a block wave says build and typecheck only. Reason: the integrate wave runs the system tests. See [the decision](../decisions/2026-11-24-horizontal-block-test-waiver.md).
- A horizontal plan has one integrate wave. Its `dependsOn` names one block wave. Reason: one parent gives the integrate wave one branch to continue.
- `chief_log` shows the branch of each wave. Reason: the integrate worker merges the block branches by name.
- `reviewTargetsFor` gives the one review gate the latest worker of each wave that is not complete, and the worker that opened the gate. Reason: the gate reviews every block that still has open code.
- In a horizontal plan, `reviewTargetsFor` puts the integrate worker first. A horizontal plan has one continuation wave that stacks on two or more blocks. Otherwise `reviewTargetsFor` keeps wave order. Reason: the first target owns the gate's one fix run, and the integrate worker must own the wiring fix.
- A completed block drops out of the targets. Its code is in the integrate head. The integrate branch continues one block, and the integrate worker merges the other blocks. Reason: the integrate head is the reviewed code for all blocks.
- A wiring defect that the gate finds goes to the integrate worker as the fix run. Reason: the integrate worker owns the wiring.
- Chief routes a wrong contract to a fresh plan. Reason: the contract wave sets the contract that the blocks share.

### Spec Writer Side Lane

- The default kind of a spec wave first hand-off is `worker`. A Spec Writer needs an explicit `kind: spec-writer`. Reason: the Worker builds from the plan and from the specs that existed before this plan, so the writer is opt-in.
- `admitDelegation` admits a first Spec Writer on the plan Spec Writer wave when all of these conditions hold. Reason: the writer needs the same branch and pull request as the worker.
  - The call has `kind: spec-writer` and no `replaces:`.
  - The wave is the plan Spec Writer wave. A first Spec Writer on another spec wave of the plan is refused. The text names `chief_delegate (planThreadId, wave: <plan Spec Writer wave>, kind: spec-writer)`. Reason: a plan has one Spec Writer.
  - `pendingWaves` is empty: every wave's latest implementation row is ready, idle after a ready report, or complete. While a wave is pending, the refusal names each unready wave. Reason: the writer covers the delta of every wave, so it starts after the code exists.
  - The wave has no live side-lane Spec Writer.
  - The call carries the branch and pull request of the chain. A different branch is rejected.
- The plan Spec Writer never starts before the last wave is ready. Reason: no worker waits for it, and the gate waits for its report.
- In a plan with several chains, the plan Spec Writer folds every delta onto the chain of the last spec wave. Reason: one writer makes one fold, so its pull request carries docs for another chain's code.
- `startWorker` launches a first side-lane Spec Writer with a managed worktree whose base branch is the task branch. It completes no row and repoints no row. Reason: the writer must never take over the implementation worktree.
- `replaces:` a side-lane Spec Writer with `kind: spec-writer` is a docs repair. The new writer gets a fresh managed worktree cut from the task branch, completes the old writer, and repoints the reviewer ledger. It writes the Spec delta again and never imports the old writer's commits. Reason: the old side checkout can hold stale or half-rebased docs commits.
- `replaces:` a side-lane Spec Writer with another kind is rejected, and the text names the chain owner. Reason: a product repair belongs to the implementation lane.
- A worker or designer may replace a ready writer only when the wave has no implementation-lane row. Reason: this legacy hand-off covers a head Spec Writer that ran before its worker.
- A `spec-writer` that replaced a worker or designer is in the implementation lane, and its hand-off stays normal. A `spec-writer` without a plan is never in the side lane. Reason: no data migration is needed.
- `chief_review` refuses to start while the plan Spec Writer is missing or not settled, or while a legacy writer delegated on another spec wave is not settled. The text names the writer, or the plan Spec Writer wave that has no writer. A spec wave that never had a writer does not block the review. Reason: the review must see the folded docs.
- `planProgress` returns a `waitWriters` step when the parent implementation row reports ready while a writer is pending. It returns the exact `chief_review` call when the last writer reports ready. Reason: Chief must not call a step that admission rejects.
- A ready report and an idle thread after a ready report count the same for both triggers. Reason: the thread convention is the same in every ready check.
- The plan review is rejected while a spec wave has a pending writer. Reason: the review must see the folded docs.
- A side-lane Spec Writer is a separate review target. It never joins a legacy stack. Reason: the writer shares the task branch, so it is not a stacked branch.
- A side-lane Spec Writer completes with a covering approve, `skipReview`, or `override`. An implementation-lane `spec-writer` completes only when its `replaces:` chain reaches a target of a passed gate. It then needs no hand-off worker and no override. Without that passed target, it keeps the rejection, and its worker follows it. Reason: a side writer has its own report and fold head, and a hand-off worker would have no gate.
- `chief_skip_specs` takes `{planThreadId, reason}`. It records the reason on every unbypassed spec wave that has no Spec Writer row. It is refused for a plan with no `spec: true` implementation wave, and once the plan Spec Writer wave has a writer row. A repeat call changes nothing. Reason: it bypasses only a Spec Writer that Chief never delegated.
- A spec waiver waives the planned Spec delta only. It does not block an incidental docs correction. Reason: a waiver and a docs repair are different decisions.
- A side-lane Spec Writer folds by rebasing only its own commits (`B..HEAD`) onto the task branch, then pushes with a plain push. It never force-pushes. Reason: a force-push can erase the commits of the worker, and a full-branch rebase replays commits that the worker already rewrote.
- On a fold conflict, a side-lane Spec Writer runs `git rebase --quit` and reports blocked. It does not restore its checkout, and the checkout may stay detached or partial. Nothing reuses that checkout. The writer never runs `git rebase --abort`, `git restore`, `git reset --hard`, `git checkout -- <path>` or a forced checkout. Reason: a user safety hook blocks those commands.
- The Spec Writer takes its content from the `## Spec delta` of the wave only. It reads code only to check a name or path that the delta states. Reason: the planner already read the code, and a second read costs tokens and can give a second, conflicting reading.
- The planner names the code path of each delta item as file and symbol. Reason: the writer does not read code to find it.
- Before the fold, the Spec Writer may check each identifier that its docs name with `git grep` at HEAD. The workers have pushed by then, so a missing name is a gap. The writer lists it under `## Unverified names` and continues. Reason: the writer starts after the last wave is ready, so a missing name is not work in progress.
- The Spec Writer model is the per-machine `spec-writer` pick in Chief settings. Without a pick, it uses the Worker pick (`MODEL_FALLBACK` in `src/core/roles.ts`). Reason: a cheaper model can apply a precise delta.
- An implementation-lane agent that reuses the chain worktree first requires a clean tree, fetches the task branch, and fast-forwards to it. It reports blocked when the fast-forward fails. Reason: the folded docs must be in the checkout before the agent reads files.
- The Reviewer scopes a side-lane writer by Fold base to Fold head. `Fold: none` means an empty scope. A docs commit inside a fold range is not drift in the range of a worker. Reason: the fold commits land in the task branch while the worker runs.
- A worker or designer on a spec wave treats the plan as its source of truth, and pre-plan specs can be stale. Reason: the Spec Writer records the change after the last wave.
- A first plan Spec Writer and a same-plan side-lane repair get a `## Docs work list (wave <w>)` section. Reason: one writer fixes and folds every known docs item.
- The section lists the `## Docs needed` of each worker and designer row on the owned waves. Reason: those rows report the docs that their waves need.
- The owned waves of the plan Spec Writer are every wave of the plan, across all chains. Reason: it covers the delta of every spec wave after the last wave.
- The owned waves of a legacy repair on another spec wave are wave `w` and each later wave of its chain before the next `spec: true` wave. Reason: a legacy writer owns the docs of its chain segment only.
- Each item carries its source thread id and wave. Reason: the writer checks each item against the docs and finds its owner.
- Rows of other plans and Spec Writer rows never appear in the section. A legacy repair also leaves out every row outside its segment. Reason: other owners fix their own docs items.
- A `None` section is skipped. Reason: it holds no docs item.
- The section lists the prior writer's blocker only when its last report was blocked. Reason: an open blocker is docs work that the repair must fix.
- The section holds whole items within 4,000 characters. Reason: a cut item loses its meaning.
- The section shows the longest whole-item prefix that leaves room, within 4,000 characters, for the exact omitted count and every omitted source thread id. The prefix may be empty. Reason: inline items let the writer fix them without a file read.
- When no prefix leaves that room, the section shows the exact omitted count and the path of one file in `$BB_THREAD_STORAGE`. The file holds the full work list. It has every collected worker and designer `## Docs needed` item of the owned waves. It also has the prior writer's blocker when its last report was blocked. Reason: no item is dropped without a way to recover it.
- A work list with no items gets no section, on a first delegation or a repair. Reason: an empty section adds only noise.
- An unplanned first writer, an implementation-lane or unplanned repair, a writer adopted by a new plan, and every non-writer kind get no section. Reason: only a same-plan side-lane writer owns the docs of its owned waves.
- The writer fixes each item that still holds, then folds once. Reason: one repair replaces separate fix and fold writers.
- On a review with several targets, a Spec Writer's findings section gets one scope line. Reason: findings carry no wave or target, so the writer needs a scope.
- The scope line tells the writer to fix only the docs findings that its mission assigns. Reason: other findings belong to their owners. The findings list itself does not change.
- The routing text says that Chief assigns each wave's review docs findings in the mission, and that the plugin attaches the wave's `## Docs needed` items. Reason: the plugin cannot attribute a review finding to a wave.

### Blocked Alerts

- A blocked worker or Spec Writer alert offers `chief_continue` for an environment or permission blocker, beside its existing replacement route. Examples are a blocked command, a dirty build-cache file, or a needed permission. The alert names the allowed step, and the thread keeps its worktree. Reason: a fresh thread for a blocked command repeats the same blocked step.
- The core rule names this in-place answer as its one exception to the fresh-worker rule (`chiefCoreRules` in `src/runtime/host.ts`). Code, test and spec defects, review findings and ready or complete follow-up still go to a fresh worker. Reason: an environment blocker has no product defect to fix, so a fresh thread repeats the same blocked step.
- A side-lane Spec Writer alert says the retry gets a fresh worktree. An implementation-lane or unplanned writer alert makes no worktree claim. Reason: only a side-lane writer gets a fresh worktree on repair.
- `continueThread` refusals for a side-lane Spec Writer say `starts a fresh worktree on the same branch and pull request`. Other refusals keep `keeps the same worktree, branch, and pull request`. Reason: the text must match the worktree that the repair gets.

### Docs Ownership

Only a Spec Writer changes `docs/`. The sections above define the lanes. This section defines who may change docs, how the plugin attributes a docs commit, and when `skipReview` refuses.

- A worker or designer never changes `docs/`, on any plan wave or on unplanned work. A fix run never changes `docs/` either. Reason: the owner gives docs to the Spec Writer.
- A worker or designer brief states the rule and its route. A needed docs change goes under `## Docs needed` in the ready result, and Chief delegates a Spec Writer. Reason: a needed change must reach the owner of docs.
- `admitDelegation` admits an implementation-lane Spec Writer on any non-design wave. The writer replaces the chain owner. The wave can be a non-spec wave, a waived spec wave, or a spec wave whose prior row is the worker. Reason: every non-design wave needs a legal docs route, and the chain owner holds the checkout.
- `admitDelegation` rejects a Spec Writer that replaces a row other than the chain owner. The text names the call that replaces the owner. Reason: a second row on the checkout would break the single implementation owner.
- `admitDelegation` rejects a Spec Writer on a design-only wave. The text names the successor wave and the call for it. Reason: a design wave changes no repository files, so its docs need goes to the successor wave.
- Such a writer shares the chain worktree and never completes on its own. Reason: its worker follows it.
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

- A worker brief renders `## Contracts to verify` as a pointer to that section of its plan file. The pointer names the plan file path. The brief still orders the agent to keep every item and to confirm each one with evidence. It also says that the reviewer checks the same list. Reason: the brief already orders a full read of the plan file, so an inline copy doubled the text.
- The reviewer brief keeps its full-plan read order and its inline contracts preview. Reason: the reviewer checks the contracts against the plan.
- A Spec Writer brief has no `## Contracts to verify`.
- An implementation-lane Spec Writer brief lists one `Wave n of N: <plan path>` line for each wave of the chain under `## Read-only context`. It lists the approved-design line when one exists. It adds the contracts of its own wave only, clipped at 3,000 characters. Reason: the contracts of the other waves belong to their workers. The writer can read each plan file.
- A side-lane Spec Writer brief lists one `Wave n of N: <plan path>` line for each non-absent wave of the plan, across all chains. It adds no contracts. Reason: the plan Spec Writer covers the delta of every spec wave, and the contracts belong to the workers.
- The plan Spec Writer brief adds a `Baseline` line when any unbypassed spec wave has `baseline`. Reason: the writer must know which new spec file the plan names.
- For each kind, `admitDelegation` accepts and refuses exactly the same requests as before the brief change. Only the source list of a Spec Writer changes. Reason: the change affects text, not admission.

A brief of a worker-kind thread or a planner thread keeps dynamic values and mode text only. No brief orders a skill load. The static rules live in the instructions of each role.

- `roleRules` in `src/core/roleRules.ts` builds the static rules of each managed role from fragments: `BRIEF_SCOPE`, `READY_CONTENT`, `NO_ASK`, `NO_PR`, `VERIFY`, `HEAVY`, `NO_TESTS_*`, `FAILS` and `DEVIATIONS`. A scope table decides which role gets which fragment.
- `bb.agents.configure` in `src/runtime/host.ts` sends these rules in the instructions on every turn. Reason: a rule that the agent must load by choice may never bind it.
- Each role reads each rule once. A brief states only an exception or a mode. Reason: a repeated rule adds length and can drift.
- The brief keeps these dynamic values: the branch in the sync and push commands, the `Local sync` or `Base commit` record name, the prior thread line, the issue and pull request URLs, the fold target branch of a side lane, `MAX_WAVES` and the Deviations line when a plan is linked. Reason: the instructions cannot know them.
- The brief keeps one role-boundary line. A worker writes and runs the tests of its wave, unless the brief waives them for a horizontal block wave, and a designer does not write or run tests. Neither changes `docs/`. A Spec Writer changes `docs/` only, never writes, edits or runs tests, builds or linters, and adds the `Chief-Spec-Writer` trailer to each commit. A planner stays read-only. Reason: a breach costs a full repair round.
- `WORKER_RULES` tell a worker to write and run the tests for its change in its wave, at the lowest level that would catch a break. They add an authoring gate, a ban on tests that assert the wording of a prose file, a filter on every test command, and the duty to fix a test that the change breaks. The plugin enforces none of this in code. Reason: the worker owns the test evidence, because the review gate has no tester.
- `PLANNER_TEXT` and the plan-review checklist in `src/research/delegationBrief.ts` require that every implementation wave carries its own tests and Verify command, except a horizontal block wave that waives its tests. A test wave stays refused. A reshape wave may update the tests that its reshape breaks. Reason: no later role writes the tests of a wave.
- `## Git workflow` keeps the dynamic lines only. It stays absent when the brief has no branch, issue or pull request. `## Fold` appears in a side brief only.
- The advisor brief, `reviewerBrief` and the stored copy of the brief have no change. Reason: they never held the working contract.
- The managed-thread instructions tell the agent to re-read the brief after a context compaction. Chief's own instructions have no change.

The five role skills and `CAMPAIGN.md` no longer exist. The [decision on role rules in instructions](../decisions/2026-11-19-role-rules-in-instructions.md) records this trade-off.

### Pull Request Pinning

- `admitDelegation` rejects a delegation when `params.prUrl` differs from the pull request URL of the prior worker. Reason: replacement workers on a chain must preserve the established pull request.
- `admitDelegation` accepts `params.prUrl` when the prior worker has no recorded pull request URL. Reason: callers must be able to record a missing pull request URL on replacement.

### Pull Request Ready Flip

- `chief_complete` of a worker marks its pull request ready. The flip uses `pr_url` when it is set. Reason: a pull request that a person opened by hand stayed draft.
- The branch fallback runs only with a local project checkout. Without one, the flip makes no forge or Git call and returns a non-fatal "still a draft" outcome. Reason: a branch name resolves only in a local checkout of the project.
- `markBranchReady` in `src/forge/forge.ts` refuses a branch name that a forge CLI reads as a pull request reference. Those forms are a bare number, `#n`, `owner/repo#n`, and a URL. The refusal is non-fatal and asks for the pull request URL. Reason: the forge CLI would flip the pull request that the reference names, not the branch.
- `readyPullRequest` in `src/runtime/completion.ts` skips a row that is not a worker. It also skips a row with neither `pr_url` nor `branch`, and runs no forge command. Reason: only a worker row names a branch to flip.
- A forge failure during the flip returns the non-fatal line. It never undoes completion. Reason: the work is done even when the forge call fails.

### Forge Pre-flight Operations

- `chief_forge_init` executes only for a chain head that has no row in any lane and no recorded pull request. Reason: secondary waves and started chains already possess branch and pull request identities.
- `chief_forge_init` rejects any wave that has a parent wave. Reason: only chain heads create pull requests and task branches.
- `chief_forge_init` names the chain head when rejecting a non-head wave. Reason: callers must know which wave opens the pull request for the chain.
- `chief_forge_init` rejects a chain head when its chain already contains a row in any lane, so a chain with only a side-lane Spec Writer counts as started. Reason: started chains must not allocate duplicate forge resources.
- `chief_forge_init` names the chain owner when it rejects a started chain head and an owner exists. Reason: callers must continue started work through replacement.
- `chief_forge_init` includes one section for each wave of the chain in the pull request body. Reason: reviewers inspect contracts for the entire chain in a single pull request.
- `chief_forge_init` clips wave contracts at 2,000 characters in the pull request body. Reason: bounded bodies prevent forge payload limit rejections.
- `chief_forge_init` clips the planner summary at 1,500 characters in the pull request body. Reason: bounded summaries keep the pull request readable.
- `chief_forge_init` formats the tracking issue body to state one pull request per chain. Reason: the tracking issue text must describe the chain pull request model.
- `chief_forge_init` formats unplanned pull request bodies identically to base commit behavior. Reason: unplanned tasks follow single-task forge conventions without plan chains.
- On a plan wave with a plan base, `chief_forge_init` uses that base when `base` is omitted. Reason: the branch and pull request must match the base that admission and review read.
- `chief_forge_init` refuses an explicit `base` that differs from a non-null plan base, before any forge effect. Reason: an explicit base never sets a second base for the chain.
- `chief_forge_init` refuses a stacked head while its plan base waits or is unresolved. Its text names the reason and offers no explicit base. Reason: an explicit base never bypasses the readiness rule.
- On a plan wave without a plan base, and on unplanned work, `chief_forge_init` keeps a free explicit `base`. Reason: only a stacked or branch-based chain fixes its base.

### Shared Worktree Cleanup

- `cleanupStep` records an action claim in `cleanup_environment_claims` before deleting branches or issuing teardown alerts. Reason: atomic claims elect exactly one owner for each shared worktree action.
- The first cleanup job that observes the worktree environment removed claims and executes branch deletion. Reason: one job must remove the shared branch safely.
- The first cleanup job that observes environment teardown trouble claims and emits a `cleanup-teardown-trouble:alert` alert. Reason: shared teardown failures must produce exactly one alert for the environment.
- The first cleanup job that observes stuck teardown claims and emits a `cleanup-teardown-stuck:alert` alert. Reason: timeout warnings on a shared environment must not trigger duplicate operator alerts.
- A cleanup job transitions to `storage` with outcome `worktree shared: <action> handled by <owner>` when another job owns the claim. Reason: non-owning jobs must complete cleanup without repeating branch or alert actions.
- `cleanupStep` records no claim when teardown discovers that the environment is in use. Reason: an environment in active use retains its branch without claiming permanent deletion rights.
- A cleanup job that later observes the environment destroyed can claim branch deletion after a previous in-use observation. Reason: earlier in-use states do not lock future deletion ownership.
- A single cleanup job on an unshared environment retains existing baseline step transitions, outcomes, and alerts. Reason: cleanup behavior for non-shared environments must not regress.

### Merge Proof Before Cleanup

- `taskPullRequests` in `src/forge/cleanup.ts` returns the pull request URLs that decide a row. An empty set means the row has no pull request. Reason: cleanup uses the same links as `cleanupEligible`.
  - A worker gives its own `pr_url` and the `pr_url` of its successor chain.
  - A reviewer gives the `pr_url` of each covered target. It uses `review_targets.pr_url`, or else the target row's `pr_url`.
  - An advisor gives the `pr_url` of its worker, or of the workers of its plan.
  - A planner gives the `pr_url` of every wave worker.
- `observeCleanup` checks merge proof before it enqueues a row. A row whose pull request is open never enters the queue. Reason: until merge the task stays live.
- Before a queued job runs its `archive` or `branch` step, the job checks merge proof again. Reason: the rule holds for jobs that were queued earlier.
  - When a pull request lacks merge proof, the job waits for a later pass. It counts no attempt and records no error.
  - `teardown` and `storage` keep their order after `archive`.
- Merge proof comes from one in-memory cache in `createCleanup` (`src/runtime/cleanup.ts`). The `branch` step reads the same cache. Reason: one owner gives every step the same answer.
  - The cache keeps a merged answer. It holds at most 500 entries and evicts the oldest first. Reason: bounds the cache size.
  - Any other answer is asked again no sooner than 5 minutes later, for each pull request. Other answers are open, closed without merge, and failed (`prMerged` returns null). Reason: a failed answer keeps the row and its branch.
- At most 10 forge lookups run in each `observeCleanup` pass. Lookups past the limit wait for a later pass. Reason: bounds the forge calls of one pass.
- A pull request closed without merge keeps its rows and its job until Chief archives them by hand, or until a later merge. Reason: until merge the task stays live.
- A row with no pull request on itself or its links keeps the timing of the earlier cleanup. Reason: rows without a pull request must not change.
- Branch deletion keeps every safety check: `ownedBranch`, `deleteSafeBranch`, and the origin check that holds every commit. Reason: merge proof adds a gate and removes no check.

### Legacy Restack Handling

- `src/plan/planProgress.ts` evaluates restack requirements only for legacy plans where waves have distinct branches. Reason: new chains share a single branch and never require branch restacking.
- The server never instructs new chain workers to restack branches. Reason: all waves in a new chain commit directly to the shared branch.

### Baseline Graph and Schedule Operations

- `parentOf` returns the first explicit dependency or the preceding wave number. Reason: explicit dependencies override sequential defaults.
- `parentOf` returns null when a wave has empty dependencies or index 1. Reason: head waves have no parent dependency.
- `successorOf` returns the first non-absent wave that depends on the specified wave. Reason: graph traversal skips waves that have no execution.
- `chainOf` traverses backward to the head and forward to the tip. Reason: callers require the complete sequence of linked waves.
- A plan is 1 to 8 implementation waves (`checkPlan`). A `test` key is refused. Reason: each implementation wave carries its own tests and Verify command, so a test wave adds no work.
- A horizontal block wave may waive its tests. Its Verify command runs build and typecheck only. The integrate wave runs the system tests. Reason: see [the decision](../decisions/2026-11-24-horizontal-block-test-waiver.md).
- A persisted legacy test wave without rows is `absent`. It is never pending, and its index is kept. With rows, it is an ordinary wave (`planWavesFor`). Reason: stored plans keep their indices and their rows.

### Heavy Command Slots

A slot limits how many heavy commands run at once on one computer. The slot wrapper admits each heavy command into a slot. Reason: several threads on one computer can overload it.

- `startWorker` publishes the slot wrapper and writes the `slots` file before it launches a worker or designer. Reason: the brief must name a script that exists.
- The `slots` file sits in `<BB data dir>/chief/heavy/`. It holds the `heavySlots` setting as one number. Reason: one host file gives one capacity for every script version.
- `heavySlotCount` returns 1 to 8 for a valid setting. Any other value, or a missing value, returns 2. Reason: an invalid setting must not block delegation.
- The wrapper reads the `slots` file at every admission round. A missing or invalid file means one slot. Reason: a lowered cap applies to new admissions at once.
- The `sim` pool always has one slot. Reason: a simulator, emulator or device needs one owner at a time.
- New admissions use only slots 1 to N, where N is the current capacity. Reason: after the holders above N exit, at most N heavy commands run.
- A lowered cap does not stop current holders. Reason: stopping a running build wastes its work.
- The wrapper records each admission with a private marker file. A started command exits with its own status, including 75. Reason: a status of 75 alone cannot tell a busy slot from a command that exits 75.
- A marker that cannot be created or removed stops the command before it starts. The wrapper prints a `[chief-heavy]` line and exits non-zero. Reason: an unrecorded admission cannot count toward the cap.
- A holder that dies, even by SIGKILL, frees its slot. Reason: the kernel releases the lock when the process ends.
- A waiting call prints a heartbeat at most every 15 seconds. The heartbeat names each holder, or `unknown` when a holder has no note. Reason: the agent sees progress during a long wait.
- After 480 seconds of waiting, the wrapper exits 75 with a run-again line, and the command never runs. Reason: an agent tool call times out on a long wait, and the agent then runs the command again.
- A call with `CHIEF_HEAVY_HELD` set runs its command directly and takes no slot. Reason: a command inside a slot must not wait for a second slot.
- A usage error exits 2 and runs nothing. Reason: an unknown pool must never run a command.
- Chief adds `## Heavy commands` to worker and designer briefs only when a published slot wrapper path is available. This rule includes briefs without a Verify block. Reason: those agents run builds and tests through the wrapper.
- Chief adds a wrapper fence under `## Verify command` only when the brief already includes that block and a wrapper path is available. The raw Verify fence stays unchanged. The wrapper fence wraps the exact Verify command. The agent fills in `<pool>`. Chief does not choose the pool from the command text. Reason: the plugin cannot know what a command does.
- If Chief cannot read the heavy-slot setting or publish the wrapper, it logs a warning and continues delegation. The brief has neither `## Heavy commands` nor a wrapper fence. Any Verify block that the brief normally includes stays unchanged. Reason: heavy preparation must never block a delegation.
- Spec Writers get neither `## Heavy commands` nor a wrapper fence. Reason: Spec Writers do not run builds or tests.
- A published script is never removed or rewritten. Its file name carries the first 12 hex characters of its content hash. Reason: a running brief keeps a script that exists.
- `artifactDir` keeps its paths and fallbacks. Heavy preparation reads the data directory through the same lookup. Reason: artifacts and heavy files must share one data root.

Known limits:

- Locks use macOS `lockf` only. Without `lockf` the wrapper runs the command unthrottled and prints one line. Upgrade when a Linux host runs Chief workers.
- Locks are not FIFO. A newer waiter can win over an older one. Upgrade with a ticket queue when starvation appears.
- An agent can bypass the wrapper. See the [decision on the slot wrapper](../decisions/2026-11-18-heavy-slots-host-capacity.md).
- Two BB data roots on one computer do not share slots. The supported setup is one data root per host.

### Approved Design Binding

- `chief_plan` with `researchThreadId` refuses an unknown thread, a non-researcher, a light researcher, a researcher owned by another Chief, or a researcher without a ready approval. These checks occur before checkout freshen, planner spawn or planner row insertion.
- `bindDesign` uses `design-approved-r<seq>.md` and `facts-approved-r<seq>.md` in the researcher's artifact directory. `<seq>` is the ready report's sequence. When the design snapshot is absent, the helper reads `design.md` and refuses a missing, blank or over-40,000-character source before checkout freshen or planner spawn.
- A later initial bind to the same researcher and ready-report sequence reuses the existing snapshots. The snapshots are write-once. An unreadable snapshot causes refusal, not replacement. Reason: a design edited after approval must not change a plan, and a plan must not start on an unreadable design.
- The facts snapshot holds the full ready result of the researcher row. Reason: the planner must read the fact report in full.
- With research on, `chief_plan` requires `undesignedReason` when neither `researchThreadId` nor `revises` is supplied. Reason: a new plan records its approved design or its reason for skipping the discussion.
- With research off, `undesignedReason` is optional. When given, the server accepts it and the brief gets `Design discussion skipped: <reason>`. Reason: a skip stays on record even when the design flow is off.
- The CLI takes the two inputs as `--research-thread thr_id` (`researchThreadId`) and `--undesigned-reason "…"` (`undesignedReason`). `bb chief plan` calls the same `startPlan`, so the CLI accepts and refuses the same inputs as the tool. Reason: one validation path keeps both entry points in agreement.
- `researchThreadId` and `undesignedReason` are refused together, and neither is accepted with `revises`. This applies to the CLI flags too. Reason: one plan has one design source.
- A new design-bound planner stores the researcher ID in `research_thread_id` and the ready-report sequence in `research_report_seq`. A `revises` planner inherits both values. Revision and `chief_forge_init` use `approvedDesign` to read that exact pair, even after a later ready report. If the sequence is missing or either snapshot is missing or unreadable, they refuse before planner freshen or spawn, or before the forge script runs, respectively. Neither recreates a snapshot or reads live `design.md`.
- The planner brief holds `## Approved design` before `## Problem`, with both paths and no inline design text. Reason: the planner reads the design from its file.
- `chief_forge_init` adds the bound design text and fact snapshot path after the plan block of the pull request body. The marker uses the stored researcher ID and ready-report sequence. Reason: reviewers read the design that the planner used.
- A reused pull request without the marker gets its body rewritten. A body that still lacks the marker refuses the call. Reason: the design block must exist before review.
- With research off, `chief_plan` accepts a plan with neither input, as before. Reason: the design flow is off.

## Invariants

- Revision and forge use the design and fact snapshots identified by the planner's stored researcher ID and ready-report sequence. Neither replaces a snapshot or selects a later approval.
- A task branch hosts at most one active implementation-lane thread, plus at most one side-lane Spec Writer for each plan. Legacy plans can hold one for each spec wave. Reason: only one thread checks out the task branch. Each writer uses its own side branch, and its fold is a fast-forward push.
- Every implementation-lane row in a plan chain shares the identical environment identifier, branch name, and pull request URL. Every side-lane Spec Writer shares the branch name and pull request URL, and has its own environment. Reason: chain identity must remain uniform across all wave transitions.
- A replacement worker marks its superseded worker as complete. Reason: superseded workers must release active claims on resources.
- A completed or ready earlier Spec Writer of a spec wave satisfies that wave. Reason: legacy chains that ran the writer first need no migration.
- Exactly one cleanup job owns each action for a shared environment in `cleanup_environment_claims`. Reason: primary key constraints prevent duplicate claim owners.
- A reviewer worktree never hosts review execution on the live environment of an active target worker. Reason: concurrent reviewer execution inside a worker workspace causes file collisions.
- `test/fixtures/legacy-wave-graph-bf73de5.json` decisions remain identical to base commit results. Reason: legacy plan verification contracts require strict regression avoidance.
- The task branch and pull request of a stacked or branch-based chain are based on its plan base. They never start from `origin/HEAD`, `main`, or `master`. Reason: the pull request must show only the changes of its own chain.
- A plan with no `stackOn` and a planner with no branch behaves as before. Reason: existing plans must not change.
- A row with a pull request is archived, and its branch deleted, only after merge proof for each such pull request. Missing or failed forge evidence keeps the row. Reason: until merge the task stays live, so a chat-requested fix can continue it.

## Related Decisions

- [Spec Writer runs in parallel on a side worktree](../decisions/2026-11-10-spec-writer-parallel-side-worktree.md) (its parallel start is superseded)
- [One Spec Writer per plan](../decisions/2026-11-18-one-spec-writer-per-plan.md)
- [Only a Spec Writer changes docs](../decisions/2026-11-10-docs-owned-by-spec-writer.md)
- [Stacked chains use a stackOn field](../decisions/2026-11-14-stacked-chains-stackon.md)
- [Heavy commands run through a host slot wrapper](../decisions/2026-11-18-heavy-slots-host-capacity.md)
- [One review gate per plan](../decisions/2026-11-18-single-review-gate.md)
- [Workers write and run their tests, no tester](../decisions/2026-11-19-workers-write-tests.md)
- [Horizontal block waves may waive tests](../decisions/2026-11-24-horizontal-block-test-waiver.md)
