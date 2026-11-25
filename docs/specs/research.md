# Research

## Purpose

The research domain lets Chief start a read-only researcher thread for one ticket. The researcher gathers neutral facts through helper threads. With `design: true`, it also holds a design discussion with the user and reports a design the user approved. It reports through `chief_report`. Chief then binds the approved design to a planner with `chief_plan`. See Design hand-off.

## Domain Terms

- **Researcher**: a managed thread with role `researcher`. It reads code and writes no code.
- **Ticket**: the `question` text: the issue or the user's request in full. With no separate ticket, the question is the ticket.
- **Design mode**: a researcher started with `design: true`. It runs stage 3.
- **Stage**: one step of the researcher's brief. Stage 1 writes neutral questions. Stage 2 gathers facts from helpers. Stage 3 is the design discussion, in design mode only.
- **Design discussion**: the stage 3 loop. The researcher asks the user design questions in its own thread, with AskUserQuestion.
- **Waiting marker**: the stored flag `waiting_on_user`. It is 1 while a design researcher waits for the user.
- **Approved design**: the design.md and the fact report of a ready design researcher. `chief_plan` binds them as write-once snapshots.
- **Helper thread**: a plain BB thread that a researcher spawns for one part of its question. It has no managed row and no `chief_*` tools.
- **Researcher pick**: the `researcher` row of Chief models by machine, for one host. A researcher and its helper threads run on that model.
- **BB default**: the model that BB picks for the project when no role pick applies.
- **Research call**: one `chief_research` call. Each call writes one `chief_research_calls` row.
- **Lifecycle alert**: the Chief alert that `chief_report` creates. `report-intake.md` defines it.
- **Stall alert**: the generic alert from the supervisor loop in `src/runtime/lifecycle.ts`. It uses `stallThresholdMs`.

## Ownership and Entry Points

| Entry point | File | Role |
| --- | --- | --- |
| `chief_research` | `src/tools/research.ts` | Registers the tool and its description. |
| `createResearch`, `research` | `src/research/research.ts` | Check the caller and write the research call row. |
| `startResearcher` | `src/research/research.ts` | Check the model, cooldown, quota and checkout, then spawn the researcher. |
| `researcherBrief` | `src/research/research.ts` | Build the researcher's prompt. It keeps stage text. The read-only rule and the no-ask rule come from the researcher's instructions. |
| `researcherNextLine` | `src/research/research.ts` | Give the Next line of a design researcher's alert and roster row. |
| `nextAction` | `src/runtime/nextAction.ts` | Choose the Next line of each alert and roster row. It calls `researcherNextLine` first for a researcher. |
| `reserveReport`, `syncLive` | `src/db/threadStore.ts` | Store `waiting_on_user` with each report and with each live state. |
| `modelConfiguration`, `setRoleModel` | `src/runtime/host.ts` | Read and write the researcher pick. `modelConfiguration` has no Tester role, and a stored tester row is never read. |
| `researchChiefInstructions`, `bb.agents.configure` | `src/runtime/host.ts` | Give Chief the research tool and its instruction. |
| `chief_models_v9` | `src/db/migrations.ts` | Stores the researcher pick and seeds it once. |
| `judgeModel` | `src/observe/retro.ts` | Reads the research helper pick, then the researcher pick, for the retro judge. |
| `bindDesign` | `src/runtime/delegation.ts` | Creates missing snapshots or reuses existing ones for a new `chief_plan` binding. |
| `approvedDesign` | `src/runtime/delegation.ts` | Reads the exact bound snapshot pair for revision and `chief_forge_init`. It never creates snapshots or reads live `design.md`. |

## Flows and States

### Start a researcher

1. Chief calls `chief_research` with `question` (the ticket), `design` and, optionally, `branch`.
2. `research` checks the caller and the research switch.
3. `startResearcher` reads Chief's environment and the host of that environment.
4. `managedSpawn.prepare` resolves the researcher's execution: the usable pick, else the BB default.
5. `startResearcher` refuses when the target model cools down or the preflight check blocks it.
6. `startResearcher` refuses when there is no `branch` and no reusable environment.
7. Without a `branch`, `freshenCheckout` fast-forwards Chief's checkout once.
8. `managedSpawn.launch` starts the researcher and writes its managed row.
9. The tool returns the researcher thread id at once. A design reply also says the design discussion runs in the researcher thread.

### Caller check

The first failing check decides the refusal.

