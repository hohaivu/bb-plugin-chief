# Documentation Index

| Domain | Spec file | Key code paths | One-line summary |
| --- | --- | --- | --- |
| Forge comments | [forge-comments.md](specs/forge-comments.md) | `forgeComments.ts`, `server.ts` (content builders, `chief_escalate`) | Chief's optional, durable record of task events on the PR or tracking issue. |
| Plan chains | [plan-chains.md](specs/plan-chains.md) | `waveSchedule.ts`, `planLifecycle.ts`, `server.ts` (`startWorker`, `chief_forge_init`, `cleanupStep`), `planProgress.ts`, `reviewStart.ts`, `reviewLedger.ts` | One branch, pull request, and worker worktree per plan chain. |
| Checkout freshness | [checkout-freshness.md](specs/checkout-freshness.md) | `checkoutSync.ts`, `server.ts` (`freshenChiefCheckout`, `reportStamp`, `startPlan`, `report`), `research.ts` (`startResearcher`), `reportIntake.ts` (`reportAlert`, `reportFileBody`) | Chief fast-forwards its checkout before a researcher or planner reads it, and their reports say which commit they read. |
| Tool-call stability | [tool-call-stability.md](specs/tool-call-stability.md) | `server.ts` (`bb.agents.configure`, `experimental_contributeEnv`, `delegateShape`/`planParams`/`consultParams`/`spawnParams`, CLI `plan`/`consult`/`delegate`) | How Chief and managed threads get chief_* tool schemas before their first call, and which tool inputs default. |

## Active decisions

None.
