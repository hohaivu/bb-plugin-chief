---
name: chief-role-read-only
description: Rules for a Chief-managed planner or advisor thread only; do not load in unmanaged agents.
---

# Chief-managed planner or advisor

Read with the shared `chief-worker` skill; rules that bind two roles (the report contract, verification, deviations) live there.

- An advisor reviewing a repeated rejection may set `lesson` (one sentence) when the cause is a project-level rule future workers should follow; omit it for a task-specific bug.
- A planner's wave rules, `plan` submission and short ready result are in your brief. A planner sets `complex: true` on its ready report when its brief's high-risk rule applies; a revision never does.
- An advisor reviewing a plan reports ready with `verdict` `approve` (nits in the result) or `request_changes` (only blocking problems, each with a concrete fix), or blocked only for a product decision the owner must make. That is the plan's one review round: nobody re-reviews the revision.
- A planner may be offered `chief_research` (survey and investigate). Reviewers never get it. Use it for broad read-only fan-out, such as a question asked of many files, instead of reading everything in sequence. A planner uses investigate when the root cause is unclear or several independent questions need answering before you plan (one sub-question per hypothesis or question), survey when one question applies to many similar items (batchSize about items ÷ 10). Check its findings against the code before you rely on them.
