# Review Engine

## Purpose

The review engine decides how a Chief-managed worker reviewer forms its verdict for review targets pinned to a pull request head. The default engine reads the code. Two optional engines add pr-agent, an external review tool.

## Domain Terms

- **Engine**: the setting `reviewEngine`. Its values are `reviewer`, `pr-agent`, and `both`.
- **Target**: one worker that a review covers. A target is pinned when the gate reads its head commit: the pull request head, else the branch head on origin. Otherwise it is not pinned.
- **Target line**: one line of a plan review subject. It covers one pull request (pinned targets) or one branch (unpinned targets), and names every worker of that group.
- **Review gate**: the one review of a plan (or of an unplanned task). It holds one reviewer and one tester, and its targets stay pinned. Its fix run and corrector join it when needed. See Review Gate.
- **Fix run**: the one fresh worker that a gate admits after a `fix` decision. It replaces the gate tester and makes the failing tests pass.
- **Corrector**: the one tester that a gate admits after a blocked fix run with wrong-test evidence. It replaces the fix run.
- **Gate decision**: the state that `gateDecision` returns for a gate: start, restart, wait, fix, docsRepair, wrongTest, escalate or pass.
- **Accepted gap**: a verification gap that Chief accepted before the review and passed in `acceptedGaps`.
- **Outcome**: the one result an engine gives for a target: definitive, needs_review, failure, or not pinned.
- **Wrapper**: the script `pr-agent-review.sh` in the attempt folder. It runs pr-agent and prints a translated result.
- **Helper**: a plain BB child thread named `Review helper`. It does the direct review in `both` mode.
- **Direct review**: the plain review in which the reviewer reads the code.
- **Fallback**: a direct review that replaces a failed or inconclusive engine step.
- **Reviewer storage**: `$BB_THREAD_STORAGE` of the reviewer thread.
- **Attempt folder**: `<BB data dir>/chief/<projectId>/<worker id>/review-<report number>/<attempt id>/`, Chief's data folder for the reviewed worker, on the host the reviewer runs on. The attempt id is a fresh 8-character id for each review start, so a repeat review never reads another attempt's files. The code writes `review-context.md`, the wrapper and the helper prompt here before the reviewer is spawned. The prompt and the engine section name the absolute path, as that host returned it.

## Ownership and Entry Points

| Entry point | File | Role |
| --- | --- | --- |
| `reviewEngine(raw)` | `src/review/prAgent.ts` | Parses the two settings. It is the only validation point. |
| `prAgentScript(dir)` | `src/review/prAgent.ts` | Returns the wrapper text, which includes the translation step. |
| `prAgentSection(mode, targets, dir)` | `src/review/prAgent.ts` | Returns the prompt lines that name the engine rules. |
| `helperPrompt(reviewerPrompt, context)` | `src/review/prAgent.ts` | Returns the helper prompt. |
| `reviewContext(input)` | `src/review/reviewStart.ts` | Returns the context text. It is a pure function. |
| `computeImpactSlice` | `src/review/impactSlice.ts` | Returns the impact slice, the changed paths (`changed`) and the docs history (`docsHistory`). |
| `reviewParams` | `src/tools/review.ts` | Defines the `chief_review` inputs, `focus` and `acceptedGaps` included. |
| `startReview` | `src/review/reviewStart.ts` | Opens or joins the review gate, pins its targets, and launches the missing side. Reads the engine once at review start. It appends the section and writes the files. |
| `gateDecision(gate)` | `src/plan/planProgress.ts` | Returns the gate decision from the gate row, its rows and the reviewer verdict. It is pure. |
| `completionRefusal` | `src/runtime/completion.ts` | Refuses `chief_complete` unless the row's gate decision is `pass`. |
| `review_gates` | `src/db/migrations.ts` | Stores one row for each gate: its key, its pinned targets and its reviewer, tester and fix ids. |
| `bb.settings.define` | `server.ts` | Defines `reviewEngine` and `prAgentDir`. |

