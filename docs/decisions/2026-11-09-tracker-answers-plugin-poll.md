# Plugin polling owns tracker answers

## Context

The owner may answer a decision on the tracker task. bb Tasks has a native Notify. It delivers a comment to the thread that wrote the latest agent reply of the task. The delivery is fire-and-forget. Its prompt tells the model to run `bb tasks comment`. The owner forbids tracker commands for the Chief model.

## Decision

The plugin polls the task comments and is the only owner of answer delivery. Chief posts decision comments with no thread identity and never passes `--notify`. Chief is therefore never the agent responder of the task. The plugin writes one alert to the existing outbox.

## Consequence

- One owner answer gives Chief one alert, with Notify on or off.
- The outbox retry and the hand-over re-targeting apply to the alert.
- The poll runs at most once in 60 s for each unit. The supervisor cycle is 30 s.
