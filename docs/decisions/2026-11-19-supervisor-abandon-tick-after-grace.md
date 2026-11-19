# Abandon a stuck supervisor tick after a grace

## Context

BB waits 5 seconds for a plugin service to settle after an abort. If the service has not settled, BB marks the plugin degraded and refuses to load the new generation. A supervisor tick awaits several calls in turn, so one slow call can keep the tick running past that wait.

## Decision

The supervisor waits 3 seconds after an abort. It then abandons a tick that still runs. An abandoned tick starts no further top-level step, reconcile row, stall or orphan iteration, or alert delivery. An alert send in flight ends its wait at once.

## Consequence

- An abandoned alert send may still reach its target. Its last error becomes `abandoned`. The next retry checks the target for the marker before it sends again.
- Generations already overlap during reload, because BB runs the new factory before it disposes the old one. This adds no new cross-generation race.
- `sweep()` and `observeCleanup()` take no stop check. An abandoned tick can still start their later reads.
