import { randomUUID } from "node:crypto";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const SECTION_NAME = "Chief";
const RULES_FILE = "chief.md";
const RECONCILE_INTERVAL_MS = 30_000;
const MAX_ALERT_LENGTH = 3_000;
const MAX_RESULT_LENGTH = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const BUSY_STATUSES = new Set(["active", "starting", "stopping", "pending"]);

const roleSchema = z.enum(["chief", "worker", "reviewer"]);
const stateSchema = z.enum([
  "starting",
  "pending",
  "active",
  "stopping",
  "idle",
  "ready",
  "blocked",
  "failed",
  "archived",
  "deleted",
  "complete",
]);
const reasoningSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);
const modelSelectionSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningLevel: reasoningSchema,
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

const modelConfigurationSchema = z.object({
  hosts: z.array(z.object({
    hostId: z.string(),
    hostName: z.string(),
    connected: z.boolean(),
    /** A valid starting point for the picker when a role has no selection. */
    fallback: modelSelectionSchema.nullable(),
    error: z.string().nullable(),
    selections: z.object({
      chief: modelSelectionSchema.nullable(),
      worker: modelSelectionSchema.nullable(),
      reviewer: modelSelectionSchema.nullable(),
    }),
    /** Roles whose stored pick this machine can no longer serve, so spawns use BB's default. */
    unusable: z.array(roleSchema),
  })),
});
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;

