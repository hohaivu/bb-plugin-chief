# Brief rules live in role skills

## Context

Every brief repeated the same working contract, git workflow and fold steps. One plan spent about 55,000 characters on this text. The skills of each role held most of the same rules.

## Decision

- The brief keeps only dynamic values and one role-boundary line.
- The `chief-worker` and `chief-role-*` skills hold the static rules.
- The brief orders a full skill load before any task or repository file read, by the Skill tool or by a full `SKILL.md` read.

## Consequence

- The plugin offers skills but cannot check that an agent loaded them. A skipped load drops the rules without a signal.
- Mitigation: one load line without a provider branch, a blocked report when a skill cannot load, and a skill reload after a context compaction.
- Mitigation: a manual canary on each provider before merge. A miss on a provider keeps the inline rules for that provider.
