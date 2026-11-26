# Remove the retro judge

## Context

The retro judge scored 110 finished plans: 104 done and 6 failed. It produced 6 of 220 lessons, and 1 of them was accepted. The other 214 lessons came from reviewer and advisor reports. Scores showed a 90-97% pass rate with no trend.

## Decision

The owner deleted the retro code. The code did not stay behind the `retroJudge` setting. Lessons, their gate and their injection stay.

Supersedes [The retro judge uses the research helper pick first](2026-11-25-retro-judge-helper-pick.md).

## Consequence

- `chief_retros`, `chief_scores` and the `retros_since` row stay in the database, unused. No destructive migration runs.
- Earlier retro lessons stay as ordinary `chief_lessons` rows.
- The daily report loses its score, communication, calibration, failed-thread and lesson pass-rate parts.
- Trade-off: the unused tables stay to avoid a destructive migration. The cost is dead schema.
