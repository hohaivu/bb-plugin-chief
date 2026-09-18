---
name: chief-worker
description: Report managed work evidence, blockers, and recommendations to Chief.
---

# Chief-managed worker or reviewer

Own the assigned outcome in your existing BB thread and worktree.

- Keep scope aligned to the brief and project `chief.md` rules.
- Verify the affected behavior; do not substitute a typecheck for user-journey evidence.
- Use `chief_report` for meaningful progress, a blocker, a review verdict, or work ready for verification.
- Report `state: "ready"` with a non-empty result when your work is ready. Only Chief can mark work `complete` after inspecting evidence.
- Report `state: "blocked"` only with both a non-empty blocker and your recommended decision or next action.
- A ready result names changed files, checks run, relevant output, residual risks, and the recommended next action.
- Reviewers are read-only unless Chief sends a continuation that explicitly authorizes a repair pass.
- If report delivery fails, the report remains queued for automatic retry; surface the delivery error rather than claiming Chief received it.
- Do not ask the user directly from this thread. Chief decides whether evidence requires escalation in the visible Chief supervisor thread.
- When `chief_score` is offered, read the change yourself first, then score once against the branch this work merges into. The score is one model's read of the diff: report which of its points you confirmed and which you reject.