const managedThreadSchema = z.object({
  threadId: z.string(),
  role: roleSchema,
  projectId: z.string(),
  chiefThreadId: z.string().nullable(),
  workerThreadId: z.string().nullable(),
  title: z.string(),
  state: stateSchema,
  status: z.string().nullable(),
  result: z.string().nullable(),
  blocker: z.string().nullable(),
  recommendation: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ManagedThread = z.infer<typeof managedThreadSchema>;

const delegateParams = z.object({
  title: z.string().trim().min(1).max(160).describe("Exact concise title for the worker thread."),
  mission: z.string().trim().min(1).max(12_000),
  successCriteria: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  context: z.string().trim().max(12_000).optional(),
});

const optionalReport = z.object({
  state: z.enum(["active", "idle", "failed"]),
  result: z.string().trim().max(MAX_RESULT_LENGTH).optional(),
  blocker: z.never().optional(),
  recommendation: z.string().trim().max(4_000).optional(),
});
const readyReport = z.object({
  state: z.literal("ready"),
  result: z.string().trim().min(1).max(MAX_RESULT_LENGTH),
  blocker: z.never().optional(),
  recommendation: z.string().trim().max(4_000).optional(),
});
const blockedReport = z.object({
  state: z.literal("blocked"),
  result: z.string().trim().max(MAX_RESULT_LENGTH).optional(),
  blocker: z.string().trim().min(1).max(4_000),
  recommendation: z.string().trim().min(1).max(4_000),
});
const reportParams = z.discriminatedUnion("state", [optionalReport, readyReport, blockedReport]);

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({ sectionId: z.string().nullable(), threads: z.array(managedThreadSchema) }),
  },
  start: {
    input: z.object({ projectId: z.string().trim().min(1).nullable() }).strict(),
    output: z.object({ threadId: z.string(), created: z.boolean() }).strict(),
  },
  create: {
    input: z.object({ projectId: z.string().trim().min(1) }).strict(),
    output: z.object({ threadId: z.string(), created: z.literal(true) }).strict(),
  },
  modelConfiguration: {
    input: z.null(),
    output: modelConfigurationSchema,
  },
  setRoleModel: {
    input: z.object({
      hostId: z.string().trim().min(1),
      role: roleSchema,
      selection: modelSelectionSchema.nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

interface ManagedRow {
  thread_id: string;
  role: z.infer<typeof roleSchema>;
  project_id: string;
  chief_thread_id: string | null;
  worker_thread_id: string | null;
  title: string;
  state: z.infer<typeof stateSchema>;
  status: string | null;
  result: string | null;
  blocker: string | null;
  recommendation: string | null;
  active_since: number | null;
  active_cycle: number;
  stall_alerted_cycle: number | null;
  lifecycle_alert_key: string | null;
  created_at: number;
  updated_at: number;
}

interface AlertRow {
  dedupe_key: string;
  target_thread_id: string;
  source_thread_id: string;
  message: string;
  delivered_at: number | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
}

const BUILT_IN_RULES = `# Chief operating rules

- Own work through completion; do not merely dispatch it.
- Inspect the worker's evidence before choosing the next action.
- Take safe, reversible next steps autonomously: continue a thread, request a focused review, or mark verified work complete.
- Escalate to the user only for genuine product or scope choices, missing permission or credentials, irreversible actions, or conflicting evidence that cannot be resolved safely.
- When escalating, lead with a recommendation, the evidence, and the smallest set of choices.
- A worker report is evidence, not proof. Review meaningful or high-risk changes independently.
- Keep thread titles literal and recognizable. Never invent codenames.
- Do not delete user threads. Mark managed work complete; let the user archive it when desired.`;

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
    const value = inline ?? (next && !next.startsWith("--") ? (index++, next) : "true");
    flags.set(name!, [...(flags.get(name!) ?? []), value]);
  }
  return {
    positional,
    one: (name: string) => flags.get(name)?.[0],
    all: (name: string) => flags.get(name) ?? [],
    bool: (name: string) => flags.get(name)?.[0] === "true",
  };
}

function clip(value: string, limit = MAX_ALERT_LENGTH) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function bullets(values?: string[]) {
  return values?.length ? values.map((value) => `- ${value}`).join("\n") : "- None stated.";
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    chiefProject: { type: "project", label: "Default Chief project" },
    stallMinutes: { type: "string", label: "Stall threshold (minutes)", default: "30" },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS plugin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS managed_threads (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('chief','worker','reviewer')),
      project_id TEXT NOT NULL,
      chief_thread_id TEXT,
      worker_thread_id TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT,
      result TEXT,
      blocker TEXT,
      recommendation TEXT,
      active_since INTEGER,
      active_cycle INTEGER NOT NULL DEFAULT 0,
      stall_alerted_cycle INTEGER,
      lifecycle_alert_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS managed_threads_chief ON managed_threads (chief_thread_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS alert_outbox (
      dedupe_key TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      message TEXT NOT NULL,
      delivered_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS alert_outbox_pending ON alert_outbox (delivered_at, created_at)`,
    `CREATE TABLE IF NOT EXISTS chief_models (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','worker','reviewer')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
  ]);

  const allRows = db.prepare(`SELECT * FROM managed_threads ORDER BY created_at ASC`);
  const activeChiefForProject = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='chief' AND project_id=? AND state NOT IN ('failed','deleted','archived','complete') ORDER BY created_at DESC LIMIT 1`,
  );
  const latestChiefForProject = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='chief' AND project_id=? ORDER BY created_at DESC LIMIT 1`,
  );
  const chiefCountForProject = db.prepare<[string]>(
    `SELECT COUNT(*) AS count FROM managed_threads WHERE role='chief' AND project_id=?`,
  );
  const existingReview = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='reviewer' AND worker_thread_id=? AND state NOT IN ('complete','archived','deleted') ORDER BY created_at DESC LIMIT 1`,
  );
  const pendingAlerts = db.prepare(
    `SELECT * FROM alert_outbox WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT 100`,
  );
  const roleModelRow = db.prepare<[string, string]>(
    `SELECT provider_id, model, reasoning_level FROM chief_models WHERE host_id=? AND role=?`,
  );
  let roles = new Map<string, ManagedRow>();
  const rulesCache = new Map<string, string>();
  const alertDeliveries = new Map<string, Promise<boolean>>();
  const reviewStarts = new Map<string, Promise<{ threadId: string; title: string; workerThreadId: string; created: boolean }>>();

  function reloadRoles() {
    roles = new Map((allRows.all() as ManagedRow[]).map((row) => [row.thread_id, row]));
  }
  reloadRoles();

  function toManaged(row: ManagedRow): ManagedThread {
    return {
      threadId: row.thread_id,
      role: row.role,
      projectId: row.project_id,
      chiefThreadId: row.chief_thread_id,
      workerThreadId: row.worker_thread_id,
      title: row.title,
      state: row.state,
      status: row.status,
      result: row.result,
      blocker: row.blocker,
      recommendation: row.recommendation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function insertThread(input: {
    threadId: string;
    role: ManagedRow["role"];
    projectId: string;
    chiefThreadId?: string | null;
    workerThreadId?: string | null;
    title: string;
    state?: ManagedRow["state"];
    status?: string | null;
  }) {
    const now = Date.now();
    db.prepare(`INSERT INTO managed_threads (
      thread_id, role, project_id, chief_thread_id, worker_thread_id, title,
      state, status, active_since, active_cycle, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET role=excluded.role, project_id=excluded.project_id,
      chief_thread_id=excluded.chief_thread_id, worker_thread_id=excluded.worker_thread_id,
      title=excluded.title, state=excluded.state, status=excluded.status, updated_at=excluded.updated_at`).run(
      input.threadId, input.role, input.projectId, input.chiefThreadId ?? null,
      input.workerThreadId ?? null, input.title, input.state ?? "starting",
      input.status ?? "starting", input.state === "active" ? now : null,
      input.state === "active" ? 1 : 0, now, now,
    );
    reloadRoles();
  }

  let sectionEnsuring: Promise<string> | null = null;
  async function ensureSection(): Promise<string> {
    if (sectionEnsuring) return sectionEnsuring;
    sectionEnsuring = (async () => {
      const sections = await bb.sdk.threadSections.list();
      let section = sections.find((candidate) => candidate.name === SECTION_NAME);
      if (!section) section = await bb.sdk.threadSections.create({ name: SECTION_NAME });
      db.prepare(`INSERT INTO plugin_meta (key, value) VALUES ('section_id', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(section.id);
      return section.id;
    })();
    try {
      return await sectionEnsuring;
    } finally {
      sectionEnsuring = null;
    }
  }

  function storedSectionId() {
    return (db.prepare(`SELECT value FROM plugin_meta WHERE key='section_id'`).get() as { value: string } | undefined)?.value ?? null;
  }

  async function readRules(projectId: string) {
    try {
      const file = await bb.sdk.projects.fileContent({ projectId, path: RULES_FILE });
      const content = file.contentEncoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : file.content;
      const rules = clip(content.trim() || BUILT_IN_RULES, 32_000);
      rulesCache.set(projectId, rules);
      return rules;
    } catch {
      rulesCache.set(projectId, BUILT_IN_RULES);
      return BUILT_IN_RULES;
    }
  }

  async function projectName(projectId: string) {
    try { return (await bb.sdk.projects.get({ projectId })).name; }
    catch { return projectId; }
  }

  type Role = z.infer<typeof roleSchema>;

  function readRoleModel(hostId: string, role: Role): ModelSelection | null {
    const row = roleModelRow.get(hostId, role) as
      | { provider_id: string; model: string; reasoning_level: string }
      | undefined;
    if (!row) return null;
    const parsed = modelSelectionSchema.safeParse({
      providerId: row.provider_id,
      model: row.model,
      reasoningLevel: row.reasoning_level,
    });
    return parsed.success ? parsed.data : null;
  }

  function writeRoleModel(hostId: string, role: Role, selection: ModelSelection | null) {
    if (!selection) {
      db.prepare(`DELETE FROM chief_models WHERE host_id=? AND role=?`).run(hostId, role);
      return;
    }
    db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, role) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model,
        reasoning_level=excluded.reasoning_level, updated_at=excluded.updated_at`).run(
      hostId, role, selection.providerId, selection.model, selection.reasoningLevel, Date.now(),
    );
  }

  // Discovery must never outlive the plugin or hang a spawn behind an
  // unreachable machine, so every catalog read is aborted on both.
  const discoveryLifetime = new AbortController();
  bb.onDispose(() => discoveryLifetime.abort());

  function discover<T>(run: (signal: AbortSignal) => Promise<T>, label: string) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    discoveryLifetime.signal.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stop();
          reject(new Error(`${label} timed out after ${MODEL_DISCOVERY_TIMEOUT_MS / 1_000} seconds.`));
        }, MODEL_DISCOVERY_TIMEOUT_MS);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      discoveryLifetime.signal.removeEventListener("abort", stop);
    });
  }

  function modelCatalog(hostId: string, providerId?: string) {
    return discover(
      (signal) => bb.sdk.providers.models({ hostId, ...(providerId ? { providerId } : {}), signal }),
      "Model discovery",
    );
  }

  type Catalog = (providerId: string) => ReturnType<typeof modelCatalog>;

  /** One scan per provider per request: three roles on one provider must not cost three reads. */
  function catalogReader(hostId: string): Catalog {
    const pending = new Map<string, ReturnType<typeof modelCatalog>>();
    return (providerId) => {
      const started = pending.get(providerId) ?? modelCatalog(hostId, providerId);
      pending.set(providerId, started);
      return started;
    };
  }

  /** The first signed-in provider's default model: what the picker starts from. */
  async function hostFallback(
    hostId: string,
    read: Catalog = catalogReader(hostId),
  ): Promise<{ fallback: ModelSelection | null; error: string | null }> {
    try {
      const providers = await discover(
        (signal) => bb.sdk.providers.list({ hostId, signal }),
        "Provider discovery",
      );
      const provider = providers.find((candidate) => candidate.available);
      if (!provider) return { fallback: null, error: "No signed-in provider on this machine." };
      const catalog = await read(provider.id);
      if (catalog.modelLoadError !== null) {
        return { fallback: null, error: `Model catalog is not available (${catalog.modelLoadError.code}).` };
      }
      const model = catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
      if (!model) return { fallback: null, error: "This machine reported no models." };
      return {
        fallback: { providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort },
        error: null,
      };
    } catch (error) {
      return { fallback: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The stored pick as the machine can serve it today, or null when it cannot.
   * Settings and the spawn sites share this so what the user sees is what runs.
   */
  async function usableSelection(
    hostId: string,
    selection: ModelSelection,
    read: Catalog = catalogReader(hostId),
  ): Promise<ModelSelection | null> {
    try {
      const catalog = await read(selection.providerId);
      if (catalog.modelLoadError !== null) {
        throw new Error(`model catalog is not available (${catalog.modelLoadError.code})`);
      }
      const model = catalog.models.find((candidate) => candidate.model === selection.model);
      if (!model) throw new Error("the machine no longer offers that model");
      const reasoningLevel = model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === selection.reasoningLevel,
      ) ? selection.reasoningLevel : model.defaultReasoningEffort;
      return { ...selection, reasoningLevel };
    } catch (error) {
      bb.log.warn(
        `Chief model ${selection.providerId}/${selection.model} is unusable on ${hostId}; using the BB default instead: ${String(error)}`,
      );
      return null;
    }
  }

  /**
   * Spawn arguments for a role. No selection, an unknown host, or a selection
   * the machine can no longer serve all fall through to BB's own defaults —
   * a stale pick must not block the work.
   */
  async function execution(role: Role, hostId: string | null) {
    const selection = hostId === null ? null : readRoleModel(hostId, role);
    if (!hostId || !selection) return {};
    return (await usableSelection(hostId, selection)) ?? {};
  }

  async function defaultHostId() {
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((candidate) => candidate.status === "connected") ?? hosts[0];
    if (!host) throw new Error("No BB host is registered; a host is required for a managed worktree.");
    return host.id;
  }

  /** The machine a role's thread will actually run on, or null when unknown. */
  async function projectHostId(projectId: string) {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      return source?.hostId ?? await defaultHostId();
    } catch (error) {
      bb.log.warn(`Could not resolve the machine for ${projectId}: ${String(error)}`);
      return null;
    }
  }

  async function environmentHostId(environmentId: string) {
    try {
      return (await bb.sdk.environments.get({ environmentId })).hostId;
    } catch (error) {
      bb.log.warn(`Could not resolve the machine for ${environmentId}: ${String(error)}`);
      return null;
    }
  }

  function chiefForProject(projectId: string) {
    return (activeChiefForProject.get(projectId) as ManagedRow | undefined) ?? null;
  }

  async function spawnChief(target: string, previous?: ManagedRow) {
    const sectionId = await ensureSection();
    const name = await projectName(target);
    const rules = await readRules(target);
    const count = (chiefCountForProject.get(target) as { count: number }).count;
    const title = count === 0 ? `Chief · ${name}` : `Chief · ${name} · ${count + 1}`;
    const prompt = [
      `You are Chief for ${name}. You supervise the ordinary BB threads in the Chief sidebar section.`,
      "",
      "Use chief_delegate for implementation work. Inspect reports and live thread evidence with chief_inspect, continue safe work, start independent reviews when warranted, and mark work complete only after verification.",
      "Lifecycle alerts are prompts to decide: continue, review, complete, or escalate. Escalate genuine product, scope, permission, credential, or irreversible decisions here to the user with your recommendation.",
      "", "## Project rules", rules,
      "", "Acknowledge the operating rules briefly, inspect the roster, and wait for work.",
    ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: target,
      environment: { type: "project-default" },
      sectionId,
      visibility: "visible",
      title,
      ...(await execution("chief", await projectHostId(target))),
      prompt,
    });
    if (previous && previous.thread_id !== thread.id) {
      const now = Date.now();
      db.transaction(() => {
        db.prepare(`UPDATE managed_threads SET state='complete', updated_at=? WHERE thread_id=?`).run(now, previous.thread_id);
        db.prepare(`UPDATE managed_threads SET chief_thread_id=?, updated_at=?
          WHERE project_id=? AND chief_thread_id=? AND state NOT IN ('complete','archived','deleted')`).run(
          thread.id, now, target, previous.thread_id,
        );
        db.prepare(`UPDATE alert_outbox SET target_thread_id=?
          WHERE target_thread_id=? AND delivered_at IS NULL`).run(thread.id, previous.thread_id);
      })();
    }
    insertThread({ threadId: thread.id, role: "chief", projectId: target, title, state: "starting", status: thread.status });
    return { threadId: thread.id, created: true as const };
  }

  async function createChief(projectId: string) {
    return spawnChief(projectId);
  }

  const chiefStarts = new Map<string, Promise<{ threadId: string; created: boolean }>>();
  async function ensureChief(projectId?: string) {
    const values = await settings.get();
    const target = projectId ?? values.chiefProject;
    if (!target) throw new Error("Configure a default Chief project first: bb plugin config chief set chiefProject <proj-id>");
    const inFlight = chiefStarts.get(target);
    if (inFlight) return inFlight;
    const start = (async () => {
      const existing = chiefForProject(target);
      if (existing) {
        await reconcileThread(existing, await ensureSection());
        const reconciled = roles.get(existing.thread_id);
        if (reconciled && !["failed", "deleted", "archived", "complete"].includes(reconciled.state)) {
          return { threadId: existing.thread_id, created: false };
        }
      }
      const previous = latestChiefForProject.get(target) as ManagedRow | undefined;
      return spawnChief(target, previous);
    })();
    chiefStarts.set(target, start);
    try {
      return await start;
    } finally {
      chiefStarts.delete(target);
    }
  }

  async function delegate(params: z.infer<typeof delegateParams>, callerThreadId?: string | null) {
    const caller = callerThreadId ? roles.get(callerThreadId) : undefined;
    const values = await settings.get();
    const projectId = caller?.project_id ?? values.chiefProject;
    if (!projectId) throw new Error("No Chief project is configured.");
    const chief = caller?.role === "chief" ? caller : chiefForProject(projectId);
    if (!chief || chief.state === "complete") throw new Error("Start Chief for this project before delegating work.");
    const sectionId = await ensureSection();
    const rules = await readRules(projectId);
    const prompt = [
      `You are the managed worker for “${params.title}”. Report to Chief thread ${chief.thread_id}.`,
      "", "## Mission", params.mission,
      "", "## Success criteria", bullets(params.successCriteria),
      "", "## Constraints", bullets(params.constraints),
      ...(params.context ? ["", "## Context", params.context] : []),
      "", "## Project rules", rules,
      "", "## Working contract",
      "- Own the requested outcome in this worktree. Keep scope narrow and verify the user journey or closest executable seam.",
      "- Use chief_report with state ready and a non-empty result when your work is ready for Chief's verification. Only Chief can mark it complete.",
      "- A blocked report must include the blocker and your recommended decision or next action.",
      "- Do not ask the user directly from this thread. Chief decides whether a question needs escalation.",
    ].join("\n");
    const hostId = await defaultHostId();
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: {
        type: "host",
        hostId,
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
      sectionId,
      visibility: "visible",
      title: params.title,
      ...(await execution("worker", hostId)),
      prompt,
    });
    insertThread({ threadId: thread.id, role: "worker", projectId, chiefThreadId: chief.thread_id, title: params.title, state: "starting", status: thread.status });
    return { threadId: thread.id, title: params.title, projectId };
  }

  async function continueThread(threadId: string, instruction: string, allowEdits = false) {
    const row = roles.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker or reviewer ${threadId}.`);
    const text = row.role === "reviewer"
      ? `${allowEdits ? "Chief explicitly authorizes a repair pass: edits are allowed for this instruction only." : "Remain review-only: do not modify files."}\n\n${instruction}`
      : instruction;
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text: clip(text, MAX_RESULT_LENGTH), mentions: [] }],
      senderThreadId: row.chief_thread_id ?? undefined,
    });
    db.prepare(`UPDATE managed_threads SET state='active', blocker=NULL, recommendation=NULL,
      active_since=?, active_cycle=active_cycle+1, stall_alerted_cycle=NULL, updated_at=? WHERE thread_id=?`).run(
      Date.now(), Date.now(), threadId,
    );
    reloadRoles();
    return roles.get(threadId)!;
  }

  async function startReview(workerThreadId: string, focus?: string) {
    const inFlight = reviewStarts.get(workerThreadId);
    if (inFlight) return inFlight;
    const start = (async () => {
      const worker = roles.get(workerThreadId);
      if (!worker || worker.role !== "worker") throw new Error(`No managed worker ${workerThreadId}.`);
      const duplicate = existingReview.get(workerThreadId) as ManagedRow | undefined;
      if (duplicate) return { threadId: duplicate.thread_id, title: duplicate.title, workerThreadId, created: false };
      const live = await bb.sdk.threads.get({ threadId: workerThreadId });
      if (BUSY_STATUSES.has(live.status)) throw new Error(`Worker ${workerThreadId} is ${live.status}; wait until it is idle before starting a review.`);
      if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Worker ${workerThreadId} is not reviewable.`);
      if (!live.environmentId) throw new Error(`Worker ${workerThreadId} has no reusable environment.`);
      const sectionId = await ensureSection();
      const rules = await readRules(worker.project_id);
      const title = `Review · ${worker.title}`;
      const prompt = [
        `Independently review the work owned by worker thread ${workerThreadId}: “${worker.title}”.`,
        focus ? `Review focus: ${focus}` : "Review for correctness, regressions, validation quality, and unnecessary complexity.",
        "This is a read-only review. Do not modify files unless Chief later sends an explicit repair instruction authorizing edits.",
        "Inspect the actual worktree and evidence; do not rely only on the worker's claims.",
        `Report findings and a ship/fix verdict to Chief thread ${worker.chief_thread_id} using chief_report with state ready.`,
        "Do not broaden scope or make product decisions. Recommend escalation when a real decision is required.",
        "", "## Project rules", rules,
      ].join("\n");
      const thread = await bb.sdk.threads.spawn({
        projectId: worker.project_id,
        environment: { type: "reuse", environmentId: live.environmentId },
        sectionId,
        visibility: "visible",
        title,
        ...(await execution("reviewer", await environmentHostId(live.environmentId))),
        prompt,
      });
      insertThread({ threadId: thread.id, role: "reviewer", projectId: worker.project_id, chiefThreadId: worker.chief_thread_id, workerThreadId, title, state: "starting", status: thread.status });
      return { threadId: thread.id, title, workerThreadId, created: true };
    })();
    reviewStarts.set(workerThreadId, start);
    try {
      return await start;
    } finally {
      reviewStarts.delete(workerThreadId);
    }
  }

  async function markComplete(threadId: string, result?: string) {
    const row = roles.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker or reviewer ${threadId}.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (BUSY_STATUSES.has(live.status)) throw new Error(`Cannot complete ${threadId} while it is ${live.status}.`);
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Cannot complete ${threadId} because it is not a live thread.`);
    db.prepare(`UPDATE managed_threads SET state='complete', status=?, result=COALESCE(?, result),
      blocker=NULL, recommendation=NULL, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      live.status, result ? clip(result, MAX_RESULT_LENGTH) : null, Date.now(), threadId,
    );
    reloadRoles();
    return roles.get(threadId)!;
  }

  function enqueueAlert(row: ManagedRow, key: string, message: string) {
    if (!row.chief_thread_id) throw new Error(`Managed thread ${row.thread_id} has no Chief to notify.`);
    db.prepare(`INSERT OR IGNORE INTO alert_outbox
      (dedupe_key, target_thread_id, source_thread_id, message, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      `${row.thread_id}:${key}`, row.chief_thread_id, row.thread_id,
      clip(`[Chief lifecycle alert]\n${message}`), Date.now(),
    );
    return `${row.thread_id}:${key}`;
  }

  async function deliverAlert(key: string) {
    const existing = alertDeliveries.get(key);
    if (existing) return existing;
    const delivery = (async () => {
      const alert = db.prepare<[string]>(`SELECT * FROM alert_outbox WHERE dedupe_key=?`).get(key) as AlertRow | undefined;
      if (!alert || alert.delivered_at !== null) return true;
      try {
        await bb.sdk.threads.send({
          threadId: alert.target_thread_id,
          mode: "queue-if-active",
          input: [{ type: "text", text: clip(alert.message), mentions: [] }],
        });
        db.prepare(`UPDATE alert_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(`UPDATE alert_outbox SET attempts=attempts+1, last_error=? WHERE dedupe_key=?`).run(clip(message, 1_000), key);
        bb.log.warn(`Could not deliver Chief alert ${key}: ${message}`);
        return false;
      }
    })();
    alertDeliveries.set(key, delivery);
    try {
      return await delivery;
    } finally {
      alertDeliveries.delete(key);
    }
  }

  async function alertChief(row: ManagedRow, key: string, message: string) {
    const outboxKey = enqueueAlert(row, key, message);
    return deliverAlert(outboxKey);
  }

  async function retryAlerts() {
    for (const alert of pendingAlerts.all() as AlertRow[]) await deliverAlert(alert.dedupe_key);
  }

  async function report(threadId: string, params: z.infer<typeof reportParams>) {
    const row = roles.get(threadId);
    if (!row || row.role === "chief") throw new Error("chief_report is available only in managed worker and reviewer threads.");
    if (["complete", "archived", "deleted"].includes(row.state)) {
      throw new Error(`Managed thread ${threadId} is ${row.state} and can no longer report.`);
    }
    const now = Date.now();
    db.prepare(`UPDATE managed_threads SET state=?, result=?, blocker=?, recommendation=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      params.state, params.result ?? null, params.state === "blocked" ? params.blocker : null,
      params.recommendation ?? null, now, threadId,
    );
    reloadRoles();
    const current = roles.get(threadId)!;
    const summary = [
      `${row.role === "reviewer" ? "Reviewer" : "Worker"} report from ${row.title} (${threadId})`,
      `State: ${params.state}`,
      ...(params.result ? [`Result: ${params.result}`] : []),
      ...(params.state === "blocked" ? [`Blocker: ${params.blocker}`] : []),
      ...(params.recommendation ? [`Recommendation: ${params.recommendation}`] : []),
      "Inspect live evidence with chief_inspect and choose: continue, review, complete, or escalate to the user.",
    ].join("\n");
    const delivered = await alertChief(current, `report:${now}:${randomUUID()}`, summary);
    if (!delivered) {
      throw new Error("Report was saved but could not be delivered to Chief. It will retry automatically; inspect Chief connectivity before reporting again.");
    }
    return current;
  }

  function stateFromLive(row: ManagedRow, status: string) {
    if (["active", "starting", "pending", "stopping"].includes(status)) return status;
    if (status === "error") return "failed";
    if (["ready", "blocked", "complete"].includes(row.state)) return row.state;
    return "idle";
  }

  async function reconcileThread(row: ManagedRow, sectionId: string) {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: row.thread_id });
    } catch (error) {
      bb.log.warn(`Transient thread read failure for ${row.thread_id}; will retry: ${String(error)}`);
      return false;
    }
    const now = Date.now();
    if (thread.deletedAt !== null) {
      db.prepare(`UPDATE managed_threads SET state='deleted', status=NULL, active_since=NULL, updated_at=? WHERE thread_id=?`).run(now, row.thread_id);
      reloadRoles();
      return true;
    }
    if (thread.archivedAt !== null) {
      db.prepare(`UPDATE managed_threads SET state='archived', status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(thread.status, now, row.thread_id);
      reloadRoles();
      return true;
    }
    if (thread.sectionId !== sectionId || thread.visibility !== "visible") {
      try {
        await bb.sdk.threads.update({ threadId: row.thread_id, sectionId, visibility: "visible" });
      } catch (error) {
        bb.log.warn(`Transient thread filing failure for ${row.thread_id}; will retry: ${String(error)}`);
      }
    }
    const nextState = stateFromLive(row, thread.status) as ManagedRow["state"];
    const enteringActive = nextState === "active" && row.state !== "active";
    db.prepare(`UPDATE managed_threads SET state=?, status=?, active_since=?,
      active_cycle=active_cycle+?, stall_alerted_cycle=CASE WHEN ? THEN NULL ELSE stall_alerted_cycle END,
      updated_at=? WHERE thread_id=?`).run(
      nextState, thread.status,
      nextState === "active" ? (row.state === "active" ? row.active_since ?? now : now) : null,
      enteringActive ? 1 : 0, enteringActive ? 1 : 0, now, row.thread_id,
    );
    reloadRoles();
    return true;
  }

  async function reconcile() {
    const sectionId = await ensureSection();
    for (const row of [...roles.values()]) {
      if (row.state !== "deleted") await reconcileThread(row, sectionId);
    }
    const projects = new Set([...roles.values()].map((row) => row.project_id));
    const configured = (await settings.get()).chiefProject;
    if (configured) projects.add(configured);
    for (const projectId of projects) await readRules(projectId);
  }

  async function lifecycle(kind: string, thread: { id: string; status?: string }, detail?: string | null) {
    const row = roles.get(thread.id);
    if (!row) return;
    const now = Date.now();
    if (row.role === "chief") {
      const state = kind === "active" ? "active"
        : kind === "idle" ? "idle"
          : kind === "failed" ? "failed"
            : kind === "archived" ? "archived" : "deleted";
      db.prepare(`UPDATE managed_threads SET state=?, status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
        state, thread.status ?? state, now, thread.id,
      );
      reloadRoles();
      return;
    }
    if (kind === "active") {
      const enteringActive = row.state !== "active";
      db.prepare(`UPDATE managed_threads SET state='active', status=?, active_since=?,
        active_cycle=active_cycle+?, stall_alerted_cycle=CASE WHEN ? THEN NULL ELSE stall_alerted_cycle END,
        updated_at=? WHERE thread_id=?`).run(
        thread.status ?? "active", enteringActive ? now : row.active_since ?? now,
        enteringActive ? 1 : 0, enteringActive ? 1 : 0, now, thread.id,
      );
      reloadRoles();
      return;
    }
    const observed = kind === "idle" ? "idle" : kind === "failed" ? "failed" : kind === "archived" ? "archived" : "deleted";
    const state = observed === "idle" && ["ready", "blocked", "complete"].includes(row.state) ? row.state : observed;
    db.prepare(`UPDATE managed_threads SET state=?, status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      state, thread.status ?? observed, now, thread.id,
    );
    reloadRoles();
    const current = roles.get(thread.id)!;
    await alertChief(current, `${kind}:${row.active_cycle}`, [
      `${current.role} “${current.title}” (${current.thread_id}) is ${observed}.`,
      ...(detail ? [`Detail: ${detail}`] : []),
      "Inspect live output and evidence. Choose a safe next step: continue it, start/assess a review, mark it complete, or escalate a genuine decision to the user.",
    ].join("\n"));
  }

  bb.events.on("thread.active", ({ thread }) => lifecycle("active", thread));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => lifecycle("idle", thread, lastAssistantText));
  bb.events.on("thread.failed", ({ thread, error }) => lifecycle("failed", thread, error));
  bb.events.on("thread.archived", ({ thread }) => lifecycle("archived", thread));
  bb.events.on("thread.deleted", ({ thread }) => lifecycle("deleted", thread));

  bb.background.service("supervisor", {
    async start(signal) {
      const wake = () => new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, RECONCILE_INTERVAL_MS);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      while (!signal.aborted) {
        try {
          await reconcile();
          const values = await settings.get();
          const parsed = Number(values.stallMinutes);
          const threshold = (Number.isFinite(parsed) && parsed > 0 ? parsed : 30) * 60_000;
          const now = Date.now();
          for (const row of [...roles.values()]) {
            if (row.role === "chief" || row.state !== "active" || row.active_since === null) continue;
            if (now - row.active_since < threshold || row.stall_alerted_cycle === row.active_cycle) continue;
            const sent = await alertChief(row, `stall:${row.active_cycle}`, [
              `${row.role} “${row.title}” (${row.thread_id}) has remained active for more than ${Math.round(threshold / 60_000)} minutes.`,
              "Inspect current evidence before intervening. Continue or steer only when a safe next instruction is clear; otherwise escalate the concrete blocker.",
            ].join("\n"));
            if (sent) {
              db.prepare(`UPDATE managed_threads SET stall_alerted_cycle=?, updated_at=? WHERE thread_id=?`).run(row.active_cycle, Date.now(), row.thread_id);
              reloadRoles();
            }
          }
          const chiefProjects = new Set(
            [...roles.values()]
              .filter((row) => row.role === "chief" && ["failed", "archived", "deleted"].includes(row.state))
              .map((row) => row.project_id),
          );
          if (values.chiefProject) chiefProjects.add(values.chiefProject);
          for (const projectId of chiefProjects) await ensureChief(projectId);
          // Replace terminal Chiefs and retarget their queued alerts before any
          // pending delivery is attempted.
          await retryAlerts();
        } catch (error) {
          bb.log.warn(`Supervisor reconciliation failed: ${String(error)}`);
        }
        await wake();
      }
    },
  });

  settings.onChange((next, previous) => {
    if (next.chiefProject && next.chiefProject !== previous.chiefProject) {
      void ensureChief(next.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
    }
  });

  function rosterFor(projectId: string, includeComplete = false) {
    return [...roles.values()].filter((row) => row.project_id === projectId && (includeComplete || row.state !== "complete"));
  }

  function belongsToChief(row: ManagedRow, chiefThreadId: string) {
    return row.thread_id === chiefThreadId || row.chief_thread_id === chiefThreadId;
  }

  function rosterForChief(chiefThreadId: string, includeComplete = false) {
    return [...roles.values()].filter(
      (row) => belongsToChief(row, chiefThreadId) && (includeComplete || row.state !== "complete"),
    );
  }

  async function inspect(threadId: string, projectId: string) {
    const row = roles.get(threadId);
    if (!row || row.project_id !== projectId) throw new Error(`No managed thread ${threadId} for this Chief project.`);
    let liveStatus = row.status;
    try {
      const live = await bb.sdk.threads.get({ threadId });
      liveStatus = live.deletedAt !== null ? "deleted" : live.archivedAt !== null ? "archived" : live.status;
    } catch (error) {
      bb.log.warn(`Could not inspect live status for ${threadId}: ${String(error)}`);
    }
    let output: string | null = null;
    try {
      output = (await bb.sdk.threads.output({ threadId })).output;
    } catch (error) {
      bb.log.warn(`Could not inspect output for ${threadId}: ${String(error)}`);
    }
    return [
      `Thread: ${row.title} (${threadId})`,
      `Role: ${row.role}`,
      `Persisted state: ${row.state}`,
      `Live status: ${liveStatus ?? "unknown"}`,
      ...(row.result ? [`Result: ${clip(row.result, 2_000)}`] : []),
      ...(row.blocker ? [`Blocker: ${clip(row.blocker, 1_000)}`] : []),
      ...(row.recommendation ? [`Recommendation: ${clip(row.recommendation, 1_000)}`] : []),
      `Last assistant output:\n${output ? clip(output, 4_000) : "(none available)"}`,
    ].join("\n");
  }

  bb.agents.registerTool({
    name: "chief_delegate",
    description: "Delegate one clearly titled unit of implementation work to a visible worker in its own managed worktree.",
    parameters: delegateParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "chief" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("chief_delegate requires an active registered Chief thread.");
      }
      const result = await delegate(params, context.threadId);
      return `Started worker “${result.title}” in thread ${result.threadId}. Track it with chief_roster.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_roster",
    description: "Inspect this project's managed threads and their bounded persisted status, result, blocker, and recommendation.",
    parameters: z.object({ includeComplete: z.boolean().optional() }),
    async execute({ includeComplete }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "chief") throw new Error("chief_roster requires a registered Chief thread.");
      const rows = rosterForChief(caller.thread_id, includeComplete);
      return rows.length ? rows.map((row) => [
        `${row.role} | ${row.state} | live:${row.status ?? "unknown"} | ${row.title} | ${row.thread_id}`,
        ...(row.result ? [`result: ${clip(row.result, 1_000)}`] : []),
        ...(row.blocker ? [`blocker: ${clip(row.blocker, 600)}`] : []),
        ...(row.recommendation ? [`recommendation: ${clip(row.recommendation, 600)}`] : []),
      ].join("\n  ")).join("\n") : "No managed threads for this project.";
    },
  });
  bb.agents.registerTool({
    name: "chief_inspect",
    description: "Inspect one managed thread's live status, persisted report, and bounded last assistant output before deciding what to do.",
    parameters: z.object({ threadId: z.string() }),
    async execute({ threadId }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "chief" || !target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      return inspect(threadId, caller.project_id);
    },
  });
  bb.agents.registerTool({
    name: "chief_continue",
    description: "Send or queue a concrete next instruction to a managed worker or reviewer. Reviewer edits require allowEdits=true.",
    parameters: z.object({
      threadId: z.string(),
      instruction: z.string().trim().min(1).max(MAX_RESULT_LENGTH),
      allowEdits: z.boolean().optional().describe("Explicitly authorize a reviewer repair pass; false keeps it review-only."),
    }),
    async execute({ threadId, instruction, allowEdits }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "chief" || !target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      await continueThread(threadId, instruction, allowEdits);
      return `Continued ${threadId}${allowEdits ? " with explicit repair authorization" : ""}.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_review",
    description: "Start or return an independent read-only review in an idle worker's existing worktree.",
    parameters: z.object({ workerThreadId: z.string(), focus: z.string().trim().max(4_000).optional() }),
    async execute({ workerThreadId, focus }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const worker = roles.get(workerThreadId);
      if (!caller || caller.role !== "chief" || !worker || !belongsToChief(worker, caller.thread_id)) {
        throw new Error(`No managed worker ${workerThreadId} for this Chief.`);
      }
      const review = await startReview(workerThreadId, focus);
      return `${review.created ? "Started" : "Using existing"} “${review.title}” in thread ${review.threadId}.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_complete",
    description: "Mark an idle managed worker or reviewer complete after Chief has inspected sufficient evidence.",
    parameters: z.object({ threadId: z.string(), result: z.string().trim().max(MAX_RESULT_LENGTH).optional() }),
    async execute({ threadId, result }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "chief" || !target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      const row = await markComplete(threadId, result);
      return `Marked “${row.title}” complete.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_report",
    description: "Report managed work state and evidence to Chief. Use ready, not complete; blocked requires blocker and recommendation.",
    parameters: reportParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_report requires a thread context.");
      await report(context.threadId, params);
      return "Report delivered to Chief.";
    },
  });

  bb.agents.configure((context) => {
    const row = roles.get(context.thread.id);
    if (!row || ["complete", "archived", "deleted"].includes(row.state)) return { tools: [], skills: [] };
    const rules = rulesCache.get(row.project_id) ?? BUILT_IN_RULES;
    if (row.role === "chief") {
      return {
        tools: ["chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_review", "chief_complete"],
        skills: ["chief"],
        instructions: `You are the registered Chief supervisor for ${context.project.name}. Use ordinary visible BB threads and drive managed work through completion.\n\n${rules}`,
      };
    }
    return {
      tools: ["chief_report"],
      skills: ["chief-worker"],
      instructions: `You are a managed ${row.role} reporting to Chief thread ${row.chief_thread_id}.\n\n${rules}`,
    };
  });

  bb.rpc.register(rpcContract, {
    status: () => ({ sectionId: storedSectionId(), threads: [...roles.values()].map(toManaged) }),
    start: ({ projectId }) => ensureChief(projectId ?? undefined),
    create: ({ projectId }) => createChief(projectId),
    modelConfiguration: async () => ({
      hosts: await Promise.all((await bb.sdk.hosts.list()).map(async (host) => {
        const connected = host.status === "connected";
        const selections = {
          chief: readRoleModel(host.id, "chief"),
          worker: readRoleModel(host.id, "worker"),
          reviewer: readRoleModel(host.id, "reviewer"),
        };
        // A connected machine can answer for its own picks, so say which ones it
        // would refuse instead of showing a model the next spawn will ignore.
        // One reader for the whole host: roles sharing a provider scan it once.
        const read = catalogReader(host.id);
        const [scan, flagged] = await Promise.all([
          connected
            ? hostFallback(host.id, read)
            : { fallback: null, error: "Machine is disconnected; its model catalog is unavailable." },
          Promise.all(roleSchema.options.map(async (role) => {
            const selection = selections[role];
            if (!connected || !selection) return null;
            return (await usableSelection(host.id, selection, read)) ? null : role;
          })),
        ]);
        return {
          hostId: host.id,
          hostName: host.name,
          connected,
          ...scan,
          selections,
          unusable: flagged.filter((role): role is Role => role !== null),
        };
      })),
    }),
    setRoleModel: ({ hostId, role, selection }) => {
      writeRoleModel(hostId, role, selection);
      return { ok: true as const };
    },
  });

  const usage = [
    "Usage:",
    "  bb chief status [--project proj_id] [--json]",
    "  bb chief start [--project proj_id] [--json]",
    "  bb chief create [--project proj_id] [--json]",
    "  bb chief adopt --thread thr_id [--json]",
    "  bb chief delegate --title \"…\" --mission \"…\" [--criteria \"…\"]... [--constraint \"…\"]... [--context \"…\"] [--json]",
    "  bb chief inspect <thread-id>",
    "  bb chief continue <thread-id> --instruction \"…\" [--allow-edits] [--json]",
    "  bb chief review <worker-thread-id> [--focus \"…\"] [--json]",
    "  bb chief complete <thread-id> [--result \"…\"] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "chief",
    summary: "Supervise visible BB worker and review threads through completion",
    commands: [
      { name: "status", summary: "Show a project's Chief-managed roster", usage: "bb chief status [--project proj_id] [--json]" },
      { name: "start", summary: "Start or return the latest Chief for a project", usage: "bb chief start [--project proj_id] [--json]" },
      { name: "create", summary: "Create another Chief for a project", usage: "bb chief create [--project proj_id] [--json]" },
      { name: "adopt", summary: "Adopt an existing ordinary thread as its project's Chief", usage: "bb chief adopt --thread thr_id [--json]" },
      { name: "delegate", summary: "Start a clearly titled worker in a managed worktree", usage: "bb chief delegate --title \"…\" --mission \"…\" [--json]" },
      { name: "inspect", summary: "Inspect a managed thread's live and reported evidence", usage: "bb chief inspect <thread-id>" },
      { name: "continue", summary: "Continue a managed worker or reviewer", usage: "bb chief continue <thread-id> --instruction \"…\" [--allow-edits] [--json]" },
      { name: "review", summary: "Start or return a read-only review for an idle worker", usage: "bb chief review <worker-thread-id> [--focus \"…\"] [--json]" },
      { name: "complete", summary: "Mark verified, non-running managed work complete", usage: "bb chief complete <thread-id> [--result \"…\"] [--json]" },
    ],
    async run(argv: string[], context: PluginCliContext): Promise<PluginCliResult> {
      const [command, ...rest] = argv;
      const args = parseArgs(rest);
      const json = args.bool("json");
      const ok = (data: unknown, text: string) => ({ exitCode: 0, stdout: clip(json ? JSON.stringify(data, null, 2) : text, 64_000) + "\n" });
      const fail = (message: string) => ({ exitCode: 1, stderr: `${message}\n\n${usage}\n` });
      try {
        if (!command || command === "help" || command === "--help") return ok({}, usage);
        if (command === "status") {
          const projectId = args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("status requires --project outside a project thread");
          const rows = rosterFor(projectId, true).map(toManaged);
          return ok({ sectionId: storedSectionId(), threads: rows }, rows.length ? rows.map((row) => `${row.role.padEnd(8)} ${row.state.padEnd(9)} ${row.title}  ${row.threadId}`).join("\n") : "Chief has no managed threads for this project.");
        }
        if (command === "start") {
          const result = await ensureChief(args.one("project") ?? context.projectId ?? undefined);
          return ok(result, `${result.created ? "Started" : "Using"} Chief thread ${result.threadId}.`);
        }
        if (command === "create") {
          const projectId = args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("create requires --project outside a project thread");
          const result = await createChief(projectId);
          return ok(result, `Created Chief thread ${result.threadId}.`);
        }
        if (command === "adopt") {
          const threadId = args.one("thread") ?? args.positional[0];
          if (!threadId) return fail("adopt requires --thread <thread-id>");
          const thread = await bb.sdk.threads.get({ threadId });
          const sectionId = await ensureSection();
          const title = `Chief · ${await projectName(thread.projectId)}`;
          await bb.sdk.threads.update({ threadId, sectionId, visibility: "visible", title });
          const previous = chiefForProject(thread.projectId);
          if (previous && previous.thread_id !== threadId) {
            const now = Date.now();
            db.transaction(() => {
              db.prepare(`UPDATE managed_threads SET state='complete', updated_at=? WHERE thread_id=?`).run(now, previous.thread_id);
              db.prepare(`UPDATE managed_threads SET chief_thread_id=?, updated_at=? WHERE project_id=? AND chief_thread_id=? AND state NOT IN ('complete','archived','deleted')`).run(threadId, now, thread.projectId, previous.thread_id);
              db.prepare(`UPDATE alert_outbox SET target_thread_id=? WHERE target_thread_id=? AND delivered_at IS NULL`).run(threadId, previous.thread_id);
            })();
          }
          insertThread({ threadId, role: "chief", projectId: thread.projectId, title, state: thread.status === "active" ? "active" : "idle", status: thread.status });
          await readRules(thread.projectId);
          return ok({ threadId, projectId: thread.projectId, title }, `Adopted ${threadId} as “${title}”.`);
        }
        if (command === "delegate") {
          const parsed = delegateParams.safeParse({
            title: args.one("title"), mission: args.one("mission"),
            successCriteria: args.all("criteria"), constraints: args.all("constraint"), context: args.one("context"),
          });
          if (!parsed.success) return fail(`Invalid delegate brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await delegate(parsed.data, context.threadId);
          return ok(result, `Started worker “${result.title}” in ${result.threadId}.`);
        }
        if (command === "inspect") {
          const threadId = args.positional[0];
          if (!threadId) return fail("inspect requires <thread-id>");
          const row = roles.get(threadId);
          if (!row) return fail(`No managed thread ${threadId}.`);
          return ok({ threadId }, await inspect(threadId, row.project_id));
        }
        if (command === "continue") {
          const threadId = args.positional[0];
          const instruction = args.one("instruction");
          if (!threadId || !instruction) return fail("continue requires <thread-id> and --instruction");
          await continueThread(threadId, instruction, args.bool("allow-edits"));
          return ok({ threadId }, `Continued ${threadId}.`);
        }
        if (command === "review") {
          const workerThreadId = args.positional[0];
          if (!workerThreadId) return fail("review requires <worker-thread-id>");
          const result = await startReview(workerThreadId, args.one("focus"));
          return ok(result, `${result.created ? "Started" : "Using existing"} “${result.title}” in ${result.threadId}.`);
        }
        if (command === "complete") {
          const threadId = args.positional[0];
          if (!threadId) return fail("complete requires <thread-id>");
          const row = await markComplete(threadId, args.one("result"));
          return ok(toManaged(row), `Marked “${row.title}” complete.`);
        }
        return fail(`Unknown command “${command}”.`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  try {
    await reconcile();
  } catch (error) {
    bb.log.warn(`Initial reconciliation deferred: ${String(error)}`);
  }
  const initial = await settings.get();
  if (initial.chiefProject) {
    void ensureChief(initial.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
  }
  bb.log.info("Chief supervisor loaded");
}