`startBranchReview` never reads the engine. An unowned branch review always uses the direct review.

## Plain Review (baseline)

This section describes the behaviour of the code at commit 6638ef5, before the engine. The `reviewer` engine keeps it unchanged.

Code paths: `reviewerPrompt`, `reviewBrief`, `startReview`, `startBranchReview` in `src/review/reviewStart.ts`. `REVIEW_ONLY` in `src/core/roles.ts`. The `bb.settings.define` block and the `createReviewStart` call in `server.ts`. The reviewer rule in `skills/chief-role-reviewer/SKILL.md`. `checkReport` in `src/report/reportIntake.ts` and `reportFinding` in `server.ts`, for the finding limits only.

### Reviewer prompt

`reviewerPrompt` builds one prompt for a worker's reviewer and for a branch reviewer.

- Invariant rules come first. Reason: the prefix caches.
- The first rule is `REVIEW_ONLY`: the reviewer does not create, modify, delete, commit, or push tracked files. A repair goes back to the worker.
- The read rule says: review by reading the code. The reviewer never runs builds, linters, typecheckers, or tests. Reason: the worker owns the lint, build, and Verify evidence, and the tester owns the test evidence.
- The prompt then lists the evidence rules, the do-not-report list, the guideline-file rule, and the rules for classifying findings. The verdict is `request_changes` only when a blocking finding exists.
- The native-design check and `## Docs ownership` are conditional blocks. See Conditional blocks.
- Each rule appears once in the prompt. Reason: a repeated rule adds length and can drift.
- Every per-run line sits under the heading `## This review`: the subject, the line that names the Chief thread for `chief_report`, an optional focus, and the provenance lines.
- When Chief passes `acceptedGaps`, the prompt adds `## Accepted gaps (Manual Verification)` after the focus line. It holds the text and this rule: the reviewer lists each gap under Manual Verification and never makes a finding of a listed gap alone. Without `acceptedGaps`, the prompt is unchanged.
- A pinned review says: inspect the pinned pull request commit. An unpinned review says: inspect the worktree and the evidence.

### Brief

`reviewBrief` returns the prompt and a separate `context` text. It reads nothing else.

- A single-worker review names the pull request and its pinned head, with the `git fetch` and `git checkout --detach` command.
- A plan review (more than one target) says: give one verdict for all targets, and name the branch of each finding.
- A plan review has one target line for each pull request. Each line names the pull request, branch, base, one pinned sha and one scope, then lists every worker of that pull request with its kind. Reason: one pull request at one commit has one diff scope.
- The kinds are `worker`, `tester`, `designer`, `Spec Writer` and `side-lane Spec Writer`.
- Targets without a readable head have one line for each branch. The line says the pull request is not pinned. Its verdict binds to the report number of each worker.
- The subject header counts target lines: `N pull requests` when all are pinned, `N branches` when none is, and `N pull requests and M branches without a pinned pull request` for a mix. It never calls an unpinned group a pull request.
- The context holds the worker brief, the recorded commands, the report pointers, the earlier workers, the previous review, the plan files, the waivers, the impact slice, and the guideline files.
- The prompt has no `## Context` list.
- When the context is not empty and its file is written, the prompt has one line: read the absolute path of `review-context.md` in full. The prompt has no wait rule.
- When the context file is not written, the prompt ends with `## review-context.md` and the context inline.
- An empty context writes no file and renders no read line.
- The worker-reported contract rule renders only when the prompt lists contract items.

### Conditional blocks

`startReview` computes four flags. Each flag decides whether one block renders. A block that renders keeps its base wording, with the exception that the native-design check has two forms.

