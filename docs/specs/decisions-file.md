# Decisions file

The decisions file is a Markdown file in the thread storage of each Chief and each Coordinator. It keeps the owner's decisions, so a Chief can re-read them after a context compaction or a hand-over. The server writes the file. The agent passes decisions to the server, and the server records them.

## Terms

| Term | Meaning |
| --- | --- |
| Decisions file | `decisions.md` in the thread storage of one Chief or Coordinator. Its path is `$BB_THREAD_STORAGE/decisions.md`. |
| Owner | The user who answers a Need you request and gives decisions. |
| Need you | An alert that asks the owner for an answer. |
| Decision entry | One block of the file: a marker line, a text, and an optional `Why:` line. |
| Kind | The field of a marker line that names the entry type: `decision` or `owner-answer`. |
| Owner answer | An owner comment on a tracker task that answers an open decision. The plugin records it. |
| Decision | Any owner answer given in chat or relayed, and any sequencing agreement. The agent passes it in the `decision` field of `chief_roster`. |
| After-section | The generated section `## Todo after: reasons (generated)` at the end of the file. |
| Linked thread | The thread named in an entry's `thread` field. |
| Todo | A row of `chief_todos`. See `work-list.md`. |
| Hand-over | The move of a Chief's open work to its successor (`handOver`). |

## Ownership and entry points

| Item | Code |
| --- | --- |
| Write step, record and copy | `src/runtime/decisions.ts`: `writeDecisions`, `recordDecision`, `copyDecisions` |
| Read that tells a missing file from a failed read | `src/runtime/artifacts.ts`: `readStorageFileIfPresent` |
| Agent input and path line | `src/tools/roster.ts` (`chief_roster`). A `decision` call runs `recordDecision`. A todo-only call runs `writeDecisions` with an unchanged list, which rebuilds the after-section. |
| Hand-over copy | `src/runtime/chiefs.ts` (`handOver`) |
| Spawn copy | `src/tools/spawn.ts` (`chief_spawn`) |
| Tracker owner answer | `src/tracker/trackerSync.ts` (`pollAnswers`), `src/runtime/forgeWiring.ts` (`recordAnswer`) |

## Baseline (behaviour at base f006ff0)

### Hand-over (`handOver`, `src/runtime/chiefs.ts`)

- `handOver` throws when the previous or the next Chief is a Coordinator.
- `handOver` throws when the next Chief belongs to another Coordinator.
- `handOver` runs one `store.batch`. The batch completes the previous Chief, moves its open work and todos, and retargets its undelivered alerts.
- `handOver` copies no file.
- `spawnChief` calls `handOver` before it inserts the new Chief row.

### Handed-off task text (`handoffSection`, `src/runtime/chiefs.ts`)

- The section names `brief.md` in the thread storage.
- The section tells the Chief to re-read `brief.md` after a context compaction.

### `chief_spawn` (`src/tools/spawn.ts`)

- The tool checks `todoId` before it starts a thread. The todo must be an open todo of the caller.
- After the thread starts, the tool moves the todo with a check-and-set update.
- The tool writes `brief.md` with `writeStorageFile`. It makes 3 tries. It waits 1 s before the second try and 2 s before the third.
- When every try fails, the result adds `brief.md not saved (…)`. The spawn stands.

### `chief_roster` (`src/tools/roster.ts`)

- The `todo` field adds a todo, or changes one by `id`.
- A todo `text` is at most 500 characters.
- A todo `after` is free text, at most 200 characters. An empty string clears it.
- A change to a todo outside the caller's project fails with `No todo #N in this project.`
- The output opens with the Pending block.

### Storage helpers (`src/runtime/artifacts.ts`)

- `writeStorageFile` writes a file under the thread storage. It writes a temp file and moves it into place.
- `readStorageFile` returns the content. It returns null for any error and never throws.
- `retryWhileProvisioning` retries after HTTP 409. It waits 1, 2, 4, 8, 15 and 30 s. That is 7 tries and about 60 s of waits.
- `retryWhileProvisioning` propagates any other error at once.

