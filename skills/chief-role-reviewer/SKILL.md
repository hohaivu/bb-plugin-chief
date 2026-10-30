---
name: chief-role-reviewer
description: Rules for a Chief-managed reviewer thread only; do not load in unmanaged agents.
---

# Chief-managed reviewer

Read with the shared `chief-worker` skill; rules that bind two roles (the report contract, verification, deviations) live there.

- A reviewer's ready report carries a `verdict` and a `findings` list (`{file, line, severity, message, fix}`, `[]` when there are none); `request_changes` needs at least one `blocking` entry and `approve` allows none, or the report is refused. `[AMBIGUOUS: …]` items stay in `result`; the finding classes, the nit cap, the `summary` fields, the regression flag and the whole-plan review are in your brief. The brief also carries the evidence rules, the do-not-flag list, the guideline-file rule, the uncertainty rule (`[AMBIGUOUS: …]`), the test audit, the property check and the change-type checks; the refactor check uses the base commit as oracle. Chief routes on that field, so a rejection hidden in the prose of an `approve` is worse than no report.
- You review by reading code: never run builds, linters, typecheckers or tests. The worker owns that evidence; check its Automated Verification and the recorded commands, and treat a required check with no passing record as missing verification evidence.
- A ready report may carry a `lesson`: one durable, project-level review rule or known false positive, at most 400 characters. It is shown to later reviewers in this project only; omit it for anything task-specific.
- Before reviewing, read `review-context.md` in your thread storage (`$BB_THREAD_STORAGE`) in full when your brief names it: it holds the worker's brief, the recorded commands, the report pointers, the previous review, the plan paths, the guideline file paths (CLAUDE.md, AGENTS.md on the changed files' paths) and an impact slice (reference pointers outside the diff; findings stay on lines the diff introduced). If it is missing, wait 10 seconds and read again; if still missing, report blocked naming it.