| Block | Renders when | Reason |
| --- | --- | --- |
| Native-design check | A reviewed implementation wave has `feature` not false. Also for an unplanned worker review, a branch review, and a legacy wave without the `feature` key. | The check judges new behaviour only. |
| Reshape sentences of the native-design check | A reviewed wave has `reshape` true, or a reviewed implementation wave lacks the `feature` key. Never for an unplanned worker review or a branch review. | Only a reshape wave judges the feature and its reshape together. |
| `## Docs ownership` | A reviewed target range has a docs/ commit, the net diff touches docs/, a spec gate or a Spec Writer exists, or the docs history is unknown. Never for a branch review. | The rule is per commit, so a net diff cannot show that it does not apply. |

- Without the reshape sentences, the native-design check loses two parts: the parenthesis `(a reshape wave's contracts do)` and the last sentence about judging a reshape commit with its feature.
- A reviewed wave is an implementation wave when it is not `design`.
- Unknown paths or unknown history keep the block. Reason: a failed lookup must never remove a rule.

### Contract items the reviewer cannot check

A contract item is worker-reported when the reviewer cannot check it at the pinned commit. Three kinds exist: an unresolved `<…>` placeholder, a fact about the worker's process, and a command that needs another repository's checkout.

- The reviewer confirms the item from the worker's report and marks it worker-reported.
- The item is unmet only when the report or the code contradicts it.
- Planner guidance forbids such items. Reason: an item that nobody can check forces a false approve or a false reject.

### Known gaps

Chief decides every known verification gap before the review. The reviewer never rules on one.

- `focus` says what to check. It never asks the reviewer to judge whether a gap blocks.
- `acceptedGaps` holds the gaps that Chief accepts, with the reason. It has at most 1,000 characters. It works for worker, pull request and branch targets.
- Reason: the reviewer may not run tests, so only Chief can accept a gap.

### Impact slice

`computeImpactSlice` returns the impact slice of one target. It runs two Git listings right after it finds the merge base. Every success path carries both values, the early return for no symbols included. The slice lines, entries, guidelines and budgets stay the same.

| Field | Source | Failed lookup |
| --- | --- | --- |
| `changed` | `git diff --name-only -z --no-renames <merge-base> <sha>`, split on the null byte. It lists text, binary and mode-only changes as raw paths. | `null` |
| `docsHistory` | `git log --no-merges -n 1 <merge-base>..<sha> -- docs/` prints a commit. | `null` |

Each lookup has its own failure handling, and a failure leaves the rest of the slice unchanged. Reason: the conditional blocks need the full path list and the full commit history, not the text diff.

### Base of the impact slice

The review start chooses the base ref of the slice for each target without a pinned head.

- A stacked or branch-based plan wave compares against `origin/<plan base>`. Reason: the chain builds on that base, not on the default branch.
- When the plan base is unresolved, the slice is skipped with the reason `stack base unresolved: <reason>`. Reason: the slice never falls back to the default branch.
- An unstacked plan wave and unplanned work compare against `origin/HEAD`, as before.
- A target with a pinned head compares against `origin/<head.base>`, as before.
- The plan base is defined in [plan-chains.md](plan-chains.md) under Stacked Chain Base.

### Starting a review

`startReview` opens the review gate of a worker, or joins it. The gate is described in Review Gate. A review of a plan covers every target of the gate.

1. It checks the worker and the Chief that owns it. A second call for the same gate joins the first call.
2. It loads the gate, or opens it in one batch. It pins each target: the pull request head, else the branch head from `git ls-remote origin refs/heads/<branch>`. All targets of one pull request share one pinned head.
3. It checks the builder environment. The tree must be clean, and the pinned commit must contain the builder HEAD. A failed check refuses the call and names the target and the recovery. It never falls back to a mutable checkout.
4. It launches only the missing side. A reviewer launches when its gate id is null or failed or blocked. A tester launches under the same rule.
5. It reads the impact slices. They never refuse a review. Each success carries the changed paths and the docs history.
6. It writes `review-context.md` to the attempt folder, before the launch. It makes 3 attempts with 1 s then 2 s of backoff. The file content is the context plus a newline. An empty context writes no file.
7. It builds the brief and launches the reviewer in a fresh managed worktree on the pinned commit. The prompt names the absolute path that the write returned.
8. When all 3 attempts fail, it sends one Chief alert with the key `review-<report number>/<attempt id>/review-context:<worker id>`. The launch still happens, and the prompt carries the context inline under `## review-context.md`. When the alert fails, it logs the failure. The write never throws.

