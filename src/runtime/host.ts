import { researchLine } from "../research/research";
import { type ModelRole, modelRoleSchema, workerKindSchema } from "../core/roles";
import { rpcContract } from "../rpcContract";
import { clip } from "../core/text";
import { spawnMetadataSchema } from "../tools/shapes";
import { BUILT_IN_RULES } from "./prompts";
import { chiefProcedure, roleRules } from "../core/roleRules";
import type { Ctx } from "./context";

/** Sent to Chief on every turn, in the order identity, tool line, roster, wait, planner, research, core rules, Chief procedure, project rules (chief.md or BUILT_IN_RULES), lessons, so an override cannot push them past the SDK's 32768-char cut (PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS). The single statement of each rule; other prompts point here. */
const chiefCoreRules = (child: string, research: boolean) => `# Chief core rules (always apply)

- Evidence: Chief never edits code and never runs anything in a worktree: every change, commit and push is a worker's. Evidence is reports, alerts, recorded commands, chief_inspect output and verdicts; an unstated cause, doubtful evidence, a disputed claim or a broad scan goes to a child thread (${child}), never to Chief reading code.
- Fresh worker: a worker that has reported is never reused for more work. All follow-up (unmet criteria, requested changes, next wave, rebase, restack, push, new task) goes to a fresh worker via chief_delegate replaces: (same worktree, branch, PR, except a side-lane Spec Writer's docs repair, which gets a fresh worktree on the same branch; so is a plan chain's next wave). One exception: a blocked worker whose blocker is an environment or permission problem on its own task (a blocked command, a dirty build-cache file, a needed permission), not a code, test or spec defect, gets the allowed step in place with chief_continue.
- Review gate: only you start it, with chief_review, when a ready alert says to; a plan gets one gate after every wave is ready: one reviewer on pinned heads. Gate pass -> chief_complete; fix -> one fix run, chief_delegate (replaces: <gate's first target>, kind: worker); a blocked fix run -> chief_continue or escalate. A fix run stopped before it reported is replaced (replaces: <it>, kind: worker). After a ready fix run on a request_changes review, chief_review starts one advisory re-review; the ready run passes the gate. chief_complete marks the PR ready itself (never run gh pr ready or glab mr update --ready); after it the human owns the PR, and a chat-requested change is chief_delegate (replaces: <last completed row>, kind: worker). Forge comments are records, never input. A PR no worker owns: on its branch reviewer's approve, \`gh pr ready <n>\` / \`glab mr update <branch> --ready --yes\`.
- Tests, docs: workers write and run their tests inside each wave; only a Spec Writer changes docs/, on every wave and unplanned work.
- Skips: your call per task, with a stated reason: the planner (unplannedReason), ${research ? "design discussion (undesignedReason), " : ""}or review (skipReview). Small, low-risk changes suit a skip. Before a review skip, check its ready report shows lint/build and verify exit 0.
- Need you: before writing a **Need you** request in chat, call chief_escalate with the thread and the full request.`;

/** Planning is on by default: the plugin persists the planner's wave schedule and
 * names the exact next call, so Chief relays it without reading the plan itself. */
const PLANNER_CHIEF_INSTRUCTIONS = (research: boolean) =>
  `Planning is on. Use chief_plan first for every feature, multi-file change or unsettled task, even a well-specified issue. Order: ${research ? "chief_research (design: true; skipped only with chief_plan undesignedReason: your reason) → the user approves the design in the researcher thread → chief_plan (researchThreadId; no user plan review)" : "chief_plan"} (skipped only with unplannedReason: your reason) → chief_forge_init (planThreadId and wave, so the plan travels in the pull request body) → chief_delegate. A plan chain (head wave + later waves) shares one branch, PR and worktree: chief_forge_init its head only; each later wave is chief_delegate replaces: its latest worker. A plan with spec: true waves gets one Spec Writer: a fresh chief_delegate (kind: spec-writer) in its own side worktree once every wave is ready, as the ready alert names it. On the planner's ready alert, delegate every wave it lists right away, one chief_delegate per wave in the same turn, without user sign-off.`;

