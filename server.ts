import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { pingGateway, runEvaluation } from "./jev/gateway";
import { getMetricDefinition } from "./jev/transform";
import { evaluationSchema, type Evaluation, type MetricKey } from "./jev/types";

const SECTION_NAME = "Chief";
const RULES_FILE = "chief.md";
const RECONCILE_INTERVAL_MS = 30_000;
const MAX_ALERT_LENGTH = 3_000;
const MAX_RESULT_LENGTH = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const JEV_DEFAULT_MODEL = "typesafe-ai/jev";
const JEV_PING_TIMEOUT_MS = 30_000;
const JEV_SCORE_TIMEOUT_MS = 180_000;
const JEV_MAX_DIFF_BYTES = 96 * 1024;
/** Lock files and generated output drown a real diff in noise nobody reviews. */
const GENERATED_OR_LOCK_PATTERN =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|.*\.generated\.[a-z]+|.*\.min\.js)$/;
const BUSY_STATUSES = new Set(["active", "starting", "stopping", "pending"]);

const roleSchema = z.enum(["chief", "worker", "reviewer"]);
/** A worker's tier, chosen by Chief at delegation time. Separate from the
 * lifecycle role above: every tier is still a "worker" for role-gated tools,
 * lifecycle alerts, and the managed_threads role CHECK. */
const tierSchema = z.enum(["junior", "senior"]);
/** The role key chief_models stores a per-machine model pick under: the
 * lifecycle roles, but with "worker" split into its two tiers. */
const modelRoleSchema = z.enum(["chief", "junior", "senior", "reviewer"]);
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
      junior: modelSelectionSchema.nullable(),
      senior: modelSelectionSchema.nullable(),
      reviewer: modelSelectionSchema.nullable(),
    }),
    /** Roles whose stored pick this machine can no longer serve, so spawns use BB's default. */
    unusable: z.array(modelRoleSchema),
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
  tier: tierSchema.default("senior").describe(
    "junior for trivial, mechanical, or already-specified bounded work (rename, typo, formatting, a function/endpoint whose shape is decided, tests for existing behavior, a localized fix whose cause is already understood); senior for everything else (unknown-cause debugging, design or refactor across modules, security/auth/concurrency/data-migration/money logic, ambiguous scope, high blast radius). When unsure, senior. Junior still needs a brief specific enough that a weaker model can finish it in one pass.",
  ),
  branch: z.string().trim().min(1).max(300).optional().describe(
    "The task branch Chief already created and pushed. The worktree is based on it and the worker commits there. Omit to base the worktree on the project default.",
  ),
  issueUrl: z.string().trim().min(1).max(500).optional().describe("URL of the tracking issue Chief opened for this task, when the forge has issues."),
  prUrl: z.string().trim().min(1).max(500).optional().describe("URL of the draft pull request Chief opened from the task branch. The worker never marks it ready."),
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

const jevStatusSchema = z.object({
  hasKey: z.boolean(),
  model: z.string(),
  /** The stored check matches the key and model in effect right now. */
  verified: z.boolean(),
  enabled: z.boolean(),
}).strict();

export type JevStatus = z.infer<typeof jevStatusSchema>;

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
      role: modelRoleSchema,
      selection: modelSelectionSchema.nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  jevStatus: {
    input: z.null(),
    output: jevStatusSchema,
  },
  jevCheck: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), message: z.string(), status: jevStatusSchema }).strict(),
  },
});

