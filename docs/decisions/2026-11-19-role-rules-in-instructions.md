# Role rules live in instructions

## Context

Skills reached roles weakly. Chief loaded its skill in 2 of 414 sessions. Skills also over-delivered: an advisor got about 8,000 characters of planner text. The [earlier decision](2026-11-13-brief-rules-in-role-skills.md) put the rules in skills and ordered a load in each brief.

## Decision

- Each role and Chief gets its rules from its own prompt, built in code: `src/core/roleRules.ts`, `src/runtime/host.ts` and `reviewerPrompt` in `src/review/reviewStart.ts`.
- No role loads a skill.
- Instructions are not stored, so the 55,000-character brief problem does not return.

## Consequence

- Each Chief turn carries about 2,000 more tokens. The prefix is cached.
- Supersedes [Brief rules live in role skills](2026-11-13-brief-rules-in-role-skills.md).