Reason: the reviewer cannot start before its context file exists, so the prompt needs no wait rule. A launched reviewer never has a prompt that names a context file that was not written. A builder environment can move, so the reviewer never runs in it.

### Branch review

`startBranchReview` reviews a branch or pull request that no managed worker owns.

- It refuses a branch that a live managed worker owns, and names that worker.
- It joins an existing open review of the same branch.
- It launches a reviewer on a managed worktree of the branch. It writes no context file.
- It accepts `acceptedGaps`. It renders the native-design check without the reshape sentences. It renders no `## Docs ownership`.

### Settings

`bb.settings.define` declares the settings. The code reads them when it uses them, for example `settings.get()` for `cascadeArchive` at spawn. `createReviewStart` receives its dependencies from `server.ts`.

### Finding limits

A reviewer's ready report carries `findings`. Each finding has `file` (1 to 300 characters), `message` (1 to 1000), `severity` (`blocking` or `nit`), an optional `line` (integer, 1 or more), and an optional `fix` (at most 1000). A report has at most 40 findings. `request_changes` needs at least one blocking finding. `approve` allows none. Reason: Chief routes on the verdict field.

## Engine Behaviour (this change)

### Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `reviewEngine` | `reviewer` | `reviewer`, `pr-agent`, or `both`. |
| `prAgentDir` | `/Volumes/VuHo_T5/Develop/personal/research/pr-agent` | The directory where `uv run pr-agent` runs. |

`reviewEngine()` trims each value. The mode is `pr-agent` or `both` only for that exact trimmed string. Any other value gives `reviewer`. An empty or non-string directory gives the default. `startReview` reads the settings once at review start. A rejected read gives `reviewer` and logs the error.

### Flow

1. `startReview` builds the brief as in the plain review.
2. In `reviewer` mode, the prompt and the files stay as in the plain review.
3. In another mode, the prompt is the plain prompt plus the engine section. The section lists every target once.
4. Before the launch, the code writes `review-context.md` to the attempt folder, as in Starting a review.
5. Before the launch, when some target is pinned, the code writes `pr-agent-review.sh` to the attempt folder. In `both` mode it also writes `review-helper.md` there. If the wrapper cannot be written, the prompt has no engine section and the reviewer does a direct review. If the helper prompt cannot be written, the section has no helper lines and no helper spawn command: the reviewer does the direct half itself, a direct review of every target (definitive pr-agent outcomes included) combined with the pr-agent outcomes, and the result line says `direct half: reviewer (helper prompt not written)`.
6. A write of either of these files follows the same 3 attempts. After 3 failures one Chief alert names the file. The alert key is `review-<report number>/<attempt id>/<file name without extension>:<worker id>`, for example `review-3/1a2b3c4d/pr-agent-review:<worker id>`. The text says the reviewer falls back to a direct review. The launch stays.
7. The reviewer runs the wrapper once for each distinct `<url> <sha>` pair. It then gives each target one outcome.
8. The reviewer sends one `chief_report`.

### Outcomes

| Outcome | When | `pr-agent` mode | `both` mode |
| --- | --- | --- | --- |
| definitive | The wrapper exits 0 with `changes_required` or `no_concerns_found`. | The reviewer uses the findings as given, without re-reading the code. | Same. |
| needs_review | The wrapper exits 0 with `needs_review`. | Direct review of the target, starting from the findings. | The findings stay nits. The helper covers the target. |
| failure | The wrapper exits non-zero, a tool error or tool timeout occurs, or stdout is not exactly one JSON line. | Direct review of the target. | Only the direct half covers the target. |
| not pinned | The target has no pinned head. | Direct review. | Direct half only. |

