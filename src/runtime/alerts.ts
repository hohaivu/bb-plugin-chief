import { type ManagedRow, terminal } from "../types";
import { ALERT_MARKER_ROOM, MAX_ALERT_LENGTH, clip } from "../core/text";
import { createHash } from "node:crypto";
import { bounded } from "./exec";
import type { Ctx } from "./context";
import { retryDue } from "./core";

/** One worker a reviewer covers: the report and PR head its verdict is bound to. */
interface AlertRow {
  dedupe_key: string;
  target_thread_id: string;
  source_thread_id: string;
  message: string;
  delivered_at: number | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  last_attempt_at: number | null;
}

export function createAlerts(ctx: Ctx) {
  const { bb, db, pendingAlerts, store } = ctx;
  /** The outbox write itself, in no transaction of its own: the report intake calls it inside its store.batch. The row needs a Chief. */
  function writeAlert(row: ManagedRow, key: string, message: string) {
    const dedupeKey = `${row.thread_id}:${key}`;
    // Only an alert of the same kind (the segment before the first ":") is stale
    // once this one lands — a newer report supersedes an older undelivered report,
    // but generic lifecycle noise (idle, active, stall, ...) must never evict a
    // pending report/verdict alert Chief has not received yet.
    const kind = key.slice(0, key.indexOf(":"));
    db.prepare(`DELETE FROM alert_outbox WHERE source_thread_id=? AND delivered_at IS NULL AND dedupe_key<>? AND dedupe_key LIKE ?`)
      .run(row.thread_id, dedupeKey, `${row.thread_id}:${kind}:%`);
    insertAlert(row.thread_id, row.chief_thread_id, dedupeKey, message);
    return dedupeKey;
  }

  /** One outbox row, once: a repeated key adds nothing and returns false. */
  function insertAlert(sourceId: string, targetId: string | null, dedupeKey: string, message: string, label = "Chief lifecycle alert") {
    // The last line is an id a retry finds in the target's queue or events; it is never clipped.
    const id = createHash("sha1").update(dedupeKey).digest("hex").slice(0, 10);
    return db.prepare(`INSERT OR IGNORE INTO alert_outbox
      (dedupe_key, target_thread_id, source_thread_id, message, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      dedupeKey, targetId, sourceId,
      `${clip(`[${label}]\n${message}`, MAX_ALERT_LENGTH - ALERT_MARKER_ROOM)}\n[alert ${id}]`, Date.now(),
    ).changes > 0;
  }

  /** Records a failure or stall once per (thread, cycle, kind), independent of its alert. Never throws:
   * returns the line the caller appends to its alert when the write failed, so the failure reaches Chief. */
  function recordFailure(row: ManagedRow, kind: "provider" | "stall" | "hard_stall", detail: "usage_limit" | "connection" | null) {
    try {
      if (!row.chief_thread_id) return null;
      const inserted = db.prepare(`INSERT OR IGNORE INTO chief_failure_events (source_thread_id, active_cycle, kind, detail, legacy, at) VALUES (?, ?, ?, ?, 0, ?)`)
        .run(row.thread_id, row.active_cycle, kind, detail, Date.now()).changes > 0;
      if (inserted) ctx.observe.event(kind === "provider" ? "provider_transient" : kind, row, detail);
      return null;
    } catch (error) {
      return `This failure could not be recorded for bb chief stats: ${clip(String(error), 200)}`;
    }
  }

  function enqueueAlert(row: ManagedRow, key: string, message: string) {
    if (!row.chief_thread_id) throw new Error(`Managed thread ${row.thread_id} has no Chief to notify.`);
    return db.transaction(() => writeAlert(row, key, message))();
  }

  /** A delivery call that stalls longer than this fails like any other, so its in-flight entry clears and the outbox retries it. */
  const ALERT_CALL_MS = 30_000;
  /** Why a retried alert no longer applies, or null. Key shape `<source>:<kind>:<rest>`; only a worker stall (`<cycle>[:hard]`) is checked here. */
  async function stillDue(alert: AlertRow): Promise<string | null> {
    const [source, kind, cycle] = alert.dedupe_key.split(":");
    if (kind !== "stall") return null;
    const row = store.get(source);
    return row && row.state === "active" && row.active_cycle === Number(cycle) ? null : "stall no longer applies";
  }

  async function deliverAlert(key: string) {
    const existing = ctx.state.alertDeliveries.get(key);
    if (existing) return existing;
    const delivery = (async () => {
      const alert = db.prepare<[string]>(`SELECT * FROM alert_outbox WHERE dedupe_key=?`).get(key) as AlertRow | undefined;
      if (!alert || alert.delivered_at !== null) return true;
      // Every direct caller meets the same backoff and cap as the batch; a deferred row is not sent and not counted as delivered.
      if (alert.attempts > 0) {
        if (!retryDue(alert, Date.now())) return false;
        const stale = await stillDue(alert);
        if (stale) {
          db.prepare(`UPDATE alert_outbox SET delivered_at=?, last_error=? WHERE dedupe_key=?`).run(Date.now(), clip(`stale: ${stale}`, 1_000), key);
          return true;
        }
        // A retry matches its earlier copy by the marker line, or by exact text for a row stored before markers.
        try {
          const text = clip(alert.message);
          const marker = `[alert ${createHash("sha1").update(key).digest("hex").slice(0, 10)}]`;
          const matches = (part: { type: string; text?: string }) => part.type === "text" && !!part.text && (part.text.includes(marker) || part.text === text);
          const queued = await bounded(() => bb.sdk.threads.queuedMessages.list({ threadId: alert.target_thread_id }), ALERT_CALL_MS);
          const alreadySent = queued.some((message) => message.content.some(matches))
            || (await bounded(() => bb.sdk.threads.events.list({
              threadId: alert.target_thread_id, types: ["item/completed"], order: "desc", limit: "50",
            }), ALERT_CALL_MS)).some((event) => event.type === "item/completed" && event.data.item.type === "userMessage"
              && event.data.item.content.some(matches));
          if (alreadySent) {
            db.prepare(`UPDATE alert_outbox SET delivered_at=?, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
            return true;
          }
        } catch {
          // Fall through to the send below.
        }
      }
      // Counted before the send: a crash after it leaves attempts > 0, so the retry checks for the marker.
      db.prepare(`UPDATE alert_outbox SET attempts=attempts+1, last_attempt_at=? WHERE dedupe_key=?`).run(Date.now(), key);
      try {
        await bounded(() => bb.sdk.threads.send({
          threadId: alert.target_thread_id,
          ...(alert.source_thread_id !== alert.target_thread_id ? { senderThreadId: alert.source_thread_id } : {}),
          mode: "queue-if-active",
          input: [{ type: "text", text: clip(alert.message), mentions: [] }],
        }), ALERT_CALL_MS);
        db.prepare(`UPDATE alert_outbox SET delivered_at=?, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(`UPDATE alert_outbox SET last_error=? WHERE dedupe_key=?`).run(clip(message, 1_000), key);
        bb.log.warn(`Could not deliver Chief alert ${key}: ${message}`);
        return false;
      }
    })();
    ctx.state.alertDeliveries.set(key, delivery);
    try {
      return await delivery;
    } finally {
      ctx.state.alertDeliveries.delete(key);
    }
  }

  /** An alert from a Chief to itself, once per key. Sent without a sender: a thread cannot message itself as its own sender. */
  async function alertSelf(chiefThreadId: string, key: string, message: string, label?: string) {
    const dedupeKey = `${chiefThreadId}:${key}`;
    insertAlert(chiefThreadId, chiefThreadId, dedupeKey, message, label);
    return deliverAlert(dedupeKey);
  }

  async function alertChief(row: ManagedRow, key: string, message: string) {
    const outboxKey = enqueueAlert(row, key, message);
    return deliverAlert(outboxKey);
  }

  /** A linked child Chief is done when it is idle, owns no open row or todo and owns a completed row. Returns the newest completed row: it keys the alert, so a later round alerts again and a repeat adds nothing. */
  function childDone(child: ManagedRow) {
    if (child.state !== "idle") return undefined;
    const owned = store.all().filter((row) => row.chief_thread_id === child.thread_id);
    if (owned.some((row) => !terminal(row.state))) return undefined;
    const latest = owned.filter((row) => row.state === "complete").reduce<ManagedRow | undefined>((best, row) => (!best || row.updated_at >= best.updated_at ? row : best), undefined);
    return latest && !db.prepare(`SELECT 1 FROM chief_todos WHERE chief_thread_id=? AND state='open'`).get(child.thread_id) ? latest : undefined;
  }

  /** The one door to a Coordinator's alerts. A child Chief's Need you (chief_escalate) or done state (the sweep, the idle event) alerts its
   * active Coordinator once per receipt key: one outbox row, never a deletion of another pending row. Any other row is ignored; a failure
   * is logged, never thrown: retryAlerts redelivers the row. */
  function alertCoordinator(child: ManagedRow, alert: { kind: "done" } | { kind: "need-you"; request: string; concerned?: ManagedRow }) {
    try {
      const coordinator = store.get(child.coordinator_thread_id ?? "");
      if (!ctx.isLinkedChild(child) || !ctx.isActiveChief(coordinator) || !ctx.isCoordinator(coordinator)) return;
      const label = `Child Chief “${clip(child.title, 120)}” (${child.thread_id}, project ${child.project_id})`;
      let receipt: string;
      let message: string;
      if (alert.kind === "need-you") {
        receipt = `coordinator-need-you:${createHash("sha1").update(alert.request).digest("hex").slice(0, 12)}`;
        message = [
          `${label} is blocked on a Need you${alert.concerned ? ` about ${alert.concerned.role} “${clip(alert.concerned.title, 120)}” (${alert.concerned.thread_id})` : ""}:`,
          clip(alert.request, 600),
          `The owner answers it in ${child.thread_id}; do not answer or relay it.`,
        ].join("\n");
      } else {
        const latest = childDone(child);
        if (!latest) return;
        receipt = `coordinator-done:${latest.thread_id}`;
        message = `${label} finished its work: every thread it owns is complete and it has no open todo. Check chief_roster, then tell the owner how work stands across your children.`;
      }
      const dedupeKey = `${child.thread_id}:${receipt}`;
      if (insertAlert(child.thread_id, coordinator.thread_id, dedupeKey, message)) void deliverAlert(dedupeKey);
    } catch (error) {
      bb.log.warn(`Could not alert Coordinator of ${child.thread_id}: ${String(error)}`);
    }
  }

  async function retryAlerts() {
    for (const alert of pendingAlerts.all(Date.now() - 60_000, Date.now()) as AlertRow[]) await deliverAlert(alert.dedupe_key);
  }
  return { alertChief, alertCoordinator, alertSelf, deliverAlert, enqueueAlert, insertAlert, recordFailure, retryAlerts, writeAlert };
}

