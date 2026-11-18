# Design discussion runs in the researcher thread

## Context

A feature or a multi-file change needs a design that the user approves. A researcher must find facts without the ticket's proposed change. The user must answer the design questions, and stall alerts must not fire while the researcher waits.

## Decision

The researcher owns stages 1 to 3: neutral questions, ticket-blind helpers and a design discussion in its own thread. Ticket-blindness and neutral questions are prompt rules. The user answers in the researcher thread. A stored `waiting_on_user` flag mutes stall alerts while the researcher waits.

Rejected: a second research tool, a server-side filter on question wording, a new model setting, a Chief-side timeout and giving the researcher `chief_escalate`.

## Consequence

- A waiting researcher has no timeout. Its stall alerts stay muted until its next report.
- When the thread cannot ask the user, the researcher reports blocked. Chief escalates the round with Need you.
- Any later report clears the flag. A failed live state clears it too.
