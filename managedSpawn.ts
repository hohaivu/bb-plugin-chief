import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ModelSelection } from "./research";
import type { ModelRole } from "./roles";

type SpawnInput = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
type Execution = Partial<ModelSelection>;

/** What launch itself reads of a row; the server's insertThread input satisfies it. */
interface InsertBase {
  threadId: string;
  role: string;
  projectId: string;
  chiefThreadId?: string | null;
  parentThreadId?: string | null;
  title: string;
  kind?: string | null;
  planThreadId?: string | null;
  state?: string;
  status?: string | null;
}

interface Prepared {
  execution: Execution;
  sectionId: string;
}

export interface ManagedSpawn<Input extends InsertBase> {
  /** Steps 1-3. `pick` is a role to resolve through spawnExecution, or an execution the caller already resolved (research). */
  prepare(
    projectId: string,
    pick: { role: ModelRole; hostId: string | null } | { execution: Execution },
  ): Promise<Prepared>;
  /**
   * Steps 5-7. Chief owns every managed thread, so the row's chiefThreadId is also the spawn's parent and lifecycle
   * owner, and `role` and a designer's `kind` go into the plugin metadata. `inTransaction` runs in the insert's transaction.
   */
  launch(
    prepared: Prepared,
    spawn: {
      projectId: string; environment: SpawnInput["environment"]; title: string; prompt: string;
      extra?: Pick<SpawnInput, "permissionMode">;
      onSpawnError?: (error: unknown) => Error;
    },
    row: Omit<Input, "threadId" | "projectId" | "parentThreadId" | "title" | "state" | "status">,
    inTransaction?: (threadId: string) => void,
  ): Promise<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["spawn"]>>>;
}

/** One module owns starting a managed thread: model pick (cooldown-checked), Chief section, rules warm-up, spawn,
 * row insert, brief file — in that order. Callers pass only what differs and build their own prompt between prepare and launch. */
export function createManagedSpawn<Input extends InsertBase>(deps: {
  bb: BbPluginApi;
  db: ReturnType<BbPluginApi["storage"]["database"]>;
  spawnExecution: (role: ModelRole, hostId: string | null, projectId: string) => Promise<Execution>;
  ensureSection: () => Promise<string>;
  readRules: (projectId: string) => Promise<unknown>;
  lifecycleOwner: (chiefThreadId: string | null) => Promise<{ lifecycleOwnerThreadId?: string }>;
  insertThread: (input: Input) => void;
  persistBrief: (threadId: string, prompt: string) => Promise<void>;
}): ManagedSpawn<Input> {
  const { bb, db, spawnExecution, ensureSection, readRules, lifecycleOwner, insertThread, persistBrief } = deps;

  async function prepare(projectId: string, pick: { role: ModelRole; hostId: string | null } | { execution: Execution }) {
    const execution = "execution" in pick ? pick.execution : await spawnExecution(pick.role, pick.hostId, projectId);
    const sectionId = await ensureSection();
    // Only to warm rulesCache: bb.agents.configure reads it synchronously and puts
    // the rules into every managed turn, so the spawn prompt does not repeat them.
    await readRules(projectId);
    return { execution, sectionId };
  }

  async function launch(
    prepared: Prepared,
    { projectId, environment, title, prompt, extra, onSpawnError }: Parameters<ManagedSpawn<Input>["launch"]>[1],
    row: Parameters<ManagedSpawn<Input>["launch"]>[2],
    inTransaction?: (threadId: string) => void,
  ) {
    const chiefThreadId = row.chiefThreadId ?? null;
    const spawnThread = async () => bb.sdk.threads.spawn({
      projectId,
      environment,
      sectionId: prepared.sectionId,
      parentThreadId: chiefThreadId ?? undefined,
      visibility: "visible",
      title,
      ...prepared.execution,
      ...extra,
      ...(await lifecycleOwner(chiefThreadId)),
      prompt,
      pluginMetadata: { role: row.role, chiefThreadId, ...(row.kind ? { kind: row.kind } : {}), ...(row.planThreadId ? { planThreadId: row.planThreadId } : {}) },
    });
    let thread: Awaited<ReturnType<typeof spawnThread>>;
    try {
      thread = await spawnThread();
    } catch (error) {
      throw onSpawnError ? onSpawnError(error) : error;
    }
    // The row exists only once the spawn resolved: a failed spawn leaves nothing behind.
    const insert = () => insertThread({
      ...row, threadId: thread.id, projectId, parentThreadId: row.chiefThreadId, title, state: "starting", status: thread.status,
    } as unknown as Input);
    if (inTransaction) db.transaction(() => { insert(); inTransaction(thread.id); })();
    else insert();
    await persistBrief(thread.id, prompt);
    return thread;
  }

  return { prepare, launch };
}