The reviewer names the reason of each fallback in its result. The result starts with `Engine: <mode>`.

### Section rules

- The section adds to the plain prompt. Every rule above it holds unless the section names an exception. It has no exclusive list of allowed commands.
- The ban on builds, linters, typecheckers, and tests holds. Direct-review reads (`git fetch`, `git checkout`, `git diff`, `gh pr view`, `glab mr view`) stay allowed.
- With no pinned target, the section holds only the heading and a direct-review line. The line says `no pinned pull request head`. It names no wrapper and no helper.
- A mixed review lists each unpinned target as direct.
- The wrapper call uses a tool timeout of 570000 ms. A missing wrapper file gets one retry after 10 seconds. Then the outcome is failure `wrapper missing`.
- The reviewer aggregates once. It merges two findings only when target, file, line, and problem match. It never merges across targets. A plan review prefixes each message with `[<branch>] `.
- Over 40 findings: keep every blocking finding and fill with nits. When blocking findings alone exceed 40, fold the blocking findings of one target and file into one finding that names the lines. The reviewer never drops a blocking finding.

### Wrapper

The wrapper is a bash 3.2 script. Usage: `bash pr-agent-review.sh <pr_url> <pinned_sha>`. The output file `pr-agent-<first 12 of sha>.json` stays next to the script as evidence. The script removes a stale output file before the run.

1. Validate the arguments, the directory, `uv`, `gh`, and the host `github.com`.
2. Compare the pull request head with the pinned sha. Mismatch or `gh` failure ends the script, and pr-agent does not run.
3. Run `uv run pr-agent --pr_url <url> --json-output <path> review` in the directory, with the five environment variables below.
4. Compare the head again. Mismatch or `gh` failure ends the script, even when pr-agent succeeded.
5. Translate the output file and print one JSON line.

| Exit | Meaning |
| --- | --- |
| 0 | One JSON line on stdout. |
| 2 | Usage, missing directory, missing `uv` or `gh`, or a host that is not GitHub. |
| 3 | The head moved or cannot be read. |
| 4 | A step ran out of time. |
| 5 | pr-agent exited non-zero. |
| 6 | The output is invalid: missing, empty, malformed, stale, a recommendation outside the three values, an issue without a file, or `changes_required` with no issue. |

Every failure prints one line `pr-agent-review: <step>: <reason>` on stderr. Stdout stays empty.

Translation table:

| pr-agent `merge_recommendation` | Verdict | Finding severity |
| --- | --- | --- |
| `changes_required` | `request_changes` | blocking |
| `no_concerns_found` | `approve` | nit |
| `needs_review` | `approve` | nit |

A finding has `file` (the trimmed `relevant_file`, at most 300), `message` (`<issue_header>: <issue_content>`, at most 900), and `line` (`start_line` when it is an integer of 1 or more, else absent). It has no `fix`. The JSON line also holds `prUrl`, `sha`, `recommendation`, and `filesNotReviewed`.

### Helper (`both` mode)

The helper is a plain child thread. It has no managed role.

1. The reviewer checks that `review-helper.md` exists. It waits 10 seconds once, then treats a missing file as a failed direct half. This wait does not apply to `review-context.md`.
2. The reviewer spawns the helper with `--lifecycle-owner-thread` set to its own thread and `--parent-notifications off`.
3. The helper reviews every target in the shared checkout. It ends with a fenced `json` block: `verdict`, `findings`, `result`, and optional `regression`. It calls no `chief_*` tool.
4. The reviewer waits for the helper after the wrapper runs. The wait is 540 s and runs at most twice.
5. A helper that is not idle or failed gets `bb thread stop`. The reviewer confirms the stop with `bb thread show`.
6. The reviewer reads the last `json` block. A block that breaks the verdict or finding rules, or a `{"blocked": …}` block, fails the direct half.
7. A failed direct half means the reviewer reviews every target itself, after the stop is confirmed.
8. After `chief_report` is accepted, the reviewer archives the helper. A failed archive appears in its final message.

