import { researchLine, type ResearchMode, researchModeSchema } from "../../research";
import { managedSkills, type ModelRole, modelRoleSchema } from "../../roles";
import { rpcContract } from "../rpcContract";
import { clip } from "../../text";
import { spawnMetadataSchema } from "../tools/shapes";
import { BUILT_IN_RULES } from "./prompts";
import type { Ctx } from "./context";

/** Sent to Chief on every turn before the project's rules (chief.md or BUILT_IN_RULES), so an override cannot push them past the SDK's 4096-char cut. The single statement of each rule; other prompts point here. */
const chiefCoreRules = (child: string) => `# Chief core rules (always apply)

- Evidence: Chief never edits code and never runs anything in a worktree: every change, commit and push is a worker's. Evidence is reports, alerts, recorded commands, chief_inspect output and verdicts; an unstated cause, doubtful evidence, a disputed claim or a broad scan goes to a child thread (${child}), never to Chief reading code.
- Fresh worker: a worker that has reported is never reused. All follow-up (unmet criteria, requested changes, next wave, rebase, restack, push, new task) goes to a fresh worker, tests to a fresh tester, via chief_delegate replaces: (same worktree, branch, PR; a plan chain has exactly one of each, so its next wave is a replaces: too); review and complete the successor.
- Review: only you start reviews, with chief_review, when a worker's ready alert says to; a plan gets one review of every branch after every wave is ready. chief_complete marks the PR ready itself (never run gh pr ready or glab mr update --ready) and needs the newest review to approve its current head, or skipReview. You mark ready a PR no worker owns, only on its branch reviewer's approve.
- Tests: workers and designers never write or run tests; a tester (kind: tester) does, as a plan's test wave or via chief_delegate (replaces: the worker, kind: tester). Spec waves: see the chief skill.
- Skips: your call per task, with a stated reason: the planner (unplannedReason), review (skipReview) or tests (chief_skip_tests, testsSkipped). Guidance, not a rule: small, low-risk changes suit a skip. Before a review skip, check its ready report shows lint/build and verify exit 0.
- Need you: before writing a **Need you** request in chat, call chief_escalate with the thread and the full request.`;

/** Planning is on by default: the plugin persists the planner's wave schedule and
 * names the exact next call, so Chief relays it without reading the plan itself. */
const PLANNER_CHIEF_INSTRUCTIONS =
  "Planning is on. Use chief_plan first for every new feature, multi-file change, or task whose design or cause is not settled, a well-specified issue included. Order: chief_plan (skipped only with unplannedReason: your reason) → chief_forge_init (planThreadId and wave, so the plan travels in the pull request body) → chief_delegate. A plan chain (a head wave and every wave that builds on it) has one branch, one pull request and one worktree: chief_forge_init only on a chain head, and each later wave of the chain with chief_delegate replaces: the chain's latest worker. Relay the planner's ready alert: delegate every wave it lists right away, one chief_delegate per wave in the same turn, without user sign-off.";

/** Chief-only cue for when to reach for chief_research; sent while research is on. */
function researchChiefInstructions(planning: boolean) {
  return `chief_research is optional. A call runs in a child researcher thread: end your turn and wait for its report alert. Use it for a broad multi-file scan or independent questions, or to check doubtful worker or reviewer evidence. When a run failed, was partial, or timed out, do not rerun the same fan-out: send the open question to ${planning ? "chief_plan" : "chief_consult"}, or the doubtful evidence to chief_review.`;
}

/** chief_roster's Pending block is the canonical work list; keep Chief calling it
 * at each turn start and after compaction instead of relying on memory. */
const ROSTER_CHIEF_INSTRUCTIONS =
  "Call chief_roster at the start of every turn, and again after any compaction: its Pending block is the work list. Track every todo with chief_roster's `todo` field (never Memory files, TodoWrite, or Task tools), and When work a todo tracks is finished, close that todo in the same turn: todo { id, state: \"done\" }. Todos tagged with another Chief or no owner are not your work: leave them unless the user asks.";

