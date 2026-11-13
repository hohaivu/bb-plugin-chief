# Managed threads keep tool search

## Context

Chief contributed `ENABLE_TOOL_SEARCH=false` for every managed thread. Its value won over the account pooler's `true`. Each managed thread then loaded every tool schema at start. Measured per request: about 18k system-tool tokens and 3k to 23k MCP-tool tokens. The plugin SDK gives Chief no way to drop MCP servers or built-in tools per thread. Environment is the only lever.

## Decision

- Chief contributes `ENABLE_TOOL_SEARCH=false` only for a row with the role `chief`. A Coordinator row has that role.
- Every other managed role gets an empty contribution. Tool search stays on for them.
- Their exact `select:` preload line loads their own `chief_*` schemas.
- Chief keeps deferral off because its preload line is the keyword form `query "+chief"`. That form does not guarantee exact tool names.

## Consequence

- Managed threads other than Chief save the token cost on every request.
- A managed thread that ignores the preload line may call a deferred `chief_*` tool with a guessed argument.
- [Chief keeps tool search](2026-11-13-chief-keeps-tool-search.md) supersedes this decision for Chief rows.
