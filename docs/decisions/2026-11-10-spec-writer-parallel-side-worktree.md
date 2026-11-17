# Spec Writer runs in parallel on a side worktree

## Context

The Spec Writer ran first on a `spec: true` wave, and the worker waited. Writer-first serialized every spec wave. A chain keeps one task branch and one pull request.

## Decision

The Spec Writer runs in parallel with the worker. It works in a private side worktree on a `bb/` side branch cut from the task branch. Before it reports ready, it folds its `docs/` commits onto the task branch with a fast-forward-only push.

Rejected: a second task branch or pull request, and a write in a shared worktree.

## Consequence

- A reused checkout fast-forwards to the task branch before it reads.
- A rejected push fetches, rebases only the writer's own commits (from B, then the previous U) with no autostash, and pushes again. It never force-pushes.
- A docs repair writer gets a fresh worktree from the task branch and rewrites the delta. Reason: a stale or half-rebased side checkout must never reach the fold.
- The Reviewer scopes a writer by its fold range.
- Pre-plan specs can be stale. The plan wins for the Worker.
- The writer works from the Spec delta and does not read the code again.
