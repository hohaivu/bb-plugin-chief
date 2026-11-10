import { clip } from "../core/text";
import { type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { COORDINATOR_REFUSED, coordinatorRefusal } from "./prompts";
import { consultParams, delegateParams, overrideSchema, planParams, stopParams, type TodoRow } from "../tools/shapes";
import type { Ctx } from "./context";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    const next = argv[index + 1];
    // A boolean flag never takes a value: `--json thr_x` keeps thr_x positional.
    const value = inline ?? (name !== "json" && next && !next.startsWith("--") ? (index++, next) : "true");
    flags.set(name!, [...(flags.get(name!) ?? []), value]);
  }
  return {
    positional,
    one: (name: string) => flags.get(name)?.[0],
    all: (name: string) => flags.get(name) ?? [],
    bool: (name: string) => flags.get(name)?.[0] === "true",
  };
}

export function registerCli(ctx: Ctx) {
  const { bb, closedTodosForProject, settings, store, todosForProject } = ctx;
  const usage = [
    "Usage:",
    "  bb chief status [--project proj_id] [--json]",
    "  bb chief stats [--project proj_id] [--chief thr_id] [--json]",
    "  bb chief start [--project proj_id] [--json]",
    "  bb chief create [--project proj_id] [--json]",
    "  bb chief adopt --thread thr_id [--json]",
    "  bb chief plan [--title \"…\"] --mission \"…\" [--context \"…\"] [--revises thr_id] [--json]",
    "  bb chief consult [--title \"…\"] --mission \"…\" [--context \"…\"] [--worker thr_id | --plan-thread thr_id] [--json]",
    "  bb chief delegate [--title \"…\"] --mission \"…\" [--criteria \"…\"]... [--constraint \"…\"]... [--context \"…\"] [--branch feature/…] [--issue-url …] [--pr-url …] [--replaces thr_id] [--plan-thread thr_id --wave N] [--unplanned-reason \"…\"] [--verify \"cmd\"] [--kind worker|designer|tester|spec-writer] [--json]",
    "  bb chief inspect <thread-id>",
    "  bb chief continue <thread-id> --instruction \"…\" [--json]",
    "  bb chief stop <thread-id> [--reason \"…\"] [--json]",
    "  bb chief complete <thread-id> [--result \"…\"] [--override \"reason\"] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "chief",
    summary: "Supervise visible BB worker and review threads through completion",
    commands: [
      { name: "status", summary: "Show a project's Chief-managed roster", usage: "bb chief status [--project proj_id] [--json]" },
      { name: "stats", summary: "Summarise a project's or Chief run's reliability: tasks, repairs, failures, wall time", usage: "bb chief stats [--project proj_id] [--chief thr_id] [--json]" },
      { name: "start", summary: "Start or return the latest Chief for a project", usage: "bb chief start [--project proj_id] [--json]" },
      { name: "create", summary: "Create another Chief for a project", usage: "bb chief create [--project proj_id] [--json]" },
      { name: "adopt", summary: "Adopt an existing ordinary thread as its project's Chief", usage: "bb chief adopt --thread thr_id [--json]" },
      { name: "plan", summary: "Start a read-only planner for work Chief has not delegated yet", usage: "bb chief plan [--title \"…\"] --mission \"…\" [--revises thr_id] [--json]" },
      { name: "consult", summary: "Start a read-only advisor on a hard problem or a change that keeps failing review", usage: "bb chief consult [--title \"…\"] --mission \"…\" [--worker thr_id | --plan-thread thr_id] [--json]" },
      { name: "delegate", summary: "Start a clearly titled worker in a managed worktree", usage: "bb chief delegate [--title \"…\"] --mission \"…\" [--branch feature/…] [--issue-url …] [--pr-url …] [--replaces thr_id] [--plan-thread thr_id --wave N] [--unplanned-reason \"…\"] [--verify \"cmd\"] [--kind worker|designer|tester|spec-writer] [--json]" },
      { name: "inspect", summary: "Inspect a managed thread's live and reported evidence", usage: "bb chief inspect <thread-id>" },
      { name: "continue", summary: "Nudge a managed thread that is still working", usage: "bb chief continue <thread-id> --instruction \"…\" [--json]" },
      { name: "stop", summary: "Interrupt a stuck managed thread, keeping its worktree for a replacement", usage: "bb chief stop <thread-id> [--reason \"…\"] [--json]" },
      { name: "complete", summary: "Mark verified, non-running managed work complete", usage: "bb chief complete <thread-id> [--result \"…\"] [--override \"reason\"] [--json]" },
    ],
    async run(argv: string[], context: PluginCliContext): Promise<PluginCliResult> {
      const [command, ...rest] = argv;
      const args = parseArgs(rest);
      const json = args.bool("json");
      const ok = (data: unknown, text: string) => ({ exitCode: 0, stdout: clip(json ? JSON.stringify(data, null, 2) : text, 64_000) + "\n" });
      const fail = (message: string) => ({ exitCode: 1, stderr: `${message}\n\n${usage}\n` });
      try {
        if (!command || command === "help" || command === "--help") return ok({}, usage);
        // The CLI cannot prove who is calling (BB_THREAD_ID is only forwarded), so no caller may start a review from it.
        if (command === "review") return fail("bb chief review is retired: only the active Chief starts reviews, through its chief_review tool. Ask Chief in its thread.");
        // The agent tools refuse anyone but the active Chief; the CLI is the same door from a
        // shell. A user's own shell or thread (no managed row) stays trusted.
        const caller = context.threadId ? store.get(context.threadId) : undefined;
        const callerRole = caller?.role;
        if (caller && !ctx.isActiveChief(caller) && command !== "status" && command !== "inspect") {
          return fail(`bb chief ${command} is for the active Chief only${callerRole === "chief" ? "" : `; a managed ${callerRole} reports with chief_report`}.`);
        }
        if (ctx.isCoordinator(caller) && COORDINATOR_REFUSED.has(`chief_${command}`)) return fail(coordinatorRefusal(`bb chief ${command}`));
        // A managed Chief reads only its own roster; an operator shell keeps the project-wide view.
        const readScope = ctx.isActiveChief(caller) ? caller.thread_id : undefined;
        const readProject = caller?.project_id ?? context.projectId;
        // A managed Chief acts only on its directly owned work; an operator shell stays unscoped.
        const scoped = async (id: string) => {
          if (caller) await ctx.controlledTarget(id, caller);
        };
        if (command === "status") {
          const projectId = readScope ? readProject : args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("status requires --project outside a project thread");
          const managedRows = readScope ? ctx.rosterForChief(readScope, true) : ctx.rosterFor(projectId, true);
          const text = [
            ...ctx.pendingLines(readScope ? managedRows.filter((row) => row.thread_id !== readScope) : managedRows, ctx.todoLines(projectId, false, readScope)),
            ...managedRows.map((row) => ctx.rosterRowLines(row).join("\n  ")),
          ].join("\n");
          return ok({ sectionId: ctx.storedSectionId(), threads: managedRows.map(ctx.toManaged) }, text);
        }
        if (command === "stats") {
          const chiefId = readScope ?? args.one("chief");
          const chief = chiefId ? store.get(chiefId) : undefined;
          if (chiefId && chief?.role !== "chief") return fail(`No Chief thread ${chiefId}.`);
          const projectId = chief?.project_id ?? args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("stats requires --project outside a project thread");
          const todos = ([...todosForProject.all(projectId), ...closedTodosForProject.all(projectId)] as TodoRow[]).filter((todo) => !chiefId || todo.chief_thread_id === chiefId);
          const stats = ctx.chiefStats({ projectId, chiefThreadId: chiefId ?? null }, chiefId ? ctx.rosterForChief(chiefId, true) : ctx.rosterFor(projectId, true), todos);
          return ok(stats, ctx.statsText(stats));
        }
        if (command === "start") {
          const result = await ctx.ensureChief(args.one("project") ?? context.projectId ?? undefined);
          return ok(result, `${result.created ? "Started" : "Using"} Chief thread ${result.threadId}.`);
        }
        if (command === "create") {
          const projectId = args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("create requires --project outside a project thread");
          const result = await ctx.createChief(projectId);
          return ok(result, `Created Chief thread ${result.threadId}.`);
        }
        if (command === "adopt") {
          const threadId = args.one("thread") ?? args.positional[0];
          if (!threadId) return fail("adopt requires --thread <thread-id>");
          // Adoption rewrites the row in place, so re-adopting a worker would
          // discard the branch and forge links its open PR depends on.
          const registered = store.get(threadId);
          if (ctx.isCoordinator(registered)) return fail(`Thread ${threadId} is a Coordinator: it owns no managed work and cannot be adopted as a project's Chief.`);
          if (registered && registered.role !== "chief") {
            return fail(`Thread ${threadId} is already a managed ${registered.role} (“${registered.title}”). Adopting it would discard its branch, forge links, and report.`);
          }
          const thread = await bb.sdk.threads.get({ threadId });
          const sectionId = await ctx.ensureSection();
          const title = `Chief · ${await ctx.projectName(thread.projectId)}`;
          await bb.sdk.threads.update({ threadId, sectionId, visibility: "visible", title });
          const previous = ctx.chiefForProject(thread.projectId);
          if (previous && previous.thread_id !== threadId) ctx.handOver(previous.thread_id, threadId, thread.projectId);
          store.insert({ threadId, role: "chief", projectId: thread.projectId, title, state: thread.status === "active" ? "active" : "idle", status: thread.status });
          await ctx.readRules(thread.projectId);
          return ok({ threadId, projectId: thread.projectId, title }, `Adopted ${threadId} as “${title}”.`);
        }
        if (command === "plan") {
          const parsed = planParams.safeParse({
            title: args.one("title"), mission: args.one("mission"), context: args.one("context"),
            revises: args.one("revises"),
          });
          if (!parsed.success) return fail(`Invalid plan brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await ctx.startPlan(parsed.data, context.threadId);
          return ok(result, `Started planner “${result.title}” in ${result.threadId}.${result.warning ? `\n${result.warning}` : ""}`);
        }
        if (command === "consult") {
          const parsed = consultParams.safeParse({
            title: args.one("title"), mission: args.one("mission"), context: args.one("context"),
            workerThreadId: args.one("worker"), planThreadId: args.one("plan-thread"),
          });
          if (!parsed.success) return fail(`Invalid consult brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await ctx.startConsult(parsed.data, context.threadId);
          return ok(result, `Started advisor “${result.title}” in ${result.threadId}.`);
        }
        if (command === "delegate") {
          const parsed = delegateParams.safeParse({
            title: args.one("title"), mission: args.one("mission"),
            successCriteria: args.all("criteria"), constraints: args.all("constraint"), context: args.one("context"),
            branch: args.one("branch"), issueUrl: args.one("issue-url"), prUrl: args.one("pr-url"),
            replaces: args.one("replaces"),
            planThreadId: args.one("plan-thread"),
            wave: args.one("wave") !== undefined ? Number(args.one("wave")) : undefined,
            unplannedReason: args.one("unplanned-reason"),
            kind: args.one("kind"),
            userApprovedRound: args.bool("user-approved-round") || undefined,
            // undefined, not false: an absent flag must not override replaces: inheritance.
            verifyCommand: args.one("verify"),
          });
          if (!parsed.success) return fail(`Invalid delegate brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await ctx.delegate(parsed.data, context.threadId);
          return ok(result, `Started worker “${result.title}” in ${result.threadId}.`);
        }
        if (command === "inspect") {
          const threadId = args.positional[0];
          if (!threadId) return fail("inspect requires <thread-id>");
          const row = store.get(threadId);
          if (!row) return fail(`No managed thread ${threadId}.`);
          if (readScope && (row.project_id !== readProject || !ctx.belongsToChief(row, readScope))) {
            return fail(`No managed thread ${threadId} for this Chief.`);
          }
          return ok({ threadId }, await ctx.inspect(threadId, row.project_id));
        }
        if (command === "continue") {
          const threadId = args.positional[0];
          const instruction = args.one("instruction");
          if (!threadId || !instruction) return fail("continue requires <thread-id> and --instruction");
          await scoped(threadId);
          const capped = await ctx.continueThread(threadId, instruction);
          return ok({ threadId }, `Continued ${threadId}.${capped ? ctx.stallCapNote : ""}`);
        }
        if (command === "stop") {
          const parsed = stopParams.safeParse({ threadId: args.positional[0], reason: args.one("reason") });
          if (!parsed.success) return fail(`Invalid stop target: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          await scoped(parsed.data.threadId);
          const row = await ctx.stopThread(parsed.data.threadId, parsed.data.reason);
          return ok(ctx.toManaged(row), `Stopped “${row.title}”. ${row.recommendation}`);
        }
        if (command === "complete") {
          const threadId = args.positional[0];
          if (!threadId) return fail("complete requires <thread-id>");
          await scoped(threadId);
          const override = args.one("override");
          if (override === "true") return fail("--override needs a reason.");
          const reason = overrideSchema.safeParse(override);
          if (!reason.success) return fail("--override must be 1-500 characters.");
          const { row, overridden, cleanup } = await ctx.markComplete(threadId, args.one("result"), reason.data);
          const ready = await ctx.readyPullRequest(row);
          return ok({ ...ctx.toManaged(row), overridden, cleanup, prReady: ready.prReady, ...(ready.error ? { prReadyError: ready.error } : {}) },
            `Marked “${row.title}” complete${overridden ? " without a matching approve (override recorded in its result)" : ""}.${ready.line}${ctx.cleanupLine(cleanup)}`);
        }
        return fail(`Unknown command “${command}”.`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });}

