import { forgeInitScript } from "../forge/forge";
import { sanitizeForge } from "../forge/forgeComments";
import { clip } from "../core/text";
import { chainOf, type PlanWave } from "../plan/waveSchedule";
import { z } from "zod";
import { execFileAsync } from "../runtime/exec";
import { FORGE_SCRIPT_TIMEOUT_MS, serverPath } from "../forge/forge";
import type { Ctx } from "../runtime/context";

/** Longest mission, success criteria or constraints text chief_forge_init puts in a pull request body. */
const FORGE_BRIEF_SECTION_MAX = 1_500;

export function registerForgeInitTool(ctx: Ctx) {
  const { bb, chainOwner, chainStarted, planBase, planWavesFor, store } = ctx;
  ctx.registerChiefTool({
    name: "chief_forge_init",
    presentation: { label: { pending: "Running forge pre-flight…", completed: "Ran forge pre-flight" } },
    description: "Run the forge pre-flight for one task — tracking issue, task branch, draft pull request — before chief_delegate. Refused for a plan until its required advisor review resolves. For a plan, call it only on a chain head (a wave nothing precedes) that has no worker yet: a chain has one branch and one pull request, its later waves continue it with chief_delegate replaces:, and the pull request body lists every wave of the chain. Returns the values, or a script to run yourself when the server could not. The pull request body is the reviewer's whole brief: planned work carries the plan summary and wave contracts (planThreadId and wave); unplanned work must pass mission, successCriteria and constraints, the same text you will pass to chief_delegate.",
    parameters: z.object({
      title: z.string().trim().min(1).max(160).describe("The exact title this task will be delegated with."),
      base: z.string().trim().min(1).max(300).optional().describe("Branch to cut from and target the pull request at. Omit for the project default; name one only to stack deliberately on an open pull request. Stack only when this work builds on that pull request's changes; independent work gets its own PR on the default base. Omit on a plan wave: a stacked or branch-based plan fixes it."),
      body: z.string().trim().min(1).max(4_000).optional().describe("Short summary for the issue and pull request body."),
      planThreadId: z.string().optional().describe("For planned work: the planner thread the task's wave comes from. Give it with wave; the plan summary and the wave's contracts are added to the issue and pull request body."),
      wave: z.number().int().min(1).optional().describe("For planned work: the 1-based wave this task implements. Give it with planThreadId."),
      mission: z.string().trim().min(1).max(12_000).optional().describe("Required without planThreadId (unplanned work): the same mission you will pass to chief_delegate. It goes into the pull request body, which is the reviewer's whole brief."),
      successCriteria: z.string().trim().max(12_000).optional().describe("The same success criteria you will pass to chief_delegate, as text (one per line)."),
      constraints: z.string().trim().max(12_000).optional().describe("The same constraints you will pass to chief_delegate, as text (one per line)."),
    }),
    async execute({ planThreadId, wave, mission, successCriteria, constraints, ...params }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) {
        throw new Error("chief_forge_init requires an active registered Chief thread.");
      }
      if ((planThreadId === undefined) !== (wave === undefined)) {
        throw new Error("Pass planThreadId and wave together, or neither.");
      }
      if (planThreadId === undefined && !mission) {
        throw new Error("chief_forge_init without planThreadId requires mission (with successCriteria and constraints when you have them): the pull request body is the reviewer's whole brief. Pass the same text you will give chief_delegate.");
      }
      let body = params.body;
      // Sections the pull request alone must carry for the reviewer; each is clipped so the body stays bounded.
      const briefSections = [
        ...(mission ? ["## Mission", clip(mission, FORGE_BRIEF_SECTION_MAX)] : []),
        ...(successCriteria ? ["## Success criteria", clip(successCriteria, FORGE_BRIEF_SECTION_MAX)] : []),
        ...(constraints ? ["## Constraints", clip(constraints, FORGE_BRIEF_SECTION_MAX)] : []),
      ];
      if (planThreadId === undefined) body = [params.body ?? `Tracking work for ${params.title}.`, "", ...briefSections].join("\n");
      if (planThreadId !== undefined && wave !== undefined) {
        const planner = store.get(planThreadId);
        if (!planner || planner.role !== "planner" || !ctx.controlsThread(planner, caller.thread_id)) {
          throw new Error(`No managed planner ${planThreadId} for this Chief.`);
        }
        const reviewRefusal = ctx.planReviewRefusal(planner);
        if (reviewRefusal) throw new Error(reviewRefusal);
        const waves = planWavesFor(planThreadId);
        if (wave > waves.length) {
          throw new Error(`Wave ${wave} is out of range: planner ${planThreadId} scheduled ${waves.length} wave(s).`);
        }
        // A chain has one branch and one pull request, opened here on its head and never again: raw waves, so a waived test wave stays on the chain.
        const rawWaves = planner.plan_waves ? JSON.parse(planner.plan_waves) as PlanWave[] : [];
        const chain = chainOf(rawWaves, wave);
        if (chain[0] !== wave) {
          throw new Error(`Wave ${wave} is not a chain head: it continues the chain of waves ${chain.join(", ")}, which has one branch and one pull request, opened by chief_forge_init on head wave ${chain[0]} only. Delegate wave ${wave} with chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}, replaces: <the chain's latest worker>).`);
        }
        const started = chainStarted(planThreadId, rawWaves, wave);
        if (started) {
          throw new Error(`Wave ${wave}'s chain already has worker ${started.thread_id}${started.branch ? ` on branch ${started.branch}` : ""}${started.pr_url ? ` with pull request ${started.pr_url}` : ""}: a chain has one branch and one pull request. ${chainOwner(planThreadId, rawWaves, wave) ? `Continue it with chief_delegate (planThreadId: ${planThreadId}, wave: ${started.plan_wave ?? wave}, replaces: ${chainOwner(planThreadId, rawWaves, wave)!.thread_id}).` : `Delegate wave ${wave}'s worker onto it with chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}).`}`);
        }
        // The plan base is authoritative for a stacked or branch-based chain: forge, admission and review read the same value.
        const pb = planBase(planThreadId, wave);
        if (pb) {
          if (params.base !== undefined && params.base !== pb.base) {
            throw new Error(`Wave ${wave}'s base is fixed by the plan (${pb.base ?? "the parent chain's branch"}); omit base.`);
          }
          if (pb.waiting || !pb.base) throw new Error(`Wave ${wave} is stacked: ${pb.waiting ?? pb.unresolved}. Run chief_forge_init for it after that.`);
          params.base = pb.base;
        }
        body = [
          params.body ?? `Tracking work for ${params.title}.`,
          ...(briefSections.length ? ["", ...briefSections] : []),
          "", `<details><summary>Plan — chain of waves ${chain.join(", ")} of ${waves.length} (planner ${planThreadId})</summary>`,
          "", clip(planner.result ?? "", 1_500),
          "</details>",
          ...chain.flatMap((n) => [
            "", `<details><summary>Wave ${n} of ${waves.length} — ${rawWaves[n - 1]!.title ?? "no description"}</summary>`,
            ...(rawWaves[n - 1]!.testsSkipped ? ["", `Tests skipped: ${ctx.forgeText(rawWaves[n - 1]!.testsSkipped!, 500)}`] : []),
            "", "### Contracts to verify", clip(rawWaves[n - 1]!.contracts ?? "None listed.", 2_000),
            "</details>",
          ]),
        ].join("\n");
      }
      // One tracking issue per plan: its title and body describe the plan, every wave's pull request tracks it.
      const planner = planThreadId ? store.get(planThreadId) : undefined;
      const planIssue = (): Partial<Parameters<typeof forgeInitScript>[0]> => {
        if (!planner) return {};
        const current = store.get(planner.thread_id)?.plan_issue_url;
        if (current) return { issueUrl: current };
        const waves = planWavesFor(planner.thread_id);
        return {
          issueTitle: planner.title.replace(/^Plan · /, ""),
          issueBody: sanitizeForge([
            "Chief tracks this plan here: one comment per task outcome, one pull request per chain.", "",
            clip(planner.result ?? "", 1_500), "", "### Waves",
            ...waves.map((entry, index) => `Wave ${index + 1}: ${entry.title ?? "no description"}${entry.dependsOn?.length ? ` · depends on ${entry.dependsOn.join(", ")}` : ""}${entry.design ? " · design" : ""}`),
          ].join("\n")),
        };
      };
      const first = forgeInitScript({ ...params, body, ...planIssue() });
      const { branch } = first;
      let script = first.script;
      const cwd = await ctx.projectPath(caller.project_id);
      let failure: string | null = null;
      if (cwd) {
        // ponytail: a remote-host project whose path also exists on the server would run against the wrong checkout; unlikely.
        try {
          // Runs for one plan are serialized, so the second wave's call sees the issue the first one made.
          const parse = (stdout: unknown) => {
            const found = String(stdout).match(/^CHIEF_FORGE (.*)$/gm)?.at(-1)?.slice("CHIEF_FORGE ".length);
            return { line: found, values: Object.fromEntries((found ?? "").split(" ").map((pair) => {
              const at = pair.indexOf("=");
              return [pair.slice(0, at), pair.slice(at + 1)];
            })) as Record<string, string> };
          };
          const run = ctx.state.forgeRuns.then(async () => {
            script = forgeInitScript({ ...params, body, ...planIssue() }).script;
            const out = await execFileAsync("sh", ["-c", script], {
              cwd, timeout: FORGE_SCRIPT_TIMEOUT_MS,
              env: { ...process.env, PATH: serverPath() },
            });
            // Recorded before the next wave's run starts, so that run reuses this issue.
            const { values } = parse(out.stdout);
            if (planner && values.branch && values.forge && values.issue_url) {
              store.setPlanIssueUrl(planner.thread_id, values.issue_url);
            }
            return out;
          });
          ctx.state.forgeRuns = run.catch(() => undefined);
          const { line, values } = parse((await run).stdout);
          if (line && values.branch && values.forge) {
            return `The forge pre-flight already ran in the project checkout: branch=${values.branch} base=${values.base ?? ""} issue_url=${values.issue_url ?? ""} pr_url=${values.pr_url ?? ""}. Pass branch, issueUrl and prUrl to chief_delegate, omitting whatever came back empty — an empty issue_url usually means the repository has issues disabled, not a failure. Do not run anything yourself.`;
          }
          failure = !line ? "no CHIEF_FORGE line" : !values.branch ? "the branch was not cut" : "no gh or glab found on the server";
        } catch (error) {
          failure = String(error);
        }
        failure = clip(failure, 200);
        bb.log.warn(`Server-side forge pre-flight fell back to Chief: ${failure}`);
      }
      return [
        ...(failure ? [`Running it on the server did not finish (${failure}), so run it yourself.`] : []),
        "Run this from the project checkout, verbatim. Every value is already substituted and quoted, every forge step is best-effort, and your own checkout never moves:",
        "", "```sh", script, "```", "",
        `The last line is CHIEF_FORGE branch=… base=… issue_url=… pr_url=…. Pass those to chief_delegate as branch, issueUrl and prUrl, omitting whatever came back empty — an empty issue_url usually means the repository has issues disabled, and an empty branch means the cut failed, so ${planThreadId !== undefined && planBase(planThreadId, wave!) ? "the stacked base branch could not be cut: rerun chief_forge_init, and do not delegate without a branch" : "delegate without one and the worktree uses the project default"}. Neither is a failure to report as one. The branch will be ${branch}.`,
      ].join("\n");
    },
  });}

