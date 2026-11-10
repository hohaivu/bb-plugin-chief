# Spec Writer runs in parallel on a side worktree

## Context

The Spec Writer ran first on a `spec: true` wave, and the worker waited. Writer-first serialized every spec wave. A chain keeps one task branch and one pull request.

## Decision

The Spec Writer runs in parallel with the worker. It works in a private side worktree on a `bb/` side branch cut from the task branch. Before it reports ready, it folds its `docs/` commits onto the task branch with a fast-forward-only push.

Rejected: a second task branch or pull request, and a write in a shared worktree.

## Consequence

- A reused checkout fast-forwards to the task branch before it reads.
- A rejected push fetches, rebases with no autostash, and pushes again. It never force-pushes.
- The Reviewer scopes a writer by its fold range.
- Pre-plan specs can be stale. The plan wins for the Worker.