`review-helper.md` holds a header, the plain prompt byte for byte, and the context under `## review-context.md`. The header replaces the instruction to read `review-context.md` and the `chief_report` and blocked rules. It never mentions a missing-file rule. It never holds the engine section. When the plain prompt already carries the context inline, the file does not hold the context a second time.

## Review Gate

The review gate is the one review of a plan. It gives one verdict and one test result for every target of the plan. For unplanned work, the gate covers one task. The gate holds one reviewer and one tester. Both run in parallel. Reason: one gate gives one answer for each plan, and no review waits on a stale checkout.

### Gate identity

- A gate has the key `plan:<planner id>`, or `task:<first id of the task chain>` for unplanned work. Reason: the key names the owner of the gate without a wave.
- A gate row stores its targets: thread id, report number, branch, pull request URL and pinned head. It also stores the ids of its reviewer, tester, and fix rows.
- The targets pin once, when the gate opens. Reason: a later change of the worker must not move the reviewed commit.
- Gate rows have no plan wave. Wave scheduling ignores them. Reason: a gate reviewer or tester is not an implementation wave.

### Opening and refusals

- `chief_review (workerThreadId: W)` opens the gate, or joins it. A call with both sides live names them and starts nothing. Reason: a retry must not start a second reviewer or tester.
- The call refuses while the readiness rules of the plan refuse the wave. Those rules cover design waves, pending Spec Writers and restacks.
- The call refuses when the builder tree is dirty. It also refuses when the pinned commit does not contain the builder HEAD. Reason: the review must see the code that the builder has, and the Spec Writer fold may be ahead of it.
- A refusal names the target and the recovery. The recovery is `chief_continue` of the worker to commit and push, or `chief_forge_init`. Reason: a refusal must say what Chief does next.

### Reviewer and tester

- The reviewer always runs in a fresh managed worktree on the pinned commit of each target. It never runs in a builder environment and never reuses an earlier reviewer. Reason: a builder tree can move, and a reused tree can hold stale code.
- The reviewer does not check a re-review range. Each review covers the whole pinned change. Reason: one pinned head has one scope, and a stored range can drift from it.
- The tester runs in its own fresh managed worktree on the first target branch. It has no `replaces:` and it supersedes no row. Reason: the tester must not take over the checkout of a builder.
- The tester writes tests on each target branch and pushes them without force. Reason: the tests belong to the branch that they test.
- The tester reports `testsPassed`. Its report is refused when the value is missing. Reason: the decision reads this value, and a missing value must not count as a pass.

### Delegation while the gate is open

- A gate target cannot be replaced with `replaces:` while the gate is open, except by the gate's fix run. The refusal names the gate fix worker. Reason: fixes go through the gate, so a second row must not take over the pinned target.
- `chief_delegate` refuses `kind: tester` while the gate is open, unless the call has `evidenceOnly: true` or it is the corrector. Reason: the gate already starts its tester.

### Completion

- `chief_complete` on a gate target succeeds only when `gateDecision` returns `pass`. Reason: an approve on a stale head is not evidence for the current head.
- An approve does not complete a target alone. Reason: the approve must come from this gate, and the tests must pass.
- A pass stamps `cleanup_approved_at` on the target and on the gate actors. Reason: cleanup needs proof of a pass.
- `skipReview` completes a row without the gate. It never stamps `cleanup_approved_at`. Reason: a skipped review is not a pass.
- `override` completes a row without the gate. It never stamps `cleanup_approved_at`. The note reads `Completed without the review gate: <reason>`. Reason: an override is Chief's decision, not a review result.

### Gate decision

`gateDecision` reads the gate row, its rows, and the newest reviewer verdict with its findings. It returns the first state that matches. A finding is a docs finding when its file starts with `docs/`. Other findings are code findings.

