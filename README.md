# Chief for BB

Chief supervises work in BB without introducing another task-management application. A project can have multiple independent Chief supervisors, each with its own workers and reviewers as ordinary **visible BB threads** filed in one native sidebar section named **Chief**. Opening any of them uses BB's normal thread chat.

## Install

```sh
bb plugin install git:https://github.com/divyesh-puri/bb-plugin-chief.git@semver:^0.1.0
```

## Workflow

1. Open BB's project-aware **New Thread** screen and click **Start Chief**. Each click creates and opens a fresh independent Chief for that project; the CLI remains available for automation.
2. Talk to `Chief · <project name>` in the normal thread UI.
3. Chief delegates clearly titled work to a worker in its own managed worktree.
4. Workers report `ready` evidence or a `blocked` state with a blocker and recommendation. Only Chief can mark work `complete`.
5. Lifecycle events alert the correct project Chief when a managed thread becomes idle, fails, is archived/deleted, or appears stalled. Alerts use a durable SQLite outbox and retry after transient delivery failures.
6. Chief inspects live status and bounded output, continues safe reversible work, starts one read-only review after a worker is idle, marks verified non-running work complete, and escalates only genuine decisions.

The plugin never treats a generic SDK error as proof that a thread was deleted. Reconciliation uses live `deletedAt`/`archivedAt`, restores visible Chief-section filing, repairs missed status transitions, and retries transient reads, updates, and alerts.

## Project rules

Put `chief.md` at the project root. Chief reads it through BB's project file API and periodically refreshes its cache. Missing, empty, or unreadable files use conservative built-in rules.

## Configuration

```sh
bb plugin config chief set chiefProject proj_...
bb plugin config chief set stallMinutes 30
```

`chiefProject` is the default used outside an existing project context; it does not limit Chief to one project.

### Models

Settings → **Chief models by machine** scans every enrolled machine for its signed-in providers
and their live model catalogs, and lets you pick a provider, model, and reasoning level per role:
Chief, worker, and reviewer. A role without a selection spawns on BB's own default for the
project, and a selection the machine can no longer serve (signed out, model retired) falls back
to that default rather than failing the spawn.

## CLI

```sh
bb chief status [--project proj_...] [--json]
bb chief start [--project proj_...] [--json]
bb chief create [--project proj_...] [--json]
bb chief adopt --thread thr_... [--json]
bb chief delegate --title "Fix checkout totals" --mission "..." --criteria "..." [--json]
bb chief inspect thr_...
bb chief continue thr_... --instruction "..." [--allow-edits] [--json]
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
