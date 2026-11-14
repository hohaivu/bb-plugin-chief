# Tool-Call Stability

## Purpose

The tool-call stability domain ensures that agents load tool schemas before tool calls and provides defaults for thread titles.

## Domain Terms

- **Tool search**: a mechanism where Claude Code defers MCP tool schemas and discovers tools on demand.
- **Preload line**: an instruction that prompts Claude Code to load deferred MCP tool schemas.
- **Managed thread**: a thread recorded in the Chief database store.
- **Seeded metadata**: initial thread metadata that Chief attaches at thread spawn time.

## Ownership and Entry Points

The file `server.ts` owns tool-call stability and title defaulting.

The domain exposes three entry points in `server.ts`:

1. `bb.agents.configure`: configures tools, skills, and prompt instructions for each thread.
2. Schema definitions (`delegateShape`, `delegateParams`, `planParams`, `consultParams`, `spawnParams`): validate tool inputs and default missing titles.
3. CLI commands (`delegate`, `plan`, `consult`): parse command arguments through the schema definitions.

## Flows and States

### Agent Configuration Flow

1. The platform invokes `bb.agents.configure` with thread context.
2. The function queries the store for the thread row.
3. If the row state is complete, archived, or deleted, the function returns empty tool and skill lists.
4. If the row is missing, the function reads seeded metadata from the plugin origin.
5. If the role is missing, the function returns empty tool and skill lists.
6. The function resolves tools for the active role.
7. For the `claude-code` provider, the function builds a schema-preload line from the resolved tools, for every role.
8. The function composes instructions with the preload line at the role position.
9. The function returns the tools, skills, and instructions.

### Brief Title Defaulting Flow

1. A caller invokes a dispatch tool or CLI command with input arguments.
2. If the caller provides an explicit title, the schema trims and validates the text.
3. If the caller omits the title, the schema reads the first line of the mission or request.
4. The schema trims that line and clips it to 160 characters.
5. The schema emits the resolved title to downstream handlers.

## Contracts

### Agent Configuration and Terminal Filters

- `bb.agents.configure` returns empty tool and skill lists when thread state is complete, archived, or deleted. Reason: finished threads require no tools.
- `bb.agents.configure` returns empty tool and skill lists when the thread lacks a role. Reason: unmanaged threads require no Chief capabilities.
- `bb.agents.configure` trusts seeded role metadata only when `origin.pluginId` matches the Chief plugin identifier. Reason: external callers must not forge internal managed roles.
- `bb.agents.configure` places project rules at the end of Chief instructions. Reason: variable project rules may exceed the 32,768-character limit without truncating core rules.

### Schema Preload Line

- With provider `claude-code`, `bb.agents.configure` adds one schema-preload instruction line. Reason: agents must load schemas before calling deferred tools.
- `bb.agents.configure` derives the preload line directly from the returned tools array. Reason: prompt instructions must match the registered tools.
- For every role, the preload line is `select:` followed by the `mcp__bb-bridge__` name of each tool. The names appear in the order of the host's selected tools array, comma-joined, each name once. Reason: Claude Code selects MCP tools by their fully qualified names, and an exact list needs no keyword match.
- The preload line follows the host's selected order, not the SDK registration order. Reason: the SDK resolves tools in registration order, and the plugin does not reorder the registration.
- The preload line of a managed role is the same as before the Chief change. Reason: only the Chief line changed.
- For managed roles, `bb.agents.configure` places the preload line third in instructions, before research, project rules, and lessons. Reason: lessons can push later lines past the 32,768-character instruction limit.
- The Chief preload line has the same `select:` form. No Chief instruction line contains `+chief` or `max_results`. Reason: the full list is about 586 characters for a plain Chief and fits the 32,768-character cut.
- The Chief tool list depends on the row. A plain, unlinked Chief gets the base list plus `chief_coordinate` and `chief_attach`. A child Chief gets the base list. A Coordinator gets `chief_roster`, `chief_spawn` and `chief_attach`. See `coordinator.md`. Reason: BB applies tools only when it builds a session, so a Chief that `chief_coordinate` upgrades could not attach until a restart. The handler of `chief_attach` refuses a caller that is not a Coordinator.
- The Chief preload names follow the tool list of the row. A plain, unlinked Chief has two more than base: 19 with planning and research on. A child Chief has 17 with both on. A Coordinator has 3. Reason: the preload line must match the returned tools.
- For the Chief role, `bb.agents.configure` places the preload line immediately after the lead greeting line. Reason: Chief must load tool schemas before roster execution.
- `bb.agents.configure` omits the preload line for non-Claude providers. Reason: other providers do not defer tool schemas.
- `bb.agents.configure` omits the preload line for complete, archived, or deleted threads. Reason: finished threads receive no tools.
- `bb.agents.configure` omits the preload line for role-less threads. Reason: unmanaged threads receive no tools.