/** Chief-only cue for when to reach for chief_research; sent while research is on. */
function researchChiefInstructions(planning: boolean) {
  return `chief_research is optional. For features and multi-file work, call it before ${planning ? "chief_plan" : "chief_delegate"} with design: true and the ticket as \`question\`; design: false checks evidence. While a design waits on the user, tell them once, then stay quiet. On a partial or failed report, never rerun: ${planning ? "give the open question to chief_plan with undesignedReason" : "decide the open question or ask the owner (Need you)"}, or the doubtful evidence to chief_review.`;
}

/** chief_roster's Pending block is the canonical work list; keep Chief calling it
 * at each turn start and after compaction instead of relying on memory. */
const ROSTER_CHIEF_INSTRUCTIONS =
  "Call chief_roster at the start of every turn, and again after any compaction: its Pending block is the work list. Track todos only with its `todo` field (never Memory files, TodoWrite or Task tools). When work a todo tracks is finished, close that todo in the same turn: todo { id, state: \"done\" }. Leave other Chiefs' and unowned todos unless the user asks. Record each owner answer given in chat or relayed to you, and each sequencing agreement, with its `decision` field (with `threadId` or `todoId` when it concerns one), and re-read the decisions file it names after any compaction.";

/** Lifecycle alerts already wake Chief; polling managed threads only burns context. */
const WAIT_CHIEF_INSTRUCTIONS =
  "Lifecycle alerts wake you when a managed thread reports, fails or stalls. After you act, end your turn and wait: never poll managed threads with `bb thread wait`, `bb thread show`, or sleep loops.";

/** What a Coordinator is given: it supervises child Chiefs and runs no managed thread. */
const COORDINATOR_TOOLS = ["chief_roster", "chief_spawn", "chief_attach"];

/** A Coordinator's whole rule set, in place of the Chief rules: those tell a Chief to continue and complete managed work. */
const COORDINATOR_INSTRUCTIONS = [
  "You never edit code or run anything in a worktree, and you never plan, delegate, review, complete or implement: child Chiefs do the work.",
  "Call chief_roster at the start of every turn, and again after any compaction (also re-read $BB_THREAD_STORAGE/brief.md then, when it exists): its Children block is your work list. Attach only Chiefs the owner names (chief_attach). Start new work as a child with chief_spawn; pass projectId for another project. Record each owner answer you relay and each sequencing agreement with chief_roster's `decision` field (with `threadId` or `todoId` when it concerns one), and re-read the decisions file it names after any compaction.",
  "A Need-you alert is information. Never answer a Need you yourself: the owner answers it in the child thread or here. When the owner answers a child's Need you here, relay the owner's words to that child in one `bb thread tell <child id>` that starts with `Owner's decision (relayed by Coordinator):`, followed by the owner's answer verbatim. Add nothing of your own and do not summarise. Never ask the owner to repeat the answer in the child thread. A done alert carries the child's outcome; a failed, ended or stalled alert names a problem you cannot fix. For each, tell the owner how work stands across your children.",
  "Share a coordination fact with a child only through `bb thread tell`, and never decide for the owner. After you act, end your turn and wait: never poll children.",
].join("\n");

