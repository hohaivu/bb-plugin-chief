# Work list

The work list is the one place where a Chief reads what is pending: the Pending block of `chief_roster`. This spec records the Chief to-do side panel that existed at base commit 310043a and its removal.

## Terms

| Term | Meaning |
| --- | --- |
| Pending block | The "Pending:" lines of `chief_roster`: threads with a next action, then open todos. |
| Missing-Report line | The Pending line for a managed thread whose current turn ended idle without a `chief_report`. |
| Todo | A row of the `chief_todos` table. A Chief adds it with `chief_roster`'s `todo` parameter. |
| Active Chief | A Chief row whose state is not `complete`, `archived` or `deleted` (`isActiveChief`). |
| Sweep | The pass that completes absorbed supporting rows (`sweep`, `completeAbsorbed`). |
| `pendingReady` | A flag in `server.ts`. The sweep starts on a store reload only after it is set. |

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
| The Pending block, the `todo #N` lines and the `after:` collapse line of `chief_roster` equal base for the same state. With `includeOthers: true`, the "Other Chiefs' todos" section equals base too. | The roster is now the only work list. |
| The JSON of `bb chief status` equals base for the same state. The text of `bb chief status` equals base for the same state, except the Missing-Report line. | The CLI reads the same state. The text output prints the Pending block (`pendingLines`). The JSON output does not. |
| `handOver` moves `chief_todos` and undelivered alerts as at base. | A successor must keep the open work. |
| A Coordinator's roster renders a Children block. Each child entry holds that child's own Pending block. See `coordinator.md`. | A Coordinator owns no managed thread. It reads the work of its children. |
| The Pending block of a plain Chief equals base for the same state. | The Coordinator change must not alter a plain Chief's work list. |
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

A managed thread can end its turn while idle, without a `chief_report`. The Missing-Report line tells Chief that this happened. It appears in the Pending block of `chief_roster`, so Chief reads it on each roster read until the condition ends. This line is the one change to the Pending block. The contracts above that compare the Pending block with base exclude it. The text output of `bb chief status` prints it too, because it prints the same Pending block. Its JSON output does not.

### One answer: `turnMissingReport`

`turnMissingReport` in `src/runtime/lifecycle.ts` answers whether the current turn still lacks a Report. It returns true when all these conditions hold:

- The row is not a Chief.
- The row has a Chief (`chief_thread_id` is set).
- The row state is `idle`.
- The alert outbox has no `report:<active_cycle>:` key for the row.

A `chief_report` writes a `report:<active_cycle>:` key for a row with a Chief. The key covers `active` reports too. Delivered outbox rows stay, so the answer stays the same on each read. The Missing-Report line, the `noreport` alert and its retry check all use this answer.

### Pending line

- A row with `turnMissingReport` true gets a recovery line from `nextAction` (`src/runtime/nextAction.ts`). `pendingLines` (`src/runtime/roster.ts`) prints that line in the Pending block.
- The line tells Chief to inspect the thread, then continue it to ask for its `chief_report`, or decide itself.
- The line stays on each read until the row reports or starts a new turn. Reason: The alert notifies Chief once. The Pending block must show open work until the cause ends.
- A row with an earlier role-specific line shows that line, not the Missing-Report line. Reason: A role-specific line holds the recovery step for its own role.
- A ready plan advisor shows no Missing-Report line when its planner has an approved plan and is idle without a Report. The planner's own row shows the line. Reason: The advisor's line shows the approval. The recovery step belongs to the planner's row.
- A row that reported shows no Missing-Report line. This covers `ready`, `blocked`, `complete` and an `active` report in the same cycle. Reason: An idle row that reported is not stuck.

### Precedence

`nextAction` checks the rows in this order. The first route that applies wins.

1. Earlier role-specific lines: a gate line, a chat fix run, a `blocked` row, and a researcher line. These come before the Missing-Report line.
2. The Missing-Report line, when `turnMissingReport` is true.
3. The ready-state routes of the row: the planner, worker, advisor and reviewer routes.

Two idle rows skip step 2 and keep their route from step 3:

- An idle design row whose latest report is `ready` keeps the approved-design route. Reason: `chief_owner_approval` admits that report. The reply and the Pending line must name the same route.
- An idle epic planner whose report intake refuses every report keeps its decision or delivery line. The refusal covers a decided epic, a delivered revision, and a planner with an advisor in review. Reason: A new `chief_report` cannot be accepted, so a retry line would stall the epic.

### Delivered epic revision

An epic revision is delivered by its ready report. Reason: Report intake refuses any later report from it.

- A later idle turn without a Report does not reopen the revision.
- Pending, `chief_consult` and `chief_plan` (`revises`) read one predicate, `epicDelivered` in `src/plan/planReview.ts`. Reason: Report intake and these routes must agree.
- Each of these names the same calls: `chief_complete` of the revision and of the original. `chief_plan` refuses a second revision.
- A blocked revision attempt stays open. Reason: A blocked report does not deliver the revision, so its retry stays valid.

### Plan advisor

A plan advisor has its own rule.

- A deciding advisor shows its planner's review line, if one applies. It never shows the Missing-Report line.
- For a `request_changes` decision, the advisor's row omits the line when the planner's own row shows the same call. The advisor's report alert and a blocked advisor's escalation keep the line. Reason: Pending names one owner for the revision call.
- An approved plan's advisor shows the approval and the planner's next action. It shows no line while the planner is idle without a Report. Reason: The planner's row holds the recovery step.
- An advisor with no decision (`advised_at` null) shows the Missing-Report line on its own row, when its planner still waits on it. Reason: The advisor's row holds the `chief_continue` call for that advisor, so the line belongs there.
- A stale advisor shows no line. A stale advisor is one whose planner is no longer `required` (`advisorStale` in `src/plan/planReview.ts`). Reason: `chief_continue` cannot resume a stale advisor.

### Alert

- The `idle` event sends the `noreport:<cycle>` alert when `turnMissingReport` is true. Reason: The check needs the saved state, not the earlier state.
- `stillDue` in `src/runtime/alerts.ts` keeps a `noreport` retry due only while `turnMissingReport` is true for the same cycle. Reason: A retry must stop when its cause ends.
- Each cycle gets at most one `noreport` alert, because the outbox key dedupes it. Reading `chief_roster` sends no alert. Reason: The alert belongs to the end of a turn, not to a read.

## Entry points

| Item | Code |
| --- | --- |
| Roster Pending block | `server.ts`: `pendingBlock`, `pendingLines`, `todoLines`, `clipPendingBlock` |
| Missing-Report line | `src/runtime/lifecycle.ts`: `turnMissingReport`. `src/runtime/nextAction.ts`: `nextAction`. `src/runtime/alerts.ts`: `stillDue` |
| Decisions after-section | `src/runtime/decisions.ts`: `writeDecisions`. `src/tools/roster.ts` calls it for a todo-only change. |
| Todo storage | `server.ts`: `chief_todos`, `todosForProject`, `closedTodosForProject` |
| Chief to another Chief | `server.ts`: `handOver` |
| Startup unpin | `server.ts`: `unpinPendingTab`, the place where `pendingReady` is set |
