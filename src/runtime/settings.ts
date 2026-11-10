import { modelSelectionSchema, type ResearchMode, type ResearchSettings } from "../../research";
import { MODEL_FALLBACK, type ModelRole } from "../../roles";
import { type ManagedRow, type ModelSelection } from "../types";
import { clip } from "../../text";
import { BUILT_IN_RULES } from "./prompts";
import type { Ctx } from "./context";

const SECTION_NAME = "Chief";

const RULES_FILE = "chief.md";

const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;

export function createSettingsRuntime(ctx: Ctx) {
  const { activeChiefForProject, anyCooldown, bb, cooldownFor, db, researchModelRow, roleModelRow, settings, store } = ctx;
  async function ensureSection(): Promise<string> {
    if (ctx.state.sectionEnsuring) return ctx.state.sectionEnsuring;
    ctx.state.sectionEnsuring = (async () => {
      const sections = await bb.sdk.threadSections.list();
      let section = sections.find((candidate) => candidate.name === SECTION_NAME);
      if (!section) section = await bb.sdk.threadSections.create({ name: SECTION_NAME });
      db.prepare(`INSERT INTO plugin_meta (key, value) VALUES ('section_id', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(section.id);
      return section.id;
    })();
    try {
      return await ctx.state.sectionEnsuring;
    } finally {
      ctx.state.sectionEnsuring = null;
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
      ctx.state.rulesCache.set(projectId, rules);
      return rules;
    } catch {
      ctx.state.rulesCache.set(projectId, BUILT_IN_RULES);
      return BUILT_IN_RULES;
    }
  }

  async function projectName(projectId: string) {
    try { return (await bb.sdk.projects.get({ projectId })).name; }
    catch { return projectId; }
  }

  function parseSelectionRow(row: unknown): ModelSelection | null {
    const value = row as { provider_id: string; model: string; reasoning_level: string } | undefined;
    if (!value) return null;
    const parsed = modelSelectionSchema.safeParse({
      providerId: value.provider_id,
      model: value.model,
      reasoningLevel: value.reasoning_level,
    });
    return parsed.success ? parsed.data : null;
  }

  function readRoleModel(hostId: string, role: ModelRole): ModelSelection | null {
    return parseSelectionRow(roleModelRow.get(hostId, role));
  }

  function readResearchModel(hostId: string, mode: ResearchMode): ModelSelection | null {
    return parseSelectionRow(researchModelRow.get(hostId, mode));
  }

  function writeResearchModel(hostId: string, mode: ResearchMode, selection: ModelSelection | null) {
    if (!selection) {
      db.prepare(`DELETE FROM research_mode_models WHERE host_id=? AND mode=?`).run(hostId, mode);
      return;
    }
    db.prepare(`INSERT INTO research_mode_models (host_id, mode, provider_id, model, reasoning_level, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, mode) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model,
        reasoning_level=excluded.reasoning_level, updated_at=excluded.updated_at`).run(
      hostId, mode, selection.providerId, selection.model, selection.reasoningLevel, Date.now(),
    );
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
  // Spread into child spawns only; BB cascades archive/delete from the owner.
  async function lifecycleOwner(chiefThreadId: string | null) {
    return chiefThreadId && (await settings.get()).cascadeArchive ? { lifecycleOwnerThreadId: chiefThreadId } : {};
  }

  async function execution(role: ModelRole, hostId: string | null) {
    const fallback = MODEL_FALLBACK[role];
    const selection = hostId === null
      ? null
      // No Designer or Tester row inherits the Worker pick; a stored but unservable one goes to BB default.
      : readRoleModel(hostId, role) ?? (fallback ? readRoleModel(hostId, fallback) : null);
    if (!hostId || !selection) return {};
    return (await usableSelection(hostId, selection)) ?? {};
  }

  /** The project's default execution options, or null; the fake host lacks the method, so a sync throw must be caught too. */
  async function projectDefaults(projectId: string) {
    try {
      const options = await bb.sdk.projects.defaultExecutionOptions({ projectId });
      return options?.providerId ? { providerId: options.providerId, model: options.model ?? "" } : null;
    } catch {
      return null;
    }
  }

  /** execution(), refused while the provider/model it would run on cools down. Fails open when the target is unknown. */
  async function spawnExecution(role: ModelRole, hostId: string | null, projectId: string) {
    const selection = await execution(role, hostId);
    if (!anyCooldown.get(Date.now())) return selection;
    const target = "providerId" in selection ? selection as { providerId: string; model: string } : await projectDefaults(projectId);
    const cooling = target && cooldownError(target.providerId, target.model);
    if (cooling) throw cooling;
    return selection;
  }

  function cooldownError(providerId: string, model: string) {
    if (!model) return null;
    const row = cooldownFor.get(providerId, model, Date.now()) as { until_at: number } | undefined;
    if (!row) return null;
    const minutes = Math.max(1, Math.ceil((row.until_at - Date.now()) / 60_000));
    return new Error(`Provider ${providerId} model ${model} hit its usage limit and is cooling down until ${new Date(row.until_at).toISOString()} (about ${minutes} min). Starting new work on it now would fail the same way. Wait for the reset, retry the failed thread with bb thread retry <id> --send-at ${minutes + 1}m, or pick another model for this role in Chief settings.`);
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

  /** The target project's own local checkout path, or null when unknown. */
  async function projectPath(projectId: string) {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      return source?.path ?? null;
    } catch (error) {
      bb.log.warn(`Could not resolve the checkout path for ${projectId}: ${String(error)}`);
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

  /** The Chief a spawn request belongs to: the calling Chief itself, or the active
   * one for the caller's project. Planning and delegation resolve it the same way. */
  async function owningChief(callerThreadId?: string | null) {
    const caller = callerThreadId ? store.get(callerThreadId) : undefined;
    const projectId = caller?.project_id ?? (await settings.get()).chiefProject;
    if (!projectId) throw new Error("No Chief project is configured.");
    const chief = caller?.role === "chief" ? caller : chiefForProject(projectId);
    if (!chief || chief.state === "complete") throw new Error("Start Chief for this project first.");
    return { chief, projectId };
  }

  /** bb.agents.configure is synchronous and can only read the cached copy, so every
   * read refreshes it. Spawning a planner gates on this live call, never on the cache. */
  async function plannerEnabled() {
    ctx.state.plannerActive = (await settings.get()).plannerEnabled;
    return ctx.state.plannerActive;
  }

  function researchFrom(values: Awaited<ReturnType<typeof settings.get>>): ResearchSettings {
    return {
      enabled: values.researchEnabled,
      maxAgentCalls: values.researchMaxAgentCalls,
      timeoutMinutes: {
        survey: values.researchSurveyTimeoutMinutes,
        investigate: values.researchInvestigateTimeoutMinutes,
      },
    };
  }

  /** A live read that also refreshes the cache. The chief_research gate calls this, never the cache. */
  async function researchSettings() {
    ctx.state.researchActive = researchFrom(await settings.get());
    return ctx.state.researchActive;
  }
  return { catalogReader, chiefForProject, cooldownError, defaultHostId, discover, ensureSection, environmentHostId, execution, hostFallback, lifecycleOwner, owningChief, plannerEnabled, projectHostId, projectName, projectPath, readResearchModel, readRoleModel, readRules, researchFrom, researchSettings, spawnExecution, storedSectionId, usableSelection, writeResearchModel, writeRoleModel };
}

