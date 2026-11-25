# Work list

The work list is the one place where a Chief reads what is pending: the Pending block of `chief_roster`. This spec records the Chief to-do side panel that existed at base commit 310043a and its removal.

## Terms

| Term | Meaning |
| --- | --- |
| Pending block | The "Pending:" lines of `chief_roster`: threads with a next action, then open todos. |
| Missing-Report line | The Pending line for a managed row whose current turn ended idle without a `chief_report`. A worker row or the owner of a plan chain can get it. |
| Plan chain | An original planner, its plan advisors and its revisions. |
| Owner | The one row of a plan chain that renders the chain's Pending line. |
| Todo | A row of the `chief_todos` table. A Chief adds it with `chief_roster`'s `todo` parameter. |
| Active Chief | A Chief row whose state is not `complete`, `archived` or `deleted` (`isActiveChief`). |
| Sweep | The pass that completes absorbed supporting rows (`sweep`, `completeAbsorbed`). |
| `pendingReady` | A flag in `ctx.state` (`src/runtime/context.ts`), set in `server.ts`. The sweep starts on a store reload only after it is set. |

## Baseline (behaviour at base 310043a)

### Panel in `app.tsx` (`TodoEntry`, `ChiefPendingPanel`, the `pending` action)

- `app.slots.threadPanelAction` registers the action `pending`. Its title is "Chief to-do" and its icon is `Crown`.
- `ChiefPendingPanel` calls the `pending` RPC with the thread id. It shows a Refresh button and an error line.
- It shows "Not a Chief thread." when the RPC returns `chief: false`. It shows "Nothing tracked yet." when `items` is empty.
- It lists open items first. It puts done items in a collapsed "Done" section. The section names how many older items the server omitted.
- `TodoEntry` shows a read-only checkbox, the label, the id, the status and the next action. Done items have a strike-through.
- The panel loads on mount, on each realtime signal `pending`, and when the realtime connection returns to `connected`.
  Reason: a signal published while the socket was down is lost.

### RPC and signal in `server.ts`

- `rpcContract.pending` takes `{ threadId }`. It returns `{ chief, items, doneOmitted }`. Each item has `id`, `label`, `status`, `action` and `done` (`todoItemSchema`, `TodoItem`).
- The handler returns `chief: true` only for an active Chief. Other threads get `chief: false` and no items.
- `todoItems()` orders the items as follows:
  1. Open threads that have a next action.
  2. Open threads that have none, newest first.
  3. Open todos of this Chief, then open todos of other Chiefs and unowned todos.
  4. Done threads and closed todos of this Chief, by recency. `MAX_DONE_ITEMS` (50) caps this group. `doneOmitted` counts the rest.
- `pendingSnapshot()` collects `todoItems()` of every active Chief. `publishPending()` serializes it and compares it with `publishedPending`.
  It publishes the realtime channel `pending` only when the text changed. Reason: not stated in the code.
- `publishedPending` lives in memory. A plugin reload clears it, so one extra signal can follow.
- `publishPending()` runs in the store's `onReload` hook and after a sweep that completed at least one row.

### Tab pin (`pinPendingTab`, `spawnChief`)

- `spawnChief` calls `pinPendingTab(thread.id)` without awaiting it, after it inserts the Chief row.
- `pinPendingTab` reads the tabs of the thread with `bb.sdk.threads.tabs.get`.
  If a `plugin-panel` tab of this plugin with `actionId` `pending` exists, it does nothing.
  Otherwise it appends that tab with `tabs.update` and `expectedRevision`.
- The tab id must equal the id that the host builds, so that opening the action finds the tab.
- It tries at most two times. It logs a warning after the second failure and never throws.

### Sweep gate (`pendingReady`, `sweep`, `completeAbsorbed`)

- The plugin sets `pendingReady` after it registers the RPC handlers and before `reconcile()`.
  Reason (code comment): everything that `pendingSnapshot()` touches is initialised by then.
- The store's `onReload` hook returns at once while `pendingReady` is false. Afterwards it starts `sweep()`, then `publishPending()`.
- The `lifecycle` handler starts `sweep()` on `idle` and `failed` events when `pendingReady` is set.
  This runs before the early returns, because the blocker can be unmanaged, hidden or complete.
- `sweep()` is single-flight. A reload during a sweep queues exactly one more pass.
  `completeAbsorbed()` completes a row only after a fresh `threads.get` shows it live and not busy. A failed read leaves the row alone.

