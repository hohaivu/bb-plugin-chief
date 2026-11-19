# One Spec Writer per plan

## Context

Each spec wave ran its own Spec Writer beside its worker. A three-wave plan ran six threads. Each writer also started before the code of its wave existed.

## Decision

A plan gets one Spec Writer. It runs once, after every wave of the plan is ready. It turns the `## Spec delta` of every spec wave into `docs/` and folds the docs onto the task branch. The owner chose this option. Going without it uses `chief_skip_specs`.

This supersedes the "runs in parallel" part of [the side-lane decision](2026-11-10-spec-writer-parallel-side-worktree.md). The side worktree and the fold stay.

## Consequence

- Docs arrive after the code. The review waits for them.
- A multi-chain plan folds every delta onto the chain of its last spec wave.
- Legacy plans with per-wave writers keep working until their writers settle.
