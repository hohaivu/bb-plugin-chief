# Chief for BB

Chief supervises work in BB without introducing another task-management application. A project can have multiple independent Chief supervisors, each with its own workers and reviewers as ordinary **visible BB threads** filed in one native sidebar section named **Chief**. Opening any of them uses BB's normal thread chat.

## Install

```sh
bb plugin install git:https://github.com/divyesh-puri/bb-plugin-chief.git@semver:^0.1.0
```

## Workflow

1. Open BB's project-aware **New Thread** screen and click **Start Chief** (the projectless New Thread screen offers a project picker instead). Each click creates and opens a fresh independent Chief for that project; a **New Chief** button in every non-personal project's thread header does the same for that thread's project, never replacing the active Chief (existing Chiefs keep their children); the CLI remains available for automation.
2. Talk to `Chief · <project name>` in the normal thread UI.
3. Planning is on by default: Chief plans first, then forges, then delegates wave 1. For planned work, Chief sends it to a read-only planner first, which splits it into waves; the plugin persists the schedule and its ready alert names the exact next delegation, so Chief relays it without reading any plan file. `chief_delegate` refuses an unplanned call unless it carries `unplannedReason`: Chief's reason for skipping the plan.
4. Chief owns the forge: `chief_forge_init` builds one script that opens a tracking issue, creates the task branch `feature/<slug>` with an empty starting commit without moving Chief's checkout, and opens a draft pull request from that branch into the base. For a plan it runs once per plan chain (a head wave and every wave that builds on it), on the chain head only, and its pull request body lists every wave of the chain. The server runs it in the project checkout and hands Chief the `CHIEF_FORGE branch=… issue_url=… pr_url=…` values; when that cannot finish (no local checkout, no `gh`/`glab` on the server's PATH, an error), the tool returns the script and Chief runs it instead. Every forge step is best-effort — a missing or unauthenticated CLI, or a repository with issues disabled, is skipped and reported, never a reason to hold up the work.
5. Chief delegates clearly titled work to a worker whose managed worktree is based on that task branch. A plan chain has one task branch, one pull request and one implementation worktree (each Spec Writer adds a side worktree): each later wave of the chain is delegated with `replaces:` the chain's latest worker, which `chief_delegate` enforces (a later wave without it, a started chain delegated fresh again, `replaces:` across chains, or a different `prUrl` than the replaced worker's is refused); independent waves (`dependsOn: []`) start their own chain with their own branch, pull request and worktree. When the agent decides or implements how the UI looks — editing in a design tool (Paper, Figma, …), implementing a design-tool artboard in code, or building UI with no approved design or explicit visual spec — it passes `kind: "designer"`. A worker is only for UI whose look an approved design or an explicit spec already fixes. A Designer's brief adds design rules for its mode: load the tool's guide; verify with tool screenshots and call its finish call (design tool), or compare a golden/simulator PNG with the artboard (design in code). Its reviewer checks the screenshots against the artboard. The worker commits and pushes there (`git push origin HEAD:<branch>`) and never touches the pull request; `chief_complete` marks it ready for review once the work is verified and reviewed, or with `skipReview` when Chief judges a review unnecessary. A plan splits a task that mixes such UI with non-UI code into a design-only wave (a Designer draws; the owner approves the artboards) and an implementation wave run by a worker. Workers and designers never write or edit tests and run them only in a fix run: the review gate's tester (`chief-role-tester`) writes and runs the tests once, beside the reviewer. When a plan marks an implementation wave `spec: true` (with a `## Spec delta` heading), Chief delegates a `kind: "spec-writer"` worker (`chief-role-spec-writer`) in the same turn as the wave's worker. The Spec Writer runs in parallel with the worker, in its own side worktree. It changes only `docs/` (`docs/INDEX.md`, `docs/specs/`, `docs/decisions/`), in readable, ASD-STE100-flavored prose, and folds the commits onto the chain's branch with a fast-forward push (it never force-pushes). The worker builds from the plan and never changes `docs/`; pre-plan specs may be stale for the wave's domains. The review gate waits for every Spec Writer; its tester then derives tests from the folded docs and the plan contracts, and the reviewer judges code against the plan and the docs, scoping each Spec Writer by its fold range. A wrong spec goes to `kind: "spec-writer"`; a Spec delta that cannot be built goes to a fresh `chief_plan`. Unplanned work runs no Spec Writer unless Chief names `kind: "spec-writer"`. When the Spec delta creates a new spec file, the plan's `## Spec baseline` names the code it covers. That wave's Spec Writer documents the current behaviour of that code first (suspected bugs go to its report's Open questions, not the docs), and the reviewer and tester treat that baseline like the delta.
   **Forge comments.** Chief also writes a short record where people look: on the task's pull request (its tracking issue when it has none) it comments each review verdict, a blocked worker and the completed result, and `chief_escalate` posts a **Need you** request with an @mention of the owner (the `forgeOwnerHandle` setting, else the `gh`/`glab` login). A plan has one shared tracking issue; every chain's pull request tracks it, and the plan's issue URL is kept on the planner row. Comments go through a `forge_comments` outbox in the plugin database: queued before anything is posted, posted in the background (never on a tool call's path), retried on the supervisor tick up to 5 times, and each carries a hidden marker so a retry after a crash never posts twice. Text is stripped of local paths, thread ids, `bb` commands and live @mentions first. A failure never blocks the work: the local record is written regardless, a missing CLI is skipped quietly, and a comment that still fails after 5 tries alerts Chief once. Agents never read these comments; the worker brief and reviewer prompt say so.