| Caller | Outcome |
| --- | --- |
| Active registered Chief, research on | Allowed. |
| Finished Chief (state `complete`, `archived` or `deleted`) | Refused: `chief_research is available only to an active Chief. A planner splits a broad scan across read-only helper threads.` |
| Planner, researcher, worker, reviewer, advisor or unmanaged thread | Refused: `chief_research is available only to an active Chief. A planner splits a broad scan across read-only helper threads.` |
| Research switched off (`researchEnabled` is off) | Refused: the research switch is off. |

### Researcher model

- A usable researcher pick sets the execution. The researcher runs on that model, and its helper command carries the same `--provider` and `--model`.
- With no pick, or an unusable pick, the execution is empty. The researcher runs on the BB default, and its helper command has no `--provider` or `--model`.
- Chief's own model is not read at runtime.

### Environment

| Call | Environment | Freshen |
| --- | --- | --- |
| No `branch` | Reuses Chief's environment. | Once, after every refusal check. |
| With `branch` | A fresh worktree on the branch (`worktreeEnvironment`). | No. |
| No `branch` and no reusable environment | Refused before any spawn. | No. |

### Researcher work

The researcher follows its brief in stages:

1. Stage 1, Context: it reads the ticket and writes neutral research questions about how the code works today. A question never names the goal or the proposed change. The user does not see these questions.
2. Stage 2, Research: it groups the questions into vertical slices and starts one helper per slice, from 1 to 6 helpers. It does not answer a question itself before the helpers report.
3. Stage 3, Design: design mode only. See the next section.

Stage 2 steps:

1. Give each helper a prompt with only the read-only rule, its questions, the fact format and the facts-only rule. Each helper prompt never holds the ticket, its title or the goal.
2. Work on the rest while the helpers run.
3. Wait for each helper with `bb thread wait <id> --status idle --timeout 540s`. Read its answer with `bb thread output <id>`.
4. Stop a helper that failed or is still not idle after a second wait. List it as a failure.
5. Check every fact the result relies on against the code. Mark or drop facts the evidence does not support.
6. Stop every helper still running, then report.

The researcher never polls with sleep loops.

### Design discussion (design mode)

1. The researcher writes `$BB_THREAD_STORAGE/design.md`. The file has the sections Current state, Desired end state, Patterns to follow, Resolved decisions and Open questions.
2. Before its first AskUserQuestion call, it reports `active` with `waitingOnUser: true`. It reports this again only after it leaves the wait.
3. It asks the open questions in rounds of at most 4 questions per call. After each round, it rewrites design.md.
4. When the user rejects the direction, it reports `active` without the flag. Then it returns to stage 1 in the same thread.
5. It reports ready only after the user approves the design. Approval is the only exit.
6. When AskUserQuestion is missing, or a call fails, times out or is dismissed, it writes the open round into design.md. Then it reports `blocked` with `waitingOnUser: true`.

AskUserQuestion comes from Claude Code natively. Elsewhere, bb's builtin ask-user-question plugin provides it, and its card times out by the user's setting (default 30 minutes). The native Claude Code timeout in bb is unconfirmed.

### Report

- The researcher reports with `chief_report` state `ready`. The first result line is `Helpers: <n>`. `Helpers: 0` means it gathered no helper facts.
- In design mode, the second result line is `Design: <absolute design.md path>`.
- The result has a `## Facts` section (each fact with its file:line evidence) and an `## Unconfirmed` section.
- Failed or stopped helpers are named. A question with no fact makes the result partial.
- When nothing usable comes back, the researcher reports blocked. It names the cause as the blocker.
- A design researcher that waits on the user reports blocked with `waitingOnUser: true`. Its blocker names the design.md path and the open round.

### Supervision

- A researcher is supervised like every other managed thread: the stall alert, `chief_stop` and `chief_continue`.
- A design researcher with state `active` and `waiting_on_user` 1 is skipped by the stall loop. Its discussion has no timeout.
- Its report arrives as a lifecycle alert. A light researcher's Next line says the research is advisory and needs no review or completion.
- The Next line of a design researcher depends on its state:

| Researcher state | Next line |
| --- | --- |
| `active`, waiting | Tell the user once that the discussion waits in the researcher thread. Do not poll or stop it. |
| `blocked`, waiting | Read the round in design.md, escalate it with `chief_escalate`, and write it under Need you. The user answers in the researcher thread. |
| `active`, not waiting | Progress only. The researcher restarted research. |
| `ready` | The user approved the design. Plan it with `chief_plan` and `researchThreadId` when planning is on, else delegate it with `chief_delegate` and the `Design:` path. |

- A light researcher, or a blocked researcher without `waiting_on_user`, keeps the generic Next lines. Reason: only a design discussion has a user wait.

