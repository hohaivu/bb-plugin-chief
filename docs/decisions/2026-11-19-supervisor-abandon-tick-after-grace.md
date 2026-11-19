# Abandon a stuck supervisor tick after a grace

## Context

BB waits 5 seconds for a plugin service to settle after an abort. If the service has not settled, BB marks the plugin degraded and refuses to load the new generation. A supervisor tick awaits several calls in turn, so one slow call can keep the tick running past that wait.

## Decision

The supervisor waits 3 seconds after an abort. It then abandons a tick that still runs. An abandoned tick starts no further step, and only its in-flight call may finish.

## Consequence

- An abandoned in-flight alert send may finish after the next generation loads. Its database write then fails, because BB closes the database.
- Alert sends already tolerate this. Attempts are counted before the send, and retries check a marker.
- Generations already overlap during reload, so this adds no new cross-generation race.
