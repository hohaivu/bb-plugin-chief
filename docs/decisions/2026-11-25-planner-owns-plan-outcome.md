# Planner owns the plan outcome

## Context

A plan advisor and its planner both showed the plan review outcome. The advisor row repeated the planner line. An advisor row can be archived or deleted, and then Chief cannot act on it.

## Decision

The planner row owns the approved or changes outcome. An advisor row shows a line only while it is the advising owner, which is the Missing-Report line for an idle advisor. The first advice from an advisor resolves the plan review on the planner.

## Consequence

- Chief acts on the planner row: the deliver line, the consult line or `chief_plan revises`.
- An archived advisor does not change the outcome, because the advice is recorded on the planner.
- An advisor row shows no approved or changes line.