### Unchanged by this spec

- `chief_todos` stores the todos. `chief_roster` accepts `todo` and `includeWaiting`.
- `pendingLines`, `todoLines` and `clipPendingBlock` build the Pending block. `bb chief status` shows the same state.
- `handOver` moves `chief_todos` and undelivered alerts from the superseded Chief to its successor, in one `store.batch`.

## Target (after this change)

### Removed

- The **Chief to-do** thread panel action, the `ChiefPendingPanel` component and `TodoEntry`.
- The `pending` RPC, `todoItemSchema`, `TodoItem`, `todoItems()`, `pendingSnapshot()` and `MAX_DONE_ITEMS`.
- The realtime channel `pending`. `publishPending()` and `publishedPending` go away. No code publishes the channel.
- The tab pin on new Chiefs. `spawnChief` neither reads nor writes thread tabs.
- Reason: the owner decided it. The Pending block is the one work list, whether or not a tracker is on.

### Added: startup unpin

- When the plugin starts, `unpinPendingTab(threadId)` runs once for each active Chief. It runs where the plugin sets `pendingReady`.
- The plugin does not await it. It never delays the start.
- If the thread has a `plugin-panel` tab of this plugin with `actionId` `pending`, `unpinPendingTab` removes exactly that tab.
  It calls `tabs.update` with `expectedRevision`. The other tabs keep their order and content.
- If the thread has no such tab, `unpinPendingTab` does not call `tabs.update`.
- On a failure it tries one more time. After the second failure it logs a warning. It never throws.
- Reason: tabs that the plugin pinned before the removal would point to an action that no longer exists.

### Contracts that stay

| Contract | Reason |
| --- | --- |
| The Pending block, the `todo #N` lines and the `after:` collapse line of `chief_roster` equal base for the same state, except the Missing-Report lines and the plan-chain rules in `## Missing-Report line`. With `includeOthers: true`, the "Other Chiefs' todos" section equals base too. | The roster is now the only work list. |
| The JSON of `bb chief status` equals base for the same state. The text of `bb chief status` equals base for the same state, except the Missing-Report line. | The CLI reads the same state. The text output prints the Pending block (`pendingLines`). The JSON output does not. |
| `handOver` moves `chief_todos` and undelivered alerts as at base. | A successor must keep the open work. |
| A Coordinator's roster renders a Children block. Each child entry holds that child's own Pending block. See `coordinator.md`. | A Coordinator owns no managed thread. It reads the work of its children. |
| The Pending block of a plain Chief equals base for the same state. | The Coordinator change must not alter a plain Chief's work list. |
| A plan-chain row renders a Pending line only as `### Plan chains: one owner` states. Its other Pending output equals a219693. | One owner per plan chain gives one line per chain. Reason: four selectors read the chain with different rules. |
| `handOver` refuses to run when the previous or the next Chief is a Coordinator, and writes nothing. | A Coordinator never owns open work, todos or alerts of a superseded Chief. |
| The sweep still runs on a store reload once `pendingReady` is set, and on `idle` and `failed` events. | The sweep completes absorbed rows. It does not depend on the panel. |
| `pendingReady` stays, and gates the sweep only. | The sweep must not run before the plugin initialises its state. |

## Other Chiefs' todos collapse

A Chief reads its own work first. A fresh Chief spent about 3k tokens on the todos of other Chiefs in its first roster. The Pending block therefore shows them as one line.

- A foreign todo is a todo of another live Chief, of an ended Chief, or of no Chief.
- By default the Pending block shows the own todos as at base, with the own `after:` collapse line.
- If foreign todos exist, one line follows the own todos: `- N other-Chief todo(s) (#ids) hidden: not your work. chief_roster includeOthers: true lists them.`
- `N` counts every foreign todo. The id list holds every foreign id in ascending order. It includes waiting todos.
- The block has no second waiting line for foreign todos. It has no "Other Chiefs' todos" header and no `(Chief …)`, `(ended Chief …)` or `(unowned)` todo line.
- If no foreign todo exists, the line does not appear.
- `chief_roster` accepts `includeOthers`. With `includeOthers: true`, the Pending block equals the output before this change, with and without `includeWaiting: true`.
- Each Coordinator child block and the Coordinator's own block collapse the same way. `includeOthers: true` expands all of them.
- The existing caps stay: `clipPendingBlock` still clips the Pending block, and the roster total is still clipped.
- `bb chief status` lists every todo, as at base. Todo add, update and close, the cross-Chief edit warning and the `includeComplete` closed-todo lines do not change.

