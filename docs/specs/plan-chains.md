# Plan Chains

## Purpose

The plan chains domain manages execution topology, branch allocation, pull requests, worker environments, reviewer worktrees, and cleanup claims.

## Domain Terms

- **Plan wave**: an ordered unit of implementation, design, or testing in a plan.
- **Chain**: an ordered sequence of waves from a head wave to a tip wave.
- **Chain head**: a plan wave with no parent dependency.
- **Chain tip**: a plan wave that has no successor wave.
- **Task branch**: the Git branch created for a plan chain.
- **Worker environment**: the managed worktree environment assigned to a worker thread.
- **Legacy plan**: an earlier plan where each wave received an independent branch.
- **Pinned review**: a review round bound to a specific pull request commit SHA.
- **Unpinned review**: a review round without a readable commit SHA.
- **Cleanup claim**: a persistent record in `cleanup_environment_claims` that assigns an environment action to one thread.
- **Repair target**: a worker thread that a reviewer covers. An open target is a repair target with work still open.
- **Loose target**: an open target that is not in a legacy stack.
- **Reject streak**: the rejection count that a reviewer row carries as `reject_streak`.
- **Rung**: the advice level (fix, consult, or stop) that `ledger.rung` returns for a reject streak.

## Ownership and Entry Points

Six modules own the plan chains domain:

1. `waveSchedule.ts` owns graph traversal, wave relationships, and wave absence.
2. `planLifecycle.ts` owns delegation admission, role progression, and waivers.
3. `server.ts` owns worker execution, forge initialization, delegation tools, and cleanup steps.
4. `planProgress.ts` owns progress checks, review readiness, legacy restack rules, and the repair decision after a reviewer verdict.
5. `reviewStart.ts` owns review launch preparation, brief generation, and environment reuse.
6. `reviewLedger.ts` owns reviewer tracking, coverage checks, and historical task chain queries.

Callers interact with these entry points:

- `chainOf(waves, n)`: returns the complete chain of wave numbers for wave `n`.
- `parentOf(waves, n)`: returns the parent wave number of wave `n`, or null for a chain head.
- `successorOf(waves, n)`: returns the successor wave number of wave `n`, or null for a chain tip.
- `heads(waves)`: returns every chain head in the plan.
- `tips(waves)`: returns every chain tip in the plan.
- `admitDelegation(request)`: admits or rejects a delegation request for a wave.
- `chief_forge_init(params)`: initializes the forge repository branch, pull request, and issue.
- `startWorker(params)`: prepares and launches a worker thread in an environment.
- `restackOf(worker, waves)`: determines whether a legacy wave requires a restack.
- `reviewAdvice(reviewer)`: returns null, or one advice of kind approve, fix, consult, or stop.
  - The advice names the layout: whole plan, single managed worker, or unowned branch.
  - The advice lists the open targets, the legacy stack groups in wave order, and the loose targets.
  - For each target, the advice states whether it is a tester branch and whether it sits on a spec-bearing chain.
  - A tester branch is a tester row or a worker on a test wave.
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
6. Chief calls `chief_delegate` for the next wave using `replaces:` referencing the prior worker.
7. The server assigns the existing worker environment, task branch, and pull request.
8. Later waves in the chain repeat this replacement sequence.
9. The chain tip worker reports ready, and Chief starts the plan review.

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

- The server assigns exactly one task branch, one pull request, and one worker worktree to each plan chain. Reason: shared environments reduce worktree disk use across dependent waves.
- The server creates a fresh managed worktree for each independent chain head. Reason: independent chains must execute in parallel without shared worktree state.
- `startWorker` reuses the environment of the prior worker when `replaces:` is present. Reason: chain waves share installed dependencies and build outputs.
- `startWorker` rejects a delegation when another non-terminal worker holds the same branch. Reason: git prohibits simultaneous checkouts of one branch in different worktrees.
- `startWorker` rejects a delegation when `params.branch` differs from the branch of the prior worker. Reason: replacement workers must remain on the established chain branch.

### Chain Admission and Delegation

- `admitDelegation` rejects a non-head wave delegation when `replaces:` is absent. Reason: non-head waves must continue on the existing worktree and branch of the chain.
- `admitDelegation` names `replaces: <latest>` when rejecting a non-head wave without a replacement target. Reason: callers must know the latest worker thread to continue the chain.
- `admitDelegation` rejects a delegation without `replaces:` when any wave in the chain already has a worker row. Reason: started chains must not allocate duplicate workers or environments.
- `admitDelegation` rejects a replacement target from another chain of the same plan. Reason: independent chains must not inherit foreign branches or environments.
- `admitDelegation` permits a fresh plan wave 1 delegation with `replaces:` targeting a blocked worker of another plan. Reason: re-planning allows recovery on the blocked worktree.
- `admitDelegation` permits a tester wave to start fresh on a new branch when the tested worker completed. Reason: post-merge testing verifies code after branch deletion.
- `admitDelegation` permits a fresh plan wave 1 Spec Writer to replace a blocked Spec Writer of another plan. Reason: specification repair across plans enables recovery from specification errors.

### Pull Request Pinning

- `admitDelegation` rejects a delegation when `params.prUrl` differs from the pull request URL of the prior worker. Reason: replacement workers on a chain must preserve the established pull request.
- `admitDelegation` accepts `params.prUrl` when the prior worker has no recorded pull request URL. Reason: callers must be able to record a missing pull request URL on replacement.

### Forge Pre-flight Operations