interface ManagedRow {
  thread_id: string;
  role: z.infer<typeof roleSchema>;
  tier: z.infer<typeof tierSchema> | null;
  branch: string | null;
  issue_url: string | null;
  pr_url: string | null;
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
- A worker report is evidence, not proof. Every worker that reports ready gets an independent review automatically; read that reviewer's verdict before completing its work.
- Start extra reviews with chief_review whenever a change is risky enough to deserve a second pass.
- Keep thread titles literal and recognizable. Never invent codenames.
- Do not delete user threads. Mark managed work complete; let the user archive it when desired.`;

const JEV_REVIEWER_INSTRUCTIONS = `
Jev scoring is available to you through chief_score. Use it once per review pass, and only after you have read the change yourself — the score is a second opinion, not your first impression.

You choose the base branch to compare against. Pick the branch this change actually merges into:
1. If the worktree has an open pull request, use its base (\`gh pr view --json baseRefName -q .baseRefName\`).
2. Otherwise use the branch the environment was forked from, if it is a real branch.
3. Otherwise use the repository's default branch (main or master).

Score against the same base on every pass for one worker; only then does the improved/regressed comparison mean anything. If you deliberately change the base, say so in your report and treat that score as a fresh baseline.

In your report to Chief, state the base you used, which findings you confirmed against the code, and which scored points you reject and why.`;

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

/** Keeps as much of the diff as the budget allows, joining separator included, so the
 * result never exceeds maxBytes. A patch that does not fit whole is cut to its byte
 * prefix rather than dropped: one oversized file must still be reviewable, and dropping
 * it would hand Jev an empty diff to score. Exported for tests. */
export function capDiff(patches: readonly { patch: string; truncated: boolean }[], maxBytes: number) {
  const parts: string[] = [];
  let size = 0;
  let truncated = false;
  for (const patch of patches) {
    if (patch.truncated) truncated = true;
    const separator = parts.length === 0 ? 0 : 1;
    const bytes = Buffer.from(patch.patch, "utf8");
    if (size + separator + bytes.byteLength > maxBytes) {
      truncated = true;
      // StringDecoder drops a trailing partial UTF-8 sequence instead of
      // emitting a replacement character mid-identifier.
      // Clamped: a full budget plus the separator makes this negative, and
      // subarray reads a negative end as an offset from the buffer's end —
      // handing back all but the last byte of the patch.
      const room = Math.max(0, maxBytes - size - separator);
      const prefix = new StringDecoder("utf8").write(bytes.subarray(0, room));
      if (prefix) parts.push(prefix);
      break;
    }
    parts.push(patch.patch);
    size += separator + bytes.byteLength;
  }
  return { diff: parts.join("\n"), truncated };
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
    jevApiKey: {
      type: "string",
      label: "AI Gateway API key",
      description: "Needed for Jev scoring. Check the connection below before enabling it.",
      secret: true,
    },
    jevModel: { type: "string", label: "Jev model", default: JEV_DEFAULT_MODEL },
    jevEnabled: {
      type: "boolean",
      label: "Let reviewers score changes with Jev",
      description: "Stays off until a connection check succeeds for the current key and model.",
      default: false,
    },
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
    // One row per (worker, base branch): a delta only means something when both
    // cycles scored the same comparison point.
    `CREATE TABLE IF NOT EXISTS jev_scores (
      worker_thread_id TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      evaluation TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (worker_thread_id, base_branch)
    )`,
    `ALTER TABLE managed_threads ADD COLUMN tier TEXT`,
    // SQLite cannot ALTER a CHECK constraint, so the 'worker'/'chief'/'reviewer'
    // key becomes 'junior'/'senior'/'chief'/'reviewer' via a table rebuild.
    // Existing picks under 'worker' survive as 'senior'.
    `CREATE TABLE chief_models_new (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','junior','senior','reviewer')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
    `INSERT INTO chief_models_new (host_id, role, provider_id, model, reasoning_level, updated_at)
      SELECT host_id, CASE role WHEN 'worker' THEN 'senior' ELSE role END, provider_id, model, reasoning_level, updated_at
      FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_new RENAME TO chief_models`,
    `ALTER TABLE managed_threads ADD COLUMN branch TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN issue_url TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN pr_url TEXT`,
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
  const previousScore = db.prepare<[string, string]>(
    `SELECT evaluation FROM jev_scores WHERE worker_thread_id=? AND base_branch=?`,
  );
  let roles = new Map<string, ManagedRow>();
  // bb.agents.configure is synchronous, so the gate's answer has to be on hand.
  let jevActive = false;
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
    tier?: ManagedRow["tier"];
    branch?: string | null;
    issueUrl?: string | null;
    prUrl?: string | null;
  }) {
    const now = Date.now();
    db.prepare(`INSERT INTO managed_threads (
      thread_id, role, project_id, chief_thread_id, worker_thread_id, title,
      state, status, tier, branch, issue_url, pr_url, active_since, active_cycle, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET role=excluded.role, project_id=excluded.project_id,
      chief_thread_id=excluded.chief_thread_id, worker_thread_id=excluded.worker_thread_id,
      title=excluded.title, state=excluded.state, status=excluded.status, tier=excluded.tier,
      branch=excluded.branch, issue_url=excluded.issue_url, pr_url=excluded.pr_url, updated_at=excluded.updated_at`).run(
      input.threadId, input.role, input.projectId, input.chiefThreadId ?? null,
      input.workerThreadId ?? null, input.title, input.state ?? "starting",
      input.status ?? "starting", input.tier ?? null, input.branch ?? null,
      input.issueUrl ?? null, input.prUrl ?? null, input.state === "active" ? now : null,
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

  type ModelRole = z.infer<typeof modelRoleSchema>;

  function readRoleModel(hostId: string, role: ModelRole): ModelSelection | null {
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

  function writeRoleModel(hostId: string, role: ModelRole, selection: ModelSelection | null) {
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
  async function execution(role: ModelRole, hostId: string | null) {
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
      "Use chief_delegate for implementation work. Inspect reports and live thread evidence with chief_inspect, continue safe work, and mark work complete only after verification.",
      "Every delegation picks a tier: junior for trivial, mechanical, or already-specified bounded work (rename, typo, formatting, a function or endpoint whose shape is decided, tests for existing behavior, a localized fix whose cause is already understood); senior for everything else (unknown-cause debugging, design or refactor across modules, security/auth/concurrency/data-migration/money logic, ambiguous scope, high blast radius). When unsure, use senior. Junior is not a vaguer brief — it is a brief specific enough that a weaker model can finish it in one pass; if the mission cannot name the cause or the intended shape, route senior instead.",
      "You own the forge for every delegation: before delegating, create the tracking issue, the task branch, and a draft pull request, then pass branch, issueUrl and prUrl to chief_delegate, and mark the PR ready only after the work is verified. The full procedure, including what to skip when a forge step fails, is in the chief skill's Git workflow section.",
      "A worker that reports ready is reviewed automatically: a reviewer thread starts in its worktree and reports back here. Wait for that verdict before completing the work, and use chief_review yourself for any further pass you want.",
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
      ...(params.branch ? [
        "", "## Git workflow",
        `Your worktree is based on ${params.branch}. Check that branch out and commit your work there.`,
        ...(params.issueUrl ? [`Tracking issue: ${params.issueUrl}`] : []),
        ...(params.prUrl ? [`Draft pull request: ${params.prUrl}`] : []),
        "Do not create, merge, or mark ready any pull request — Chief owns the forge. Commit and push to the task branch, then report ready.",
      ] : []),
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
        workspace: {
          type: "managed-worktree",
          baseBranch: params.branch ? { kind: "named" as const, name: params.branch } : { kind: "default" as const },
        },
      },
      sectionId,
      visibility: "visible",
      title: params.title,
      ...(await execution(params.tier, hostId)),
      prompt,
    });
    insertThread({
      threadId: thread.id, role: "worker", projectId, chiefThreadId: chief.thread_id, title: params.title,
      state: "starting", status: thread.status, tier: params.tier,
      branch: params.branch, issueUrl: params.issueUrl, prUrl: params.prUrl,
    });
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

  /** A failed auto-review must never swallow the alert Chief is waiting for. */
  async function autoReview(row: ManagedRow) {
    try {
      const review = await startReview(row.thread_id);
      const reviewer = review.created ? null : roles.get(review.threadId);
      // The worker fixed what the review found and reported ready again. Its
      // finished reviewer has to look again, or the fix cycle ships unreviewed.
      if (!reviewer || BUSY_STATUSES.has(reviewer.state)) return { ...review, resumed: false };
      await continueThread(
        review.threadId,
        "The worker reported ready again. Re-check the current worktree, including everything changed since your last report, and send Chief a fresh verdict with chief_report.",
      );
      return { ...review, resumed: true };
    } catch (error) {
      bb.log.warn(`Could not auto-start a review for ${row.thread_id}: ${String(error)}`);
      return null;
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
      row.role === "worker" && params.state === "ready"
        ? "An independent review starts by itself once this worker goes idle. Inspect the evidence now, but wait for the reviewer's verdict before completing the work."
        : "Inspect live evidence with chief_inspect and choose: continue, review, complete, or escalate to the user.",
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
    // Ready work earns its reviewer without Chief having to ask for one; Chief
    // still owns the verdict. Only now is the worker idle enough to review.
    const pending = current.role === "worker" && current.state === "ready";
    const review = pending ? await autoReview(current) : null;
    await alertChief(current, `${kind}:${row.active_cycle}`, [
      `${current.role} “${current.title}” (${current.thread_id}) is ${observed}.`,
      ...(detail ? [`Detail: ${detail}`] : []),
      review
        ? `Independent review “${review.title}” (${review.threadId}) ${review.resumed ? "has been asked to re-check the latest changes" : "is running in this worktree"}. Read its report before completing this work.`
        : pending
          ? "Its review could not be started automatically. Start one with chief_review before completing this work."
          : "Inspect live output and evidence. Choose a safe next step: continue it, start/assess a review, mark it complete, or escalate a genuine decision to the user.",
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
    // A new key or model has not been checked yet, whatever the toggle says.
    if (next.jevApiKey !== previous.jevApiKey || next.jevModel !== previous.jevModel) {
      writeJevFingerprint(null);
    }
    void jevStatus().catch((error) => bb.log.warn(`Could not re-check the Jev gate: ${String(error)}`));
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
      ...(row.tier ? [`Tier: ${row.tier}`] : []),
      ...(row.branch ? [`Branch: ${row.branch}`] : []),
      ...(row.issue_url ? [`Issue: ${row.issue_url}`] : []),
      ...(row.pr_url ? [`Pull request: ${row.pr_url}`] : []),
      `Persisted state: ${row.state}`,
      `Live status: ${liveStatus ?? "unknown"}`,
      ...(row.result ? [`Result: ${clip(row.result, 2_000)}`] : []),
      ...(row.blocker ? [`Blocker: ${clip(row.blocker, 1_000)}`] : []),
      ...(row.recommendation ? [`Recommendation: ${clip(row.recommendation, 1_000)}`] : []),
      `Last assistant output:\n${output ? clip(output, 4_000) : "(none available)"}`,
    ].join("\n");
  }

  // --- Jev scoring -------------------------------------------------------
  // The toggle is a claim; the stored fingerprint is the proof. Nothing scores
  // unless a connection check succeeded for the exact key and model in force.

  function jevFingerprint(values: { jevApiKey?: string; jevModel: string }) {
    return createHash("sha256").update(`${values.jevApiKey ?? ""}\n${values.jevModel}`).digest("hex");
  }

  function storedJevFingerprint() {
    return (db.prepare(`SELECT value FROM plugin_meta WHERE key='jev_verified'`).get() as { value: string } | undefined)?.value ?? null;
  }

  function writeJevFingerprint(fingerprint: string | null) {
    if (fingerprint === null) {
      db.prepare(`DELETE FROM plugin_meta WHERE key='jev_verified'`).run();
      return;
    }
    db.prepare(`INSERT INTO plugin_meta (key, value) VALUES ('jev_verified', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(fingerprint);
  }

  /** Reads the gate and repairs it: an enabled toggle without a matching check is
   * forced back off, so editing settings through the CLI cannot slip past the UI. */
  async function jevStatus(): Promise<JevStatus> {
    const values = await settings.get();
    const verified = Boolean(values.jevApiKey) && storedJevFingerprint() === jevFingerprint(values);
    if (!verified && values.jevEnabled) {
      jevActive = false;
      await settings.experimental_set({ jevEnabled: false });
      return { hasKey: Boolean(values.jevApiKey), model: values.jevModel, verified: false, enabled: false };
    }
    jevActive = values.jevEnabled;
    return { hasKey: Boolean(values.jevApiKey), model: values.jevModel, verified, enabled: values.jevEnabled };
  }

  async function checkJevConnection() {
    const values = await settings.get();
    if (!values.jevApiKey) {
      writeJevFingerprint(null);
      return { ok: false, message: "Enter an AI Gateway API key first.", status: await jevStatus() };
    }
    try {
      await pingGateway({ apiKey: values.jevApiKey, model: values.jevModel, timeoutMs: JEV_PING_TIMEOUT_MS });
    } catch (error) {
      writeJevFingerprint(null);
      return { ok: false, message: clip(String(error), 500), status: await jevStatus() };
    }
    writeJevFingerprint(jevFingerprint(values));
    return { ok: true, message: `Reached ${values.jevModel}. You can turn scoring on now.`, status: await jevStatus() };
  }

  async function collectDiff(environmentId: string, baseBranch: string) {
    const files = await bb.sdk.environments.diffFiles({ environmentId, target: "all", mergeBaseBranch: baseBranch });
    if (files.outcome !== "available") throw new Error(`Cannot diff against ${baseBranch}: ${diffFailure(files)}`);
    const paths = files.files.map((file) => file.path).filter((path) => !GENERATED_OR_LOCK_PATTERN.test(path));
    if (paths.length === 0) {
      throw new Error(
        files.files.length === 0
          ? `Nothing has changed against ${baseBranch}.`
          : `Only generated or lock files changed against ${baseBranch}.`,
      );
    }
    const patches = await bb.sdk.environments.diffPatch({ environmentId, paths, target: { type: "all", mergeBaseBranch: baseBranch } });
    if (patches.outcome !== "available") throw new Error(`Cannot diff against ${baseBranch}: ${diffFailure(patches)}`);

    const { diff, truncated } = capDiff(patches.patches, JEV_MAX_DIFF_BYTES);
    if (diff.trim() === "") throw new Error(`The diff against ${baseBranch} carries no reviewable text.`);
    return { diff, fileCount: paths.length, truncated };
  }

  function diffFailure(result: { outcome: "not_applicable" | "unavailable"; message?: string; failure?: { message: string } }) {
    return result.outcome === "not_applicable" ? (result.message ?? "not applicable") : (result.failure?.message ?? "unavailable");
  }

  async function scoreChange(reviewer: ManagedRow, baseBranch: string) {
    const status = await jevStatus();
    if (!status.enabled) throw new Error("Jev scoring is off. Turn it on in Chief's settings after a successful connection check.");
    const values = await settings.get();
    if (!values.jevApiKey) throw new Error("Jev scoring has no API key.");
    const workerThreadId = reviewer.worker_thread_id;
    if (!workerThreadId) throw new Error("This reviewer is not attached to a worker.");

    const live = await bb.sdk.threads.get({ threadId: reviewer.thread_id });
    if (!live.environmentId) throw new Error("This review thread has no environment to diff.");
    const { diff, fileCount, truncated } = await collectDiff(live.environmentId, baseBranch);

    const worker = roles.get(workerThreadId);
    const stored = previousScore.get(workerThreadId, baseBranch) as { evaluation: string } | undefined;
    const previous = stored ? evaluationSchema.parse(JSON.parse(stored.evaluation)) : undefined;

    const evaluation = await runEvaluation(
      { apiKey: values.jevApiKey, model: values.jevModel, timeoutMs: JEV_SCORE_TIMEOUT_MS },
      {
        task: worker?.title ?? reviewer.title,
        diff,
        repositoryContext: await readRules(reviewer.project_id),
      },
      previous,
    );

    db.prepare(`INSERT INTO jev_scores (worker_thread_id, base_branch, evaluation, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(worker_thread_id, base_branch) DO UPDATE SET evaluation=excluded.evaluation, updated_at=excluded.updated_at`).run(
      workerThreadId, baseBranch, JSON.stringify(evaluation), Date.now(),
    );
    return formatEvaluation(evaluation, { baseBranch, fileCount, truncated, hadPrevious: previous !== undefined });
  }

  function formatEvaluation(
    evaluation: Evaluation,
    context: { baseBranch: string; fileCount: number; truncated: boolean; hadPrevious: boolean },
  ) {
    const scored = (Object.entries(evaluation.metrics) as [MetricKey, Evaluation["metrics"][MetricKey]][])
      .filter((entry): entry is [MetricKey, { applicable: true; score: number }] => entry[1].applicable && entry[1].score !== undefined)
      .sort((left, right) => left[1].score - right[1].score);
    const lines = [
      `Jev score vs ${context.baseBranch} · ${context.fileCount} file(s)${context.truncated ? " · diff truncated, treat low scores as provisional" : ""}`,
      "",
      ...scored.map(([key, metric]) => `${getMetricDefinition(key).label}: ${metric.score}/10`),
    ];
    if (evaluation.priorities.length) {
      lines.push("", "Weakest dimensions:");
      for (const priority of evaluation.priorities) {
        lines.push(`- ${getMetricDefinition(priority.metric).label} (${priority.severity}): ${priority.reason}`);
      }
    }
    if (context.hadPrevious) {
      lines.push("", `Since the last score against this same base — improved: ${evaluation.improvements?.join(", ") || "none"}; regressed: ${evaluation.regressions?.join(", ") || "none"}.`);
    }
    lines.push(
      "",
      "This is one model's opinion on the diff alone. Confirm or reject each point against the code you read, and say so in your report to Chief.",
    );
    return lines.join("\n");
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
        `${row.role}${row.tier ? ` (${row.tier})` : ""} | ${row.state} | live:${row.status ?? "unknown"} | ${row.title} | ${row.thread_id}`,
        ...(row.branch ? [`branch: ${row.branch}`] : []),
        ...(row.issue_url ? [`issue: ${row.issue_url}`] : []),
        ...(row.pr_url ? [`pr: ${row.pr_url}`] : []),
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

  bb.agents.registerTool({
    name: "chief_score",
    description: "Score this review's change on 19 engineering-quality dimensions. You choose the base branch to compare against.",
    parameters: z.object({
      baseBranch: z.string().trim().min(1).describe("The branch this change will merge into — the PR's base, or main/master."),
    }),
    async execute({ baseBranch }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "reviewer" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("chief_score is available only in an active managed review thread.");
      }
      return scoreChange(caller, baseBranch);
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
    const scoring = row.role === "reviewer" && jevActive;
    return {
      tools: scoring ? ["chief_report", "chief_score"] : ["chief_report"],
      skills: ["chief-worker"],
      instructions: [
        `You are a managed ${row.role} reporting to Chief thread ${row.chief_thread_id}.`,
        ...(scoring ? [JEV_REVIEWER_INSTRUCTIONS] : []),
        "",
        rules,
      ].join("\n"),
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
          junior: readRoleModel(host.id, "junior"),
          senior: readRoleModel(host.id, "senior"),
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
          Promise.all(modelRoleSchema.options.map(async (role) => {
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
          unusable: flagged.filter((role): role is ModelRole => role !== null),
        };
      })),
    }),
    setRoleModel: ({ hostId, role, selection }) => {
      writeRoleModel(hostId, role, selection);
      return { ok: true as const };
    },
    jevStatus: () => jevStatus(),
    jevCheck: () => checkJevConnection(),
  });

  const usage = [
    "Usage:",
    "  bb chief status [--project proj_id] [--json]",
    "  bb chief start [--project proj_id] [--json]",
    "  bb chief create [--project proj_id] [--json]",
    "  bb chief adopt --thread thr_id [--json]",
    "  bb chief delegate --title \"…\" --mission \"…\" [--criteria \"…\"]... [--constraint \"…\"]... [--context \"…\"] [--tier junior|senior] [--branch feature/…] [--issue-url …] [--pr-url …] [--json]",
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
      { name: "delegate", summary: "Start a clearly titled worker in a managed worktree", usage: "bb chief delegate --title \"…\" --mission \"…\" [--tier junior|senior] [--branch feature/…] [--issue-url …] [--pr-url …] [--json]" },
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
          // Adoption rewrites the row in place, so re-adopting a worker would
          // discard the branch and forge links its open PR depends on.
          const registered = roles.get(threadId);
          if (registered && registered.role !== "chief") {
            return fail(`Thread ${threadId} is already a managed ${registered.role} (“${registered.title}”). Adopting it would discard its branch, forge links, and report.`);
          }
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
            tier: args.one("tier"),
            branch: args.one("branch"), issueUrl: args.one("issue-url"), prUrl: args.one("pr-url"),
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
  await jevStatus().catch((error) => bb.log.warn(`Could not read the Jev gate: ${String(error)}`));
  const initial = await settings.get();
  if (initial.chiefProject) {
    void ensureChief(initial.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
  }
  bb.log.info("Chief supervisor loaded");
}
