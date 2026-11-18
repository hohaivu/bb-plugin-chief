# One review gate per plan

## Context

A plan ran one review per round. Each rejection needed a retest, a reject streak and a new review, so one plan could cost many rounds. A review could also run on a checkout that had moved on.

## Decision

- One gate per plan, or per unplanned task, holds one reviewer and one tester. Both run in parallel on pinned heads.
- A gate `fix` admits one fresh fix worker. It replaces the gate tester and must make the tests pass.
- A blocked fix run with wrong-test evidence admits at most one corrector tester. A corrector that is not green escalates.
- The gate never starts a second review. *Amended: one advisory re-review may start after a green fix run, see [advisory re-review](2026-11-18-advisory-re-review.md).* A chat-requested change gets a fresh fix run on the unmerged pull request, with no review.

## Consequence

- The fix commit and its tests reach the human without a review.
- Stacked chains get their tests and fixes on the tip branch.
- Cleanup waits for merge proof, so a chat fix can continue the row.
- A gate needs an origin branch.
- This decision supersedes [retest after a fix round](2026-11-10-retest-after-fix-round.md).
