import { randomBytes } from "node:crypto";
import { createSentry, secretsOf } from "./sentry";
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
 * Must be created with the original bb: its warn feeds Sentry, so the wrapped log would recurse. It also returns that wrapped bb: assign it over ctx.bb so every module built after it reports its warnings. */
export function createObserve(ctx: Ctx) {
  const { bb, db, settings } = ctx;
  let values: { sentryDsn?: string; sentryAuthToken?: string } = {};
  void settings.get().then((next) => { values = next; }, () => {});
  settings.onChange((next) => { values = next; });
  const secrets = () => secretsOf(values);
  const sentry = createSentry({ dsn: () => values.sentryDsn, secrets, release: pkg.version, warn: (message) => bb.log.warn(message) });
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
      let committed: unknown;
      try { committed = receipt.get(eventId); } catch { return; } // db closed before this macrotask: nothing to send
      if (committed) sentry.send({ eventId, level: WARNING.has(kind) ? "warning" : "error", kind, message: clean ?? kind, tags });
    });
  }

  /** Plugin warnings go straight to Sentry: not ledgered, so no receipt. */
  function warn(message: string) {
    sentry.send({ eventId: newEventId(), level: "warning", kind: "plugin_warn", message, tags: {} });
  }
  // A Proxy keeps the SDK object's own `this`; only log.warn differs. `sdk` is callable but a namespace, not a method: binding it breaks it.
  const log = { debug: (message: string) => bb.log.debug(message), info: (message: string) => bb.log.info(message), error: (message: string) => bb.log.error(message), warn: (message: string) => { bb.log.warn(message); warn(message); } };
  const observed = new Proxy(bb, { get: (target, prop) => { const value = prop === "log" ? log : Reflect.get(target, prop, target); return typeof value === "function" && prop !== "sdk" ? value.bind(target) : value; } });
  return { observe: { event, warn }, bb: observed };
}
