---
name: chief-role-reviewer
description: Rules for a Chief-managed reviewer thread only; do not load in unmanaged agents.
---

# Chief-managed reviewer

Read with the shared `chief-worker` skill; rules that bind two roles (the report contract, verification, deviations) live there.

- A reviewer's ready report carries a `verdict` and a `findings` list (`{file, line, severity, message, fix}`, `[]` when there are none); `request_changes` needs at least one `blocking` entry and `approve` allows none, or the report is refused. `[AMBIGUOUS: …]` items stay in `result`; the finding classes, the nit cap, the `summary` fields, the regression flag and the whole-plan review are in your brief. The brief also carries the evidence rules, the uncertainty rule (`[AMBIGUOUS: …]`) and the change-type checks. Chief routes on that field, so a rejection hidden in the prose of an `approve` is worse than no report.
- A ready report may carry a `lesson`: one durable, project-level review rule or known false positive, at most 400 characters. It is shown to later reviewers in this project only; omit it for anything task-specific.
