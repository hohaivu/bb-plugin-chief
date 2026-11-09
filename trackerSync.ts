// Mirrors Chief's units of work to a task tracker through the Tracker protocol. Owns the tables, unit resolution and the one
// reconcile pass. Hooks only record local rows; sync() makes every remote call. Nothing here is awaited by a tool or report,
// and nothing here throws to a caller: off, unmapped or unavailable is a no-op.

import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ManagedRow } from "./server";
import { clip } from "./text";
import type { Tracker, TrackerStatus } from "./tracker";

/** Appended at the end of MIGRATIONS; never edit an earlier entry. */
export const TRACKER_TABLES = [
  `CREATE TABLE IF NOT EXISTS tracker_units (
    root_thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, tracker_project TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, marker TEXT NOT NULL,
    task_id TEXT, create_state TEXT CHECK (create_state IN ('sent','failed')), create_attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT, flagged INTEGER NOT NULL DEFAULT 0, merge_checked_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tracker_receipts (
    root_thread_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('thread','unthread','pr','file','decision','answer')),
    ref TEXT NOT NULL, payload TEXT, state TEXT CHECK (state IN ('sent','failed')), attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, result TEXT, answered_at INTEGER, created_at INTEGER NOT NULL,
    PRIMARY KEY (root_thread_id, kind, ref))`,
];

const MAX_ATTEMPTS = 5;
const MERGE_POLL_MS = 5 * 60_000;
const ANSWER_POLL_MS = 60_000;
const sha = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);
const errorText = (error: unknown) => clip(error instanceof Error ? error.message : String(error), 1_000);

interface UnitRow {
  root_thread_id: string; project_id: string; tracker_project: string; title: string; description: string; marker: string;
  task_id: string | null; create_state: "sent" | "failed" | null; create_attempts: number;
  status: string | null; flagged: number; merge_checked_at: number | null;
}
interface ReceiptRow {
  root_thread_id: string; kind: string; ref: string; payload: string | null; state: "sent" | "failed" | null;
  attempts: number; last_error: string | null; result: string | null; answered_at: number | null; created_at: number;
}
/** What a sent decision remembers once its payload is cleared. */
type Posted = { id: string; number: number; concernedThreadId: string };

