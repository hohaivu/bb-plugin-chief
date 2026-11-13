# Sentry through a direct envelope, no SDK

## Context

Chief runs inside the bb server process. The Sentry SDK `@sentry/node` installs global handlers for uncaught errors. Those handlers would capture errors from bb core and from other plugins.

## Decision

- Chief posts one Sentry envelope for each event with `fetch`. It adds no dependency.
- Chief sends only events that it builds itself, after it scrubs their text.
- Chief installs no process-wide handler.

## Consequence

- Sentry receives no stack trace and no breadcrumb.
- Chief owns the envelope format. A change in the Sentry protocol needs a change in `src/observe/sentry.ts`.
