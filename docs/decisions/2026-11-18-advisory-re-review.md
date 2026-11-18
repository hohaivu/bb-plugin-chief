# One advisory re-review after a green fix run

## Context

A gate reviewer asks for changes. The fix run then makes the tests pass. Until now the gate never starts a second review, so the fixed code reaches the human without a review.

## Decision

- After a green fix run or corrector on a `request_changes` review, one more `chief_review` starts one advisory re-reviewer.
- The gate still passes on the green run. The re-review never starts a fix.
- A gate gets at most one re-review.

## Consequence

- Each gate that needed a fix may run one extra reviewer.
- A fix commit gets a review before the human, but that review never blocks the gate.
- This amends the "never starts a second review" bullet of [one review gate per plan](2026-11-18-single-review-gate.md).
