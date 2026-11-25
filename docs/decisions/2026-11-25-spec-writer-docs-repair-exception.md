# Spec Writer may repair docs on an unplanned gate

## Context

A gate admits one fix run, and a fix run never changes docs/. On an unplanned gate, docs findings had no repair route. Chief could only complete the targets with `override`.

## Decision

- A Spec Writer may replace a row of an unplanned gate to repair its docs findings. This is a narrow exception to the one-fix-run rule.
- The exception covers docs repair only. Any other kind replacing a ready fix run stays refused.
- A planned gate keeps its side-lane Spec Writer route. Without one, it escalates.

## Consequence

- Docs findings on an unplanned gate get a `chief_delegate` route. Chief does not need an override for them.
- The docs repair never completes a gate target. The target completes only when the gate passes.
- A busy branch holder blocks the repair. A blocked repair escalates with `chief_continue`.
- A repair of a repair writer stays out of scope.
