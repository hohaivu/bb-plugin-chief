# Chief keeps tool search

## Context

A Chief thread started with about 63k tokens of context. Chief contributed `ENABLE_TOOL_SEARCH=false` for its own rows, so Claude Code loaded every built-in and MCP tool schema. The plugin SDK gives an agent plugin no per-thread `disallowedTools` and no MCP-server selection. Deferral through tool search is the only lever. The Chief preload line used the keyword form `query "+chief"`, which does not name tools exactly. The exact `select:` line for a plain Chief is about 586 characters, far below the 32,768-character instruction cut.

## Decision

- Every Claude Code row gets an exact `select:` preload line, in the host's selected tool order. Chief rows included.
- Chief contributes no provider environment for any thread. The `experimental_contributeEnv` handler is removed.
- Chief never contributes `ENABLE_TOOL_SEARCH=true`. A proxy may not forward tool reference blocks.

## Consequence

- Chief and managed rows defer unused tool schemas, unless another plugin or user settings turn tool search off.
- A Chief that ignores the preload line may call a deferred `chief_*` tool with guessed arguments. Chief accepts this risk for the token saving.
- Core built-in tools and MCP server instructions still load. A larger cut needs a per-thread tool lever in the plugin SDK.