## Contracts

### DEC-1 Writer and file

- Only the server writes `decisions.md`. Each Chief and each Coordinator has one file in its own thread storage.
- Each write reads the file, changes it, and writes it back. Reason: a write that skips the read would drop the entries already in the file.
- Writes to one file run one at a time. Reason: two writes to one file would interleave and lose an entry.
- A read that fails for any reason except a missing file skips the write. The file keeps its content, and the server logs a warning. Reason: a write after a failed read would replace the file with a shorter one.
- Only an error whose message starts with `HTTP 404` or `ENOENT` counts as a missing file. Any other error is a read failure, even when its text contains `404` or `not found`. Reason: a path such as `thr_404` in another error would otherwise count as missing, and the write would erase the file.
- A write or read failure never fails a tool call or a hand-over. The server logs a warning. Reason: the file is a record, and the tool call is the owner's work.

### DEC-2 Entry format

- The file starts with the header `# Decisions`, then the high-water line `<!-- chief-last-id=N -->` (see DEC-5), then the entries, then the after-section.
- Each entry starts with a marker line: `<!-- chief-decision id=N kind=K thread=T todo=D at=TIME -->`.
- `thread` and `todo` hold `-` when the entry has no value.
- `kind` is `decision` or `owner-answer`.
- The text lines follow the marker line. Each reason line follows the text, and starts with `Why: `. An entry without a reason has no `Why:` line. Reason: a reader sees the reason next to its text, and a multi-line reason keeps its line breaks.
- A text line that starts with `\`, `<!-- chief-`, `## Todo after` or `Why: ` gets one leading backslash. The parser removes one leading backslash from each text line. Reason: the parser would read an unescaped line as structure, and the backslash also escapes a text line that already starts with a backslash.
- The parser splits entries at marker lines. It drops everything from the exact generated heading on. Reason: the after-section is rebuilt on every write, so the parser never reads it back as entries.
- Lines before the first marker line are ignored.

### DEC-3 Bounds

- An entry text is at most 600 characters. An entry reason is at most 300 characters. Reason: an entry stays far smaller than the file cap, so the newest entry always fits.
- The server clips longer input. It does not refuse the call. Reason: the design clips input instead of refusing it.
- The file is at most 8,000 characters after every write. Reason: each write reads and rewrites the whole file, so the cap bounds the cost of a write.
- When a write exceeds 8,000 characters, the lowest-id entries leave first. The newest entry always stays. Reason: the design orders eviction this way (after finished work, then the oldest entries). The design gives no other reason.
- The after-section is at most 2,000 characters. Reason: the section is rebuilt on every write, so it must not take the room the entries need under the 8,000-character cap.

### DEC-4 Pruning

- Every write drops an entry whose linked thread is `complete`, `archived` or `deleted`. It uses the same `terminal` check as the rest of the plugin (`src/types.ts`).
- An entry whose linked thread is unknown to the store stays.
- Every write drops an entry whose todo is missing or not `open`.
- Reason: the file keeps records for open work only.
- Only a write prunes the file. A file with no later write keeps its entries.

### DEC-5 Ids

- Ids are unique within one file, and they increase in write order.
- The file keeps a high-water id in its `<!-- chief-last-id=N -->` line. Pruning and eviction never lower it, even when every entry is pruned.
- A new entry gets the high-water id plus one, in write order. The write then stores the new high-water id.
- A copy into a non-empty file gives each copied entry a new id after the existing ids and the high-water id.
- Reason: an id is never given to a second entry in one file. A removed entry's id therefore never points at a newer entry.

### DEC-6 After-section

- Each write rebuilds the after-section from scratch.
- The section lists the open todos of the owner that have a non-null `after`.
- Each line uses the roster's todo-line format: `- todo #N: text (after: …)`. Reason: the same line shows in the Pending block.
- A todo whose `after` changes shows the new text on the next write. A todo that closes leaves the section on the next write.

