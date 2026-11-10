# Retest after a fix round gates the review

## Context

After a rejection, a worker fixes the code. The next review could start with no test rerun. A fix after a rejection is the riskiest change, and one review covers every chain of the plan.

## Decision

- After a rejection, `chief_review` is refused while a covered chain owes a rerun. Before a review, the rerun stays advice, because no verdict exists to invalidate.
- A Tester that started after the fix and reported ready discharges the debt. Row creation does not, because it proves nothing about the tests.
- `retestSkipped` waives every listed rerun, not one. A review covers all chains, so one reason covers the whole list.
- The retest Tester skips the consult and user rungs. The rerun adds no new rejection. Every other replacement keeps them.

Rejected: a per-fix waiver, and a gate that counts Tester rows.

## Consequence

- Chief gets one legal hand-off to the live chain owner in each refusal.
- Reviewers see each waived rerun in their brief.
