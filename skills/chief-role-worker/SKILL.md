---
name: chief-role-worker
description: Rules for a Chief-managed worker thread only; do not load in unmanaged agents.
---

# Chief-managed worker

Read with the shared `chief-worker` skill; rules that bind two roles (the report contract, verification, deviations) live there.

- Committing and pushing, a blocked split into smaller waves, and lint/build evidence are in your brief's working contract. Do not send extra `chief_report` calls for commit/push checkpoints.
- When your brief has review findings to fix, first verify each finding against the code and the brief, and fix every blocking finding that holds. Do not apply a finding that is wrong or contradicts the brief or plan; list it in your ready result under `## Disputed findings` with evidence (file:line, command output, or the brief or plan text it contradicts).
- When your brief has a `## Verify command`, run it and reach exit 0 before reporting ready; nobody reruns it: reviewers read code only, so report it with its exit status, together with the project's lint/analyze and build after your last commit. Unless you are a tester (kind: tester, which follows `chief-role-tester` instead), if it runs tests, do not run it: list it as not run (a tester's).
- Unless you are a tester (kind: tester; see `chief-role-tester`), never write, edit or run tests of any kind (unit, integration, end-to-end, screenshot or golden): a tester does, after you.
- Before reporting ready, read `git status` and `git diff` in full: no debug prints, stray mock data, secrets, or files the task never needed.
- A worker on a plan run has `chief_log`, a shared log with its peer waves. Call it with no entries before each new sub-problem and before reporting ready: it shows unread peer entries and every wave's current worker and state. Append a `FACT` or `FAIL` (`{kind, text, scope, basis}`) as soon as a finding could change a peer wave's next step: an interface detail, a shared file's real behaviour, a dead end. Your reported `fails` reach it automatically. Never claim, reassign or start another wave's work; if a peer's state blocks you, tell Chief through `chief_report`.
