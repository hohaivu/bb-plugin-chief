# Horizontal block waves may waive tests

## Context

A horizontal plan splits work into parallel block waves. Each block wave builds one contract slice on its own branch. Its tests cover only that slice, because the system does not exist until the integrate wave merges the blocks. The rule in [workers write and run their tests](2026-11-19-workers-write-tests.md) asks every implementation wave to carry its own tests. That rule adds work to block waves that the integrate wave repeats.

## Decision

- A wave brief may waive tests for a horizontal block wave. The block worker runs build and typecheck only.
- The integrate wave of the same plan keeps the test rule and runs system tests.
- The waiver is text only. The plugin adds no code guard.

## Consequence

- Block waves carry no test evidence until the integrate wave runs.
- The integrate wave holds the test risk of every block.
- This decision amends [workers write and run their tests](2026-11-19-workers-write-tests.md) for block waves only.
