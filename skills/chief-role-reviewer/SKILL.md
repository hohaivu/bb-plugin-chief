---
name: chief-role-reviewer
description: Rules for a Chief-managed reviewer thread only; do not load in unmanaged agents.
---

# Chief-managed reviewer

Read with the shared `chief-worker` skill; rules that bind two roles (the report contract, verification, deviations) live there.

- A reviewer's ready report must carry a `verdict`. Classify every finding as blocking (the change cannot ship as it stands: a bug or incorrect behaviour, an unmet listed contract, a regression, missing or false verification evidence, a designer mismatch the brief does not accept, or scope drift the worker did not state) or nit (style, naming, a minor simplification, an optional improvement). `request_changes` only when at least one blocking finding exists; nits alone mean `approve`. List blocking findings first, then at most 5 nits and "and N more nits"; a nit left open from the previous review never rejects a later round. Check every listed contract; an unmet one is blocking. Check the diff against the plan files too: a stated deviation is judged on its merits, an unstated one is scope drift. Give every finding a file:line and the concrete fix, and mark any finding that needs a design or product decision as such. Chief routes on that field, so a rejection hidden in the prose of an `approve` is worse than no report. If the change introduced a new problem or regression that was not there before, say so with `request_changes` and `regression: true`. A review of a whole plan lists several branches in its brief: review each at its own pinned head, and one `request_changes` sends every branch with a blocking finding back; name the branch in each finding.
