# Evidence-only retest needs a complete receipt (superseded by [one review gate per plan](2026-11-18-single-review-gate.md))

## Context

An evidence-only tester reruns existing commands instead of rediscovering them. Without a complete receipt or a pin, such a rerun could pass the retest debt with no valid evidence.

## Decision

- Chief offers the evidence-only option only when the newest ready tester of the chain has a complete receipt.
- An evidence-only tester needs `Expected head: <sha>` in its mission. Its HEAD must equal that commit.
- A missing input, or a fix that needs a test change, makes the tester report blocked. It never reports ready.
- Without a complete receipt, Chief delegates a normal Tester. Normal mode stays the fallback.
- Debt discharge does not change. A ready tester of either mode pays the debt.

Rejected: a default evidence mode, and a plugin refusal of `evidenceOnly`.

## Consequence

- A retest without a complete receipt runs in normal mode, which costs more tokens.
- Chief names the pin in each evidence-only mission.
