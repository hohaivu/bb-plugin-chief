# Chief for BB

Chief supervises work in BB without introducing another task-management application. A project can have multiple independent Chief supervisors, each with its own workers and reviewers as ordinary **visible BB threads** filed in one native sidebar section named **Chief**. Opening any of them uses BB's normal thread chat.

## Install

```sh
bb plugin install git:https://github.com/divyesh-puri/bb-plugin-chief.git@semver:^0.1.0
```

## Workflow

1. Open BB's project-aware **New Thread** screen and click **Start Chief**. Each click creates and opens a fresh independent Chief for that project; the CLI remains available for automation.
2. Talk to `Chief · <project name>` in the normal thread UI.
3. Planning is on by default: Chief plans first, then forges, then delegates wave 1. For planned work, Chief sends it to a read-only planner first, which splits it into waves; the plugin persists the schedule and its ready alert names the exact next delegation, so Chief relays it without reading any plan file. `chief_delegate` refuses an unplanned call unless it carries `unplannedReason`.
4. Chief owns the forge: `chief_forge_init` returns one ready-to-run script that opens a tracking issue, creates the task branch `feature/<slug>` with an empty starting commit without moving Chief's checkout, and opens a draft pull request from that branch into the base. Chief runs the script and reads the `CHIEF_FORGE branch=… issue_url=… pr_url=…` line it prints. Every forge step is best-effort — a missing or unauthenticated CLI, or a repository with issues disabled, is skipped and reported, never a reason to hold up the work.
5. Chief delegates clearly titled work to a worker whose managed worktree is based on that task branch. The worker commits and pushes there and never touches the pull request; Chief marks it ready for review once the work is verified and reviewed.
6. Workers report `ready` evidence or a `blocked` state with a blocker and recommendation. Only Chief can mark work `complete`.
7. Lifecycle events alert the correct project Chief when a managed thread becomes idle, fails, is archived/deleted, or appears stalled — with its last output and the next steps; at twice `stallMinutes` the alert tells Chief to stop it with `chief_stop`. Alerts use a durable SQLite outbox and retry after transient delivery failures.
8. A worker that reports `ready` names its own next call: an intermediate wave tells Chief to delegate the next wave (`chief_delegate` with `replaces:`), with no review in between; the final wave, or any worker with no plan link, tells Chief to start the one review of the whole run with `chief_review`. The reviewer reads the worker's brief (a long mission or context is clipped), plus every wave's plan file on a multi-wave run, and reports a structured `verdict` of `approve` or `request_changes` rather than a ship-or-fix opinion buried in prose. Reviewers never edit; a repair goes to a fresh worker in the same worktree.
9. Chief inspects live status and bounded output, nudges threads that are still working (a finished worker's follow-up always goes to a fresh worker with `chief_delegate` `replaces:`), marks verified non-running work complete, and escalates only genuine decisions.

The plugin never treats a generic SDK error as proof that a thread was deleted. Reconciliation uses live `deletedAt`/`archivedAt`, restores visible Chief-section filing, repairs missed status transitions, and retries transient reads, updates, and alerts.

## Project rules

Put `chief.md` at the project root. Chief reads it through BB's project file API and periodically refreshes its cache. Missing, empty, or unreadable files use conservative built-in rules.

## Configuration

```sh
bb plugin config chief set chiefProject proj_...
bb plugin config chief set stallMinutes 30
bb plugin config chief set autoSpawn false
```

`chiefProject` is the default used outside an existing project context — including the **Start Chief**
button on the root New thread screen, which bb gives no project of its own. It does not limit Chief to
one project. `autoSpawn` (default `false`) controls whether Chief should automatically start upon BB launch or settings changes.
`stallMinutes` (default 30) sets the soft stall alert; twice that sends the stop alert.

### Models

Settings → **Chief models by machine** scans every enrolled machine for its signed-in providers
and their live model catalogs, and lets you pick a provider, model, and reasoning level per role:
Chief, planner, junior worker, senior worker, reviewer, and advisor. A role without a selection spawns on BB's own
default for the project, and a selection the machine can no longer serve (signed out, model
retired) falls back to that default rather than failing the spawn.

Every delegation picks a worker tier — junior or senior — and each tier can run on its own model.
Junior fits trivial, mechanical, or already-specified bounded work; senior covers everything else.
See [`skills/chief/SKILL.md`](skills/chief/SKILL.md) for how Chief chooses.

### Git workflow

`chief_delegate` takes three optional forge fields alongside the brief: `branch` bases the worker's
managed worktree on that branch instead of the project default, and `issueUrl` and `prUrl` are
recorded with the thread and shown in `chief_roster` and `chief_inspect`. The plugin never runs
`git`, `gh`, or `glab` itself — the BB plugin SDK exposes no shell — so `chief_forge_init` generates
the script, with every value substituted and quoted, and Chief runs it from its own thread. Both GitHub (`gh`) and GitLab (`glab`) are covered;
the surrounding policy, including what to skip when a forge step fails, is the **Git workflow** section
of [`skills/chief/SKILL.md`](skills/chief/SKILL.md).

### Planning

Settings → **Plan before delegating** (on by default). With it on, Chief gains `chief_plan`: it sends
one unit of work to a read-only planner that reads the project's own checkout on a plain prompt, with
no provider plan mode and no approval prompt, and splits the work into up to 8 sequential waves, each
a self-contained plan for one worker with its own tier. It submits those waves through `chief_report`'s
`plan` field, and the plugin saves each one to the thread's own storage as `plan-1.md … plan-N.md` (or
`plan.md` for the legacy string form) and persists the schedule.