| Order | Condition | Decision | Next action |
| --- | --- | --- | --- |
| 1 | No gate exists. | `start` | `chief_review (workerThreadId: W)`, when the readiness rules pass. Otherwise the existing block. |
| 2 | The reviewer or tester is missing, failed or blocked. | `restart` | `chief_review (workerThreadId: W)` again starts only that side. A blocked tester names its environment blocker. |
| 3 | The reviewer, tester, fix run or corrector is busy. | `wait` | Names the busy side. |
| 4 | No fix run exists, both sides reported, and the tester has `testsPassed` false, or a code finding exists. | `fix` | `chief_delegate (replaces: <gate tester>, kind: worker)`, once. |
| 5 | Docs findings exist, and no Spec Writer repair was created after the verdict and is ready. | `docsRepair` | `chief_delegate (replaces: <that branch's latest side-lane Spec Writer>, kind: spec-writer)`. When no such writer exists, `escalate`. |
| 6 | A fix run is blocked on a wrong test, and no corrector exists. | `wrongTest` | `chief_delegate (replaces: <fix run>, kind: tester)`, once. |
| 7 | The corrector is red or blocked, or the fix run is blocked on a wrong test after a corrector exists. | `escalate` | Names the test and the owner. |
| 8 | Otherwise. | `pass` | Completion is allowed. |

Rules:

- A target whose current report number differs from its pinned number gives `escalate`. The text names the target and says that it changed after the gate pinned it. Reason: the verdict no longer covers the target.
- A docs finding routes only to a Spec Writer repair or to escalation. Reason: only a Spec Writer changes docs.
- A `docsRepair` is refused while the fix run or the corrector is busy. Reason: one writable owner holds the gate at a time.
- A `pass` needs `testsPassed` true on the tester, or on the fix run when one exists, and every docs finding settled. An approve, or a `request_changes` whose only blocking findings are docs, can pass when those docs are settled. Reason: the decision reads the test result and the docs state together.
- A ready fix run with `testsPassed` true settles the tester result and the code findings of the gate. Reason: the fix run ran the tests on the fixed code, so the old findings no longer decide.
- A fix run that fails gives `chief_continue` of that run, or `escalate`. Reason: a failed run keeps its evidence, and a fresh row would lose it.

### Fix Run and Corrector

A `fix` decision admits one fix run. A blocked fix run with wrong-test evidence admits one corrector. No other repair route exists.

- The fix run is a fresh `kind: worker` that replaces the gate tester. `chief_delegate` admits it only when `gateDecision` is `fix`, and only once. The admission requires the explicit `kind`, and `replaces:` without `kind` is refused. Reason: the kind decides the lane, and an implicit kind can start the wrong row.
- The fix run reuses the gate tester's environment, branch and pull request. Reason: the fix commit goes on the same branch as the tests.
- A second fix run is refused. Its text reads: `The gate already had its fix run (F): escalate to the user.`
- The fix run brief names the gate's reviewer verdict file and findings, even when the reviewer row is complete. It also names the tester report and its `## Failing tests`. Reason: the fix run needs the same evidence as the gate.
- The fix run never writes, edits, skips or deletes a test, fixture or test config. It never changes `docs/`. Reason: only the tester writes tests, and only a Spec Writer changes docs.
- The fix run reports ready only with `testsPassed` true. Reason: the decision reads this value, and a missing value must not count as a pass.
- The fix run reports blocked only with wrong-test evidence: the test file and line, the plan or docs text that it contradicts, and the command output. Reason: product code is fixed in the run, and only a wrong test leaves the run.
- A blocked fix run admits one corrector: `chief_delegate (replaces: <fix run>, kind: tester)`. The corrector runs when the fix run is blocked on a wrong test and no corrector exists. It fixes only the named tests, then reruns the gate's failing commands. It reports `testsPassed`.
- The corrector's `testsPassed` true gives `pass`. A red or blocked corrector gives `escalate`. A second fix worker is never admitted. Reason: the goal allows one fix run and at most one corrector.

