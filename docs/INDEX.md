# Documentation Index

| Domain | Spec file | Key code paths | One-line summary |
| --- | --- | --- | --- |
| Forge comments | [forge-comments.md](specs/forge-comments.md) | `forgeComments.ts`, `server.ts` (content builders, `chief_escalate`) | Chief's optional, durable record of task events on the PR or tracking issue. |
| Plan chains | [plan-chains.md](specs/plan-chains.md) | `waveSchedule.ts`, `planLifecycle.ts`, `server.ts` (`startWorker`, `chief_forge_init`, `cleanupStep`), `planProgress.ts` (`reviewAdvice`, `onSpecChain`), `reviewStart.ts`, `reviewLedger.ts` | One branch, pull request, and worker worktree per plan chain. |
| Checkout freshness | [checkout-freshness.md](specs/checkout-freshness.md) | `checkoutSync.ts`, `server.ts` (`freshenChiefCheckout`, `reportStamp`, `startPlan`), `research.ts` (`startResearcher`), `reportIntake.ts` (`report`, `reportAlert`, `reportFileBody`) | Chief fast-forwards its checkout before a researcher or planner reads it, and their reports say which commit they read. |
| Report intake | [report-intake.md](specs/report-intake.md) | `reportIntake.ts` (`createReportIntake`, `checkReport`, `reportAlert`, `verdictFileBody`, `reportFileBody`), `server.ts` (`chief_report`, adapters) | One owner for `chief_report` acceptance and publication: required state first, then optional files and the alert. |
| Tool-call stability | [tool-call-stability.md](specs/tool-call-stability.md) | `server.ts` (`bb.agents.configure`, `experimental_contributeEnv`, `delegateShape`/`planParams`/`consultParams`/`spawnParams`, CLI `plan`/`consult`/`delegate`) | How Chief and managed threads get chief_* tool schemas before their first call, and which tool inputs default. |
| Review engine | [review-engine.md](specs/review-engine.md) | `prAgent.ts`, `reviewStart.ts` (`startReview`), `server.ts` (settings `reviewEngine`/`prAgentDir`) | How a worker reviewer forms its verdict: reading code, pr-agent per pinned target, or both, with a direct-review fallback. |
| Work list | [work-list.md](specs/work-list.md) | `server.ts` (`chief_roster` Pending block, `chief_todos`, `bb chief status`, `handOver`, `unpinPendingTab`) | Chief's work list is the roster's Pending block; the Chief to-do side panel is removed. |
| Tracker | [tracker.md](specs/tracker.md) | `tracker.ts`, `trackerSync.ts`, `trackerBbTasks.ts`, `server.ts` (settings `tracker`/`trackerProjects`, `startPlan`, `startWorker`, `chief_escalate`, supervisor), `reportIntake.ts` (`trackFiles`) | Optional mirror of Chief work to a task tracker behind a replaceable protocol; owner answers reach Chief once through the plugin. |

## Active decisions

- [Translate pr-agent output without re-verification](decisions/2026-11-06-pr-agent-no-reverify.md)
- [Plugin polling owns tracker answers](decisions/2026-11-09-tracker-answers-plugin-poll.md)
