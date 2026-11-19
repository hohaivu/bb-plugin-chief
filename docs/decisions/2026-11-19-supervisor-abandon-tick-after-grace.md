# Abandon a stuck supervisor tick after a grace

## Context

BB waits 5 seconds for a plugin service to settle after an abort. If the service has not settled, BB marks the plugin degraded and refuses to load the new generation. A supervisor tick awaits several calls in turn, so one slow call can keep the tick running past that wait.

## Decision

The supervisor waits 3 seconds after an abort. It then abandons a tick that still runs. An abandoned tick starts no new operation: no further step, reconcile row, stall or orphan iteration, alert attempt, Chief spawn, cleanup job or read, or git command. A call dispatched before abandonment may finish. The tick writes no state from its result, except one exception: a dispatched Chief spawn that replaces a different Chief records only its row and a pending-handover marker, in one transaction. The next live tick adopts the marker only when both Chiefs stay eligible, and otherwise drops it with no handover.

## Consequence

- An abandoned alert send refunds its attempt and marks the row `uncertain`. The next retry checks the target for the marker before it sends again.
- Accepted limit: the recipient does not deduplicate. A late original send may duplicate one alert. Chief accepts this.
- Generations overlap during reload, because BB runs the new factory before it disposes the old one. A dispatched archive may therefore finish beside a later pass of the next generation.
- No new operation starts after abandonment, so the overlap is limited to calls already dispatched.
- A tick-owned reload sweep stops with the tick, and an independent sweep never does.