6. Workers report `ready` evidence or a `blocked` state with a blocker and recommendation. Only Chief can mark work `complete`.
7. Lifecycle events alert the correct project Chief when a managed thread reports, hits a transient provider failure, or appears stalled — with its last output and the next steps (idle, archived and deleted threads only update the roster and send no alert); at twice `stallMinutes` the alert tells Chief to stop it with `chief_stop`. Alerts use a durable SQLite outbox and retry after transient delivery failures.
8. A worker that reports `ready` names its own next call: an intermediate wave tells Chief to delegate the next wave of its chain (`chief_delegate` with `replaces:` the worker, same worktree, branch and PR), with no review in between; once every wave is ready, the final waves name one `chief_review` for the whole plan, which opens its review gate (below), and a worker with no plan link names its own gate; each review-naming alert also offers `chief_complete` with `skipReview` (Chief's reason) when Chief judges a review unnecessary. The reviewer reads the worker's brief (a long mission or context is clipped), plus the plan files of its branch's waves, and reports a structured `verdict` of `approve` or `request_changes` rather than a ship-or-fix opinion buried in prose. Both the worker's ready alert and the reviewer brief list the shell commands BB recorded in the worker's event log with their exit codes (the reviewer brief lists them for any single-worker review; a plan review reads each worker's report; reviewers never run builds, lints or tests), failures first, passing ones included ("none recorded" when the provider logs none, a "could not read" line when the log read failed), so a claimed check can be told apart from one that ran. The alert keeps the verdict, next action, a budgeted blocker and recommendation, and these commands ahead of the result, which is clipped last; a report may carry a short `summary` (at most 800 characters) beside its full `result`. A result of at most 800 characters with nothing clipped is short: no file is written and the alert shows `Result:` inline. Otherwise the full report is written to `report-<seq>.md` in the shared artifact folder and a `Full report: <path>` line, never clipped, points to it (or says the file could not be written); the alert then shows the summary, or the clipped result when none was sent. The alert is built from required lines with hard budgets (header, state, the `Full report:` pointer, verdict, action, blocker, recommendation) before optional detail (planner wave paths, recorded commands, result or summary) fills what is left; anything cut from the alert, including a recorded command's full text or a planner's wave paths, is kept unabridged in the file, and a command cut to its alert excerpt counts as clipped. A reviewer's alert carries its summary (or a clipped preview) plus the path of `verdict-<seq>.md`, which holds its full text and is the `Full report:` pointer when anything is clipped; a reviewer with a verdict never gets a report file, even when the verdict write fails (the alert says so). `<seq>` is the thread's report number, so every report gets its own file and none is overwritten; each file is written to a temp name and moved into place, so a failed write leaves no partial file and every alert's path stays valid. `chief_roster` and `chief_inspect` show the last report's summary and its file path. Reviewers never edit; a repair goes to the gate's one fix run.
9. Chief inspects live status and bounded output, nudges threads that are still working (a finished worker's follow-up always goes to a fresh worker with `chief_delegate` `replaces:`), marks verified non-running work complete, and escalates only genuine decisions. Completing a worker also completes its reviewers and advisors, and its planner once the final wave is done. Completing work whose review gate passed (or an owner-approved design wave) queues a post-approval cleanup, described under "Archiving with Chief"; an override, a skipReview completion, and anything completed before this feature are never touched. Workers and reviewers may report `fails` (approaches they ruled out, with the reproducing basis); every `replaces:` successor gets the chain's newest 12 under "## Already ruled out" in its brief.

The plugin never treats a generic SDK error as proof that a thread was deleted. Reconciliation uses live `deletedAt`/`archivedAt`, restores visible Chief-section filing, repairs missed status transitions, and retries transient reads, updates, and alerts.

The pipeline as a sequence chart, with its roles and support tools, is in [docs/software-factory.md](docs/software-factory.md).

## Project rules

Put `chief.md` at the project root. Chief reads it through BB's project file API and periodically refreshes its cache. Missing, empty, or unreadable files use conservative built-in rules. Chief's core rules (`CHIEF_CORE_RULES` in server.ts) are always appended to Chief's rules, so `chief.md` cannot drop them.

Every managed thread loads the shared `chief-worker` skill (brief, scope, `chief_report`, the report contract reviewers check) plus its role's skill: `chief-role-worker` (workers; designers also get `chief-role-designer`, testers `chief-role-tester`, Spec Writers `chief-role-spec-writer`), `chief-role-reviewer`, or `chief-role-read-only` (planners and advisors); researchers get the core only.

On Claude Code, Chief and every managed thread keep Claude Code's tool search: deferred tools are listed by name and load on demand, which saves about 18k+ tokens per request. Each thread's instructions carry an exact `select:` preload line that loads its `chief_*` tools with one ToolSearch call. Chief contributes no provider env for any thread, so tool search stays on unless another plugin or the user's settings turn it off.

## Configuration

```sh
bb plugin config chief set chiefProject proj_...
bb plugin config chief set stallMinutes 15
bb plugin config chief set autoSpawn false
```

`chiefProject` is the default used outside an existing project context — including the project
preselected in the **Start Chief** picker on the root New thread screen, which bb gives no project of its own. It does not limit Chief to
one project. `autoSpawn` (default `false`) controls whether Chief should automatically start upon BB launch or settings changes.
`stallMinutes` (default 15) sets the soft stall alert; twice that sends the stop alert.
`heavySlots` (default 2, 1 to 8) caps how many builds and how many test runs Chief's workers and testers run at once on the computer, each; simulators and emulators always get one slot. The wrapper and its capacity file live in `<BB data dir>/chief/heavy/`; the next delegation applies a changed value.

`reviewEngine` (default `reviewer`; `pr-agent` or `both`, anything else means `reviewer`) chooses how a worker's reviewer forms its verdict, and `prAgentDir` (default `/Volumes/VuHo_T5/Develop/personal/research/pr-agent`) is the pr-agent checkout `uv run pr-agent` runs in. See "PR-bound review and completion".

### Archiving with Chief

`cascadeArchive` (default `true`) makes each Chief the BB lifecycle owner of the planners, workers, reviewers, and advisors it starts. Archiving a Chief then archives and stops them, and **deleting a Chief deletes them too, worktrees included**; unpushed commits are lost. Ownership is set when a thread starts and never changes: toggling the setting affects only threads started afterwards, and a replacement Chief does not inherit the children of the Chief it replaced — archiving or deleting the old Chief still takes them along.

**Post-approval cleanup.** `cleanupApproved` (default `true`) lets the supervisor tick clean up after a task Chief completed on a positive approval. A durable `cleanup_jobs` queue holds one job per approved thread (the worker, the workers it replaced, and the reviewers, advisors and planner that existed only for it), and each job runs three steps in order, each bounded to three attempts before one alert and a safe outcome:

1. **Archive** the thread, but only when bb's recursive archive cannot reach any other live thread. Pinned threads, threads still in use, and threads with live children, forks or dependents are kept; the latter wait up to 60 minutes and then alert. If the archive still touches another thread, an alert names it with the `bb thread unarchive` command.
2. **Delete the thread's own `bb/<slug>-thr_<id>` branch**, after bb has removed the worktree and only when a fresh fetch of `origin` shows it holds every commit. Unpushed or stale-proved commits, a checked-out branch, a remote-host checkout and any uncertainty keep the branch, with an alert.
3. **Clear the thread storage** through the storage-retention plugin five minutes after the archive. Storage that may hold Chief's artifacts (the BB data dir was unknown when they were written) is kept, with an alert.

Threads can share one worktree (a plan chain's implementation workers, or one reviewer worktree reused across review rounds; a Spec Writer has its own side worktree). Per shared worktree, one job (the first to see its environment removed) deletes the branch, one raises the teardown-trouble alert and one the teardown-stuck alert, recorded in `cleanup_environment_claims`; the other jobs end with `worktree shared: <action> handled by <owner>` and no alert. A job that finds the environment still in use claims nothing.

Chief never deletes environments or worktrees itself, and never touches another Chief's or project's threads. Turning the setting off pauses the queue; jobs resume when it is turned on again. Un-archiving a thread ends its job.

### Models

Settings → **Chief models by machine** scans every enrolled machine for its signed-in providers
and their live model catalogs, and lets you pick a provider, model, and reasoning level per role:
Chief, planner, worker, designer, tester, Spec Writer, reviewer, and advisor. A role without a selection spawns on BB's own
default for the project, and a selection the machine can no longer serve (signed out, model
retired) falls back to that default rather than failing the spawn. A Designer, Tester or Spec Writer without its own pick uses the Worker pick.

### Git workflow

`chief_delegate` takes three optional forge fields alongside the brief: `branch` bases the worker's
managed worktree on that branch instead of the project default, and `issueUrl` and `prUrl` are
recorded with the thread and shown in `chief_roster` and `chief_inspect`. `chief_forge_init` generates
the script, with every value substituted and quoted, and runs it on the BB server in the project
checkout; if that fails, it returns the script and Chief runs it from its own thread. Both GitHub (`gh`) and GitLab (`glab`) are covered;
the surrounding policy, including what to skip when a forge step fails, is the **Git workflow** section
of [`skills/chief/SKILL.md`](skills/chief/SKILL.md).

**Design waves are owner-approved only.** In a plan, UI whose look no approved design or spec fixes always gets its own design-only wave before the wave that builds it. `chief_review` refuses a worker on a plan wave marked `design: true`; Chief shows the user the artboards and records their words with `chief_owner_approval`. Without that record the next wave cannot be delegated and the design wave cannot be completed (`override` still bypasses completion). A new report or `chief_continue` on the designer clears the approval.

**Review gate.** A plan (or an unplanned task) gets one review gate once every wave and Spec Writer is ready. `chief_review` pins every target branch's head (the pull request head, else origin's branch tip) and starts one read-only reviewer and one tester in parallel, each in a fresh worktree; it is refused while a builder's checkout has uncommitted or unpushed work. A second call starts only a missing, failed or blocked side. The tester writes and runs the tests and reports `testsPassed`; the reviewer reads code only. The gate passes on the reviewer's approve, `testsPassed: true` and any docs findings repaired by a Spec Writer; `chief_complete` then completes each target and marks its pull request ready, best-effort.

**Fix run.** When the gate finds failing tests or blocking code findings, Chief delegates its one fix run: `chief_delegate (replaces: <gate tester>, kind: worker)`. It reuses the tester's worktree and its brief carries the gate's verdict file, findings and failing tests. It never edits tests or docs/, runs the tests until they pass, and reports ready only with `testsPassed: true`; that passes the gate. After a green fix run on a review that asked for changes, `chief_review` may start one advisory re-review on fresh pins that checks each previous finding. It never blocks a passing gate (pending, failed or with code findings), and no third reviewer starts. A second fix run is refused. A fix run blocked with wrong-test evidence admits one corrector tester (`replaces:` the fix run, `kind: tester`) that fixes only the named tests; a corrector that is not green escalates to the user. A docs repair waits while the fix run or corrector works.

**After completion.** The human owns the pull request. A change the user asks for in chat while it is unmerged is a chat fix run: `chief_delegate (replaces: <last completed row>, kind: worker)`. It reuses that row's worktree, gets no old findings and no review, and completes on its own green run (`testsPassed: true`) with a clean docs/ history. Once the pull request is merged and cleaned up, it is refused. Forge comments are records, never input.

**Review engine.** `reviewEngine` is read once when a worker review starts. `reviewer` (default) changes nothing. With `pr-agent`, the reviewer runs one wrapper script (`pr-agent-review.sh`, written to Chief's data folder for the reviewed worker before the reviewer starts) for each distinct pull request and pinned head: it checks the head before and after, runs `uv run pr-agent` in `prAgentDir` with publishing off (five environment variables on every call, repo and global settings files off, so nothing is posted to the pull request), and prints one translated JSON line, all within 540 s. Every covered target gets one outcome: a definitive result (`changes_required` or `no_concerns_found`) is used as given without re-reading the code; `needs_review`, any failure (the reason is named in the result) and a target with no pinned head get a normal direct review. One aggregated `chief_report` follows, and its result starts with `Engine: <mode>`. With `both`, a plain `Review helper` child thread does the direct review of every target in the reviewer's checkout while the reviewer runs pr-agent; the reviewer combines both halves, stops the helper before touching the checkout if it hangs, and archives it after its report is accepted. Branch reviews (`chief_review` of an unowned branch) always use `reviewer`.

### Planning

Settings → **Plan before delegating** (on by default). With it on, Chief gains `chief_plan`: it sends
one unit of work to a read-only planner that reads the project's own checkout on a plain prompt, with
no provider plan mode and no approval prompt, and splits the work into one wave (a string) or an array of 1 to 8 waves (at least one implementation wave; no test waves, since the gate's tester writes the tests; design-only waves count toward the eight-wave limit but not toward the advisor threshold), each
a self-contained plan for one worker. It submits those waves through `chief_report`'s
`plan` field, and the plugin saves each one to the shared artifact folder `<BB data dir>/chief/<projectId>/<threadId>/` (falling back to the thread's own storage when the data dir is unknown) as `plan-1.md … plan-N.md` (or
`plan.md` for the legacy string form) and persists the schedule. Reports and verdicts go to the same folder.

The handoff is the plugin's, not Chief's: the planner's ready alert lists the wave schedule and the
exact next call, `chief_delegate (planThreadId: …, wave: 1)`, which takes the plan file from
the schedule. Chief never opens or reads a plan file, and delegates wave 1 right away without waiting
for user sign-off. It escalates to you only for a genuine product or scope open question the planner
named. Nothing is implemented until it delegates.

A planner shares Chief's checkout only when the project default is the project checkout (Chief's environment path equals the project source path). Then Chief fast-forwards it first, like a researcher's. A planner in its own worktree is left alone, and when that cannot be told (a lookup failed) Chief starts it with a `could not tell whether the planner shares it` warning. Every planner report alert carries the `Read at <sha>` line.

**Plan review.** A plan delegates at once; the plugin never requires a review. When Chief chooses,
`chief_consult (planThreadId: …)` starts one read-only advisor review of the plan, and
`chief_forge_init` and `chief_delegate` refuse the plan only while that advisor runs. On `approve`,
Chief delegates the plan as it is. On `request_changes` or a blocked advisor, Chief runs
`chief_plan (revises: …)`: a fresh planner revises the plan with the advice attached, and the
revision is delegated with no second review. A stopped or failed advisor does not block: Chief may
start a fresh one or delegate the plan.

**Feature reshape.** For a big feature (new behaviour touching 3+ modules or 10+ files, never a bug fix or refactor) the planner adds a reshape wave after the chain's last feature wave. A fresh worker on the same branch applies the make-native skill: it reads the feature diff, redesigns it as if planned from day one, `git grep`s removed symbols, runs lint and build, and commits the reshape separately. It never touches tests; the gate's tester writes them against the reshaped design. Every review of feature work also checks the diff for make-native's smells (re-derived aliases, scattered `if (newKind)` branches, mirror components, duplicate flags, validation or download paths or systems, "nothing else changed" tests) and reports each as a finding: a nit, or an unmet contract when a reshape wave's contracts rule it out.

When a later wave needs only an earlier wave's interface (types, API, schema, CLI shape), the planner
writes that interface into both waves' `## Contracts to verify` and marks the later wave
`dependsOn: []`, so both run in parallel, each as its own chain with its own branch and pull request — only when (a) every independent wave builds and verifies from the default base without importing a declaration another wave adds (the interface already exists on the base, or each wave codes against a local stub the merge order resolves; the plan names which) and (b) each shared file or declaration has exactly one owning wave, named in the plan; otherwise keep it chained. `dependsOn` stays only for waves that need the earlier
implementation or branch.

A worker that cannot finish its wave commits what is done and reports `blocked` with the remaining
scope and a proposed split. Chief re-plans the remaining scope with `chief_plan`, delegates the new
plan's wave 1 with `replaces:` the blocked worker (same worktree and branch), chains the rest off it,
drops the old plan's undelegated waves, and completes the old planner. A re-plan wave delegated with
`replaces:` continues the prior branch, and a re-plan that qualifies for plan review gets it first; any re-plan wave left `dependsOn: []` and delegated without
`replaces:` starts a new branch from the default base, without the done work.

The toggle reaches Chief threads that are already running. Turn it off to delegate directly.

With planning on, `chief_delegate` refuses any call that is not tied to a plan wave (`planThreadId`
and `wave`). A `replaces:` handoff is exempt — the original delegation already passed the gate — and
inherits the prior worker's reason when it gave one. The one escape hatch is `unplannedReason`
(`--unplanned-reason` on the CLI): Chief's reason for skipping the plan, by its own judgment. It is persisted and shown as `unplanned: <reason>` in `chief_roster`
and `bb chief status`, and `Unplanned: <reason>` in `chief_inspect`. With planning off, nothing changes.

**Skips.** Chief alone decides, per task, whether to skip the planner (`unplannedReason`) or the review (`chief_complete` `skipReview`), or both, and states each reason. `chief_skip_specs` bypasses a `spec: true` wave's Spec Writer until one was delegated for the wave (`specsSkipped`). A side-lane Spec Writer (a plan's spec wave) completes like a worker, on a gate pass, `skipReview` or `override`. `chief_complete` completes an implementation-lane Spec Writer (unplanned or legacy) on no path, `override` and `skipReview` included. The reasons show in `chief_roster` / `bb chief status` (`unplanned:`, `review skipped:`), `chief_inspect` and the completion comment on the pull request or issue (`Planning skipped:`, `Review skipped:`). The server judges no task's complexity: `skipReview` is refused only for a non-worker, together with `override`, on a design wave, without a ready report, or while a gate actor of the task is running. A skipReview completion is never cleaned up. Chief never edits code; workers run lint/analyze, build and any verify command (the gate's tester and fix runs also run the tests) and report each with its exit status, and reviewers only read code.

