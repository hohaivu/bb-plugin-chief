import { configurationContext, setup, start } from "./harness";
import { GAPS_PROPERTY, FOCUS_PROPERTY, withPlanFlags } from "./reviewerToolDelta";
import { ATTACH_DEFINITION, acceptEvidenceOnlyDelta } from "./specLaneWording";
import { withHostCompaction } from "./shrinkEdits";
import { acceptStackedBranchDelta } from "./stackedBranchToolDelta";

// The tool-config capture of toolCallStability.test.ts (lines 20-69, same cases, same normalization), reused to snapshot another commit.
// test/fixtures/tool-config-9689364.txt was captured by running it unchanged on base 9689364; tool-config-7178582.txt stays frozen.
const marker = "# Project rules marker";
export const toolConfigCases = [
  { label: "short rules", rules: `${marker}\n- Keep rules small.`, name: "Asha", chiefOnly: false },
  { label: "worst case", rules: `${marker}\n${"- Project rule text.\n".repeat(1_600)}`.slice(0, 32_000), name: "N".repeat(5_000), chiefOnly: true },
];
// The plugin SDK caps dynamic instructions at PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS (node_modules/@get-bb/plugin-sdk/dist/testing/index.js).
export const INSTRUCTIONS_CAP = 32_768;
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

type Definition = { description: string; inputSchema: { required?: string[]; properties: Record<string, { description?: string }> } };
export type ToolConfig = { catalog: Record<string, Definition>; entries: { key: string; tools: string[]; skills: string[]; instructions: string | null | undefined }[] };

// Docs-ownership wave: the ONLY differences allowed between base 9689364 and head, each compared byte for byte (asserted, then undone, then the rest must be equal).
const KIND_OLD = "on a spec-bearing chain it also replaces the latest worker, designer or tester of a wave to fix the docs";
const KIND_NEW = "on any other plan wave except a design-only one it replaces the chain's current implementation row (the call a refusal names) for a docs change";
const SKIP_OLD = "Refused, like override, for an implementation-lane Spec Writer. Never cleaned up.";
const SKIP_NEW = "Refused, like override, for an implementation-lane Spec Writer. Also refused when the branch has a docs/ commit that no Spec Writer of this task is recorded on (Chief-Spec-Writer trailer); when that check cannot run, the reply says so. Never cleaned up.";
export const TESTS_DOCS_LINE = "- Tests, docs: only a tester writes or runs tests (a plan's test wave, or chief_delegate replaces: the worker, kind: tester); only a Spec Writer changes docs/, on every wave and unplanned work (chief skill).";
const SKIPS_OLD_PHRASE = "Guidance, not a rule: small";
// "Chief keeps tool search" wave (plan thr_peiq8gukb2, wave 1 steps 1 and 5; docs/specs/tool-call-stability.md, docs/specs/work-list.md): the chief_roster delta and the Chief preload edit.
export const ROSTER_OTHERS_OLD = "others' todos are listed apart and tagged — leave them unless the user asks";
export const ROSTER_OTHERS_NEW = "others' todos show as one count line (includeOthers: true lists them, tagged) — leave them unless the user asks";
export const INCLUDE_OTHERS_PROPERTY = { description: "List todos owned by other or ended Chiefs, and unowned ones, in full; by default the Pending block shows them as one count line.", type: "boolean" };
export const PRELOAD_OLD_TAIL = /query "\+chief", max_results \d+$/;
/** The order in which the host selects a plain Chief's tools (the `tools` array of `bb.agents.configure`), pinned here as a literal: the preload line follows it, while the SDK returns the tools in registration order. */
export const CHIEF_HOST_ORDER = [
  "chief_plan", "chief_consult", "chief_spawn", "chief_forge_init", "chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review",
  "chief_complete", "chief_owner_approval", "chief_skip_tests", "chief_skip_specs", "chief_escalate", "chief_sync", "chief_research", "chief_coordinate", "chief_attach",
];
/** The chief_roster delta ("Chief keeps tool search"), asserted exactly and then undone: the optional `includeOthers` boolean and the one description clause. */
export function acceptRosterOthersDelta(tool: any, name: string) {
  if (name !== "chief_roster") return;
  const properties = tool.inputSchema.properties;
  if (JSON.stringify(properties.includeOthers) !== JSON.stringify(INCLUDE_OTHERS_PROPERTY) || (tool.inputSchema.required ?? []).includes("includeOthers")) throw new Error("chief_roster.includeOthers: must be the one optional boolean");
  delete properties.includeOthers;
  if (tool.description.split(ROSTER_OTHERS_NEW).length !== 2) throw new Error("chief_roster description: must hold the one authorized clause");
  tool.description = tool.description.replace(ROSTER_OTHERS_NEW, ROSTER_OTHERS_OLD);
}
/** Coordinator comms wave 2: chief_coordinate gains the one optional `goal` string (COORD-1), asserted exactly and then undone. */
export const COORDINATE_GOAL_PROPERTY = { description: "The owner's words asking for coordination, verbatim; saved to brief.md.", type: "string", minLength: 1, maxLength: 4000 };
export function acceptCoordinateGoalDelta(tool: any, name: string) {
  if (name !== "chief_coordinate") return;
  if (JSON.stringify(tool.inputSchema.properties.goal) !== JSON.stringify(COORDINATE_GOAL_PROPERTY) || (tool.inputSchema.required ?? []).includes("goal")) throw new Error("chief_coordinate.goal: must be the one optional bounded string");
  delete tool.inputSchema.properties.goal;
}
/** The preload names a Chief row must ask for: the returned tools in the host's pinned order. Throws if the returned tools are not exactly that set (so the order is checked, not assumed from the SDK registration order). */
export const chiefPreloadTail = (returned: string[]) => {
  const ordered = CHIEF_HOST_ORDER.filter((name) => returned.includes(name));
  if (ordered.length !== returned.length || new Set(returned).size !== returned.length) throw new Error(`Chief tools are not a unique subset of the host order: ${returned.join()}`);
  return `select:${ordered.map((name) => `mcp__bb-bridge__${name}`).join(",")}`;
};

