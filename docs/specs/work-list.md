# Work list

The work list is the one place where a Chief reads what is pending: the Pending block of `chief_roster`. This spec records the Chief to-do side panel that existed at base commit 310043a and its removal.

## Terms

| Term | Meaning |
| --- | --- |
| Pending block | The "Pending:" lines of `chief_roster`: threads with a next action, then open todos. |
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
| The Pending block, the `todo #N` lines, the `after:` collapse line and the "Other Chiefs' todos" section of `chief_roster` equal base for the same state. | The roster is now the only work list. |
| The text and JSON of `bb chief status` equal base for the same state. | The CLI reads the same state. |
| `handOver` moves `chief_todos` and undelivered alerts as at base. | A successor must keep the open work. |
| A Coordinator's roster renders a Children block. Each child entry holds that child's own Pending block. See `coordinator.md`. | A Coordinator owns no managed thread. It reads the work of its children. |
| The Pending block of a plain Chief equals base for the same state. | The Coordinator change must not alter a plain Chief's work list. |
| `handOver` refuses to run when the previous or the next Chief is a Coordinator, and writes nothing. | A Coordinator never owns open work, todos or alerts of a superseded Chief. |
| The sweep still runs on a store reload once `pendingReady` is set, and on `idle` and `failed` events. | The sweep completes absorbed rows. It does not depend on the panel. |
| `pendingReady` stays, and gates the sweep only. | The sweep must not run before the plugin initialises its state. |

## Entry points

| Item | Code |
| --- | --- |
| Roster Pending block | `server.ts`: `pendingBlock`, `pendingLines`, `todoLines`, `clipPendingBlock` |
| Todo storage | `server.ts`: `chief_todos`, `todosForProject`, `closedTodosForProject` |
| Chief to another Chief | `server.ts`: `handOver` |
| Startup unpin | `server.ts`: `unpinPendingTab`, the place where `pendingReady` is set |
