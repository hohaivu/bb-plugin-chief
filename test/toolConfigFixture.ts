import { configurationContext, setup, start } from "./harness";

// The tool configuration the host returns for every role, provider, planner and research setting, captured as one JSON text (toolCallStability.test.ts, coordinator.test.ts).
const marker = "# Project rules marker";
const toolConfigCases = [
  { label: "short rules", rules: `${marker}\n- Keep rules small.`, name: "Asha", chiefOnly: false },
  { label: "worst case", rules: `${marker}\n${"- Project rule text.\n".repeat(1_600)}`.slice(0, 32_000), name: "N".repeat(5_000), chiefOnly: true },
];
// The plugin SDK caps dynamic instructions at PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS (node_modules/@get-bb/plugin-sdk/dist/testing/index.js).
const INSTRUCTIONS_CAP = 32_768;
export const toolConfigFixture = async () => {
  const entries: { key: string; tools: string[]; skills: string[]; instructions: string | null | undefined }[] = [];
  const catalog: Record<string, unknown> = {};
  const roots: string[] = [];
  for (const { label, rules, name, chiefOnly } of toolConfigCases) {
    const state = await setup({ rules });
    roots.push(state.storageRoot);
    const chief = await start(state);
    const lesson = state.db.prepare("INSERT INTO chief_lessons (project_id, text, source_thread_id, at, role) VALUES ('proj_1', ?, ?, ?, ?)");
    lesson.run("Lesson for every role.", chief.threadId, 1, null);
    lesson.run("Lesson for reviewers.", chief.threadId, 2, "reviewer");
    const seeded = (role: string, extra: object = {}) => ({ role, chiefThreadId: chief.threadId, ...extra });
    const roles: [string, string, object | undefined][] = [
      ["chief", chief.threadId, undefined],
      ...(chiefOnly ? [] : [
        ["worker", "thr_seed_worker", seeded("worker")],
        ["plan worker", "thr_seed_plan_worker", seeded("worker", { planThreadId: "thr_seed_plan" })],
        ["designer", "thr_seed_designer", seeded("worker", { kind: "designer" })],
        ["tester", "thr_seed_tester", seeded("worker", { kind: "tester" })],
        ["spec-writer", "thr_seed_spec_writer", seeded("worker", { kind: "spec-writer" })],
        ["reviewer", "thr_seed_reviewer", seeded("reviewer")],
        ["planner", "thr_seed_planner", seeded("planner")],
        ["researcher", "thr_seed_researcher", seeded("researcher")],
        ["advisor", "thr_seed_advisor", seeded("advisor")],
      ] as [string, string, object][]),
    ];
    for (const provider of ["codex", "claude-code"]) for (const planner of [true, false]) for (const research of [true, false]) {
      await state.harness.behavior.setSettings({ plannerEnabled: planner });
      await state.harness.behavior.callRpc("setResearchSettings", { enabled: research });
      for (const [role, id, pluginMetadata] of roles) {
        const base = configurationContext(id, "proj_1", name);
        const configured = await state.harness.behavior.resolveAgentConfiguration({ ...base, provider: { ...base.provider, id: provider }, ...(pluginMetadata ? { pluginMetadata } : {}) });
        for (const tool of configured.tools as any[]) {
          const definition = { description: tool.description, inputSchema: tool.inputSchema };
          if (JSON.stringify(catalog[tool.name] ?? definition) !== JSON.stringify(definition)) throw new Error(`${tool.name} differs between configurations`);
          catalog[tool.name] = definition;
        }
        entries.push({ key: `${label} | ${role} | ${provider} | planner ${planner} | research ${research}`, tools: configured.tools.map((tool: any) => tool.name), skills: configured.skills, instructions: configured.instructions });
      }
    }
  }
  return roots.reduce((text, root) => text.replaceAll(root, "<storage>"), JSON.stringify({ catalog, entries }, null, 1));
};
/** The order in which the host selects a plain Chief's tools (the `tools` array of `bb.agents.configure`), pinned here as a literal: the preload line follows it, while the SDK returns the tools in registration order. */
export const CHIEF_HOST_ORDER = [
  "chief_plan", "chief_consult", "chief_spawn", "chief_forge_init", "chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review",
  "chief_complete", "chief_owner_approval", "chief_skip_specs", "chief_escalate", "chief_sync", "chief_research", "chief_coordinate", "chief_attach",
];
/** The preload names a Chief row must ask for: the returned tools in the host's pinned order. Throws if the returned tools are not exactly that set, so the order is checked, not assumed from the SDK. */
export const chiefPreloadTail = (returned: string[]) => {
  const ordered = CHIEF_HOST_ORDER.filter((name) => returned.includes(name));
  if (ordered.length !== returned.length || new Set(returned).size !== returned.length) throw new Error(`Chief tools are not a unique subset of the host order: ${returned.join()}`);
  return `select:${ordered.map((name) => `mcp__bb-bridge__${name}`).join(",")}`;
};
