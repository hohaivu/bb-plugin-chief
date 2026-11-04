# Documentation Index

| Domain | Spec file | Key code paths | One-line summary |
| --- | --- | --- | --- |
| Forge comments | [forge-comments.md](specs/forge-comments.md) | `forgeComments.ts`, `server.ts` (content builders, `chief_escalate`) | Chief's optional, durable record of task events on the PR or tracking issue. |
| Plan chains | [plan-chains.md](specs/plan-chains.md) | `waveSchedule.ts`, `planLifecycle.ts`, `server.ts` (`startWorker`, `chief_forge_init`), `planProgress.ts` | One branch, pull request, and worker worktree per plan chain. |

## Active decisions

None.
