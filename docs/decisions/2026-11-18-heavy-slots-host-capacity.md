# Heavy commands run through a host slot wrapper with a mutable capacity

## Context

Several Chief workers and testers can run builds and test suites on one computer at once. Each run can use all cores and much memory. A slot count baked into a brief goes stale when the user lowers the `heavySlots` setting. A hook could enforce the wrapper, but the plugin does not own the agent's shell.

## Decision

- The wrapper is an instruction in the brief. The plugin does not enforce it with hooks.
- One host file, `slots`, holds the capacity. Every admission round reads it. No script carries a count.
- The wrapper and the `slots` file sit in `<BB data dir>/chief/heavy/`.
- A script name carries the hash of its content. The plugin never rewrites a published script.

Rejected: a count baked into each script, and enforcement by hooks.

## Consequence

- An agent can bypass the wrapper. The plugin cannot detect a bypass.
- A lowered cap applies to new admissions. Current holders finish.
- Locks use macOS `lockf`. Linux runs unthrottled until a `flock` path exists.
