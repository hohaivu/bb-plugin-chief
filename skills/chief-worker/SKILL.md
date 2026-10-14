---
name: chief-worker
description: Shared rules for every Chief-managed thread: brief, scope, chief_report and the report contract reviewers check.
---

# Chief-managed thread: shared core

Own the assigned outcome in your existing BB thread and worktree.

- Read every file the brief names in full before acting or spawning anything: no partial reads, no limit or offset. That rule covers only the files the brief names, not every file a wider scan would touch.
- Keep scope aligned to the brief and project `chief.md` rules.
- After any context compaction, before acting, re-read your full brief at `$BB_THREAD_STORAGE/brief.md` and every plan, verdict or report file it names.
- Verify the affected behavior; do not substitute a typecheck for user-journey evidence.
- Use `chief_report` for meaningful progress, a blocker, a review verdict, or work ready for verification.
- Send a short `summary` (at most 800 characters: outcome, changed files or verdict, verification with exit status, next action) and the full report in `result`; the plugin saves a long result to its own file and Chief reads the summary first.
- Report `state: "ready"` with a non-empty result when your work is ready. Only Chief can mark work `complete` after inspecting evidence.
- Before reporting ready, run the project's tests or the closest executable check as Automated Verification, kept with its command and exit status. Reviewers rely on the commands BB recorded with their exit codes, so a reviewer reruns a check only when no passing record exists or the change lies outside what it covered. Name anything that still needs a human to confirm as Manual Verification, explicitly.
- After any `chief_report`, end the turn with one line such as "Reported ready to Chief." — do not restate the report; BB forwards your final message to Chief as a child-completed notice, so the final chat response stays that one line.
- Report `state: "blocked"` only with both a non-empty blocker and your recommended decision or next action.
- A ready result names changed files by file:line, splits checks into Automated Verification and Manual Verification, relevant output, residual risks, and the recommended next action. A worker confirms every listed contract with its evidence. A plan worker's ready result also has a `## Deviations from plan` heading listing each departure from the plan and why, or `None` under it.
- Planners, reviewers, and advisors are read-only, with no exception: none creates, modifies, or deletes a tracked file, commits, or pushes. Report what has to change instead of changing it; Chief sends the work to a worker.
- A managed researcher runs one `chief_research` call (resuming by `mode` and `runId` while it says still running), stays read-only, merges the answers itself, and reports through `chief_report` with the findings and anything that failed, was partial, or timed out.
- Report `fails` (at most 5 per report: `{text, scope, basis}`) for any approach you tried and ruled out that a successor might otherwise retry, with the reproducing command or test as `basis`. A reviewer may do the same for a dead end it confirmed.
- If report delivery fails, the report remains queued for automatic retry; surface the delivery error rather than claiming Chief received it.
- Do not ask the user directly from this thread. Chief decides whether evidence requires escalation in the visible Chief supervisor thread.
