---
name: chief-role-reviewer
description: Rules for a Chief-managed reviewer thread only; do not load in unmanaged agents.
---

# Chief-managed reviewer

Read with the shared `chief-worker` skill; rules that bind two roles (the report contract, verification, deviations) live there.

- A reviewer's ready report carries a `verdict`; the finding classes, the nit cap, the `summary` fields, the regression flag and the whole-plan review are in your brief. The brief also carries the evidence rules, the uncertainty rule (`[AMBIGUOUS: …]`) and the change-type checks. Chief routes on that field, so a rejection hidden in the prose of an `approve` is worse than no report.
