# Only a Spec Writer changes docs

## Context

Workers could change `docs/` on non-spec chains and on unplanned work. A shared task branch then holds docs commits with no clear owner.

## Decision

- Only a Spec Writer changes `docs/`, on every wave and on unplanned work.
- Every Spec Writer commit carries the trailer `Chief-Spec-Writer: <thread id>`. The reviewer also accepts a reported range, because legacy writers have no trailer.
- Every review carries a prompt rule. It blocks a docs commit that no Spec Writer of this task owns.
- A later Spec Writer can adopt such a commit under `## Adopted docs commits`.
- A deterministic gate runs only at `skipReview`, on the pushed head. When it cannot run, the skip proceeds and the reply says why.

Rejected: a worker revert (it is itself a docs change, and history keeps the violation), a history rewrite, a refusal in `chief_report`, and a gate on approve.

## Consequence

- A branch with legacy trailerless docs commits needs `chief_review` or `override` instead of `skipReview`.
- The trailer is cooperative attribution. It is not a security boundary.