**Shared plan log.** Workers delegated from the same planner get `chief_log`. One call appends up to 5
`FACT`/`FAIL` notes and returns the peer notes it has not seen yet (30 at most per call), then each wave's
current worker, state and last status line. A plan worker's `chief_report` fails are mirrored in as `FAIL`.
It is pull-only: it never alerts Chief or changes any thread's state, and no worker can claim another wave.

### Advisor

`chief_consult (planThreadId: …)` (`--plan-thread`) starts an optional read-only advisor for one
review of a plan before delegation, when Chief chooses (see **Plan review**). It reads code and runs the read-only commands its brief
allows, but never changes a tracked file, commits, or pushes. Its advice goes back to Chief.

### Researcher

`chief_research` is Chief-only. Its call takes `question` (and an optional `branch`) and returns at
once with the id of a **researcher** thread. The researcher is a normal managed thread: it works
read-only, decides whether to answer alone or to spawn up to 6 plain helper threads that share its
checkout, merges their answers, and reports through `chief_report`. The report arrives as a
lifecycle alert, so Chief ends its turn instead of polling. A report starts with `Helpers: <n>`
and has `## Confirmed` and `## Unconfirmed` sections; a failed or stopped helper is named, and the
result is marked partial.

`design: true` adds a design discussion: the researcher asks the user its open questions in its own
thread (AskUserQuestion, through Claude Code or bb's ask-user-question plugin) and reports a
`design.md` the user approved. `design: false` reports facts only, for evidence checks. With
planning on, Chief then calls `chief_plan` with `researchThreadId` (`bb chief plan
--research-thread thr_id`): Chief binds write-once snapshots of the design and the fact report, the
planner gets them as its brief, and `chief_forge_init` puts the full design in the pull request
body. There is no user review of the plan. While research is on, a plan without a design passes
`undesignedReason` (`--undesigned-reason "…"`).

Planners do not get `chief_research`; the chief-role-read-only skill tells them how to spawn their
own read-only helper threads. Reviewers, workers and advisors never get it. The server refuses a
call from any of them. Settings has one **Researcher** switch, on by default; while it is off,
Chief gets neither the tool nor the line about it. `researchChiefInstructions` in
src/runtime/host.ts owns when Chief uses research and what it does after a failed or partial
report (it does not rerun).

The researcher thread reuses Chief's own environment and permission mode, so it reads Chief's
checkout. If that checkout cannot be shared, the call fails with a clear error; it never falls back
to a fresh worktree. With `branch`, it runs in a fresh worktree on that branch instead. Helpers
share the researcher's environment. They are read-only only because the prompt tells them to be,
and the limit of 6 is in the prompt only. There is no run, mode, timeout or call cap: a researcher
is supervised like every other managed thread, by the stall alert and `chief_stop` /
`chief_continue`.

The researcher's model is the **Researcher** row in Settings → Chief models by machine, picked like
the Worker row. A researcher without a pick, or whose pick the machine can no longer serve, runs
on BB's default model for the project, and so do its helpers. The **Researcher** switch sits with
the other Chief switches in the plugin settings.

Before the researcher starts, Chief fast-forwards its checkout to `origin/<default branch>` (`git fetch` + `git merge --ff-only`). It skips this, appending one `Did not fast-forward…` line to the tool result and still starting the researcher, when a researcher or planner of this Chief is running, tracked files have uncommitted changes, the branch has local commits, git or a lookup fails or times out, or the checkout is on another host. Every researcher report alert says `Read at <sha>` (the commit it read) and, when the default branch has moved since, that the answer may be stale.

**Upgrade note.** Old researcher briefs tell the researcher to call `chief_research` with a mode
and runId; after the reload those calls are refused, and old workflow runs are not collected. Before
you merge and reload, ask Chief to do this once for each project that used research:

1. Find live research runs:
   `sqlite3 ~/.bb/chief/data.db "SELECT DISTINCT run_id FROM chief_research_calls WHERE run_id IS NOT NULL AND started_at > (strftime('%s','now')-7200)*1000"`.
   Match them against `bb workflows list --json` in that project. Never touch a run that is not in
   that list (retro runs are workflows too).
2. For each match, read `bb workflows status <run-id>`. If it is not terminal, wait for the
   researcher to report, or run `bb workflows stop <run-id>` and check `status` again. If the status
   cannot be read or the stop is not confirmed, stop the run from the Workflows view. This does not
   block the merge.
3. For each non-terminal researcher row in `chief_roster`: let it report, or `chief_stop` it. Never
   `chief_continue` an old researcher after the reload; ask again with a fresh `chief_research` call.
4. Planners mid-flight need nothing: their `chief_research` call is refused with a message that
   points at helper threads.

Your existing Investigate model pick is copied once to the Researcher row. A later clear of that row
is not copied again.

### Work list

`chief_roster` opens with a **Pending** block: one line per managed thread that has a next
action, in the same wording its lifecycle alert already used, so the two never disagree. Chief
is instructed to call `chief_roster` at the start of every turn and again after any compaction,
so the Pending block — not memory — is what it works from.
Chief's own todos — including queued work nobody has delegated yet — live in the Pending block as
`todo #N` lines: `chief_roster` with `todo: { text, after? }` adds one, `todo: { id, text?, after?, state? }`
changes or closes it (`done`/`dropped`); Chief is told to use them instead of Memory files, TodoWrite,
or Task tools. Each todo records the Chief thread that added it. Every Chief still sees the
project's open todos, but others' and legacy unowned ones show as one count line after its own;
`chief_roster includeOthers: true` lists them, tagged (`(Chief thr_…)`, `(ended Chief thr_…)`,
`(unowned)`) under an "Other Chiefs' todos" header. Editing one
owned by another live Chief works but starts with a warning. When a Chief is superseded (replacement,
orphan sweep, `bb chief adopt`) its todos move to the successor.
Open todos with an `after:` condition show in Pending as one count line; `chief_roster includeWaiting: true` lists them.

### Tracker

Chief can mirror its work to a task tracker. It is off by default.

- Settings: `tracker` (`none` or `bb-tasks`) selects the adapter. `trackerProjects` maps each Chief project to a tracker project, one `proj_abc=ABC` entry per line. A project with no entry is not mirrored.
- Mirrored: each new plan or undelegated worker becomes one task. Its planners and workers are attached to the task, and a replaced worker is detached after its successor is attached. Pull request links, the plan files and the reviewer verdict files are added. The task status follows the work: planning, working, review (a pull request is open), done (every pull request is merged, or there is none). `chief_escalate` posts one decision comment (`Decision #N`) and sets a `needs-decision` flag until the owner answers.
- Not mirrored: milestone, plan, verdict or completion comments, subtasks, work started before the tracker was on, and researcher or consult-only threads. Merge-only requests (`chief_escalate` with `merge: true`) post no decision.
- Answers: the plugin polls the task. One owner comment answers one decision (start it with `#N` when several are open) and reaches Chief once, as a lifecycle alert, through the plugin only. The tracker's own notify setting plays no part, and Chief never runs tracker commands.
- Switching `tracker` off deletes nothing and stops every tracker call. Switching it back on resumes pending work.

## Coordinator

Ask a Chief to run `/coordinator` to make it a Coordinator. The upgrade is one-way, and only a Chief that owns no open work can take it.

- A Coordinator supervises child Chiefs in any project. It runs no planner, worker, reviewer, tester, advisor or researcher, and `chief_plan`, `chief_delegate`, `chief_complete` and the other work tools refuse it.
- Attach existing Chiefs the owner names with `chief_attach`. Start new ones with `chief_spawn` and `projectId`. `chief_roster` shows a Children block with each child's state and pending items.
- It gets an alert each time a child calls `chief_escalate` (a Need you) and once when a child finishes all its work. The owner answers a Need you in the child's own thread or in the Coordinator's thread; the Coordinator relays an answer given there to the child verbatim, marked as the owner's decision.
- There is one level: a child cannot become a Coordinator, and a Coordinator cannot be attached or handed work.

## CLI

```sh
bb chief status [--project proj_...] [--json]   # Pending block includes open todos
bb chief stats [--project proj_...] [--chief thr_...] [--json]   # tasks, repair rounds, failures, wall time
bb chief start [--project proj_...] [--json]
bb chief create [--project proj_...] [--json]
bb chief adopt --thread thr_... [--json]
bb chief plan [--title "Fix checkout totals"] --mission "..." [--context "..."] [--revises thr_...] [--json]
bb chief consult [--title "Fix checkout totals"] --mission "..." --plan-thread thr_... [--context "..."] [--json]
bb chief delegate [--title "Fix checkout totals"] --mission "..." --criteria "..." [--branch feature/...] [--issue-url ...] [--pr-url ...] [--unplanned-reason "..."] [--kind worker|designer|tester|spec-writer] [--json]
bb chief inspect thr_...
bb chief continue thr_... --instruction "..." [--json]
bb chief stop thr_... [--reason "..."] [--json]
bb chief complete thr_... [--result "..."] [--json]
```

`bb chief review` is retired for every caller, because the CLI cannot prove who is calling. Only the active Chief starts reviews, through its `chief_review` tool; the review rule is in its core rules (`CHIEF_CORE_RULES` in server.ts).

Agent tools expose the lifecycle: `chief_plan` (when planning is on; `revises` for a reviewed plan), `chief_consult` (`planThreadId` for a plan's one review), `chief_spawn` (hands one task to a new Chief), `chief_forge_init`, `chief_delegate`, project-scoped `chief_roster` (with an optional `todo` field), `chief_inspect`, `chief_continue`, `chief_stop`, `chief_review`, `chief_complete`, `chief_owner_approval`, `chief_skip_specs`, `chief_escalate`, `chief_sync` (fast-forwards Chief's own checkout before it reads code), and worker/reviewer/advisor `chief_report`.

`chief_spawn` starts a second Chief for the project with the task's request and context as its first message, with no link back. It moves at most one of the caller's open todos, and a task moves only when none of the source Chief's unfinished workers holds it: `chief_stop` and a ready report do not release a worker, only `chief_complete` does.

## Build and verify

```sh
npm install
bb plugin types --check
npx tsc --noEmit
npm test
bb plugin build
```

The plugin adds a project-aware **Start Chief** launcher (with a project picker on the projectless screen) to BB's New Thread screen a role badge to managed thread headers (Crown + Chief on Chief threads, Crown + Researcher on researcher threads, and the role name — Planner, Worker, Designer, Tester, Spec Writer, Reviewer, Advisor — on other managed threads), and a **New Chief** button (Crown + plus) to every thread header outside the personal project that creates an additional, independent Chief for the thread's project without replacing the active one. It has no standalone Chief workspace, custom sidebar replacement, or task-management UI.