/** Lifecycle alerts already wake Chief; polling managed threads only burns context. */
const WAIT_CHIEF_INSTRUCTIONS =
  "Lifecycle alerts wake you when a managed thread reports, fails transiently, or stalls. After you act, end your turn and wait: never poll managed threads with `bb thread wait`, `bb thread show`, or sleep loops.";

/** What a Coordinator is given: it supervises child Chiefs and runs no managed thread. */
const COORDINATOR_TOOLS = ["chief_roster", "chief_spawn", "chief_attach"];

/** A Coordinator's whole rule set, in place of the Chief rules: those tell a Chief to continue and complete managed work. */
const COORDINATOR_INSTRUCTIONS = [
  "You never edit code or run anything in a worktree, and you never plan, delegate, review, complete or implement: child Chiefs do the work.",
  "Call chief_roster at the start of every turn: its Children block is your work list. Attach only Chiefs the owner names (chief_attach). Start new work as a child with chief_spawn; pass projectId for another project.",
  "A Need-you alert is information: the owner answers it in the child thread. Never answer or relay it. A done alert means: check chief_roster, then tell the owner how work stands across your children.",
  "Share a coordination fact with a child only through `bb thread tell`, and never decide for the owner. After you act, end your turn and wait: never poll children.",
].join("\n");

/** Claude Code defers MCP tools until ToolSearch loads them; an agent that calls one first guesses its arguments and is refused. */
function toolSchemaLine(tools: string[], compact: boolean) {
  // shortcut: Chief's full select: list (~610 chars) does not fit its 4096-char cut, so Chief gets the keyword form; switch back if Chief's instructions shrink.
  const call = compact ? `query "+chief", max_results ${tools.length}` : `select:${tools.map((name) => `mcp__bb-bridge__${name}`).join(",")}`;
  return `If your chief_* tools are deferred (listed by name only), load their schemas before calling any, once per session and again after compaction, with one ToolSearch call: ${call}`;
}