### Chat Fix

A change that the owner asks for after completion gets a chat fix. It gets no review.

- A chat fix is a fresh `kind: worker` that replaces a completed gate target or a completed fix run. It is admitted only while that row's pull request is not merged.
- The chat fix runs with `fix_run='chat'`. It reuses that row's environment, and its brief tells it to fetch and fast-forward to the origin branch before it edits.
- The chat fix gets no old findings. Its mission is the chat request.
- The chat fix completes on its own green run: `ready`, `testsPassed` true, and a passing `docsGate`. It stamps `cleanup_approved_at` when cleanup is active.
- The chat fix is refused once the pull request is merged and cleaned up. Reason: cleanup deletes the branch that the fix needs.

## Contracts and Invariants

| Contract | Reason |
| --- | --- |
| `reviewer` mode produces the same prompt, files, and alerts as the plain review. An invalid setting value gives `reviewer`. | The engine changes no behaviour without opt-in. |
| `startBranchReview` ignores the engine. | The engine binds to a pinned head of a managed worker. |
| Every target gets exactly one outcome. | One report covers every target of a plan. |
| A definitive outcome is translated without re-verification. | See the decision note. |
| The verdict is `request_changes` if and only if a retained finding is blocking. | `checkReport` refuses any other report. |
| The reviewer never drops a blocking finding to fit the cap, and never merges findings across targets. | Each branch owns its findings. |
| Every pr-agent call carries `CONFIG__PUBLISH_OUTPUT=false`, `CONFIG__PROPAGATE_TOOL_ERRORS=true`, `PR_REVIEWER__REQUIRE_MERGE_RECOMMENDATION=true`, `CONFIG__USE_REPO_SETTINGS_FILE=false`, and `CONFIG__USE_GLOBAL_SETTINGS_FILE=false`. | pr-agent never posts to the pull request. The last two variables stop the reviewed repository or organization from enabling posting. |
| A moved or unreadable head never gives exit 0. | The verdict binds to the pinned commit. |
| Every wrapper step has a time limit. The script returns within 540 s plus 5 s of kill grace. It kills the process group of a step that runs out of time. | The reviewer stays inside its 570 s tool timeout. |
| The wrapper never uses a GitLab host. | Only the `gh` head check exists. |
| In `both` mode the reviewer does not change the shared checkout while the helper can run. It stops the helper and confirms the stop first. | One checkout serves two agents. |
| An unconfirmable stop is the only blocked path of the engine section. The report names the helper id. | The reviewer cannot use the checkout safely. |
| The reviewer archives the helper only after `chief_report` is accepted. A cleanup failure never undoes the report. | Required result comes before optional cleanup. |
| A failed write of a new file never throws and never undoes the launch. | The reviewer falls back to a direct review or to the inline context. |
| The code reads the forge head one time for each distinct pull request in a review start. | All targets of one pull request must share one pinned commit. |
| `review-context.md` is written before the launch. | A launched reviewer never names a file that does not exist. |
| `changed` equals the set of `git diff --name-only -z --no-renames <merge-base> <sha>`. A failed lookup gives `null`, never `[]`. | The conditional blocks need a complete path list, binary and mode-only paths included. |
| `docsHistory` is true when some non-merge commit in `<merge-base>..<sha>` touches docs/, a reverted change included. A failed lookup gives `null`, never `false`. | The ownership rule is per commit. |
| Unknown paths or unknown docs history keep `## Docs ownership`. | A failed lookup never removes a rule. |
| The engine changes no ledger, verdict storage, approve gate, or lesson rule. The engine appears only in the result text. | The engine is a way to form a verdict, not a new owner. |
| One writable owner holds a gate at a time: the gate tester, then the fix run, then the corrector. A docs repair runs only while none of them is busy. | Two writers on one checkout can overwrite each other's commits. |

## Related Decisions

- [Translate pr-agent output without re-verification](../decisions/2026-11-06-pr-agent-no-reverify.md)
