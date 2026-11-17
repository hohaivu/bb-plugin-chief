# Research

## Purpose

The research domain lets Chief start a read-only researcher thread for one question. The researcher answers alone, or it splits the question across helper threads. It reports its merged answer through `chief_report`.

## Domain Terms

- **Researcher**: a managed thread with role `researcher`. It reads code and writes no code.
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
| `researcherBrief` | `src/research/research.ts` | Build the researcher's prompt. |
| `modelConfiguration`, `setRoleModel` | `src/runtime/host.ts` | Read and write the researcher pick. |
| `researchChiefInstructions`, `bb.agents.configure` | `src/runtime/host.ts` | Give Chief the research tool and its instruction. |
| `chief_models_v9` | `src/db/migrations.ts` | Stores the researcher pick and seeds it once. |
| `judgeModel` | `src/observe/retro.ts` | Reads the researcher pick for the retro judge. |

## Flows and States

### Start a researcher

1. Chief calls `chief_research` with `question` and, optionally, `branch`.
2. `research` checks the caller and the research switch.
3. `startResearcher` reads Chief's environment and the host of that environment.
4. `managedSpawn.prepare` resolves the researcher's execution: the usable pick, else the BB default.
5. `startResearcher` refuses when the target model cools down or the preflight check blocks it.
6. `startResearcher` refuses when there is no `branch` and no reusable environment.
7. Without a `branch`, `freshenCheckout` fast-forwards Chief's checkout once.
8. `managedSpawn.launch` starts the researcher and writes its managed row.
9. The tool returns the researcher thread id at once.

### Caller check

| Caller | Outcome |
| --- | --- |
| Active registered Chief, research on | Allowed. |
| Inactive or finished Chief | Refused: `chief_research requires an active registered Chief thread.` |
| Planner, researcher, worker, reviewer, advisor or unmanaged thread | Refused: `chief_research is available only to an active Chief. A planner splits a broad scan across read-only helper threads (chief-role-read-only skill).` |
| Research switched off | Refused: `chief_research is off in Chief settings → Chief researcher.` |

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

The researcher follows its brief:

1. Decide how to work. Answer alone when the question is narrow. Split it when its parts are independent.
2. Spawn at most 6 helper threads, one part each. Work on the rest while they run.
3. Give each helper the read-only rule, its part, the overall goal and the evidence rule.
4. Wait for each helper with `bb thread wait <id> --status idle --timeout 540s`. Read its answer with `bb thread output <id>`.
5. Stop a helper that failed or is still not idle after a second wait. List it as a failure.
6. Check every answer the result relies on against the code. Mark or drop answers the evidence does not support.
7. Stop every helper still running, then report.

The researcher never polls with sleep loops.

### Report

- The researcher reports with `chief_report` state `ready`. The first result line is `Helpers: <n>`, and `Helpers: 0` means it worked alone.
- The result has `## Confirmed` (each answer with its evidence) and `## Unconfirmed` sections.
- Failed or stopped helpers are named. A part with no answer makes the result partial.
- When nothing usable comes back, the researcher reports blocked. It names the cause as the blocker.

### Supervision

- A researcher is supervised like every other managed thread: the stall alert, `chief_stop` and `chief_continue`.
- Its report arrives as a lifecycle alert. Its Next line says the research is advisory and needs no review or completion.

## Contracts

### Chief-only tool

- `chief_research` is Chief-only. Reason: Chief decides when research runs. A planner uses its own helper threads.
- `question` is 1 to 4,000 characters after trimming. Reason: not stated in the code.
- `branch` is optional, 1 to 300 characters, and only Chief may pass it. Reason: a researcher already reads its own worktree.
- Every call writes one `chief_research_calls` row. `mode` and `run_id` are null, and `outcome` is `spawned` or `error`. Reason: the roster counts research calls.
- Every refusal happens before any thread exists. Reason: a refused call leaves Chief's checkout as it was.
- The reply names the researcher thread and its title, then says `Do not poll: end your turn.` Reason: the report arrives as a lifecycle alert.
- The title is `Research · <question clipped to 60 characters>`.

### Researcher start

- The spawn goes through `managedSpawn.prepare` with role `researcher`. Reason: the researcher uses the same model path as a worker.
- A target that cools down refuses the call before any spawn. Reason: a spawn on a cooling model would fail.
- A preflight block refuses the call. The message names the blocked provider and asks for another pick or a retry after the reset. Reason: a provider that is not installed or is out of quota cannot run.
- A refused call does not freshen Chief's checkout. Reason: a refusal leaves the checkout as it was.

### Researcher model

- `researcher` is a role of `chief_models`. Settings → Chief models by machine edits it with the same picker as Worker. Reason: each role has one model control.
- `setRoleModel({ role: "researcher", selection })` stores a pick. `selection: null` clears it, and a later start does not re-import it. Reason: the seed runs once, in the migration.
- At runtime, no code path falls back to Chief's model, Worker's model or a research-mode pick. Reason: each role has one model source.
- The retro judge (`judgeModel`) reads the researcher pick. Reason: the investigate pick is no longer editable, so the judge follows the researcher pick.

### Helper threads