export function registerHost(ctx: Ctx) {
  const { bb, db, settings, store } = ctx;
  bb.agents.configure((context) => {
    const row = store.get(context.thread.id);
    if (row && ["complete", "archived", "deleted"].includes(row.state)) return { tools: [], skills: [] };
    // insertThread only runs after threads.spawn resolves, so the very first
    // configure() call for a brand-new thread can land before that row exists. The
    // role and chief seeded into pluginMetadata at spawn time cover that gap —
    // without it, a fast environment (a reused reviewer worktree wins this race far
    // more often than a freshly provisioned one) could start a thread with no tools
    // at all, including chief_report. pluginMetadata itself is writable by any API
    // client, another plugin, or the thread's own agent, so only trust it when
    // origin.pluginId proves this thread was actually created by our own spawn call
    // (seeding pluginMetadata always attributes the new thread to this plugin).
    const seeded = context.origin.pluginId === bb.pluginId
      ? spawnMetadataSchema.safeParse(context.pluginMetadata)
      : undefined;
    const role = row?.role ?? (seeded?.success ? seeded.data.role : undefined);
    if (!role) return { tools: [], skills: [] };
    const rules = ctx.state.rulesCache.get(context.project.id) ?? BUILT_IN_RULES;
    const research = researchLine(role, ctx.state.researchActive);
    // A researcher's brief says how to use chief_research, so it has no line but still needs the tool while research is on.
    const researchTool = !!research || (role === "researcher" && !!ctx.state.researchActive?.enabled);
    const claudeCode = context.provider.id === "claude-code";
    if (role === "chief") {
      const coordinator = ctx.isCoordinator(row);
      const child = ctx.isLinkedChild(row);
      const tools = coordinator ? COORDINATOR_TOOLS : [
        ...(ctx.state.plannerActive ? ["chief_plan"] : []),
        "chief_consult", "chief_spawn",
        "chief_forge_init", "chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review", "chief_complete", "chief_owner_approval", "chief_skip_tests", "chief_skip_specs", "chief_escalate", "chief_sync",
        ...(researchTool ? ["chief_research"] : []),
        // A child Chief is already supervised: it may not upgrade itself.
        ...(child ? [] : ["chief_coordinate"]),
      ];
      return {
        tools,
        skills: coordinator ? [] : child ? ["chief"] : ["chief", "coordinator"],
        instructions: [
          coordinator
            ? `You are the registered Coordinator for ${clip(context.project.name, 100)}: you supervise child Chiefs in any project, not managed threads.`
            : `You are the registered Chief supervisor for ${clip(context.project.name, 100)}. Use ordinary visible BB threads and drive managed work through completion.`,
          ...(claudeCode ? [toolSchemaLine(tools, true)] : []),
          ...(child ? [`Coordinator ${row!.coordinator_thread_id} supervises you: call chief_escalate before every Need you, without threadId when no managed thread concerns it yet.`] : []),
          "",
          // The SDK cuts instructions at 4096 chars, so the variable project rules come last. The built-in rules tell a Chief to continue and complete managed work, so a Coordinator gets only a project chief.md.
          ...(coordinator ? [COORDINATOR_INSTRUCTIONS, ...(rules === BUILT_IN_RULES ? [] : ["", rules])] : [
            ROSTER_CHIEF_INSTRUCTIONS,
            WAIT_CHIEF_INSTRUCTIONS,
            ...(ctx.state.plannerActive ? ["", PLANNER_CHIEF_INSTRUCTIONS] : []),
            ...(research ? ["", research, researchChiefInstructions(ctx.state.plannerActive)] : []),
            "",
            chiefCoreRules(`${ctx.state.plannerActive ? "chief_plan, " : ""}chief_review${research ? ", chief_research" : ""}`),
            "",
            rules,
          ]),
        ].join("\n"),
      };
    }
    const chiefThreadId = row?.chief_thread_id ?? (seeded?.success ? seeded.data.chiefThreadId ?? null : null);
    // The newest 10 lessons, shown oldest first and clipped; better-sqlite3 is synchronous, so configure stays so.
    const newestLessons = (roleClause: string) => (db.prepare(`SELECT text FROM chief_lessons WHERE project_id=? AND ${roleClause} ORDER BY at DESC, id DESC LIMIT 10`).all(context.project.id) as { text: string }[]).reverse();
    const lessons = newestLessons(`(role IS NULL OR role='advisor')`);
    const reviewLessons = role === "reviewer" ? newestLessons(`role='reviewer'`) : [];
    // BUILT_IN_RULES are Chief's own (continue, complete, chief_review), so a managed thread
    // gets only a project's chief.md; its brief and the chief-worker skills cover the rest.
    const tools = ["chief_report", ...(role === "worker" && (row?.plan_thread_id ?? (seeded?.success ? seeded.data.planThreadId : undefined)) ? ["chief_log"] : []), ...(researchTool ? ["chief_research"] : [])];
    return {
      tools,
      // A designer is a worker row with kind "designer"; seeded metadata covers the pre-insertThread race.
      skills: managedSkills(role, row?.kind ?? (seeded?.success ? seeded.data.kind : undefined)),
      instructions: [
        `You are a managed ${role} reporting to Chief thread ${chiefThreadId}. chief_report: follow the chief-worker skill's report contract; after reporting, end with one line.`,
        "After any context compaction, before acting, re-read your full brief at $BB_THREAD_STORAGE/brief.md and every plan, verdict or report file it names.",
        ...(claudeCode ? [toolSchemaLine(tools, false)] : []),
        ...(research ? [research] : []),
        ...(rules === BUILT_IN_RULES ? [] : ["", rules]),
        ...(lessons.length ? ["", clip(["## Lessons from earlier review rounds", ...lessons.map((lesson) => `- ${lesson.text}`)].join("\n"), 3_000)] : []),
        ...(reviewLessons.length ? ["", clip(["## Review lessons (known false positives and checks)", ...reviewLessons.map((lesson) => `- ${lesson.text}`)].join("\n"), 3_000)] : []),
      ].join("\n"),
    };
  });

  // Best-effort: another plugin's ENABLE_TOOL_SEARCH (account-pool) may win, and a session before insertThread gets none; the preload line is the fallback.
  bb.providers.experimental_contributeEnv("claude-code", ({ threadId }) =>
    store.get(threadId) ? [{ name: "ENABLE_TOOL_SEARCH", value: "false", reason: "Chief-managed threads call chief_* tools before a deferred schema loads" }] : []);

  bb.rpc.register(rpcContract, {
    status: () => ({ sectionId: ctx.storedSectionId(), threads: store.all().map(ctx.toManaged) }),
    start: ({ projectId }) => ctx.ensureChief(projectId ?? undefined),
    create: ({ projectId }) => ctx.createChief(projectId),
    // The header badge asks for one thread's role on every thread it renders on: not the roster.
    role: ({ threadId }) => ({ role: store.get(threadId)?.role ?? null }),
    modelConfiguration: async () => ({
      hosts: await Promise.all((await bb.sdk.hosts.list()).map(async (host) => {
        const connected = host.status === "connected";
        const selections = {
          chief: ctx.readRoleModel(host.id, "chief"),
          planner: ctx.readRoleModel(host.id, "planner"),
          worker: ctx.readRoleModel(host.id, "worker"),
          designer: ctx.readRoleModel(host.id, "designer"),
          tester: ctx.readRoleModel(host.id, "tester"),
          "spec-writer": ctx.readRoleModel(host.id, "spec-writer"),
          reviewer: ctx.readRoleModel(host.id, "reviewer"),
          advisor: ctx.readRoleModel(host.id, "advisor"),
        };
        // A connected machine can answer for its own picks, so say which ones it
        // would refuse instead of showing a model the next spawn will ignore.
        // One reader for the whole host: roles sharing a provider scan it once.
        const read = ctx.catalogReader(host.id);
        const [scan, flagged] = await Promise.all([
          connected
            ? ctx.hostFallback(host.id, read)
            : { fallback: null, error: "Machine is disconnected; its model catalog is unavailable." },
          Promise.all(modelRoleSchema.options.map(async (role) => {
            const selection = selections[role];
            if (!connected || !selection) return null;
            return (await ctx.usableSelection(host.id, selection, read)) ? null : role;
          })),
        ]);
        return {
          hostId: host.id,
          hostName: host.name,
          connected,
          ...scan,
          selections,
          unusable: flagged.filter((role): role is ModelRole => role !== null),
        };
      })),
    }),
    researchConfiguration: async () => ({
      settings: await ctx.researchSettings(),
      hosts: await Promise.all((await bb.sdk.hosts.list()).map(async (host) => {
        const connected = host.status === "connected";
        const selections = {
          survey: ctx.readResearchModel(host.id, "survey"),
          investigate: ctx.readResearchModel(host.id, "investigate"),
        };
        // One reader for the whole host: modes sharing a provider scan it once.
        const read = ctx.catalogReader(host.id);
        const [scan, flagged] = await Promise.all([
          connected
            ? ctx.hostFallback(host.id, read)
            : { fallback: null, error: "Machine is disconnected; its model catalog is unavailable." },
          Promise.all(researchModeSchema.options.map(async (mode) => {
            const selection = selections[mode];
            if (!connected || !selection) return null;
            return (await ctx.usableSelection(host.id, selection, read)) ? null : mode;
          })),
        ]);
        return {
          hostId: host.id,
          hostName: host.name,
          connected,
          ...scan,
          selections,
          unusable: flagged.filter((mode): mode is ResearchMode => mode !== null),
        };
      })),
    }),
    setResearchModel: ({ hostId, mode, selection }) => {
      ctx.writeResearchModel(hostId, mode, selection);
      return { ok: true as const };
    },
    setResearchSettings: async (patch) => {
      const values: Record<string, boolean | number> = {};
      if (patch.enabled !== undefined) values.researchEnabled = patch.enabled;
      if (patch.maxAgentCalls !== undefined) values.researchMaxAgentCalls = patch.maxAgentCalls;
      const timeouts = patch.timeoutMinutes ?? {};
      if (timeouts.survey !== undefined) values.researchSurveyTimeoutMinutes = timeouts.survey;
      if (timeouts.investigate !== undefined) values.researchInvestigateTimeoutMinutes = timeouts.investigate;
      ctx.state.researchActive = ctx.researchFrom(await settings.experimental_set(values));
      return ctx.state.researchActive;
    },
    setRoleModel: ({ hostId, role, selection }) => {
      ctx.writeRoleModel(hostId, role, selection);
      return { ok: true as const };
    },
  });}

