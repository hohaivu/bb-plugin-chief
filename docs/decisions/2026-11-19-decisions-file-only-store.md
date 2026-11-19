# Decisions file is the only store

## Context

Owner decisions reach a Chief through chat, relays and tracker comments. A context compaction removes them from the Chief's context. The Chief needs a record that survives compaction and hand-over. The owner chose a file over a database table.

## Decision

Each Chief and each Coordinator keeps a `decisions.md` in its own thread storage. The server writes the file. No database table and no migration hold decisions.

## Consequence

- Each write reads and rewrites the whole file. The file is capped at 8,000 characters, so the cost stays bounded.
- A failed hand-over copy leaves the successor without the copied entries. The server logs a warning.
- Chat answers and relays reach the file only when the agent passes them in the `decision` field.
- The server cannot check who sent a relay. It trusts the field.