## Todo after reasons in the decisions file

A Chief's decisions file lists its own open todos that wait on an `after:` condition. See `decisions-file.md`.

- A todo change through `chief_roster` rebuilds the after-section of the caller's decisions file.
- The after-section lines use the Pending block's todo-line format: `- todo #N: text (after: …)`.
- The Pending block does not change. The after-section is a second output of the same todos.
- `handOver` also copies the predecessor's decisions file to the successor. The copied after-section is rebuilt from the successor's own todos on the copy's write.

## Missing-Report line

A managed row can end its turn while idle, without a `chief_report`. The Missing-Report line tells Chief that this happened. It appears in the Pending block of `chief_roster`, so Chief reads it on each roster read until the condition ends.

Two kinds of managed row can get the line:

- A worker row. Its kinds are `worker`, `designer` and `spec-writer`. Each kind can get the line.
- The owner row of a plan chain. See `### Plan chains: one owner`.

### Pending changes relative to base

Base for worker rows is commit 37d959d. Base for plan-chain rows is commit a219693. The contracts above that compare the Pending block with base exclude these changes.

- A worker row gets the line from `nextAction` when `turnMissingReport` is true. See Pending line below.
- A plan-chain row changes relative to a219693 in these eight ways:
  1. An advisor row never repeats the planner line. Only the chain owner renders a line.
  2. A blocked advisor's text moves to the planner's `chief_plan revises` line.
  3. An idle planner, advisor or revision without a Report gets the Missing-Report line, when it is the owner.
  4. A reactivated delivered epic revision shows its completion line when it is not busy: idle, failed or stopped.
  5. A busy delivered revision shows no line.
  6. A blocked revision with an idle original shows one line, on the revision row.
  7. An archived or deleted row is excluded, and the owner table applies to the rows that remain. See Rules.
  8. `chief_consult` refuses while an idle usable advisor has no advice. This is the same rule that Pending uses.
- The `noreport` alert and its retry check change. They are not Pending changes. See Alert below.
- `bb chief status` prints the line in its text output, because the text output prints the same Pending block. Its JSON output does not print it.

### One answer: `turnMissingReport`

`turnMissingReport` in `src/runtime/lifecycle.ts` answers whether the current turn of a managed row still lacks a Report. It returns true when all these conditions hold:

- The row is not a Chief.
- The row has a Chief (`chief_thread_id` is set).
- The row state is `idle`.
- The alert outbox has no `report:<active_cycle>:` key for the row.

A `chief_report` writes a `report:<active_cycle>:` key for a row with a Chief. The key covers `active` reports too. Delivered outbox rows stay, so the answer stays the same on each read. The Missing-Report line, the `noreport` alert and its retry check all use this answer.

### Pending line

- A worker row with `turnMissingReport` true gets a recovery line from `nextAction` (`src/runtime/nextAction.ts`), unless it is a gated row (see Precedence). A gated row gets only the gate route, including a replacement row that inherits its chain's gate. `pendingLines` (`src/runtime/roster.ts`) prints that line in the Pending block.
- The line tells Chief to inspect the thread, then continue it to ask for its `chief_report`, or decide itself.
- The line stays on each read until the row reports or starts a new turn. Reason: The alert notifies Chief once. The Pending block must show open work until the cause ends.
- A worker row with an earlier role-specific line shows that line, not the Missing-Report line. Reason: A role-specific line holds the recovery step for its own role.
- A row that reported shows no Missing-Report line. This covers `ready`, `blocked`, `complete` and an `active` report in the same cycle. Reason: An idle row that reported is not stuck.

### Precedence

`nextAction` checks the routes of a row in this order. The first route that applies wins.

A plan-chain row (a planner, a plan advisor or a revision) takes `planChainAction` first. It skips the steps below.

1. Earlier role-specific lines: a gate line, a chat fix run, a `blocked` row, and a researcher line.
2. The Missing-Report line, for a worker row when `turnMissingReport` is true.
3. The ready-state routes of the row.

An idle design wave whose latest report is `ready` skips step 2. It keeps the approved-design route in step 3. Reason: `chief_owner_approval` admits that report. The reply and the Pending line must name the same route.

