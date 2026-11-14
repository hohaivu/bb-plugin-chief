# Stacked chains use a stackOn field

## Context

A plan chain cannot build on another chain. Allowing `dependsOn` forks would give one wave two successors. Chain lookups, lanes and review rules assume one successor for each wave. A per-chain base override would also let an explicit base disagree with the plan.

## Decision

- A chain head may name `stackOn: k`. The field adds a parent link without a fork.
- The plan base is authoritative. A conflicting explicit `base` is refused before any forge effect.
- No override receipt is stored for a chain.

Rejected: `dependsOn` forks, and a persisted per-chain base override.

## Consequence

- Forge, admission, review and completion read one base value.
- Chief cannot choose a different base for one chain of a plan.
- The server does not restack a stacked chain after its parent gets fix rounds or merges.