The handoff is the plugin's, not Chief's: the planner's ready alert lists the wave schedule and the
exact next call, `chief_delegate (planThreadId: …, wave: 1)`, which takes the plan file and tier from
the schedule. Chief never opens or reads a plan file, and delegates wave 1 right away without waiting
for user sign-off. It escalates to you only for a genuine product or scope open question the planner
named. Nothing is implemented until it delegates, and no worktree is spent on a plan.

The toggle reaches Chief threads that are already running. Turn it off to delegate directly.

With planning on, `chief_delegate` refuses any call that is not tied to a plan wave (`planThreadId`
and `wave`). A `replaces:` handoff is exempt — the original delegation already passed the gate — and
inherits the prior worker's reason when it gave one. The one escape hatch is `unplannedReason`
(`--unplanned-reason` on the CLI): a short reason why, meant only for junior-sized, bounded work whose
shape and cause are already known. It is persisted and shown as `unplanned: <reason>` in `chief_roster`
and `bb chief status`, and `Unplanned: <reason>` in `chief_inspect`. With planning off, nothing changes.

### Advisor

When a reviewer and worker stop converging (two straight `request_changes` verdicts, or one that
reports a regression), Chief gains `chief_consult`: a read-only advisor that reads code and runs
commands to reproduce the problem, but never edits, commits, or pushes. With a worker it runs in
that worker's own worktree, briefed on the mission, the reviewer verdicts, and the branch; without
one it runs in the project's own checkout, like a plan. Its advice goes back to Chief, which decides
the next worker round or escalates.

### Work list

`chief_roster` opens with a **Pending** block: one line per managed thread that has a next
action, in the same wording its lifecycle alert already used, so the two never disagree. Chief
is instructed to call `chief_roster` at the start of every turn and again after any compaction,
so the Pending block — not memory — is what it works from.
The same block, for every active Chief, is in a thread's side panel under **Actions → Chief
pending**, and it updates live as managed threads change.

## CLI

```sh
bb chief status [--project proj_...] [--json]
bb chief start [--project proj_...] [--json]
bb chief create [--project proj_...] [--json]
bb chief adopt --thread thr_... [--json]
bb chief plan --title "Fix checkout totals" --mission "..." [--context "..."] [--json]
bb chief consult --title "Fix checkout totals" --mission "..." [--worker thr_...] [--context "..."] [--json]
bb chief delegate --title "Fix checkout totals" --mission "..." --criteria "..." --tier junior|senior [--branch feature/...] [--issue-url ...] [--pr-url ...] [--unplanned-reason "..."] [--json]
bb chief inspect thr_...
bb chief continue thr_... --instruction "..." [--json]
bb chief stop thr_... [--reason "..."] [--json]
bb chief review thr_worker [--focus "..."] [--json]
bb chief complete thr_... [--result "..."] [--json]
```

Agent tools expose the lifecycle: `chief_plan` (when planning is on), `chief_consult`, `chief_forge_init`, `chief_delegate`, project-scoped `chief_roster`, `chief_inspect`, `chief_continue`, `chief_stop`, `chief_review`, `chief_complete`, and worker/reviewer/advisor `chief_report`.

## Build and verify

```sh
npm install
bb plugin types --check
npx tsc --noEmit
npm test
bb plugin build
```

The plugin adds a project-aware **Start Chief** launcher to BB's New Thread screen and a compact Crown + Chief badge to Chief thread headers. It has no standalone Chief workspace, custom sidebar replacement, or task-management UI.
