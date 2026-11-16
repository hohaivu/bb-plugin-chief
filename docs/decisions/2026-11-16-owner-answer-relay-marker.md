# Owner answers reach a child through a marked relay

## Context

A child Chief asks the owner through a Need you. The owner may answer in the child thread or in the Coordinator thread. The Coordinator must pass a Coordinator-thread answer to the child. A tell from a Coordinator is coordination information by default, so the child cannot tell an owner answer from a coordination fact without a signal.

## Decision

The Coordinator relays the owner's answer with `bb thread tell <child id>`. The message starts with the fixed text `Owner's decision (relayed by Coordinator):`, followed by the answer verbatim. The child treats a tell with that prefix as the owner's decision. No tool, schema or alert kind is added.

## Consequence

- Any thread can send the prefix text. The child trusts it only from its own live Coordinator.
- The relay runs through the Coordinator prompt. When the prompt does not relay, the owner repeats the answer in the child thread.
- The owner's words reach the child unchanged, because the Coordinator adds nothing.
