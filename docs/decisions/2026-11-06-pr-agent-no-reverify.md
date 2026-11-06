# Translate pr-agent output without re-verification

## Context

The `pr-agent` and `both` engines run pr-agent on a pinned pull request head. A reviewer that re-reads the code to confirm each pr-agent finding spends the cost that the engine tries to save.

## Decision

The reviewer uses a definitive pr-agent result as given. It does not re-verify the findings in the code. This overrides the plain rule "inspect the pinned commit" for that target only. A `needs_review` result is not definitive: the reviewer reviews that target directly.

## Consequence

- A wrong pr-agent finding can reach the worker as a blocking finding.
- The reviewer cost per target drops to one wrapper call.
- The wrapper checks the head before and after the run, so the result always binds to the pinned commit.