- A researcher spawns at most 6 helper threads (`RESEARCH_MAX_HELPERS`). Reason: a fixed bound keeps quota use safe. The bound is in the prompt only, and no server code enforces it.
- A helper shares the researcher's environment. It starts with `--parent-self` and `--lifecycle-owner-thread` set to the researcher. Reason: the helper reads the same checkout and reports to its researcher.
- A helper gets `--provider` and `--model` only when the researcher has a pick. Reason: the helper runs on the researcher's model.
- Each helper prompt states the read-only rule. Helpers do not spawn threads.
- A helper has no managed row and no `chief_*` tools. Reason: not stated in the code.

### Tool exposure

- `bb.agents.configure` gives `chief_research` to Chief only when research is enabled. Reason: planners and researchers do not start researchers.
- A planner and a researcher get no research instruction line. Reason: a researcher's brief covers its own work.
- Chief's instruction says that a call starts a researcher thread. It also says when to call and when not to rerun a partial answer.

### Settings

- The research settings hold one field, `enabled`. A patch with `maxAgentCalls` or `timeoutMinutes` is refused by the strict schema. Reason: the cap and timeouts belonged to the workflow path.
- `researchConfiguration` returns only `{ settings }`. Reason: model picks live in `modelConfiguration`.
- The RPC contract has no `setResearchModel`. Reason: the researcher pick uses `setRoleModel`.
- Old stored settings keys and the `research_mode_models` table stay in place and are not read. Reason: the migration drops no data.

### Roster

- The roster counts a Chief `spawned` row as a call and as a success. Reason: a spawned researcher has no run outcome to count.
- The roster output keeps the shape `{ role, mode, calls, succeeded }`. Historical non-Chief rows count as before.

### Removed mechanisms

- No BB workflow runs research. Only `src/observe/retro.ts` calls `runWorkflowCli`. Reason: the researcher decides its own work.
- No agent-call cap, per-mode timeout, server hard stop or unreported-run alert exists. Reason: the stall alert and `chief_stop` replace them.
- A researcher that waits on helpers stays active. A long run can raise the stall alert. Reason: intended, because the stall alert replaces the hard timeout.

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

## Related Decisions

- [Researcher is a normal agent with a role model](../decisions/2026-11-17-researcher-normal-agent.md)
- Related specs: [checkout-freshness.md](checkout-freshness.md), [report-intake.md](report-intake.md), [observability.md](observability.md).

## Baseline: Behaviour Before This Change

This section describes the code at base commit `b8ec18e`. The sections above describe the behaviour after this change.

### Research call and modes

- `chief_research` runs one of two modes, `survey` or `investigate`. Each mode starts a BB workflow from `RESEARCH_SCRIPTS` through `runWorkflowCli`. (`src/research/research.ts`, `createResearch`)
- `researchParams` in `src/research/research.ts` takes `mode`, `question`, `items`, `batchSize`, `questions`, `verify`, `models`, `runId` and `branch`. A new run needs `mode` and `question`, and also `items` or `questions` for its mode.
- Chief, planners and researchers may use both modes. Reason: not stated in the code.
- A call with `runId` waits on that run. A call that reaches its deadline returns `Still running` and the run continues.
- A Chief call starts a researcher thread. That researcher calls `chief_research` again with its mode and `runId` until the run ends. (`startResearcher`, `researchRun`)

### Caller checks

- `researchCaller` refuses unmanaged threads, finished rows, an inactive Chief, roles it does not know, modes a role may not use, and research switched off. Reason: the code says unmanaged threads have no row, which stops recursion.
- `research` writes one `chief_research_calls` row in a `finally` block for every call. The row holds `mode` and `run_id`.

### Models

- `researchModels` reads the mode's pick from `research_mode_models` through `readResearchModel` (`src/runtime/settings.ts`). A pick that the host cannot serve is dropped, and its stages use the caller's model.
- A researcher child runs on the mode's pick, else on Chief's own model. Reason: not stated in the code.
- A Chief call refuses when Chief's own provider and model cannot be read. Reason: the researcher thread must be pinned to a known model.

### Start and environment

- `researchPrepare` refuses on the call cap, the model, the cooldown and the quota. It refuses before any spawn.
- `startResearcher` refuses when Chief has no reusable environment and no `branch`. Reason: the researcher reads Chief's working tree.
- `startResearcher` freshens Chief's checkout after the refusal checks, unless `branch` is set. Reason: the researcher reads Chief's checkout.
- The reply says `Started researcher thread … It runs the <mode> in your checkout`.

### Supervision

- `checkUnreported` runs in the supervisor loop of `src/runtime/lifecycle.ts`. For a researcher whose run ended without a report, it saves the result and alerts Chief after a 3-minute grace period. (`RESEARCH_REPORT_GRACE_MS`)
- `checkUnreported` alerts Chief after 5 failed status reads in a row. (`RESEARCH_UNREAD_LIMIT`)
- A server timer stops a run at its mode's timeout. It makes up to 5 stop rounds, 30 seconds apart. Reason: the server keeps the hard stop so it does not depend on the child resuming.

### Settings

- `researchEnabled` is the research switch. (`src/runtime/core.ts`)
- `researchMaxAgentCalls` has a default of 24 and accepts 1 to 100. (`src/runtime/core.ts`)
- `researchSurveyTimeoutMinutes` and `researchInvestigateTimeoutMinutes` each have a default of 10 minutes and accept 1 to 60. (`src/runtime/core.ts`)
- `setResearchModel` stores a per-mode pick in `research_mode_models`. (`writeResearchModel`, `src/runtime/settings.ts`)