A gated row is a worker or reviewer row that is not `complete` and that has one of these gates:

- A gate that names the row as a target or actor.
- The newest gate of the row's replacement chain (its `replaces_thread_id` links), when that gate has no `plan_thread_id` and at least one target is not `complete`. An unplanned Spec Writer that replaces a gate target is an example. Reason: the replacement continues the gated work.

The gate route takes precedence for every gated row. This holds even where the route emits no line. In Pending, only the gate's display target renders the gate line: the first target that is not `complete`. Reason: one line for each gate. Other gated rows, including replacement rows that inherit a gate, show no line and do not fall through to Missing-Report recovery (step 2). In an alert, every gated row renders the gate line, without the display-target filter.

### Plan chains: one owner

A plan chain has one original planner P. Its plan advisors are the rows whose `plan_thread_id` is P. Its revisions are the planners whose `replaces_thread_id` is P. A chain is one level deep. Chief cannot consult a revision, and cannot revise a revision.

`owner(row)` in `src/plan/planReview.ts` names one owner for each chain. Every row of a chain gets the same result. `planChainAction` in `src/runtime/nextAction.ts` renders the owner's line. Reason: four readers used different rules, and the advisor row repeated the planner line.

`owner`, `status`, `consultRefusal`, `revisionRefusal` and `reportRefusal` in `src/plan/planReview.ts` read the same attempts and delivered rule. Reason: one rule keeps the four readers in agreement.

#### Terms

| Term | Meaning |
| --- | --- |
| Usable row | A row whose state is not `archived` or `deleted`. |
| Advisor attempt | The oldest usable busy advisor with no advice, else the newest usable `idle` advisor with no advice. |
| Revision attempt | The newest usable revision that is `busy`, `idle` or `blocked` and does not deliver. |
| Delivered revision | The newest usable revision that delivers. An epic revision delivers when its last report state is `ready`. A task revision delivers when it has stored plan waves. |

- Live state never changes delivery. Reason: `last_report_state` does not change when a thread goes busy again.
- A failed advisor, or one that `chief_stop` blocked with no advice, is not an attempt. Reason: it cannot report again, so it would hold the chain.

#### Owner table

The first row that matches wins.

| Condition | Kind | Owner |
| --- | --- | --- |
| P missing or not usable | `closed` | none |
| P complete, epic | `closed` | none |
| P complete, task, usable delivered revision | `revised` | the delivered revision |
| P complete, task, otherwise | `closed` | none |
| P has no stored result | `planning` | P |
| Review `required`, advisor attempt | `advising` | the advisor attempt |
| Review `required`, no advisor attempt | `consult` | P |
| Review `approved` | `approved` | P |
| Review `changes`, delivered epic revision already complete | `revised` | P |
| Review `changes`, delivered revision | `revised` | the delivered revision |
| Review `changes`, revision attempt | `revising` | the revision attempt |
| Review `changes`, no usable revision | `revise` | P, with the decider |
| Review unset, or unrecognized | `plan` | P |

#### Lines by kind

Only the owner row renders a line in Pending. The lines are:

- `planning`: a blocked P gets the generic blocked line. An idle P without a Report gets the Missing-Report line. Otherwise no line.
- `advising`: an idle advisor without a Report gets the Missing-Report line. Otherwise no line.
- `consult`: the consult-again line for P when the required review has no advisor attempt. A failed, stopped or archived advisor leaves no attempt. Otherwise the planner route of P. A blocked P gets the generic blocked line instead.
- `approved`, `plan`: the planner route of P. This is the next call for P, as at a219693. A blocked P gets the generic blocked line instead.
- `revise`: the `chief_plan revises` line for P. When the decider is blocked, the line starts with the blocked advisor text.
- `revising`: a blocked revision gets the `chief_plan revises` line for P. An idle revision without a Report gets the Missing-Report line. Otherwise no line.
- `revised`: the planner route of the owner, once the owner is not busy: the delivered revision, or P when an epic revision is complete. The route shows also when the owner failed or was stopped. An epic revision gets the "complete both" line, or the complete call for P once the revision is complete. A task revision gets the delegate-waves line.
- `closed`: no line.

#### Rules

