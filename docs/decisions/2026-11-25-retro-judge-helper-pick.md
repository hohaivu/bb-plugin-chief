# The retro judge uses the research helper pick first

## Context

The retro judge reads logs and scores them against a fixed rubric. It does not need the strongest model. The researcher pick is for research work, and the owner may set it to a stronger model. The `research-helper` role is the cheaper pick for research helper work.

## Decision

The retro judge (`judgeModel`) reads the `research-helper` pick first. When that pick is unset or unusable, it reads the `researcher` pick. When both are unusable, it uses the BB default.

Rejected: a separate judge role with its own pick. It adds a control that the owner does not need.

## Consequence

- Judges run on the helper model when the owner sets it. The judge score quality depends on that model.
- A researcher pick change no longer changes the judge model while a helper pick is set.
- The order is in code only. The 2026-11-17 decision no longer describes the judge model.
