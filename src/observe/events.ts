import { randomBytes } from "node:crypto";
import { parseDsn, createSentry } from "./sentry";
import { scrub } from "./scrub";
import pkg from "../../package.json";
import type { Ctx } from "../runtime/context";

/** The columns a ledger row takes from a thread row; a ManagedRow satisfies it. */
export interface EventRow {
  thread_id?: string | null;
  project_id?: string | null;
  role?: string | null;
  plan_thread_id?: string | null;
  plan_wave?: number | null;
}

/** Ledgered here and never sent to Sentry. */
const LOCAL_ONLY = new Set(["nudge"]);
const WARNING = new Set(["request_changes", "plan_review_changes", "review_skipped", "tests_skipped", "specs_skipped", "override", "stopped"]);
const newEventId = () => randomBytes(16).toString("hex");

/** One local ledger of failures, review outcomes and nudges (chief_events), mirrored to Sentry when a DSN is set.
 * Must be created with the original bb: its warn feeds Sentry, so the wrapped log would recurse. */
export function createObserve(ctx: Ctx) {
  const { bb, db, settings, store } = ctx;
  let config: { dsn?: string; token?: string } = {};
  const read = (values: { sentryDsn?: string; sentryAuthToken?: string }) => { config = { dsn: values.sentryDsn, token: values.sentryAuthToken }; };
  void settings.get().then(read, () => {});
  settings.onChange((next) => read(next));
  const secrets = () => [config.dsn, config.token, config.dsn ? parseDsn(config.dsn)?.publicKey : undefined].filter((value): value is string => !!value);
  const sentry = createSentry({ dsn: () => config.dsn, secrets, release: pkg.version, warn: (message) => bb.log.warn(message) });
  const insert = db.prepare(`INSERT INTO chief_events (event_id, at, project_id, thread_id, role, plan_thread_id, plan_wave, kind, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const receipt = db.prepare<[string]>(`SELECT 1 FROM chief_events WHERE event_id=?`);

  /** Inserts one row synchronously, so a caller's transaction rolls it back. A ledgered kind then reaches Sentry on the next macrotask, only if its row (the receipt) was committed. */
  function event(kind: string, row: EventRow, detail?: string | null, extraTags: Record<string, string> = {}) {
    const eventId = newEventId();
    const clean = detail == null ? null : scrub(detail, secrets()).slice(0, 300);
    try {
      insert.run(eventId, Date.now(), row.project_id ?? null, row.thread_id ?? null, row.role ?? null, row.plan_thread_id ?? null, row.plan_wave ?? null, kind, clean);
    } catch (error) {
      bb.log.warn(`Could not record a ${kind} event: ${String(error)}`);
      return;
    }
    if (LOCAL_ONLY.has(kind)) return;
    const tags: Record<string, string> = { kind, ...extraTags };
    for (const [name, value] of [["role", row.role], ["thread_id", row.thread_id], ["project_id", row.project_id], ["plan_thread_id", row.plan_thread_id], ["plan_wave", row.plan_wave]] as const) {
      if (value != null) tags[name] = String(value);
    }
    setImmediate(() => {
      if (receipt.get(eventId)) sentry.send({ eventId, level: WARNING.has(kind) ? "warning" : "error", kind, message: clean ?? kind, tags });
    });
  }

  /** A failed chief_* call: the tool name and the first line of its message only, never its params or result. */
  function toolError(tool: string, threadId: string | undefined, projectId: string | undefined, error: unknown) {
    const row = (threadId ? store.get(threadId) : undefined) ?? { thread_id: threadId, project_id: projectId };
    const message = error instanceof Error ? error.message : String(error);
    event("tool_error", row, `${tool}: ${message.split("\n")[0]}`, { tool });
  }

  /** Plugin warnings go straight to Sentry: not ledgered, so no receipt. */
  function warn(message: string) {
    sentry.send({ eventId: newEventId(), level: "warning", kind: "plugin_warn", message, tags: {} });
  }
  return { observe: { event, toolError, warn } };
}
