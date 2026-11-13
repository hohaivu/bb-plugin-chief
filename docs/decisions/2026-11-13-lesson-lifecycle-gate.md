# One gated lesson store

## Context

Reviewers and advisors could write a lesson, and it reached every prompt at once. A wrong lesson, such as a reviewer false positive, spread without a check. The retro grader adds a second source of lessons.

## Decision

- `chief_lessons` stays the one store. It gets a `status`: `proposed`, `accepted` or `retired`.
- Report-intake lessons and retro lessons start as `proposed`. Only `accepted` lessons reach a prompt.
- Existing rows are `accepted`, so they keep their injection.
- Chief decides with `bb chief lesson accept|retire <id> --reason`.
- Chief does not add a second proposals table.

## Consequence

- A reviewer lesson waits for one Chief decision before it helps anyone.
- The retro and the intake share one lifecycle, one injection query and one CLI.
- The plugin never edits a prompt, a skill or code on its own.