## Contracts

### Chief-only tool

- `chief_research` is Chief-only. Reason: Chief decides when research runs. A planner uses its own helper threads.
- `question` is 1 to 4,000 characters after trimming. It is the ticket. Reason: not stated in the code.
- `design` is required and boolean. `true` runs the design discussion. `false` gathers facts only. Reason: a feature needs a user-approved design, and an evidence check needs facts only.
- `branch` is optional, 1 to 300 characters, and only Chief may pass it. Reason: a researcher already reads its own worktree.
- Every call writes one `chief_research_calls` row. `mode` and `run_id` are null, and `outcome` is `spawned` or `error`. Reason: the roster counts research calls.
- Every refusal happens before any thread exists. Reason: a refused call leaves Chief's checkout as it was.
- The reply names the researcher thread and its title, then says `Do not poll: end your turn.` A design reply also says the design discussion runs in the researcher thread. The launch reply asks for no announcement. Reason: the report arrives as a lifecycle alert.
- The title is `Research · <question clipped to 60 characters>`. With `design: true`, the title is `Design · <question clipped to 60 characters>`.

### Researcher start

- The spawn goes through `managedSpawn.prepare` with role `researcher`. Reason: the researcher uses the same model path as a worker.
- A target that cools down refuses the call before any spawn. Reason: a spawn on a cooling model would fail.
- A provider with status `not_installed` refuses the call. The message names the provider and asks for another pick. Reason: a provider that is not installed cannot run.
- A usage window at 100% does not refuse the call. The researcher starts, and BB logs a warning that names the window and the percent. The warning names the reset time only when BB reports one. Reason: the usage reading describes one account, and the owner may have switched the default account.
- An `unauthenticated` or `expired` status does not refuse the call. BB logs a warning and the researcher starts. Reason: a pooled or proxied host can still serve the provider.
- A refused call does not freshen Chief's checkout. Reason: a refusal leaves the checkout as it was.

### Researcher rows

- `research_design` is 1 for a design launch and 0 for a light launch. A row with no value reads as light. Reason: the stall loop and `nextAction` pick the design lines from this flag.
- An upsert without `researchDesign` keeps the stored value. Reason: a recovery row seeded before the launch insert keeps the launch's value.
- A design-bound planner row stores the researcher ID in `research_thread_id` and the ready-report sequence in `research_report_seq`. A `revises` planner copies both. See Design hand-off.
- `waiting_on_user` is 1 only after a design researcher reports `waitingOnUser`. Every later report stores 0, and a `failed` live state stores 0. Reason: a rejection restart returns to stall supervision because its report has no flag.
- `waitingOnUser` is refused for other roles, for light researchers and for states other than `active` and `blocked`. Reason: the marker only describes a design discussion.
- A design researcher reports ready only after the user approves the design. Reason: the approved design gates planning and delegation.
- A waiting researcher gets no stall alert and no hard stall alert, and it records no failure. Reason: the user answers on the user's own time, and the discussion has no timeout.
- When a design researcher blocks with `waitingOnUser`, Chief escalates the round named in its blocker. The user answers in the researcher thread. Reason: the researcher does not get `chief_escalate`, and the thread that asks must receive the answer.
- A researcher never proceeds on its own judgment, and never treats silence as approval. Reason: a design needs the user's explicit approval.

### Researcher model

- `researcher` is a role of `chief_models`. Settings → Chief models by machine edits it with the same picker as Worker. Reason: each role has one model control.
- `setRoleModel({ role: "researcher", selection })` stores a pick. `selection: null` clears it, and a later start does not re-import it. Reason: the seed runs once, in the migration.
- At runtime, no code path falls back to Chief's model, Worker's model or a research-mode pick. Reason: each role has one model source.
- The retro judge (`judgeModel`) reads the `research-helper` pick first. When that pick is unset or unusable, it reads the researcher pick. When both are unusable, it uses the BB default. Reason: judging is log reading against a fixed rubric, so the cheaper helper pick runs it when set. See [Retro judge model](../decisions/2026-11-25-retro-judge-helper-pick.md).

### Helper threads

- A researcher spawns at most 6 helper threads (`RESEARCH_MAX_HELPERS`). Reason: a fixed bound keeps quota use safe. The bound is in the prompt only, and no server code enforces it.
- A helper shares the researcher's environment. It starts with `--parent-self` and `--lifecycle-owner-thread` set to the researcher. Reason: the helper reads the same checkout and reports to its researcher.
- A helper gets `--provider` and `--model` only when the researcher has a pick. Reason: the helper runs on the researcher's model.
- Each helper prompt states the read-only rule and the facts-only rule. Helpers do not spawn threads.
- A helper prompt never holds the ticket, its title or the goal. Reason: facts gathered without the desired outcome stay neutral.
- A helper has no managed row and no `chief_*` tools. Reason: not stated in the code.