### DEC-7 Triggers

Only these calls write a decisions file:

| Trigger | Entry or copy | Source |
| --- | --- | --- |
| `chief_roster` with a `decision` | One `decision` entry in the caller's file | The agent |
| `chief_roster` with a `todo` change and no `decision` | Rebuilds the after-section of the caller's file | The server |
| Tracker owner answer that matches an open decision | One `owner-answer` entry in the live Chief's file | The plugin poll |
| `handOver` | Copies every surviving entry to the successor | The server |
| `chief_spawn` with a moved todo | Copies the entries of that todo to the new Chief | The server |

Reason: each write needs one known trigger.

### DEC-8 Roster path line and the `decision` field

- Every `chief_roster` output has the line `Decisions: $BB_THREAD_STORAGE/decisions.md` as its first line, for a Chief and for a Coordinator.
- The output stays within 6,000 characters. The path line, a failed-write note and the caller's own Pending block are fitted first. The Children block (Coordinator) or the rest of the roster (Chief) fills what is left. Reason: the Pending block is the work list, and the path line is how the agent finds the file after a compaction.
- The path line needs no file read. It shows whether or not the file exists.
- A `decision` input has `text`, an optional `why`, an optional `threadId`, and an optional `todoId`. The call accepts up to 4,000 characters of `text`. The entry keeps at most 600.
- A `todoId` that is not in the caller's project fails with an error. The call writes nothing.
- A failed write adds one note line to the output. The note says the decisions file was not updated.
- The Chief and Coordinator instructions name the `decision` field. Reason: the server cannot see chat answers or relays.

### DEC-9 Hand-over copy

- `handOver` starts a copy of the predecessor's file to the successor after the rows move.
- The copy keeps every surviving entry after the successor's own prune.
- `handOver` does not wait for the copy. Reason: `handOver` runs in synchronous paths.
- A copy that fails logs a warning. The successor then has no copied entries.

### DEC-10 Spawn copy

- `chief_spawn` copies the entries whose `todo` equals the moved todo into the new Chief's file.
- When no todo is given, or the todo does not move, the new Chief has no file. Reason: the design copies only the entries tied to the moved todo.
- The spawn leaves the caller's file unchanged.

### DEC-11 Tracker owner answer

- After the answer transaction commits, a matched owner answer is recorded in the live Chief's file as an `owner-answer` entry. Reason: a file write cannot run inside a database transaction.
- The entry's `thread` is the concerned thread of the decision.
- The entry's reason names the decision number and the task title.
- The matcher (`tracker.md`, Decisions and answers) picks the decision. A comment that starts with `#N` matches open decision N. A comment without a matching number matches the only open decision when exactly one is open. Reason: not stated in the code. The tracker spec gives the rule.
- A comment that matches no decision records nothing. Reason: the entry would name a decision the owner did not answer.
- A failed record logs a warning. It never rolls back the answer or the alert. Reason: the alert already delivers the answer.
- With no live Chief, nothing is recorded.

## Known limits

- The server cannot tell a chat answer, a Coordinator relay and a sequencing agreement apart. All three record as `decision`. Reason: the `decision` field has no kind.
- The server trusts the `decision` field. It does not check the sender.
- A file changes only on a write. A file of an idle Chief keeps stale entries until the next write.
- The parser drops whitespace-only lines at the end of an entry's text or reason. Reason: the parser trims the end of each entry body before it reads the `Why:` lines.
- The missing-file match reads the host's error text. The live host's response for a fresh thread is not checked in code. A manual check on a fresh Chief confirms it.

## Related decisions

- [Decisions file is the only store](../decisions/2026-11-19-decisions-file-only-store.md)
- [Plugin polling owns tracker answers](../decisions/2026-11-09-tracker-answers-plugin-poll.md)
- [Owner answers reach a child through a marked relay](../decisions/2026-11-16-owner-answer-relay-marker.md)
