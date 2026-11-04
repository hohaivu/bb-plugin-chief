# Plan Chains

## Purpose

The plan chains domain manages execution topology, branch allocation, pull requests, and worker environments across plan waves.

## Domain Terms

- **Plan wave**: an ordered unit of implementation, design, or testing in a plan.
- **Chain**: an ordered sequence of waves from a head wave to a tip wave.
- **Chain head**: a plan wave with no parent dependency.
- **Chain tip**: a plan wave that has no successor wave.
- **Task branch**: the Git branch created for a plan chain.
- **Worker environment**: the managed worktree environment assigned to a worker thread.
- **Legacy plan**: an earlier plan where each wave received an independent branch.

## Ownership and Entry Points

Four modules own the plan chains domain:

1. `waveSchedule.ts` owns graph traversal, wave relationships, and wave absence.
2. `planLifecycle.ts` owns delegation admission, role progression, and waivers.
3. `server.ts` owns worker execution, forge initialization, and delegation tools.
4. `planProgress.ts` owns progress checks, review readiness, and legacy restack rules.

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

### Legacy Restack Handling

- `planProgress.ts` evaluates restack requirements only for legacy plans where waves have distinct branches. Reason: new chains share a single branch and never require branch restacking.
- `server.ts` provides restack instructions only for legacy stacked plans. Reason: historical plan graphs in SQLite require backward compatibility.
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
- `legacyWaveGraph.oracle.json` decisions remain identical to base commit results. Reason: legacy plan verification contracts require strict regression avoidance.

## Related Decisions

None.