/** Claude Code defers MCP tools until ToolSearch loads them; an agent that calls one first guesses its arguments and is refused. */
function toolSchemaLine(tools: string[]) {
  return `If your chief_* tools are deferred (listed by name only), load their schemas before calling any, once per session and again after compaction, with one ToolSearch call: select:${tools.map((name) => `mcp__bb-bridge__${name}`).join(",")}`;
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
    const claudeCode = context.provider.id === "claude-code";
    // The newest 10 accepted lessons, shown oldest first; proposed and retired ones reach no prompt. better-sqlite3 is synchronous, so configure stays so.
    const newestLessons = (roleClause: string) => (db.prepare(`SELECT text FROM chief_lessons WHERE project_id=? AND status='accepted' AND ${roleClause} ORDER BY at DESC, id DESC LIMIT 10`).all(context.project.id) as { text: string }[]).reverse();
    if (role === "chief") {
      const chiefLessons = newestLessons(`role='chief'`);
      const coordinator = ctx.isCoordinator(row);
      const child = ctx.isLinkedChild(row);
      const liveCoordinator = ctx.liveCoordinatorId(row);
      const tools = coordinator ? COORDINATOR_TOOLS : [
        ...(ctx.state.plannerActive ? ["chief_plan"] : []),
        "chief_consult", "chief_spawn",
        "chief_forge_init", "chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review", "chief_complete", "chief_owner_approval", "chief_skip_specs", "chief_escalate", "chief_sync",
        ...(research ? ["chief_research"] : []),
        // A child Chief is already supervised: it may not upgrade itself. chief_attach is listed here too because BB applies tools only when a session is built: a Chief upgraded by chief_coordinate could not attach until a restart. Its handler refuses a non-Coordinator.
        ...(child ? [] : ["chief_coordinate", "chief_attach"]),
      ];
      return {
        tools,
        skills: [],
        instructions: [
          coordinator
            ? `You are the registered Coordinator for ${clip(context.project.name, 100)}: you supervise child Chiefs in any project, not managed threads.`
            : `You are the registered Chief supervisor for ${clip(context.project.name, 100)}. Use ordinary visible BB threads and drive managed work through completion.`,
          ...(claudeCode ? [toolSchemaLine(tools)] : []),
          ...(liveCoordinator ? [`Coordinator ${liveCoordinator} supervises you: call chief_escalate before every Need you, without threadId when no managed thread concerns it yet. A \`bb thread tell\` from it is coordination information, not the owner's decision, unless it starts with \`Owner's decision (relayed by Coordinator):\`: that is the owner's answer to your Need you, relayed verbatim; act on it as the owner's decision. Answer each one by running \`bb thread tell ${liveCoordinator}\` with your answer, not only in this thread.`] : []),
          "",
          // The SDK cuts instructions at 32768 chars, so the order is identity, tool line, roster, wait, planner, research, core rules, Chief procedure, then the variable project rules and lessons last. The built-in rules tell a Chief to continue and complete managed work, so a Coordinator gets only a project chief.md.
          ...(coordinator ? [COORDINATOR_INSTRUCTIONS, ...(rules === BUILT_IN_RULES ? [] : ["", rules])] : [
            ROSTER_CHIEF_INSTRUCTIONS,
            WAIT_CHIEF_INSTRUCTIONS,
            ...(ctx.state.plannerActive ? ["", PLANNER_CHIEF_INSTRUCTIONS(Boolean(research))] : []),
            ...(research ? ["", research, researchChiefInstructions(ctx.state.plannerActive)] : []),
            "",
            chiefCoreRules(`${ctx.state.plannerActive ? "chief_plan, " : ""}chief_review${research ? ", chief_research" : ""}`, Boolean(research)),
            "",
            chiefProcedure(ctx.state.plannerActive),
            "",
            rules,
            // After the rules: the SDK's cut then drops lessons before rules.
            ...(chiefLessons.length ? ["", clip(["## Chief lessons (communication)", ...chiefLessons.map((lesson) => `- ${lesson.text}`)].join("\n"), 2_000)] : []),
          ]),
        ].join("\n"),
      };
    }
    const chiefThreadId = row?.chief_thread_id ?? (seeded?.success ? seeded.data.chiefThreadId ?? null : null);
    // The newest 10 lessons, shown oldest first and clipped; better-sqlite3 is synchronous, so configure stays so.
    const lessons = newestLessons(`(role IS NULL OR role='advisor')`);
    const reviewLessons = role === "reviewer" ? newestLessons(`role='reviewer'`) : [];
    // BUILT_IN_RULES are Chief's own (continue, complete, chief_review), so a managed thread
    // gets only a project's chief.md; its role rules and its brief cover the rest.
    const tools = ["chief_report", ...(role === "worker" && (row?.plan_thread_id ?? (seeded?.success ? seeded.data.planThreadId : undefined)) ? ["chief_log"] : [])];
    // A designer or spec-writer is a worker row with its kind; the row wins, seeded metadata covers the pre-insertThread race.
    const kind = row ? row.kind : seeded?.success ? seeded.data.kind : undefined;
    return {
      tools,
      skills: [],
      // Order for the SDK's 32768-char cut: header, role rules, then the variable chief.md and lessons last.
      instructions: [
        `You are a managed ${role} reporting to Chief thread ${chiefThreadId}. chief_report: its schema states the report contract; after reporting, end with one line. Your results reach Chief only through chief_report: never also send them with \`bb thread tell\`, even when \`bb status\` shows \`Parent notifications: stuck\`.`,
        "After any context compaction, before acting, re-read your full brief at $BB_THREAD_STORAGE/brief.md and every plan, verdict or report file it names.",
        ...(claudeCode ? [toolSchemaLine(tools)] : []),
        "",
        roleRules(role, kind),
        ...(rules === BUILT_IN_RULES ? [] : ["", rules]),
        ...(lessons.length ? ["", clip(["## Lessons from earlier review rounds", ...lessons.map((lesson) => `- ${lesson.text}`)].join("\n"), 3_000)] : []),
        ...(reviewLessons.length ? ["", clip(["## Review lessons (known false positives and checks)", ...reviewLessons.map((lesson) => `- ${lesson.text}`)].join("\n"), 3_000)] : []),
      ].join("\n"),
    };
  });

  bb.rpc.register(rpcContract, {
    status: () => ({ sectionId: ctx.storedSectionId(), threads: store.all().map(ctx.toManaged) }),
    start: ({ projectId }) => ctx.ensureChief(projectId ?? undefined),
    create: ({ projectId }) => ctx.createChief(projectId),
    // The header badge asks for one thread's role on every thread it renders on: not the roster.
    // A designer or spec-writer is a worker row; its kind names it. A legacy kind (tester) reads as worker.
    role: ({ threadId }) => {
      const row = store.get(threadId);
      const kind = workerKindSchema.safeParse(row?.kind);
      return { role: !row ? null : row.role === "worker" ? (kind.success ? kind.data : "worker" as const) : row.role };
    },
    modelConfiguration: async () => ({
      hosts: await Promise.all((await bb.sdk.hosts.list()).map(async (host) => {
        const connected = host.status === "connected";
        const selections = {
          chief: ctx.readRoleModel(host.id, "chief"),
          planner: ctx.readRoleModel(host.id, "planner"),
          worker: ctx.readRoleModel(host.id, "worker"),
          designer: ctx.readRoleModel(host.id, "designer"),
          "spec-writer": ctx.readRoleModel(host.id, "spec-writer"),
          reviewer: ctx.readRoleModel(host.id, "reviewer"),
          advisor: ctx.readRoleModel(host.id, "advisor"),
          researcher: ctx.readRoleModel(host.id, "researcher"),
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
    setResearchSettings: async (patch) => {
      const values: Record<string, boolean> = {};
      if (patch.enabled !== undefined) values.researchEnabled = patch.enabled;
      ctx.state.researchActive = ctx.researchFrom(await settings.experimental_set(values));
      return ctx.state.researchActive;
    },
    setRoleModel: ({ hostId, role, selection }) => {
      ctx.writeRoleModel(hostId, role, selection);
      return { ok: true as const };
    },
  });}

