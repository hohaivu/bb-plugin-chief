import { clip, type RecordedCommand } from "../core/text";
import { transientFailure } from "./util";
import type { Ctx } from "./context";

export function createInspect(ctx: Ctx) {
  const { bb, planWavesFor, store, upsertCooldown } = ctx;
  async function lastOutput(threadId: string) {
    try {
      return (await bb.sdk.threads.output({ threadId })).output;
    } catch (error) {
      bb.log.warn(`Could not inspect output for ${threadId}: ${String(error)}`);
      return null;
    }
  }

  /** The worker's completed shell commands as BB recorded them (item/completed commandExecution),
   * last 20. null when the log cannot be read; [] when the provider records none. Never throws. */
  async function recordedCommands(threadId: string): Promise<RecordedCommand[] | null> {
    try {
      const commands: RecordedCommand[] = [];
      let beforeSeq: string | undefined;
      // The server rejects a page over 100 events (HTTP 400), which used to read as "none recorded".
      // ponytail: newest first, 5 pages of 100 events; commands older than that budget are not shown.
      for (let page = 0; page < 5 && commands.length < 20; page++) {
        const events = await bb.sdk.threads.events.list({ threadId, types: ["item/completed"], order: "desc", limit: "100", ...(beforeSeq ? { beforeSeq } : {}) });
        for (const event of events) {
          if (event.type !== "item/completed" || event.data.item.type !== "commandExecution") continue;
          const item = event.data.item;
          commands.push({ command: item.command, exitCode: item.exitCode ?? null, status: item.status });
          if (commands.length === 20) break;
        }
        if (events.length < 100) break;
        beforeSeq = String(events.at(-1)!.seq);
      }
      return commands.reverse();
    } catch (error) {
      bb.log.warn(`Could not read recorded commands for ${threadId}: ${String(error)}`);
      return null;
    }
  }

  async function lastProviderError(threadId: string) {
    try {
      const [event] = await bb.sdk.threads.events.list({ threadId, types: ["provider/error", "system/error"], order: "desc", limit: "1" });
      if (event?.type !== "provider/error" && event?.type !== "system/error") return null;
      const info = event.type === "provider/error" ? event.data.errorInfo : undefined;
      const text = [info?.category, info?.httpStatusCode, event.data.message, event.data.detail].filter(Boolean).join(" ");
      return { text, at: event.createdAt };
    } catch (error) {
      bb.log.warn(`Could not read the last provider error for ${threadId}: ${String(error)}`);
      return null;
    }
  }

  /** Records a usage-limit failure as a cooldown on the thread's provider+model. Never throws. */
  async function noteCooldown(threadId: string, failure: { text: string; at: number }) {
    const transient = transientFailure(failure.text);
    if (!transient?.usageLimit) return null;
    // The thread carries its provider; its execution options carry the model.
    let options: { providerId?: string; model?: string } | null = null;
    try {
      const [live, execution] = await Promise.all([bb.sdk.threads.get({ threadId }), bb.sdk.threads.defaultExecutionOptions({ threadId })]);
      options = { providerId: live?.providerId, model: execution?.model };
    } catch (error) {
      bb.log.warn(`Could not read the provider of ${threadId}: ${String(error)}`);
    }
    if (!options?.providerId) {
      bb.log.warn(`No provider known for ${threadId}; its usage limit is not recorded as a cooldown.`);
      return null;
    }
    if (!options.model) {
      bb.log.warn(`No model known for ${threadId}; its usage limit is not recorded as a cooldown.`);
      return null;
    }
    const until = failure.at + (transient.resetSeconds ?? 15 * 60) * 1000;
    upsertCooldown.run(options.providerId, options.model, until, clip(failure.text, 400), Date.now());
    return { providerId: options.providerId, model: options.model, until };
  }

  async function inspect(threadId: string, projectId: string) {
    const row = store.get(threadId);
    if (!row || row.project_id !== projectId) throw new Error(`No managed thread ${threadId} for this Chief project.`);
    let liveStatus = row.status;
    try {
      const live = await bb.sdk.threads.get({ threadId });
      liveStatus = live.deletedAt !== null ? "deleted" : live.archivedAt !== null ? "archived" : live.status;
    } catch (error) {
      bb.log.warn(`Could not inspect live status for ${threadId}: ${String(error)}`);
    }
    const output = await lastOutput(threadId);
    return [
      `Thread: ${row.title} (${threadId})`,
      `Role: ${row.role}`,
      ...(row.kind ? [`Kind: ${row.kind}`] : []),
      ...(row.branch ? [`Branch: ${row.branch}`] : []),
      ...(row.issue_url ? [`Issue: ${row.issue_url}`] : []),
      ...(row.pr_url ? [`Pull request: ${row.pr_url}`] : []),
      ...(row.unplanned_reason ? [`Unplanned: ${clip(row.unplanned_reason, 300)}`] : []),
      ...(row.review_skipped ? [`Review skipped: ${clip(row.review_skipped, 300)}`] : []),
      ...(row.tests_skipped ? [`Tests skipped: ${clip(row.tests_skipped, 300)}`] : []),
      ...(row.retest_skipped ? [`Retest skipped: ${clip(row.retest_skipped, 300)}`] : []),
      ...(row.role === "planner" ? planWavesFor(threadId).flatMap((wave, index) => wave.testsSkipped ? [`wave ${index + 1}: tests skipped: ${clip(wave.testsSkipped, 300)}`] : []) : []),
      ...(row.role === "planner" ? planWavesFor(threadId).flatMap((wave, index) => wave.specsSkipped ? [`wave ${index + 1}: specs skipped: ${clip(wave.specsSkipped, 300)}`] : []) : []),
      `Persisted state: ${row.state}`,
      `Live status: ${liveStatus ?? "unknown"}`,
      ...(row.summary ? [`Summary: ${row.summary}`] : []),
      ...(row.result ? [`Result: ${clip(row.result, 1_500)}`] : []),
      ...(row.blocker ? [`Blocker: ${clip(row.blocker, 600)}`] : []),
      ...(row.recommendation ? [`Recommendation: ${clip(row.recommendation, 600)}`] : []),
      ...(row.verdict ? [`Verdict: ${row.verdict}`] : []),
      ...(row.verdict_path ? [`Verdict file: ${row.verdict_path}`] : []),
      ...(row.report_path ? [`Full report (last chief_report): ${row.report_path}`] : []),
      `Last assistant output:\n${output ? clip(output, 2_000) : "(none available)"}`,
    ].join("\n");
  }
  return { inspect, lastOutput, lastProviderError, noteCooldown, recordedCommands };
}