- `chief_forge_init` executes only for a chain head that has no worker row and no recorded pull request. Reason: secondary waves and started chains already possess branch and pull request identities.
- `chief_forge_init` rejects any wave that has a parent wave. Reason: only chain heads create pull requests and task branches.
- `chief_forge_init` names the chain head when rejecting a non-head wave. Reason: callers must know which wave opens the pull request for the chain.
- `chief_forge_init` rejects a chain head when its chain already contains a worker row. Reason: started chains must not allocate duplicate forge resources.
- `chief_forge_init` names the latest worker when rejecting a started chain head. Reason: callers must continue started work through replacement.
- `chief_forge_init` includes one section for each wave of the chain in the pull request body. Reason: reviewers inspect contracts for the entire chain in a single pull request.
- `chief_forge_init` includes waived test waves in the pull request body with their recorded waiver reasons. Reason: reviewers must see omitted test coverage and its justification.
- `chief_forge_init` clips wave contracts at 2,000 characters in the pull request body. Reason: bounded bodies prevent forge payload limit rejections.
- `chief_forge_init` clips the planner summary at 1,500 characters in the pull request body. Reason: bounded summaries keep the pull request readable.
- `chief_forge_init` formats the tracking issue body to state one pull request per chain. Reason: the tracking issue text must describe the chain pull request model.
- `chief_forge_init` formats unplanned pull request bodies identically to base commit behavior. Reason: unplanned tasks follow single-task forge conventions without plan chains.

### Review Worktree

- `startReview` launches a fresh managed worktree on the pull request branch for the first pinned review of a task. Reason: a new review requires an isolated worktree checkout.
- `startReview` reuses the newest earlier pinned reviewer worktree for a later pinned review of the same task when that reviewer is eligible. Reason: worktree reuse saves disk space and checkout time across review rounds.
- `reusableEnvironment` returns an environment only when the earlier reviewer thread is live, not archived, not active, and has an existing worktree. Reason: reviews must not disrupt active threads or touch deleted environments.
- `startReview` never reuses an environment that matches the live environment identifier of any review target worker. Reason: a reviewer must not mutate or lock the workspace of an active target worker.
- The reviewer brief instructs the reviewer to checkout the pinned commit detached. Reason: detached checkouts avoid local branch divergence during review.
- `startReview` launches a fresh managed worktree when `reusableEnvironment` returns null, rejects, or times out. Reason: review launches must continue without failure when reuse cannot complete safely.
- `startReview` uses the live environment of the worker for an unpinned review. Reason: unpinned reviews run directly in the environment of the worker.
- `startReview` never selects an unpinned review environment for later reviewer reuse. Reason: unpinned reviews record no pinned commit SHA and belong to workers.

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

- `planProgress.ts` evaluates restack requirements only for legacy plans where waves have distinct branches. Reason: new chains share a single branch and never require branch restacking.
- `server.ts` words restack instructions only for the legacy stacks that `reviewAdvice` returns. It never groups targets itself. Reason: historical plan graphs in SQLite require backward compatibility.
- The server never instructs new chain workers to restack branches. Reason: all waves in a new chain commit directly to the shared branch.

### Baseline Graph and Schedule Operations

- `parentOf` returns the first explicit dependency or the preceding wave number. Reason: explicit dependencies override sequential defaults.
- `parentOf` returns null when a wave has empty dependencies or index 1. Reason: head waves have no parent dependency.
- `successorOf` returns the first non-absent wave that depends on the specified wave. Reason: graph traversal skips waves that have no execution.
- `chainOf` traverses backward to the head and forward to the tip. Reason: callers require the complete sequence of linked waves.
- `planWavesFor` marks a waived test wave as absent when no worker executed on it. Reason: undelegated waived tests do not participate in active scheduling.

## Invariants

- A task branch hosts at most one active worker thread at any time. Reason: concurrent git operations on the same branch corrupt git reflogs.
- Every worker in a plan chain shares the identical environment identifier, branch name, and pull request URL. Reason: chain identity must remain uniform across all wave transitions.
- A replacement worker marks its superseded worker as complete. Reason: superseded workers must release active claims on resources.
- Exactly one cleanup job owns each action for a shared environment in `cleanup_environment_claims`. Reason: primary key constraints prevent duplicate claim owners.
- A reviewer worktree never hosts review execution on the live environment of an active target worker. Reason: concurrent reviewer execution inside a worker workspace causes file collisions.
- `legacyWaveGraph.oracle.json` decisions remain identical to base commit results. Reason: legacy plan verification contracts require strict regression avoidance.
- Reviewer advice is not permission. Reason: advice is plan-wide wording, and permission is per task.
- `reviewAdvice` takes its rung from the `reject_streak` that the reviewer carries, through `ledger.rung`. Reason: one carried streak gives one answer for the alert, Pending, and the action panel.
- `ledger.replacement` keeps permission for a `replaces:`. It decides from task history, consult timing, and user approval. Reason: permission depends on the task, not on the plan.
- A satisfied consult still shows consult advice. `chief_delegate` decides whether the `replaces:` proceeds. Reason: advice stays plan-wide wording.
- `server.ts` `nextAction` formats the result of `reviewAdvice` and makes no repair decision of its own. Reason: one module reads plan state and reviewer state together, and the server only writes sentences.
- The report alert, `chief_roster` Pending, and the action panel read the same `reviewAdvice` answer. Reason: the three surfaces must never give different advice.

## Related Decisions

None.