### Tool exposure

- `bb.agents.configure` gives `chief_research` to Chief only when research is enabled. Reason: planners and researchers do not start researchers.
- A planner and a researcher get no research instruction line. Reason: a researcher's brief covers its own work.
- Chief's instruction says that a call starts a researcher thread. It also says when to call and when not to rerun a partial answer.
- Chief's instruction says to use `design: true` for features and multi-file work, and `design: false` for evidence checks. While a discussion waits, Chief tells the user once. Reason: the depth follows the kind of work.

### Settings

- The research settings hold one field, `enabled`. A patch with `maxAgentCalls` or `timeoutMinutes` is refused by the strict schema. Reason: the cap and timeouts belonged to the workflow path.
- The RPC contract has no `setResearchModel`. Reason: the researcher pick uses `setRoleModel`.
- Old stored settings keys and the `research_mode_models` table stay in place and are not read. Reason: the migration drops no data.

### Roster

- The roster counts a Chief `spawned` row as a call and as a success. Reason: a spawned researcher has no run outcome to count.
- The roster output keeps the shape `{ role, mode, calls, succeeded }`. Historical non-Chief rows count as before.

### Removed mechanisms

- No BB workflow runs research. Only `src/observe/retro.ts` calls `runWorkflowCli`. Reason: the researcher decides its own work.
- No agent-call cap, per-mode timeout, server hard stop or unreported-run alert exists. Reason: the stall alert and `chief_stop` replace them.
- A researcher that waits on helpers stays active. A long run can raise the stall alert. Reason: intended, because the stall alert replaces the hard timeout.

## Design hand-off

After the user approves a design, `chief_plan` binds that design to the planner. Reason: the planner builds from the approved design, not from a later edit of design.md.

### Inputs

- `researchThreadId` (CLI `--research-thread thr_id`) names the design researcher. Chief passes it with a one-line mission. Reason: the design comes from that researcher's thread.
- `undesignedReason` (CLI `--undesigned-reason "…"`) names why the work needs no design, in 1 to 300 characters. Reason: a small fix may skip the design, and the skip stays on record.
- Neither input may appear with the other, and neither may appear with `revises`. The CLI flags follow the same rule. Reason: one plan has one design source, and a revision inherits it.
- With research on, a plan with no `researchThreadId` and no `revises` needs `undesignedReason`. Reason: each plan records its design or its skip.
- With research off, neither input is required. When `undesignedReason` is given, the server accepts it and renders it in the brief. Reason: the design flow is off, but the skip still stays on record.

### Refusals

`chief_plan` with `researchThreadId` refuses before any thread spawns and before Chief's checkout freshens. It refuses when:

- no row has that id,
- the row is not a researcher,
- the researcher is a light researcher,
- another Chief owns the researcher,
- its last report is not ready,
- an existing snapshot cannot be read, or
- the design snapshot is absent and `design.md` is missing, blank or over 40,000 characters.

Reason: a plan must not start on an unapproved or unreadable design.

### Snapshots

- On a new binding, `bindDesign(researcher, projectId)` creates missing snapshots in the researcher's artifact directory. `design-approved-r<seq>.md` holds the text of `design.md`. `facts-approved-r<seq>.md` holds the full ready result. A later initial bind to the same researcher and ready-report sequence reuses existing snapshots. Reason: reusing the exact approved design and fact report keeps the planner's inputs stable after edits or later approvals.
- Revision and forge call `approvedDesign(researcherId, seq, projectId)` with the pair stored on the planner row. A later ready report does not change the pair. If the sequence is missing or either snapshot is missing or unreadable, revision refuses before checkout freshen or spawn, and forge refuses before its script runs. The lookup never recreates a file or reads live `design.md`. Reason: a missing or unreadable snapshot causes refusal, not a silent swap.
- The planner brief names both paths and never holds their text. Reason: a clipped copy loses content.

### Planner brief

- A planner with a design gets a `## Approved design` section before `## Problem`. It names both paths and says the design is its brief. Reason: the design sets the plan, and the title and mission only route the task.
- The section says the resolved decisions are settled. Reason: a plan must not reopen them.
- A wave that depends on an unconfirmed fact names that fact under `## Depends on unconfirmed facts`. Reason: an unconfirmed fact can be wrong.
- A revision gets the same section with the same paths. Reason: a revision builds on the same design.
- With `undesignedReason`, the brief gets one Context line: `Design discussion skipped: <reason>`.

