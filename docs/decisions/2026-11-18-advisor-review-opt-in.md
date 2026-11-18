# Advisor review is opt-in at Chief's discretion

## Context

The plugin required one advisor review for each plan with more than one implementation wave or a `complex` mark. The owner decided that the advisor is an optional consult, not a gate.

## Decision

- The plugin never requires a plan review by itself.
- Chief starts a plan advisor with `chief_consult planThreadId` when Chief chooses.
- A plan advisor that Chief started blocks forge init and delegation while it runs.

## Consequence

- Multi-wave and high-risk plans get no automatic review. The trade-off is accepted.
- The plugin states no criteria for when Chief consults.
- The rule "one advisor review per multi-wave or complex plan" is superseded.
- A `request_changes` or blocked advisor still routes to `chief_plan revises`.