- A busy owner shows no line. Reason: Chief waits for a thread that is working.
- A held result comes before recovery. An idle planner or delivered revision with a held result shows its route line, not the Missing-Report line. Reason: the held line names the next call.
- An advisor row shows a line only as the `advising` owner. Reason: the advisor row would otherwise repeat the planner line.
- A blocked advisor's text appears only in the planner's `chief_plan revises` line. Reason: the planner revises the plan.
- In an alert, a chain row that is not the owner renders the owner's line. Reason: an advisor's ready alert still names the planner's next call.
- A delivered revision keeps the chain when it goes busy or idle again. Reason: the delivered result stands until Chief completes it.
- A failed owner shows no line, except a delivered revision, which keeps its held route. Reason: a delivered result still needs its completion call, and a failed row cannot act.
- An archived or deleted row is excluded. The owner table applies to the rows that remain. An older usable advisor or revision can then own the chain. For an open epic with no remaining delivered revision or revision attempt, P owns the chain again. A completed task stays closed. Reason: Chief cannot act on a removed thread.
- The planner row, not the advisor row, owns the approved or changes outcome. See [planner owns the plan outcome](../decisions/2026-11-25-planner-owns-plan-outcome.md).

#### Consult and revision refusals

- `chief_consult` refuses while the advisor attempt is busy or idle. For an idle attempt, the refusal names `chief_continue` for that advisor, which asks for its `chief_report`. Reason: one usable advisor holds the review, so a second consult would duplicate it.
- `chief_report` refuses a guarded planner report while the advisor attempt exists. A guarded report is any epic report, or a ready report that carries a plan. Reason: a replacement plan or epic report would drop the advisor's gate and overwrite the reviewed result.
- `chief_plan revises` refuses while a usable delivered revision exists, in any live state. Reason: the delivered result stands until Chief completes it.
- After the delivered revision is archived or deleted, the owner table applies to the remaining rows. For an open epic with no remaining delivered revision or revision attempt, P owns the chain again. If its review asked for changes, `chief_plan revises` admits a new revision. A completed task stays closed and refused. Reason: the removed revision no longer holds the result.
- `chief_plan revises` still admits a new revision over an idle or blocked undelivered attempt. The new revision supersedes it, as at a219693. Reason: an undelivered attempt holds no result, so superseding it loses none. A busy attempt still refuses.

### Alert

The alert is separate from Pending. It reaches Chief once per turn.

- The `idle` event sends the `noreport:<cycle>` alert when `turnMissingReport` is true. Reason: The check needs the saved state, not the earlier state.
- The alert applies to every managed row with a Chief, including planners, advisors and revisions. Reason: Parent notifications are `stuck`, so BB does not report a turn that ends without a `chief_report`.
- `stillDue` in `src/runtime/alerts.ts` keeps a `noreport` retry due only while `turnMissingReport` is true for the same cycle. Reason: A retry must stop when its cause ends.
- The retry check changed from base. At base it checked only the `idle` state. Now it also stops when the row reports in the same cycle.
- Each cycle gets at most one `noreport` alert, because the outbox key dedupes it. Reading `chief_roster` sends no alert. Reason: The alert belongs to the end of a turn, not to a read.
- The alert and Pending differ in scope. Every managed row with a Chief can get the alert. A worker row gets the Pending line. A plan-chain row gets both the alert and, as chain owner, the Pending line.

## Entry points

| Item | Code |
| --- | --- |
| Roster Pending block | `src/runtime/roster.ts`: `pendingBlock`, `pendingLines`, `todoLines`, `clipPendingBlock` |
| Missing-Report line | `src/runtime/lifecycle.ts`: `turnMissingReport`. `src/runtime/nextAction.ts`: `nextAction`, `missingReportLine`, `planChainAction`. `src/runtime/alerts.ts`: `stillDue` |
| Plan chain owner | `src/plan/planReview.ts`: `owner`, `status`, `advisors`, `revisions`, `consultRefusal`, `revisionRefusal`, `reportRefusal`. `src/runtime/delegation.ts`: `startPlanConsult` |
| Decisions after-section | `src/runtime/decisions.ts`: `writeDecisions`. `src/tools/roster.ts` calls it for a todo-only change. |
| Todo storage | `src/runtime/core.ts`: `chief_todos`, `todosForProject`, `closedTodosForProject` |
| Chief to another Chief | `src/runtime/chiefs.ts`: `handOver` |
| Startup unpin | `src/runtime/chiefs.ts`: `unpinPendingTab`. `server.ts`: where `pendingReady` is set |
