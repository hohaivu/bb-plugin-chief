import { configurationContext, setup, start } from "./harness";

// The tool-config capture of toolCallStability.test.ts (lines 20-69, same cases, same normalization), reused to snapshot another commit.
// test/fixtures/tool-config-9689364.txt was captured by running it unchanged on base 9689364; tool-config-7178582.txt stays frozen.
export const toolConfigFixture = async () => {
  const entries: { key: string; tools: string[]; skills: string[]; instructions: string | null | undefined }[] = [];
  const catalog: Record<string, unknown> = {};
  const roots: string[] = [];
  const marker = "# Project rules marker";
  const cases = [
    { label: "short rules", rules: `${marker}\n- Keep rules small.`, name: "Asha", chiefOnly: false },
    { label: "worst case", rules: `${marker}\n${"- Project rule text.\n".repeat(1_600)}`.slice(0, 32_000), name: "N".repeat(5_000), chiefOnly: true },
  ];
  for (const { label, rules, name, chiefOnly } of cases) {
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

type Definition = { description: string; inputSchema: { required?: string[]; properties: Record<string, { description?: string }> } };
export type ToolConfig = { catalog: Record<string, Definition>; entries: { key: string; tools: string[]; skills: string[]; instructions: string | null | undefined }[] };

// Docs-ownership wave: the ONLY differences allowed between base 9689364 and head, each compared byte for byte (asserted, then undone, then the rest must be equal).
const KIND_OLD = "on a spec-bearing chain it also replaces the latest worker, designer or tester of a wave to fix the docs";
const KIND_NEW = "on any other plan wave except a design-only one it replaces the chain's current implementation row (the call a refusal names) for a docs change";
const SKIP_OLD = "Refused, like override, for an implementation-lane Spec Writer. Never cleaned up.";
const SKIP_NEW = "Refused, like override, for an implementation-lane Spec Writer. Also refused when the branch has a docs/ commit that no Spec Writer of this task is recorded on (Chief-Spec-Writer trailer); when that check cannot run, the reply says so. Never cleaned up.";
export const TESTS_DOCS_LINE = "- Tests, docs: only a tester writes or runs tests (a plan's test wave, or chief_delegate replaces: the worker, kind: tester); only a Spec Writer changes docs/, on every wave and unplanned work (chief skill).";
const SKIPS_OLD_PHRASE = "Guidance, not a rule: small";

/** Throws unless `head` equals `base` apart from: the chief_delegate `kind` clause, the chief_complete `skipReview` clause, and in Chief's core rules the Tests line (now Tests, docs)
 * and the Skips line (the phrase swap only). Everything else, down to every other core-rule byte and every other tool text and schema, must be identical. */
export function compareToolConfig(base: ToolConfig, head: ToolConfig) {
  const fail = (what: string): never => { throw new Error(`tool config differs from base outside the allowed edits: ${what}`); };
  const names = Object.keys(base.catalog);
  if (Object.keys(head.catalog).join() !== names.join()) fail("tool names or order");
  for (const name of names) {
    const was = structuredClone(base.catalog[name]!);
    const now = structuredClone(head.catalog[name]!);
    const edit = (tool: Definition, path: "kind" | "skipReview", from: string, to: string, wasText: string) => {
      const property = tool.inputSchema.properties[path]!;
      if (property.description !== wasText.replace(from, to)) fail(`${name}.${path} is not the base text with the one authorized clause`);
      property.description = wasText;
    };
    if (name === "chief_delegate") edit(now, "kind", KIND_OLD, KIND_NEW, was.inputSchema.properties.kind!.description!);
    if (name === "chief_complete") edit(now, "skipReview", SKIP_OLD, SKIP_NEW, was.inputSchema.properties.skipReview!.description!);
    if (JSON.stringify(now) !== JSON.stringify(was)) fail(`${name} (description or schema)`);
  }
  if (head.entries.length !== base.entries.length) fail("entry count");
  head.entries.forEach((entry, index) => {
    const old = base.entries[index]!;
    if (entry.key !== old.key || JSON.stringify(entry.tools) !== JSON.stringify(old.tools) || JSON.stringify(entry.skills) !== JSON.stringify(old.skills)) fail(`${old.key}: key, tools or skills`);
    if (entry.instructions === old.instructions) return;
    if (!entry.key.includes("| chief |") || !entry.instructions || !old.instructions) fail(`${old.key}: instructions`);
    const was = old.instructions!.split("\n");
    const restored = entry.instructions!.split("\n").map((line) => {
      if (line.startsWith("- Tests, docs:")) return line === TESTS_DOCS_LINE ? was.find((other) => other.startsWith("- Tests:"))! : fail(`${old.key}: the Tests, docs line`);
      if (line.startsWith("- Skips:")) {
        const base = was.find((other) => other.startsWith("- Skips:"))!;
        return line === base.replace(SKIPS_OLD_PHRASE, "Small") && base.includes(SKIPS_OLD_PHRASE) ? base : fail(`${old.key}: the Skips line`);
      }
      return line;
    }).join("\n");
    // A text the plugin caps keeps its length, so the head shows a few more tail characters than base once its two lines are shorter: only that tail may differ.
    const capped = entry.instructions!.length === old.instructions!.length;
    if (!(restored === old.instructions || (capped && restored.startsWith(old.instructions!)))) fail(`${old.key}: instructions`);
  });
}
