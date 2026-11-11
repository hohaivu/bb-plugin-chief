# Tool-Call Stability

## Purpose

The tool-call stability domain ensures that agents load tool schemas before tool calls and provides defaults for thread titles.

## Domain Terms

- **Tool search**: a mechanism where Claude Code defers MCP tool schemas and discovers tools on demand.
- **Preload line**: an instruction that prompts Claude Code to load deferred MCP tool schemas.
- **Provider environment**: environment variables that plugins contribute to an agent session.
- **Managed thread**: a thread recorded in the Chief database store.
- **Seeded metadata**: initial thread metadata that Chief attaches at thread spawn time.

## Ownership and Entry Points

The file `server.ts` owns tool-call stability, environment contributions, and title defaulting.

The domain exposes four entry points in `server.ts`:

1. `bb.agents.configure`: configures tools, skills, and prompt instructions for each thread.
2. `bb.providers.experimental_contributeEnv`: contributes session environment variables for the `claude-code` provider.
3. Schema definitions (`delegateShape`, `delegateParams`, `planParams`, `consultParams`, `spawnParams`): validate tool inputs and default missing titles.
4. CLI commands (`delegate`, `plan`, `consult`): parse command arguments through the schema definitions.

## Flows and States

### Agent Configuration Flow

1. The platform invokes `bb.agents.configure` with thread context.
2. The function queries the store for the thread row.
3. If the row state is complete, archived, or deleted, the function returns empty tool and skill lists.
4. If the row is missing, the function reads seeded metadata from the plugin origin.
5. If the role is missing, the function returns empty tool and skill lists.
6. The function resolves tools for the active role.
7. For the `claude-code` provider, the function builds a schema-preload line from the resolved tools.
8. The function composes instructions with the preload line at the role position.
9. The function returns the tools, skills, and instructions.

### Provider Environment Flow

1. The platform resolves provider environment variables for a thread and provider.
2. If the provider is not `claude-code`, Chief returns an empty array.
3. Chief checks the store for an existing thread row.
4. If the thread row exists and its role is `chief`, Chief contributes `ENABLE_TOOL_SEARCH=false`. A Coordinator row has the role `chief`.
5. If the thread row has any other role, Chief returns an empty array.
6. If the thread row is missing, Chief returns an empty array.

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
- For managed roles, the preload line lists tools in exact array order with the `mcp__bb-bridge__` prefix. Reason: Claude Code selects MCP tools by their fully qualified names.
- For managed roles, `bb.agents.configure` places the preload line third in instructions, before research, project rules, and lessons. Reason: lessons can push later lines past the 32,768-character instruction limit.
- For the Chief role, the preload line requests `query "+chief"` with `max_results` equal to the tool count. Reason: full tool names exceed Chief's instruction character budget.
- The Chief tool list depends on the row. A plain, unlinked Chief gets the base list plus `chief_coordinate` and `chief_attach`. A child Chief gets the base list. A Coordinator gets `chief_roster`, `chief_spawn` and `chief_attach`. See `coordinator.md`. Reason: BB applies tools only when it builds a session, so a Chief that `chief_coordinate` upgrades could not attach until a restart. The handler of `chief_attach` refuses a caller that is not a Coordinator.
- The Chief `max_results` follows the tool count of the row. A plain, unlinked Chief has two more than base: 19 with planning and research on. A child Chief has 17 with both on. A Coordinator has 3. Reason: the preload line must match the registered tools.
- For the Chief role, `bb.agents.configure` places the preload line immediately after the lead greeting line. Reason: Chief must load tool schemas before roster execution.
- `bb.agents.configure` omits the preload line for non-Claude providers. Reason: other providers do not defer tool schemas.
- `bb.agents.configure` omits the preload line for complete, archived, or deleted threads. Reason: finished threads receive no tools.
- `bb.agents.configure` omits the preload line for role-less threads. Reason: unmanaged threads receive no tools.

### Provider Environment Contribution

- Chief contributes `ENABLE_TOOL_SEARCH=false` only for the `claude-code` provider. Reason: this setting targets Claude Code tool deferral behavior.
- Chief contributes `ENABLE_TOOL_SEARCH=false` only when a thread row exists in the store and its role is `chief`. A Coordinator row has the role `chief`. Reason: unmanaged threads must not inherit Chief environment settings.
- Chief contributes an empty array for a managed row with any other role. Reason: with deferral off, each such thread carries about 18k system-tool tokens and 3k to 23k MCP-tool tokens in every request.
- For a managed row that is not a Chief row, the effective value of `ENABLE_TOOL_SEARCH` comes from another plugin, from user settings, or from the Claude Code default. Example: the account pooler contributes `true`. Reason: Chief does not own that value for these rows.
- Chief never contributes `ENABLE_TOOL_SEARCH=true`. Reason: a proxy may not forward tool reference blocks.
- Chief contributes an empty array when the thread row is absent. Reason: Chief cannot verify role ownership before thread insertion.
- Chief contributes an empty array for any provider other than `claude-code`. Reason: other providers do not support this environment variable.
- The environment contribution operates per session and leaves user settings unchanged. Reason: plugin environment variables must not alter global user configuration.
- For a managed role other than Chief, the preload line is the primary mechanism that loads `chief_*` schemas. Reason: tool search stays on for these threads, and the exact `select:` line loads their one to three tools.
- For the Chief role, the preload instruction line acts as a fallback when another plugin wins environment precedence. Reason: the host selects the first plugin contributor for a variable name.
- For the Chief role, the preload instruction line acts as a fallback when a session starts before thread database insertion. Reason: the environment resolver queries the database before insertion finishes.

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

## Invariants

- For non-Claude providers, `bb.agents.configure` returns byte-identical instructions and skills relative to the base implementation. Reason: stability changes target Claude Code deferral issues exclusively.
- For non-Claude providers, tool selection, names, and ordering remain identical to base behavior. Reason: provider changes must not alter tool catalogs.
- Parameter schemas alter input schemas only by removing `title` from required properties and updating its description. Reason: validation rules must stay strict for all other fields. The two optional parameters above, `projectId` and `threadId`, are the only other schema changes.
- Only threads with verified plugin origin metadata receive seeded roles during initial configuration. Reason: untrusted metadata must not grant elevated capabilities.
- Chief instructions place the preload line and core rules before the 32,768-character truncation boundary. Reason: truncation must never discard critical operational rules.

## Trade-offs

- Disabling tool search deferral increases prompt token consumption. Full tool schemas load at session start rather than on demand. This cost applies only to Chief threads.
- A managed thread that is not a Chief thread may call a deferred `chief_*` tool before it loads the schema, if it ignores the preload line. Chief accepts this risk for the token saving.
- The keyword query `+chief` for Chief does not guarantee exact tool name resolution. Third-party tools containing `chief` in their name could match the query.

## Related Decisions

- [Managed threads keep tool search](../decisions/2026-11-11-managed-threads-keep-tool-search.md)
- [Coordinator stays a Chief row with two nullable columns](../decisions/2026-11-10-coordinator-stays-chief-row.md)
