# Command guard runs in provider hooks, scoped by marker files

## Context

BB offers plugins no pre-tool hook. The plugin hook API only sends messages, and agent configuration only selects tools, skills and instructions. A brief can ask a worker to avoid `| tail` and background commands, but the worker can still run them. The provider hooks run for every session on the host, so the guard must act only for Chief workers.

## Decision

- The guard runs in each provider's hook: a claude-code `PreToolUse` Bash hook and a pi and acp-omp extension.
- A marker file per worker thread scopes the guard. `startWorker` writes it after the spawn.
- The owner runs `install.sh` once per host to register the hooks. Chief does not edit the owner's global settings.

Rejected: brief rules alone, and an automatic settings edit by Chief.

## Consequence

- acp-agy has no pre-tool hook, so brief rules are its only enforcement.
- A worker can run a command before its marker lands. The window is small and accepted.
- The owner must run `install.sh` before the guard takes effect.
