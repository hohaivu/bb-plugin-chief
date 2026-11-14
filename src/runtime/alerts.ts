import { type ManagedRow, terminal } from "../types";
import { ALERT_MARKER_ROOM, MAX_ALERT_LENGTH, clip } from "../core/text";
import { createHash } from "node:crypto";
import { bounded } from "./exec";
import type { Ctx } from "./context";
import { retryDue, stallThresholdMs } from "./core";
import { BUSY_STATUSES } from "./constants";

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
  /** Deletes the source's undelivered alerts of the same kind (the segment of `key` before its first ":") except `key` itself, optionally only those to one target.
   * A newer report supersedes an older undelivered report, a newer done an older done; generic lifecycle noise (idle, active, stall, ...) never evicts a pending report or verdict alert. */
  function evictOlder(sourceId: string, key: string, targetId?: string) {
    db.prepare(`DELETE FROM alert_outbox WHERE source_thread_id=? AND delivered_at IS NULL AND dedupe_key<>? AND dedupe_key LIKE ? AND (? IS NULL OR target_thread_id=?)`)
      .run(sourceId, `${sourceId}:${key}`, `${sourceId}:${key.slice(0, key.indexOf(":"))}:%`, targetId ?? null, targetId ?? null);
  }

  /** The outbox write itself, in no transaction of its own: the report intake calls it inside its store.batch. The row needs a Chief. */
  function writeAlert(row: ManagedRow, key: string, message: string) {
    const dedupeKey = `${row.thread_id}:${key}`;
    evictOlder(row.thread_id, key);
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

  /** The current receipt suffix of each state-derived Coordinator alert, or undefined when it does not apply now. Creating the alert and re-checking a retry both call it, so the key and the freshness rule cannot drift. */
  const receiptRest: Record<"done" | "failed" | "stalled", (child: ManagedRow, thresholdMs: number, now: number) => string | undefined> = {
    done: (child) => childDone(child)?.thread_id,
    failed: (child) => (child.state === "failed" ? String(child.active_cycle) : undefined),
    stalled: (child, thresholdMs, now) => stalledKey(child, thresholdMs, now),
  };

  /** A delivery call that stalls longer than this fails like any other, so its in-flight entry clears and the outbox retries it. */
  const ALERT_CALL_MS = 30_000;
  /** Why a retried alert no longer applies, or null. Key shape `<source>:<kind>:<rest>`. A Coordinator kind is checked against the same live
   * condition that created it (coordinatorOf, childDone, stalledKey), so a retry is due exactly when a fresh evaluation gives the same key. */
  async function stillDue(alert: AlertRow): Promise<string | null> {
    const [source, kind, ...parts] = alert.dedupe_key.split(":");
    const rest = parts.join(":");
    if (kind === "stall") {
      const row = store.get(source);
      return row && row.state === "active" && row.active_cycle === Number(parts[0]) ? null : "stall no longer applies";
    }
    if (!kind.startsWith("coordinator-") || kind === "coordinator-ended") return null;
    const child = store.get(source);
    if (!child) return `${kind} source is gone`;
    const stale = `${kind} no longer applies`;
    const coordinator = coordinatorOf(child);
    const derived = kind.slice("coordinator-".length);
    if (derived in receiptRest) {
      const thresholdMs = derived === "stalled" ? stallThresholdMs(await ctx.settings.get()) : 0;
      return coordinator === alert.target_thread_id && receiptRest[derived as keyof typeof receiptRest](child, thresholdMs, Date.now()) === rest ? null : stale;
    }
    switch (kind) {
      case "coordinator-need-you":
        // A key from before the cycle suffix (one part) has no cycle: the relation check alone decides, and the hash is never read as a cycle.
        return coordinator === alert.target_thread_id && (parts.length === 1 || child.active_cycle === Number(parts[1])) ? null : stale;
      case "coordinator-attached":
        return coordinator === rest ? null : stale;
      case "coordinator-gone":
        return ctx.isActiveChief(child) && child.coordinator_thread_id === rest && deadCoordinator(child) ? null : stale;
      default:
        return null;
    }
  }

  async function deliverAlert(key: string) {
    const existing = ctx.state.alertDeliveries.get(key);
    if (existing) return existing;
    const delivery = (async () => {
      const alert = db.prepare<[string]>(`SELECT * FROM alert_outbox WHERE dedupe_key=?`).get(key) as AlertRow | undefined;
      if (!alert || alert.delivered_at !== null) return true;
      // Every direct caller meets the same backoff and cap as the batch; a deferred row is not sent and not counted as delivered.
      // A Coordinator receipt whose target is dead can never land: it is settled stale when it no longer applies, else left unsent.
      const deadTarget = key.includes(":coordinator-") && ["complete", "archived", "deleted"].includes(store.get(alert.target_thread_id)?.state ?? "");
      if (alert.attempts > 0 || deadTarget) {
        if (alert.attempts > 0 && !retryDue(alert, Date.now())) return false;
        const stale = await stillDue(alert);
        if (stale) {
          db.prepare(`UPDATE alert_outbox SET delivered_at=?, last_error=? WHERE dedupe_key=?`).run(Date.now(), clip(`stale: ${stale}`, 1_000), key);
          return true;
        }
        if (deadTarget) return false;
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

  /** The managed rows a Chief owns. */
  const ownedRows = (chief: ManagedRow) => store.all().filter((row) => row.chief_thread_id === chief.thread_id);

  /** A linked child Chief is done when it is idle, owns no open row or todo and owns a completed row. Returns the newest completed row: it keys the alert, so a later round alerts again and a repeat adds nothing. */
  function childDone(child: ManagedRow) {
    if (child.state !== "idle") return undefined;
    const { rows, todos } = openWork(child);
    if (rows.length || todos.n) return undefined;
    return ownedRows(child).filter((row) => row.state === "complete").reduce<ManagedRow | undefined>((best, row) => (!best || row.updated_at >= best.updated_at ? row : best), undefined);
  }

  /** The Coordinator a child Chief is linked to and live under, for a child that is itself still an active Chief. A superseded (complete) child has none. */
  function coordinatorOf(child: ManagedRow) {
    return ctx.isActiveChief(child) ? ctx.liveCoordinatorId(child) : undefined;
  }

  const isGone = (row: ManagedRow) => row.state === "archived" || row.state === "deleted";

  /** The child's Coordinator row when it is archived or deleted, else undefined. */
  function deadCoordinator(child: ManagedRow) {
    const coordinator = store.get(child.coordinator_thread_id ?? "");
    return ctx.isCoordinator(coordinator) && isGone(coordinator!) ? coordinator : undefined;
  }

  /** When the child last asked the owner in its current turn (a need-you receipt of its active_cycle), or null. */
  function needYouAt(child: ManagedRow) {
    return (db.prepare(`SELECT MAX(created_at) AS at FROM alert_outbox WHERE dedupe_key LIKE ?`).get(`${child.thread_id}:coordinator-need-you:%:${child.active_cycle}`) as { at: number | null }).at;
  }

  /** What an idle child still holds: its open managed rows, its open todos, and when it or any of them last changed. */
  function openWork(child: ManagedRow) {
    const rows = ownedRows(child).filter((row) => !terminal(row.state));
    const todos = (db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(after IS NULL), 0) AS ready FROM chief_todos WHERE chief_thread_id=? AND state='open'`).get(child.thread_id) as { n: number; ready: number });
    return { rows, todos, since: Math.max(child.updated_at, ...rows.map((row) => row.updated_at)) };
  }

  /** `<cycle>:active` for a child whose turn has run thresholdMs; `<cycle>:idle` for an idle child with open work that nothing moves (no busy row, no
   * Need you this cycle, quiet thresholdMs); else undefined. The creation and retry checks of a stalled alert both call it. */
  function stalledKey(child: ManagedRow, thresholdMs: number, now: number) {
    if (child.state === "active") return child.active_since !== null && now - child.active_since >= thresholdMs ? `${child.active_cycle}:active` : undefined;
    if (child.state !== "idle") return undefined;
    const { rows, todos, since } = openWork(child);
    if (!rows.length && !todos.ready) return undefined;
    if (rows.some((row) => BUSY_STATUSES.has(row.status ?? "") || BUSY_STATUSES.has(row.state))) return undefined;
    if (needYouAt(child) !== null) return undefined;
    return now - since >= thresholdMs ? `${child.active_cycle}:idle` : undefined;
  }

  /** The one door to a Coordinator's alerts. Each kind has one receipt key, so a repeat adds nothing; a retried row is re-checked by stillDue.
   * A child whose Coordinator is archived or deleted gets a notice instead. A failure is logged, never thrown: retryAlerts redelivers the row. */
  function alertCoordinator(child: ManagedRow, alert: { kind: "state" } | { kind: "stalled"; thresholdMs: number } | { kind: "need-you"; request: string; concerned?: ManagedRow; url?: string }) {
    try {
      const dead = deadCoordinator(child);
      if (dead && ctx.isActiveChief(child)) {
        void alertSelf(child.thread_id, `coordinator-gone:${dead.thread_id}`, `Your Coordinator ${dead.thread_id} was ${dead.state}: it gets no more alerts. Tell the owner here; another Coordinator can take you over with chief_attach.`, "Coordinator notice")
          .catch((error) => bb.log.warn(`Could not notify ${child.thread_id} of its gone Coordinator: ${String(error)}`));
        return;
      }
      const coordinatorId = ctx.liveCoordinatorId(child);
      const ended = alert.kind === "state" && isGone(child);
      if (!coordinatorId || !(ended || ctx.isActiveChief(child))) return;
      const label = `Child Chief “${clip(child.title, 120)}” (${child.thread_id}, project ${child.project_id})`;
      const now = Date.now();
      const kind = alert.kind === "state" ? (ended ? "ended" : child.state === "idle" ? "done" : "failed") : alert.kind;
      const rest = alert.kind === "need-you" ? `${createHash("sha1").update(alert.request).digest("hex").slice(0, 12)}:${child.active_cycle}`
        : kind === "ended" ? child.state
        : receiptRest[kind as keyof typeof receiptRest](child, alert.kind === "stalled" ? alert.thresholdMs : 0, now);
      if (!rest) return;
      const receipt = `coordinator-${kind}:${rest}`;
      let message: string;
      if (alert.kind === "need-you") {
        message = [
          `${label} is blocked on a Need you${alert.concerned ? ` about ${alert.concerned.role} “${clip(alert.concerned.title, 120)}” (${alert.concerned.thread_id})` : ""}:`,
          clip(alert.request, 600),
          ...(alert.url ? [`PR: ${alert.url}`] : []),
          `The owner answers it in ${child.thread_id}.`,
        ].join("\n");
      } else if (alert.kind === "stalled") {
        if (rest.endsWith(":active")) {
          message = `${label} has been in one turn for ${Math.round((now - child.active_since!) / 60_000)} minutes (stall threshold ${Math.round(alert.thresholdMs / 60_000)}); it may be looping. Tell the owner; they can stop it in its own thread.`;
        } else {
          const { rows, todos, since } = openWork(child);
          message = `${label} has been idle ${Math.round((now - since) / 60_000)} minutes with open work: ${rows.length} open threads (${rows.filter((row) => row.state === "ready").length} ready, ${rows.filter((row) => row.state === "blocked").length} blocked), ${todos.n} open todos. Tell the owner.`;
        }
      } else if (kind === "done") {
        const outcome = ownedRows(child).filter((row) => row.state === "complete")
          .sort((a, b) => b.updated_at - a.updated_at).slice(0, 3)
          .map((row) => `“${clip(row.title, 80)}”${row.pr_url ? ` ${row.pr_url}` : ""}`).join("; ");
        message = `${label} finished its work. Outcome: ${clip(outcome, 300)}`;
        // Only an older undelivered done of this child is evicted: the newest one says everything.
        evictOlder(child.thread_id, receipt, coordinatorId);
      } else if (kind === "failed") {
        message = `${label} failed: its last turn ended in an error. Tell the owner; it can be retried in its own thread.`;
      } else {
        message = `${label} was ${child.state}. Its open work, if any, moves to a successor Chief that stays your child.`;
      }
      const dedupeKey = `${child.thread_id}:${receipt}`;
      if (insertAlert(child.thread_id, coordinatorId, dedupeKey, message, "Coordinator alert")) {
        void deliverAlert(dedupeKey).catch((error) => bb.log.warn(`Could not deliver Coordinator alert ${dedupeKey}: ${String(error)}`));
      }
    } catch (error) {
      bb.log.warn(`Could not alert Coordinator of ${child.thread_id}: ${String(error)}`);
    }
  }

  /** Attach: an idle-done child's current done round is recorded as already delivered, so attaching sends no done alert. Synchronous; it sends nothing. */
  function baselineDone(child: ManagedRow, coordinatorId: string) {
    const done = childDone(child)?.thread_id;
    if (!done) return;
    const key = `${child.thread_id}:coordinator-done:${done}`;
    if (insertAlert(child.thread_id, coordinatorId, key, "(baseline at attach: not sent)", "Coordinator alert")) {
      db.prepare(`UPDATE alert_outbox SET delivered_at=? WHERE dedupe_key=? AND delivered_at IS NULL`).run(Date.now(), key);
    }
  }

  async function retryAlerts() {
    for (const alert of pendingAlerts.all(Date.now() - 60_000, Date.now()) as AlertRow[]) await deliverAlert(alert.dedupe_key);
  }
  return { alertChief, alertCoordinator, alertSelf, baselineDone, deliverAlert, enqueueAlert, insertAlert, needYouAt, recordFailure, retryAlerts, writeAlert };
}

