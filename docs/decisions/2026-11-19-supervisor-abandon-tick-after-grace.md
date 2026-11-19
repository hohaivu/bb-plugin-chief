# Abandon a stuck supervisor tick after a grace

## Context

BB waits 5 seconds for a plugin service to settle after an abort. If the service has not settled, BB marks the plugin degraded and refuses to load the new generation. A supervisor tick awaits several calls in turn, so one slow call can keep the tick running past that wait.

## Decision

The supervisor waits 3 seconds after an abort. It then abandons a tick that still runs. An abandoned tick starts no new operation: no further step, reconcile row, stall or orphan iteration, alert attempt, or cleanup read or archive. A call dispatched before abandonment may finish, and the tick writes no state from its result.

## Consequence

- An abandoned alert send may still reach its target. Its last error becomes `abandoned`. The next retry checks the target for the marker before it sends again.
- Generations overlap during reload, because BB runs the new factory before it disposes the old one. A dispatched archive may therefore finish beside a later pass of the next generation.
- No new operation starts after abandonment, so the overlap is limited to calls already dispatched.
