# Coordinator stays a Chief row with two nullable columns

## Context

A Coordinator supervises child Chiefs. A new `role` value would need a rebuild of `managed_threads`, because the role check lives in the table. The column `chief_thread_id` already means "managed work of this Chief". Every alert, stall, sweep, roster and target path reads it that way.

## Decision

A Coordinator keeps `role='chief'`. Two appended columns hold the state: `coordinator` on the Coordinator row and `coordinator_thread_id` on a child row. The link never uses `chief_thread_id`.

## Consequence

- No table rebuild. Existing rows keep null values.
- Code that selects Chiefs must exclude Coordinators where a plain Chief is meant (project-level routing).
- Managed-work paths never see a child Chief as managed work.