/** Throws unless `head` equals `base` apart from: the chief_delegate `kind` clause, the chief_complete `skipReview` clause, in Chief's core rules the Tests line (now Tests, docs)
 * and the Skips line (the phrase swap only), and (#213) the chief_attach tool of a plain Chief (exact definition, right after chief_coordinate), and ("Chief keeps tool search") the
 * chief_roster `includeOthers` property plus its one description clause, and a plain Chief's claude-code preload line `query "+chief", max_results N` becoming `select:` plus every returned
 * tool in the host's pinned order. Chief instructions must EXACTLY equal the base text rebuilt uncapped, edited (core rules and preload line), then capped at the SDK limit; everything else must be identical.
 * `head` is cloned, never mutated. */
export function compareToolConfig(base: ToolConfig, original: ToolConfig) {
  const fail = (what: string): never => { throw new Error(`tool config differs from base outside the allowed edits: ${what}`); };
  const head = structuredClone(original);
  // The #213 delta, asserted exactly and then removed, so everything else still compares against base byte for byte.
  if ("chief_attach" in base.catalog) fail("base already has chief_attach");
  if (JSON.stringify(head.catalog["chief_attach"]) !== JSON.stringify(ATTACH_DEFINITION)) fail("chief_attach definition");
  delete head.catalog["chief_attach"];
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
    acceptEvidenceOnlyDelta(now, name);
    acceptCoordinateGoalDelta(now, name);
    acceptStackedBranchDelta(now, name);
    if (name === "chief_delegate") edit(now, "kind", KIND_OLD, KIND_NEW, was.inputSchema.properties.kind!.description!);
    if (name === "chief_complete") edit(now, "skipReview", SKIP_OLD, SKIP_NEW, was.inputSchema.properties.skipReview!.description!);
    if (name === "chief_review") {
      const properties = now.inputSchema.properties as Record<string, unknown>;
      if (JSON.stringify(properties["acceptedGaps"]) !== JSON.stringify(GAPS_PROPERTY)) fail("chief_review.acceptedGaps is not the planned schema");
      delete properties["acceptedGaps"];
      if (JSON.stringify(properties["focus"]) !== JSON.stringify(FOCUS_PROPERTY)) fail("chief_review.focus is not the base schema with the one authorized description");
      properties["focus"] = was.inputSchema.properties["focus"];
    }
    // Forward: the base chief_report plus the named edits (exact counts) must equal head's.
    if (name === "chief_roster") {
      const properties = now.inputSchema.properties as Record<string, unknown>;
      if (JSON.stringify(properties["includeOthers"]) !== JSON.stringify(INCLUDE_OTHERS_PROPERTY)) fail("chief_roster.includeOthers is not the planned optional boolean");
      delete properties["includeOthers"];
      if ((now.inputSchema.required ?? []).includes("includeOthers")) fail("chief_roster.includeOthers is required");
      if (was.description.split(ROSTER_OTHERS_OLD).length !== 2 || now.description !== was.description.replace(ROSTER_OTHERS_OLD, ROSTER_OTHERS_NEW)) fail("chief_roster description is not the base text with the one authorized clause");
      now.description = was.description;
    }
    if (name === "chief_report") withPlanFlags(was.inputSchema.properties["plan"] as Parameters<typeof withPlanFlags>[0]);
    if (JSON.stringify(now) !== JSON.stringify(was)) fail(`${name} (description or schema)`);
  }
  if (head.entries.length !== base.entries.length) fail("entry count");
  head.entries.forEach((entry, index) => {
    const old = base.entries[index]!;
    const plainChief = entry.key.includes("| chief |");
    const returnedTools = [...entry.tools];
    if (plainChief) {
      if (entry.tools[entry.tools.indexOf("chief_coordinate") + 1] !== "chief_attach") fail(`${old.key}: chief_attach not right after chief_coordinate`);
      // Only the one checked insertion is removed; a duplicate stays and fails the exact tools comparison below.
      entry.tools.splice(entry.tools.indexOf("chief_coordinate") + 1, 1);
    } else if (entry.tools.includes("chief_attach")) fail(`${old.key}: chief_attach outside a plain Chief`);
    if (entry.key !== old.key || JSON.stringify(entry.tools) !== JSON.stringify(old.tools) || JSON.stringify(entry.skills) !== JSON.stringify(old.skills)) fail(`${old.key}: key, tools or skills`);
    // Only a non-Chief entry may match base unchanged or with the shrink-prompts compaction edit (applied to the base text); every Chief entry needs the authorized core-rule edits (and the preload edit on claude-code), so a restored base text must reach the exact comparison below.
    if (!plainChief && entry.instructions === old.instructions) return;
    if (!plainChief && old.instructions !== undefined && entry.instructions === withHostCompaction(old.instructions)) return;
    if (!plainChief || !entry.instructions || !old.instructions) fail(`${old.key}: instructions`);
    // Chief's project rules are the last instruction component, so the uncapped base is the frozen text up to the marker plus the generator's own full rule input.
    // Anchor that reconstruction to the frozen base, apply only the authorized edits BEFORE the cap, cap at the SDK limit, and require exact equality: no tail byte is taken from head.
    const rules = toolConfigCases.find((candidate) => old.key.startsWith(`${candidate.label} |`))!.rules;
    const cut = old.instructions!.indexOf(marker);
    if (cut < 0) fail(`${old.key}: rules marker missing in base`);
    const prefix = old.instructions!.slice(0, cut);
    if (`${prefix}${rules}`.slice(0, INSTRUCTIONS_CAP) !== old.instructions) fail(`${old.key}: base is not prefix + rules capped`);
    const once = (text: string, start: string) => { const lines = text.split("\n"); const at = lines.findIndex((line) => line.startsWith(start)); if (at < 0 || lines.some((line, index) => index > at && line.startsWith(start))) fail(`${old.key}: base has not exactly one ${start} line`); return { lines, at }; };
    // The preload edit is applied to the uncapped base before the cap, so the longer line moves the cap tail exactly as it does at head.
    const claudeCode = entry.key.includes("| claude-code |");
    let edited = prefix;
    if (claudeCode) {
      const preload = once(prefix, "If your chief_* tools are deferred");
      if (!PRELOAD_OLD_TAIL.test(preload.lines[preload.at]!)) fail(`${old.key}: base preload is not the +chief keyword form`);
      preload.lines[preload.at] = preload.lines[preload.at]!.replace(PRELOAD_OLD_TAIL, chiefPreloadTail(returnedTools));
      edited = preload.lines.join("\n");
    } else if (prefix.includes("ToolSearch")) fail(`${old.key}: base has a preload line without claude-code`);
    const tests = once(edited, "- Tests:");
    tests.lines[tests.at] = TESTS_DOCS_LINE;
    const skips = once(tests.lines.join("\n"), "- Skips:");
    if (!skips.lines[skips.at]!.includes(SKIPS_OLD_PHRASE)) fail(`${old.key}: base Skips line lacks the old phrase`);
    skips.lines[skips.at] = skips.lines[skips.at]!.replace(SKIPS_OLD_PHRASE, "Small");
    if (entry.instructions !== `${skips.lines.join("\n")}${rules}`.slice(0, INSTRUCTIONS_CAP)) fail(`${old.key}: instructions`);
  });
}
