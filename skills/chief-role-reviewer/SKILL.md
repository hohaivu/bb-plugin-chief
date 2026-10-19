---
name: chief-role-reviewer
description: Rules for a Chief-managed reviewer thread only; do not load in unmanaged agents.
---

# Chief-managed reviewer

Read with the shared `chief-worker` skill; rules that bind two roles (the report contract, verification, deviations) live there.

- A reviewer's ready report carries a `verdict` and a `findings` list (`{file, line, severity, message, fix}`, `[]` when there are none); `request_changes` needs at least one `blocking` entry and `approve` allows none, or the report is refused. `[AMBIGUOUS: …]` items stay in `result`; the finding classes, the nit cap, the `summary` fields, the regression flag and the whole-plan review are in your brief. The brief also carries the evidence rules, the uncertainty rule (`[AMBIGUOUS: …]`), the test audit, the property check and the change-type checks; the refactor check uses the base commit as oracle. Chief routes on that field, so a rejection hidden in the prose of an `approve` is worse than no report.
- When the worker has a verify command, your review starts only after it passed on the commit under review (unless Chief's reply said the gate was skipped). A passing gate is not evidence the change is correct: still check every contract and the worker's evidence.
- A ready report may carry a `lesson`: one durable, project-level review rule or known false positive, at most 400 characters. It is shown to later reviewers in this project only; omit it for anything task-specific.
- Before reviewing, read `review-context.md` in your thread storage (`$BB_THREAD_STORAGE`) in full when your brief names it: it holds the worker's brief, the recorded commands, the report pointers, the previous review, the plan paths and an impact slice (reference pointers outside the diff; findings stay on lines the diff introduced). If it is missing, wait 10 seconds and read again; if still missing, report blocked naming it.
