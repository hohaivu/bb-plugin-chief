# Chief for BB

Chief supervises work in BB without introducing another task-management application. A project can have multiple independent Chief supervisors, each with its own workers and reviewers as ordinary **visible BB threads** filed in one native sidebar section named **Chief**. Opening any of them uses BB's normal thread chat.

## Install

```sh
bb plugin install git:https://github.com/divyesh-puri/bb-plugin-chief.git@semver:^0.1.0
```

## Workflow

1. Open BB's project-aware **New Thread** screen and click **Start Chief**. Each click creates and opens a fresh independent Chief for that project; the CLI remains available for automation.
2. Talk to `Chief · <project name>` in the normal thread UI.
3. Chief owns the forge: before delegating it opens a tracking issue, creates the task branch `feature/<slug>` with an empty starting commit, and opens a draft pull request from that branch into the base. Every forge step is best-effort — a missing or unauthenticated CLI, or a repository with issues disabled, is skipped and reported, never a reason to hold up the work.
4. Chief delegates clearly titled work to a worker whose managed worktree is based on that task branch. The worker commits and pushes there and never touches the pull request; Chief marks it ready for review once the work is verified and reviewed.
5. Workers report `ready` evidence or a `blocked` state with a blocker and recommendation. Only Chief can mark work `complete`.
6. Lifecycle events alert the correct project Chief when a managed thread becomes idle, fails, is archived/deleted, or appears stalled. Alerts use a durable SQLite outbox and retry after transient delivery failures.
7. A worker that reported `ready` is reviewed automatically: as soon as it goes idle the plugin starts one read-only reviewer in its worktree and tells Chief to wait for that verdict. The reviewer reads the same brief the worker was given, and reports a structured `verdict` of `approve` or `request_changes` rather than a ship-or-fix opinion buried in prose. Reviewers never edit; a repair goes back to the worker. Chief can start further reviews itself with `chief_review`.
8. Chief inspects live status and bounded output, continues safe reversible work, marks verified non-running work complete, and escalates only genuine decisions.

The plugin never treats a generic SDK error as proof that a thread was deleted. Reconciliation uses live `deletedAt`/`archivedAt`, restores visible Chief-section filing, repairs missed status transitions, and retries transient reads, updates, and alerts.

## Project rules

Put `chief.md` at the project root. Chief reads it through BB's project file API and periodically refreshes its cache. Missing, empty, or unreadable files use conservative built-in rules.

## Configuration

```sh
bb plugin config chief set chiefProject proj_...
bb plugin config chief set stallMinutes 30
```

`chiefProject` is the default used outside an existing project context — including the **Start Chief**
button on the root New thread screen, which bb gives no project of its own. It does not limit Chief to
one project.

### Models

Settings → **Chief models by machine** scans every enrolled machine for its signed-in providers
and their live model catalogs, and lets you pick a provider, model, and reasoning level per role:
Chief, junior worker, senior worker, and reviewer. A role without a selection spawns on BB's own
default for the project, and a selection the machine can no longer serve (signed out, model
retired) falls back to that default rather than failing the spawn.

Every delegation picks a worker tier — junior or senior — and each tier can run on its own model.
Junior fits trivial, mechanical, or already-specified bounded work; senior covers everything else.
See [`skills/chief/SKILL.md`](skills/chief/SKILL.md) for how Chief chooses.

### Git workflow

`chief_delegate` takes three optional forge fields alongside the brief: `branch` bases the worker's
managed worktree on that branch instead of the project default, and `issueUrl` and `prUrl` are
recorded with the thread and shown in `chief_roster` and `chief_inspect`. The plugin never runs
`git`, `gh`, or `glab` itself — the BB plugin SDK exposes no shell — so Chief runs those commands
from its own thread and passes the results in. Both GitHub (`gh`) and GitLab (`glab`) are covered;
the exact procedure, including what to skip when a forge step fails, is the **Git workflow** section
of [`skills/chief/SKILL.md`](skills/chief/SKILL.md).

### Jev review scoring

Reviewers can score a change on 19 engineering-quality dimensions — correctness, coupling,
changeability, security, and so on — through the `chief_score` tool. The reviewer picks the base
branch to compare against (the open PR's base, else main/master) and Chief diffs the whole
worktree against it, uncommitted work included. Scoring the same worker against the same base
twice reports which dimensions improved and which regressed.

Settings → **Jev review scoring**. Enter an AI Gateway API key, press **Check connection**, then
turn the toggle on. The toggle stays off until a check succeeds for the exact key and model in
force; changing either one, or a failed check, closes the gate again. This is enforced on the
server, so setting `jevEnabled` through the CLI cannot skip the check.

The score is evidence for the reviewer to confirm or reject against the code it read — never a
completion gate.

## CLI

```sh
bb chief status [--project proj_...] [--json]
bb chief start [--project proj_...] [--json]
bb chief create [--project proj_...] [--json]
bb chief adopt --thread thr_... [--json]
bb chief delegate --title "Fix checkout totals" --mission "..." --criteria "..." [--tier junior|senior] [--branch feature/...] [--issue-url ...] [--pr-url ...] [--json]
bb chief inspect thr_...
bb chief continue thr_... --instruction "..." [--json]
bb chief review thr_worker [--focus "..."] [--json]
bb chief complete thr_... [--result "..."] [--json]
```

Agent tools expose the lifecycle: `chief_delegate`, project-scoped `chief_roster`, `chief_inspect`, `chief_continue`, `chief_review`, `chief_complete`, and worker/reviewer `chief_report`.

## Build and verify

```sh
npm install
bb plugin types --check
npx tsc --noEmit
npm test
bb plugin build
```

The plugin adds a project-aware **Start Chief** launcher to BB's New Thread screen and a compact Crown + Chief badge to Chief thread headers. It has no standalone Chief workspace, custom sidebar replacement, or task-management UI.