### Pull request body

- A designed plan's pull request body holds the full design text after the plan block. The block holds the researcher id, the ready report sequence, a marker and the fact report path. Reason: reviewers read the approved design with the code.
- The body shows the fact report path only, not its text. Reason: the body has a size limit, and a 40,000-character design plus 8,000 characters of facts could exceed it.
- A reused pull request without the marker gets its body rewritten. If the marker is still missing, `chief_forge_init` refuses and asks for a new run. Reason: the design block must exist before review.
- A plan without a design keeps the pull request body it had before this change. Reason: existing plans must not change.

### Flow

1. Chief calls `chief_research` with `design: true`.
2. The user approves the design in the researcher thread.
3. Chief calls `chief_plan` with `researchThreadId`.
4. Chief calls `chief_forge_init`.
5. Chief calls `chief_delegate` for the first wave.

## Migration

- Migration `chief_models_v9` rebuilds `chief_models` with role `researcher` added. Every existing row keeps its values. Reason: the rebuild copies all columns.
- The migration copies each host's `investigate` pick into a `researcher` row, if the host has one. Reason: the user's current choice is kept.
- The seed runs once. Later clears never re-import it. Reason: migrations run once.

## Cutover

Old researcher briefs ask the researcher to call `chief_research` with `mode` and `runId`. After the reload, those calls are refused, and old workflow runs are not collected. Chief of each project that used research runs this procedure before the user merges. The user then merges and runs the documented reload.

1. Find live research runs. The query covers the last 2 hours, because the old timeouts cap a run at 60 minutes:
   ```sql
   SELECT DISTINCT run_id FROM chief_research_calls WHERE run_id IS NOT NULL AND started_at > (strftime('%s','now')-7200)*1000
   ```
   Match the ids against `bb workflows list --json` in that project. Never touch a run whose id is not in that list, because retro runs are workflows too.
2. For each match, run `bb workflows status <run-id>`. If it is not terminal, wait for the researcher to report, or run `bb workflows stop <run-id>` and check the status again. If the status cannot be read or the stop is not confirmed, list the run id in the hand-off to the user. Do not block the merge on it.
3. For each non-terminal managed researcher row in `chief_roster`, let it report or run `chief_stop`. Never run `chief_continue` on an old researcher after the reload. Ask again with a fresh `chief_research` call.
4. Planners mid-flight need no action. After the reload, their `chief_research` call is refused, and the refusal names helper threads.

## Trade-offs

- The helper cap and the read-only rule are prompt rules. No server enforces them. See the decision.
- The cutover is manual, and it runs before the merge. See the decision.
- The design discussion has no timeout, and its stall alerts stay muted while it waits. See the decision.

## Related Decisions

- [Researcher is a normal agent with a role model](../decisions/2026-11-17-researcher-normal-agent.md)
- [Design discussion runs in the researcher thread](../decisions/2026-11-18-crispy-design-discussion.md)
- Related specs: [checkout-freshness.md](checkout-freshness.md), [report-intake.md](report-intake.md), [observability.md](observability.md).

## Baseline: Behaviour Before the Design Hand-off

This section describes the behaviour before the design hand-off, after the design:true|false flow. The sections above describe the behaviour after the hand-off. Reason: a reviewer compares the two states.

### Research call and design mode

- `chief_research` takes `question` (the ticket), `design` and optional `branch`. `design: true` runs the design discussion. `design: false` gathers facts only. (`src/research/research.ts`, `researchParams`)
- A design researcher reports `ready` with the `Helpers:` and `Design:` result lines, then the fact report. (`src/research/research.ts`, `researcherBrief`)
- `research_thread_id` is stored and unused. Reason: the column waits for the hand-off.

### Planning

- `chief_plan` takes no design input. `planParams` in `src/tools/shapes.ts` has no `researchThreadId` and no `undesignedReason`.
- `startPlan` in `src/runtime/delegation.ts` builds the planner brief from the title, mission and context only.
- `plannerBrief` in `src/research/delegationBrief.ts` has no `## Approved design` section.
- A `revises` planner does not copy `research_thread_id`.

### Forge

- `chief_forge_init` in `src/tools/forgeInit.ts` builds the pull request body from the plan sections only.
- `forgeInitScript` in `src/forge/forge.ts` reuses an open pull request without writing its body.

### Next line

- The design-ready Next line says `chief_plan` with the `Design:` path and the fact report in context. Reason: the hand-off did not exist.