export function createTrackerSync(deps: {
  db: ReturnType<BbPluginApi["storage"]["database"]>;
  log: Pick<BbPluginApi["log"], "info" | "warn" | "error">;
  /** Null when the setting selects no adapter. A rejected settings read is also null. */
  config: () => Promise<{ tracker: Tracker; projects: Map<string, string> } | null>;
  get: (id: string) => ManagedRow | undefined;
  /** Every row, oldest first: equal created_at keep their insertion order (the store's ORDER BY created_at, rowid). A worker's earlier workers are the rows before it. */
  all: () => ManagedRow[];
  /** The ids of a replaces: chain, from the given row back to its oldest ancestor. */
  taskChain: (id: string) => string[];
  /** The worker ids a reviewer covers. */
  reviewTargets: (reviewerId: string) => string[];
  /** Whether a planner's plan is absorbed. */
  planDone: (planner: ManagedRow) => boolean;
  /** Whether the pull request is merged; null when the forge could not say. */
  prMerged: (url: string, projectId: string) => Promise<boolean | null>;
  /** Writes one outbox alert to the live Chief of that thread and returns its dedupe key; null when there is none. Synchronous: it runs inside a transaction. */
  answerAlert: (threadId: string, key: string, message: string) => string | null;
  deliver: (dedupeKey: string) => Promise<unknown>;
}) {
  const { db, log, get, all } = deps;
  const polled = new Map<string, number>();
  const warned = new Set<string>();

  const unitOf = (rootId: string) => db.prepare(`SELECT * FROM tracker_units WHERE root_thread_id=?`).get(rootId) as UnitRow | undefined;
  const receiptsOf = (rootId: string, kind: string) =>
    db.prepare(`SELECT * FROM tracker_receipts WHERE root_thread_id=? AND kind=? ORDER BY created_at, rowid`).all(rootId, kind) as ReceiptRow[];
  const addReceipt = (rootId: string, kind: string, ref: string, payload: string | null) =>
    db.prepare(`INSERT OR IGNORE INTO tracker_receipts (root_thread_id, kind, ref, payload, created_at) VALUES (?, ?, ?, ?, ?)`).run(rootId, kind, ref, payload, Date.now());
  const posted = (receipt: ReceiptRow) => JSON.parse(receipt.result ?? "{}") as Posted;

  /** One root map for one sync pass or hook call: a single scan of the store, then every thread's unit by its root thread id (null for a thread that is no part of a tracked unit). */
  function rootMap() {
    const ordered = all();
    const position = new Map(ordered.map((r, i) => [r.thread_id, i]));
    // The first worker (in persisted order) holding each pull request or branch; a head joins it when that worker comes before the head.
    const keys = (r: ManagedRow) => [r.pr_url ? `pr\0${r.project_id}\0${r.pr_url}` : "", r.branch ? `branch\0${r.project_id}\0${r.branch}` : ""].filter(Boolean);
    const first = new Map<string, number>();
    ordered.forEach((r, i) => { if (r.role === "worker") for (const key of keys(r)) if (!first.has(key)) first.set(key, i); });
    const roots = new Map<string, string | null>();
    function resolve(row: ManagedRow | undefined, seen: Set<string>): string | null {
      if (!row || seen.has(row.thread_id)) return null;
      seen.add(row.thread_id);
      if (row.role === "planner") return deps.taskChain(row.thread_id).at(-1)!;
      if (row.role === "worker") {
        const planner = row.plan_thread_id ? get(row.plan_thread_id) : undefined;
        if (planner) return resolve(planner, seen);
        const headId = deps.taskChain(row.thread_id).at(-1)!;
        const head = get(headId);
        if (!head || !(head.pr_url || head.branch)) return headId;
        // A follow-up on the pull request or branch of earlier work joins that work's unit, whatever the earlier worker's state.
        const at = position.get(headId) ?? -1;
        const earliest = Math.min(...keys(head).map((key) => first.get(key) ?? Infinity));
        return earliest < at ? resolve(ordered[earliest], seen) : headId;
      }
      if (row.role === "advisor") {
        if (row.plan_thread_id) return resolve(get(row.plan_thread_id), seen);
        return row.worker_thread_id ? resolve(get(row.worker_thread_id), seen) : null;
      }
      if (row.role === "reviewer") {
        const target = deps.reviewTargets(row.thread_id)[0] ?? row.worker_thread_id;
        return target ? resolve(get(target), seen) : null;
      }
      return null;
    }
    return (row: ManagedRow | undefined) => {
      if (!row) return null;
      if (!roots.has(row.thread_id)) roots.set(row.thread_id, resolve(row, new Set()));
      return roots.get(row.thread_id)!;
    };
  }

  /** The unit's threads, its phase and its pull requests, from the local rows. */
  function describe(rootId: string, root: ReturnType<typeof rootMap>) {
    const top = get(rootId);
    if (!top) return null;
    const newest = (a: ManagedRow, b: ManagedRow) => b.created_at - a.created_at;
    /** A worker and the workers that replace it, oldest first. */
    const chainFrom = (head: ManagedRow) => {
      const chain = [head];
      for (;;) {
        const next = all().filter((r) => r.role === "worker" && r.replaces_thread_id === chain[chain.length - 1]!.thread_id && !chain.includes(r)).sort(newest)[0];
        if (!next) break;
        chain.push(next);
      }
      return chain;
    };
    const joined = all()
      .filter((r) => r.role === "worker" && !r.plan_thread_id && !r.replaces_thread_id && r.thread_id !== rootId && root(r) === rootId)
      .map(chainFrom);
    const joinedBusy = joined.some((chain) => chain[chain.length - 1]!.state !== "complete");
    let threads: ManagedRow[];
    let phase: "planning" | "working" | "finished";
    if (top.role === "planner") {
      const planners = all().filter((r) => r.role === "planner" && (r.thread_id === rootId || r.replaces_thread_id === rootId));
      const ids = new Set(planners.map((p) => p.thread_id));
      const effective = planners.filter((p) => p.plan_waves && (p.state === "ready" || p.state === "complete")).sort(newest)[0] ?? top;
      const workers = all().filter((r) => r.role === "worker" && r.plan_thread_id && ids.has(r.plan_thread_id));
      threads = [...planners, ...workers, ...joined.flat()];
      phase = deps.planDone(effective) && !joinedBusy ? "finished"
        : workers.some((w) => w.plan_thread_id === effective.thread_id) || joinedBusy ? "working" : "planning";
    } else if (top.role === "worker") {
      const chain = chainFrom(top);
      threads = [...chain, ...joined.flat()];
      phase = chain[chain.length - 1]!.state === "complete" && !joinedBusy ? "finished" : "working";
    } else return null;
    const prUrls = [...new Set(threads.filter((t) => t.role === "worker" && t.pr_url).map((t) => t.pr_url!))];
    return { threads, phase, prUrls };
  }

  /** Runs one hook body only when a tracker is selected. Never awaits the adapter and never throws. */
  async function hook(name: string, body: (config: NonNullable<Awaited<ReturnType<typeof deps.config>>>) => void) {
    try {
      const config = await deps.config();
      if (config) body(config);
    } catch (error) {
      log.warn(`Tracker ${name} hook failed: ${errorText(error)}`);
    }
  }

  /** A unit that can take receipts: it exists and its create did not fail. */
  const openUnit = (row: ManagedRow, root = rootMap()) => {
    const rootId = root(row);
    const unit = rootId ? unitOf(rootId) : undefined;
    return unit && unit.create_state !== "failed" ? unit : undefined;
  };

  /** Settles a receipt: its payload is dropped in both terminal states. */
  const settle = (r: ReceiptRow, state: "sent" | "failed", result: string | null, error: string | null) =>
    db.prepare(`UPDATE tracker_receipts SET state=?, payload=NULL, result=?, last_error=? WHERE root_thread_id=? AND kind=? AND ref=?`)
      .run(state, result, error, r.root_thread_id, r.kind, r.ref);

  async function send(tracker: Tracker, unit: UnitRow, r: ReceiptRow): Promise<string | null> {
    const task = unit.task_id!;
    switch (r.kind) {
      case "thread": {
        if (r.payload !== null) {
          // Comment first, so an attach retry never posts it twice; a retry may follow a post that succeeded.
          const marker = `chief-request:${r.ref}`;
          const prior = r.attempts > 0 ? (await tracker.comments(task)).find((c) => c.body.includes(marker)) : undefined;
          if (!prior) await tracker.postComment(task, r.payload);
        }
        await tracker.attachThread(task, r.ref);
        return null;
      }
      case "unthread": await tracker.detachThread(task, r.ref); return null;
      case "pr": await tracker.linkPullRequest(task, r.ref); return null;
      case "file": {
        if (r.payload === null) throw new Error("the file content is gone");
        await tracker.attachFile(task, { name: r.ref.slice(r.ref.indexOf(":") + 1), content: r.payload });
        return null;
      }
      default: {
        const decision = JSON.parse(r.payload!) as { concernedThreadId: string; number: number; body: string };
        // A retry may follow a post that succeeded: its marker finds that comment instead of posting twice.
        const prior = r.attempts > 0 ? (await tracker.comments(task)).find((c) => c.body.includes(`chief-decision:${r.ref}`))?.id : undefined;
        const id = prior ?? await tracker.postComment(task, decision.body);
        return JSON.stringify({ id, number: decision.number, concernedThreadId: decision.concernedThreadId } satisfies Posted);
      }
    }
  }

  async function sendReceipts(tracker: Tracker, unit: UnitRow, threads: ManagedRow[]) {
    const pending = db.prepare(`SELECT * FROM tracker_receipts WHERE root_thread_id=? AND state IS NULL AND kind<>'answer' ORDER BY created_at, rowid`)
      .all(unit.root_thread_id) as ReceiptRow[];
    for (const r of pending) {
      if (r.kind === "unthread") {
        // Detach only after this thread and its successor are attached.
        // A successor spawned while the tracker was off has no receipt and is not waited for.
        const needs = [r.ref, ...threads.filter((t) => t.replaces_thread_id === r.ref).map((t) => t.thread_id)];
        const attached = new Map(receiptsOf(unit.root_thread_id, "thread").map((t) => [t.ref, t.state]));
        const states = needs.filter((id) => attached.has(id)).map((id) => attached.get(id) ?? null);
        if (states.includes("failed")) { settle(r, "failed", null, "an attach it depends on failed"); continue; }
        if (states.some((state) => state !== "sent")) continue;
      }
      db.prepare(`UPDATE tracker_receipts SET attempts=attempts+1 WHERE root_thread_id=? AND kind=? AND ref=?`).run(r.root_thread_id, r.kind, r.ref);
      try {
        settle(r, "sent", await send(tracker, unit, r), null);
      } catch (error) {
        const reason = errorText(error);
        if (r.attempts + 1 >= MAX_ATTEMPTS) {
          settle(r, "failed", null, reason);
          log.warn(`Tracker ${r.kind} receipt ${r.ref} failed after ${MAX_ATTEMPTS} attempts: ${reason}`);
        } else {
          db.prepare(`UPDATE tracker_receipts SET last_error=? WHERE root_thread_id=? AND kind=? AND ref=?`).run(reason, r.root_thread_id, r.kind, r.ref);
        }
      }
    }
  }

  async function syncStatus(tracker: Tracker, unit: UnitRow, phase: "planning" | "working" | "finished", prUrls: string[]) {
    let want: TrackerStatus;
    if (phase !== "finished") want = phase;
    else if (!prUrls.length || unit.status === "done") want = "done";
    else {
      want = "review";
      if (unit.status === "review" && (unit.merge_checked_at ?? 0) <= Date.now() - MERGE_POLL_MS) {
        db.prepare(`UPDATE tracker_units SET merge_checked_at=? WHERE root_thread_id=?`).run(Date.now(), unit.root_thread_id);
        const merged = await Promise.all(prUrls.map((url) => deps.prMerged(url, unit.project_id)));
        if (merged.every((m) => m === true)) want = "done";
      }
    }
    if (want === unit.status) return;
    try {
      await tracker.setStatus(unit.task_id!, want);
      db.prepare(`UPDATE tracker_units SET status=? WHERE root_thread_id=?`).run(want, unit.root_thread_id);
    } catch (error) {
      const key = `${unit.root_thread_id}:${want}`;
      if (!warned.has(key)) { warned.add(key); log.warn(`Tracker status ${want} for ${unit.root_thread_id} failed; the next pass retries: ${errorText(error)}`); }
    }
  }

  const openDecisions = (rootId: string) => receiptsOf(rootId, "decision").filter((d) => d.state === "sent" && d.answered_at === null);

  async function syncFlag(tracker: Tracker, unit: UnitRow) {
    const open = openDecisions(unit.root_thread_id).length > 0;
    if (open === !!unit.flagged) return;
    try {
      await tracker.setDecisionFlag(unit.tracker_project, unit.task_id!, open);
      db.prepare(`UPDATE tracker_units SET flagged=? WHERE root_thread_id=?`).run(open ? 1 : 0, unit.root_thread_id);
    } catch (error) {
      log.warn(`Tracker decision flag for ${unit.root_thread_id} failed; the next pass retries: ${errorText(error)}`);
    }
  }

  /** An owner comment answers at most one open decision; the answer receipt and the Chief alert commit together. */
  async function pollAnswers(tracker: Tracker, unit: UnitRow) {
    const rootId = unit.root_thread_id;
    if (!openDecisions(rootId).length || Date.now() - (polled.get(rootId) ?? 0) < ANSWER_POLL_MS) return;
    polled.set(rootId, Date.now());
    const comments = await tracker.comments(unit.task_id!);
    const times = new Map(comments.map((c) => [c.id, c.at]));
    const at = (d: ReceiptRow) => times.get(posted(d).id) ?? d.created_at;
    const oldest = Math.min(...openDecisions(rootId).map(at));
    const answered = new Set(receiptsOf(rootId, "answer").map((a) => a.ref));
    for (const comment of comments) {
      if (!comment.byOwner || comment.body.includes("chief-decision:") || comment.body.includes("chief-request:") || answered.has(comment.id) || !(comment.at > oldest)) continue;
      const open = openDecisions(rootId).filter((d) => at(d) < comment.at);
      if (!open.length) continue;
      const named = Number(/^#(\d+)/.exec(comment.body.trim())?.[1]);
      const match = open.find((d) => posted(d).number === named) ?? (open.length === 1 ? open[0] : undefined);
      const text = clip(comment.body, 4_000);
      const [key, source, message] = match
        ? [`decision-${match.ref}:answer`, posted(match).concernedThreadId,
          `The owner answered decision #${posted(match).number} on tracker task “${unit.title}”:\n${text}\nTreat this as the owner's answer to that Need you request.`]
        : [`tracker-${sha(comment.id)}:comment`, rootId,
          `The owner commented on tracker task “${unit.title}” while decisions ${open.map((d) => `#${posted(d).number}`).join(", ")} are open. The comment names none of them:\n${text}\nTreat it as a reply only if it fits one of those Need you requests.`];
      let outbox: string;
      try {
        outbox = db.transaction(() => {
          db.prepare(`INSERT INTO tracker_receipts (root_thread_id, kind, ref, state, result, created_at) VALUES (?, 'answer', ?, 'sent', ?, ?)`)
            .run(rootId, comment.id, match?.ref ?? null, Date.now());
          if (match) db.prepare(`UPDATE tracker_receipts SET answered_at=? WHERE root_thread_id=? AND kind='decision' AND ref=?`).run(Date.now(), rootId, match.ref);
          const dedupeKey = deps.answerAlert(source, key, message);
          if (!dedupeKey) throw new Error("no live Chief to tell");
          return dedupeKey;
        })();
      } catch (error) {
        log.warn(`Tracker answer on ${rootId} not recorded; the next poll retries: ${errorText(error)}`);
        return;
      }
      void deps.deliver(outbox).catch((error) => log.warn(`Tracker answer alert ${outbox} not delivered; the outbox retries: ${errorText(error)}`));
    }
  }

  async function create(tracker: Tracker, unit: UnitRow) {
    db.prepare(`UPDATE tracker_units SET create_attempts=create_attempts+1 WHERE root_thread_id=?`).run(unit.root_thread_id);
    try {
      // A retry may follow a create that succeeded: its marker finds that task instead of creating a second one.
      const id = (unit.create_attempts > 0 ? await tracker.findTask(unit.tracker_project, unit.marker) : null)
        ?? await tracker.createTask({ project: unit.tracker_project, title: unit.title, description: unit.description });
      db.prepare(`UPDATE tracker_units SET task_id=?, create_state='sent', last_error=NULL WHERE root_thread_id=?`).run(id, unit.root_thread_id);
    } catch (error) {
      const reason = errorText(error);
      db.prepare(`UPDATE tracker_units SET last_error=? WHERE root_thread_id=?`).run(reason, unit.root_thread_id);
      if (unit.create_attempts + 1 < MAX_ATTEMPTS) return;
      db.transaction(() => {
        db.prepare(`UPDATE tracker_units SET create_state='failed' WHERE root_thread_id=?`).run(unit.root_thread_id);
        db.prepare(`UPDATE tracker_receipts SET state='failed', payload=NULL, last_error=? WHERE root_thread_id=? AND state IS NULL`).run(reason, unit.root_thread_id);
      })();
      log.warn(`Tracker task for ${unit.root_thread_id} not created after ${MAX_ATTEMPTS} attempts: ${reason}`);
    }
  }

  async function pass() {
    const config = await deps.config();
    if (!config || !(await config.tracker.available())) return;
    const { tracker } = config;
    const step = async (what: string, unit: UnitRow, run: () => Promise<void>) => {
      try { await run(); } catch (error) { log.warn(`Tracker ${what} for ${unit.root_thread_id} failed: ${errorText(error)}`); }
    };
    for (const unit of db.prepare(`SELECT * FROM tracker_units WHERE task_id IS NULL AND create_state IS NULL ORDER BY created_at`).all() as UnitRow[]) {
      await step("create", unit, () => create(tracker, unit));
    }
    const root = rootMap();
    for (const unit of db.prepare(`SELECT * FROM tracker_units WHERE task_id IS NOT NULL ORDER BY created_at`).all() as UnitRow[]) {
      const facts = describe(unit.root_thread_id, root);
      if (facts) {
        // Receipts were recorded by the hooks while the tracker was on; the pass never discovers threads or pull requests itself.
        await step("receipts", unit, () => sendReceipts(tracker, unit, facts.threads));
        await step("status", unit, () => syncStatus(tracker, unit, facts.phase, facts.prUrls));
      }
      await step("flag", unit, () => syncFlag(tracker, unit));
      await step("answers", unit, () => pollAnswers(tracker, unit));
    }
  }

  let running: Promise<void> | null = null;
  let again = false;

  /** Records a spawned thread's attachment intent: its thread (with a request comment to post first, when given), the thread it replaces and its pull request. Only a hook that ran while the tracker was on calls this. */
  const attach = (row: ManagedRow, note?: string, root = rootMap()) => {
    const unit = openUnit(row, root);
    if (!unit) return;
    const prior = row.replaces_thread_id;
    db.transaction(() => {
      addReceipt(unit.root_thread_id, "thread", row.thread_id, note ?? null);
      if (prior && receiptsOf(unit.root_thread_id, "thread").some((t) => t.ref === prior)) addReceipt(unit.root_thread_id, "unthread", prior, null);
      if (row.role === "worker" && row.pr_url) addReceipt(unit.root_thread_id, "pr", row.pr_url, null);
    })();
  };

  return {
    /** A thread that joins an existing unit: a plan revision, a plan's worker or a replacement. Nothing is recorded while the tracker is off, and nothing is filled in later. */
    join: (row: ManagedRow) => hook("join", () => attach(row)),
    /** A new plan or an undelegated worker begins a unit, when its project is mapped. */
    start: (row: ManagedRow, description: string) => hook("start", ({ projects }) => {
      const project = projects.get(row.project_id);
      const root = rootMap();
      const rootId = root(row);
      if (!project || !rootId) return;
      const marker = `chief-unit:${sha(rootId)}`;
      const existed = unitOf(rootId);
      db.prepare(`INSERT OR IGNORE INTO tracker_units (root_thread_id, project_id, tracker_project, title, description, marker, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(rootId, row.project_id, project, row.title.replace(/^Plan · /, ""), `${clip(description, 4_000)}\n\n${marker}`, marker, Date.now());
      // Follow-up work on a unit that already has a task says what it is for once; a unit made now already holds the mission.
      attach(row, existed && rootId !== row.thread_id ? `**Follow-up request** (Chief)\n\n${clip(description, 4_000)}\n\nchief-request:${row.thread_id}` : undefined, root);
    }),
    /** Queues the files an accepted report wrote. */
    attachFiles: (row: ManagedRow, files: { name: string; content: string }[]) => hook("attachFiles", () => {
      const unit = openUnit(row);
      if (unit) for (const file of files) addReceipt(unit.root_thread_id, "file", `${row.thread_id}:${file.name}`, file.content);
    }),
    /** Queues a decision comment for a request Chief escalated. The same request on a unit posts once. */
    decide: (row: ManagedRow, request: string) => hook("decide", () => {
      const unit = openUnit(row);
      if (!unit) return;
      const ref = sha(request);
      db.transaction(() => {
        const number = 1 + receiptsOf(unit.root_thread_id, "decision").length;
        const body = `**Decision #${number}** (Chief)\n\n${clip(request, 12_000)}\n\nAnswer with a comment; start it with #${number} when several decisions are open.\n\nchief-decision:${ref}`;
        addReceipt(unit.root_thread_id, "decision", ref, JSON.stringify({ concernedThreadId: row.thread_id, number, body }));
      })();
    }),
    /** The one reconcile pass. Single-flight: a call during a pass queues exactly one more. Never rejects. */
    sync(): Promise<void> {
      if (running) { again = true; return running; }
      running = (async () => {
        do {
          again = false;
          await pass();
        } while (again);
      })().catch((error) => log.warn(`Tracker sync failed; the supervisor tick retries: ${errorText(error)}`)).finally(() => { running = null; });
      return running;
    },
  };
}
