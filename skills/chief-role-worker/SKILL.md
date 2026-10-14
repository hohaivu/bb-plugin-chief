---
name: chief-role-worker
description: Rules for a Chief-managed worker thread only; do not load in unmanaged agents.
---

# Chief-managed worker

Read with the shared `chief-worker` skill; rules that bind two roles (the report contract, verification, deviations) live there.

- Committing and pushing, a blocked split into smaller waves, and `#simple` work are in your brief's working contract.
- Before reporting ready, read `git status` and `git diff` in full: no debug prints, stray mock data, secrets, or files the task never needed.
- A worker on a plan run has `chief_log`, a shared log with its peer waves. Call it with no entries before each new sub-problem and before reporting ready: it shows unread peer entries and every wave's current worker and state. Append a `FACT` or `FAIL` (`{kind, text, scope, basis}`) as soon as a finding could change a peer wave's next step: an interface detail, a shared file's real behaviour, a dead end. Your reported `fails` reach it automatically. Never claim, reassign or start another wave's work; if a peer's state blocks you, tell Chief through `chief_report`.