### No Provider Environment

- The plugin registers no `experimental_contributeEnv` handler. Chief contributes no provider environment for any thread. Reason: with an exact preload line, Chief can keep tool search, which defers built-in and MCP tool schemas that Chief never uses.
- The effective value of `ENABLE_TOOL_SEARCH` comes from another plugin, from user settings, or from the Claude Code default. Example: the account pooler contributes `true`. Reason: Chief does not own that value for any row.
- Chief never contributes `ENABLE_TOOL_SEARCH=true`. Reason: a proxy may not forward tool reference blocks.
- The preload line is the mechanism that loads `chief_*` schemas for every role. Reason: tool search stays on, and the exact `select:` line loads the tools of the row.
- The plugin SDK gives an agent plugin no per-thread `disallowedTools` and no MCP-server selection. Chief cannot remove built-in tools or MCP servers. Reason: the SDK configuration holds only `tools`, `skills` and `instructions`, so deferral is the only lever.

### Title Defaulting and Input Validation

- Parameter schemas make `title` optional for `chief_delegate`, `chief_plan`, `chief_consult`, and `chief_spawn`. Reason: task titles are display labels that can derive from missions.
- Parameter schemas make `title` optional for CLI `delegate`, `plan`, and `consult`. Reason: command line callers benefit from automatic title derivation.
- When the caller omits `title`, the schema clips the trimmed first line of `mission` to 160 characters. Reason: mission statements provide concise default thread titles.
- When the caller omits `title` in `chief_spawn`, the schema clips the trimmed first line of `request` to 160 characters. Reason: spawn handoffs receive owner requests instead of mission fields.
- The schema trims carriage return and newline characters from the default title source. Reason: multi-line strings must not corrupt single-line title fields.
- The schema keeps a valid explicit title between 1 and 160 characters without alterations. Reason: explicit user titles must persist verbatim.
- The schema refuses an explicit empty string, whitespace-only string, or string over 160 characters. Reason: invalid explicit titles indicate caller errors.
- The schema requires non-empty `mission` for `chief_delegate`, `chief_plan`, and `chief_consult`. Reason: workers and planners require task instructions.
- The schema requires non-empty `request` for `chief_spawn`. Reason: child Chief instances require explicit owner requests.
- `chief_spawn` has an optional `projectId`. Only a Coordinator may pass it. Reason: a Coordinator starts child Chiefs in any project.
- `chief_escalate` has an optional `threadId`. Reason: a child Chief can escalate before any managed thread exists.
- `delegateParams` refuses input that combines `unplannedReason` and `planThreadId`. Reason: planned tasks do not use unplanned justification reasons.
- `chief_forge_init` retains a required `title` parameter without default logic. Reason: pull requests and tracking issues require explicit forge titles.
- `planParams` and `consultParams` accept an optional `branch`, with no default. The schema trims it and allows 1 to 300 characters. Reason: the thread reads the project default unless the caller names a branch.

## Invariants

- For non-Claude providers, `bb.agents.configure` returns byte-identical instructions and skills relative to the base implementation. Reason: stability changes target Claude Code deferral issues exclusively.
- For non-Claude providers, tool selection, names, and ordering remain identical to base behavior. Reason: provider changes must not alter tool catalogs.
- Parameter schemas alter input schemas only by removing `title` from required properties and updating its description. Reason: validation rules must stay strict for all other fields. The optional parameters `projectId`, `threadId`, and `branch` (on `planParams` and `consultParams`) are the only other schema changes.
- Only threads with verified plugin origin metadata receive seeded roles during initial configuration. Reason: untrusted metadata must not grant elevated capabilities.
- Chief instructions place the preload line and core rules before the 32,768-character truncation boundary. Reason: truncation must never discard critical operational rules.

## Trade-offs

- Deferral is on for managed rows and for Chief, unless another plugin or user settings turn tool search off. Then the saving does not appear.
- A Chief or managed thread may call a deferred `chief_*` tool before it loads the schema, if it ignores the preload line. Chief accepts this risk for the token saving.
- Core built-in tools and MCP server instructions still load for every thread. A larger cut needs a per-thread tool lever in the plugin SDK.

## Related Decisions

- [Managed threads keep tool search](../decisions/2026-11-11-managed-threads-keep-tool-search.md)
- [Chief keeps tool search](../decisions/2026-11-13-chief-keeps-tool-search.md)
- [Coordinator stays a Chief row with two nullable columns](../decisions/2026-11-10-coordinator-stays-chief-row.md)
