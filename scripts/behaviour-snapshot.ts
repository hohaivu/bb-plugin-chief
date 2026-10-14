// Behaviour snapshot: runs two builds of the plugin (a base ref and this checkout) against byte-identical copies
// of one data.db and diffs everything they say, byte for byte. A scripted before/after comparison for refactors,
// not a unit test: it is not part of `npm test`, and it never touches server.test.ts.
//
//   node scripts/behaviour-snapshot.ts --base <ref> --db <copy of data.db> [--work <dir>]
//
// Make the copy once. Never point --db at the live file:
//   sqlite3 ~/.bb/plugins/chief/data.db ".backup $BB_THREAD_STORAGE/snap/data.db"
//
// Exit codes: 0 identical; 1 differ (first 200 diff lines printed); 2 a capture category captured nothing;
// 3 the snapshot itself failed. Outputs (base.txt, head.txt, the per-build DB copies) hold real project data:
// they stay under --work (default: next to --db) and are never committed.
//
// Later waves add scenarios by appending `step(...)` calls in `captureScenarios`; the harness stays as it is.
// "Live" below means a row whose state is not complete, archived or deleted.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

const SELF = fileURLToPath(import.meta.url);
const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const sha = (text: string) => createHash("sha1").update(text).digest("hex");


// ---------------------------------------------------------------------------------------------------------------
// Orchestrator: two builds, two DB copies, one diff.
// ---------------------------------------------------------------------------------------------------------------

function orchestrate() {
  const base = arg("--base");
  const dbArg = arg("--db");
  if (!base || !dbArg) die("usage: node scripts/behaviour-snapshot.ts --base <ref> --db <copy of data.db> [--work <dir>]");
  const db = resolve(dbArg!);
  if (!existsSync(db)) die(`--db ${db} does not exist; make it with sqlite3 <live data.db> ".backup <copy>"`);
  const live = join(homedir(), ".bb", "plugins", "chief");
  if (realpathSync(db).startsWith(realpathSync(live))) die(`--db is inside ${live}; the snapshot never touches the live database. Use a .backup copy.`);
  const head = resolve(dirname(SELF), "..");
  const work = resolve(arg("--work") ?? dirname(db));
  mkdirSync(work, { recursive: true });
  const baseDir = join(work, "base-worktree");

  const run = (cmd: string, args: string[], cwd: string) => {
    const result = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
    if (result.status !== 0) die(`${cmd} ${args.join(" ")} (in ${cwd}) failed:\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  };

  const sha1 = run("git", ["rev-parse", base!], head);
  spawnSync("git", ["worktree", "remove", "--force", baseDir], { cwd: head });
  rmSync(baseDir, { recursive: true, force: true });
  run("git", ["worktree", "prune"], head);
  run("git", ["worktree", "add", "--detach", baseDir, sha1], head);
  try {
    symlinkSync(join(head, "node_modules"), join(baseDir, "node_modules"));
    const builds = [{ name: "base", dir: baseDir }, { name: "head", dir: head }].map((build) => {
      run("bb", ["plugin", "build"], build.dir);
      const dist = join(build.dir, "dist", "server.js");
      if (!existsSync(dist)) die(`${build.name} build emitted no dist/server.js`);
      const copy = join(work, `${build.name}.db`);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(copy + suffix, { force: true });
      copyFileSync(db, copy);
      const out = join(work, `${build.name}.txt`);
      const child = spawnSync(process.execPath, [SELF, "--capture", dist, "--db", copy, "--out", out], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] });
      process.stdout.write(`== ${build.name} (${build.name === "base" ? sha1.slice(0, 9) : "working tree"})\n${child.stdout}`);
      return { out, status: child.status };
    });
    const failed = builds.find((build) => build.status !== 0);
    if (failed) process.exit(failed.status === 2 ? 2 : 3);
    const [before, after] = builds.map((build) => readFileSync(build.out));
    if (before.equals(after)) {
      console.log(`identical: ${before.length} bytes, base.txt == head.txt`);
      process.exit(0);
    }
    const diff = spawnSync("diff", ["-u", builds[0].out, builds[1].out], { encoding: "utf8", maxBuffer: 1 << 28 });
    console.log(diff.stdout.split("\n").slice(0, 200).join("\n"));
    console.log(`DIFFERENT: see ${builds[0].out} and ${builds[1].out}`);
    process.exit(1);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", baseDir], { cwd: head });
  }
}

function die(message: string): never {
  console.error(message);
  process.exit(3);
}

// ---------------------------------------------------------------------------------------------------------------
// Capture: load one build on a fake host over one DB copy and write everything it says to one text file.
// ---------------------------------------------------------------------------------------------------------------

const TERMINAL = ["complete", "archived", "deleted"];
const HOST = "host_snap";
const FILES_ROOT = "/snap-files";
const ROLES = ["chief", "planner", "worker", "reviewer", "advisor", "researcher"];

/** Sorted-key JSON, so object key order never shows up as a difference. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item);
}

async function capture(distPath: string, dbPath: string, outPath: string) {
  const buildDir = dirname(dirname(distPath));
  const database = new Database(dbPath);
  database.pragma("busy_timeout = 5000");

  // Pinned clock. It moves only when a short sleep "elapses" (timers of 10 s or more never fire), so a polling
  // loop ends the same way in both builds and no wall-clock reading reaches the output.
  const RealDate = Date;
  let clock = (database.prepare("SELECT MAX(updated_at) AS m FROM managed_threads").get() as { m: number | null }).m ?? 0;
  clock += 3_600_000;
  class SnapDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock);
      else super(...(args as [number]));
    }
    static now() { return clock; }
  }
  globalThis.Date = SnapDate as unknown as DateConstructor;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms = 0, ...rest: unknown[]) => {
    if (Number(ms) >= 10_000) return realSetTimeout(fn, ms, ...rest).unref();
    return setImmediate(() => { clock += Number(ms) || 0; fn(...rest); });
  }) as unknown as typeof setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = ((handle: any) => {
    if (handle?.constructor?.name === "Immediate") clearImmediate(handle);
    else realClearTimeout(handle);
  }) as typeof clearTimeout;

  // git, gh and glab never run. `gh pr view` answers prHead with the row's reviewed_head_sha (no pr_url: it fails).
  const cp = createRequire(import.meta.url)("node:child_process");
  const customPromisify = Symbol.for("nodejs.util.promisify.custom");
  const execStub: any = () => { throw new Error("execFile must be invoked through promisify"); };
  execStub[customPromisify] = async (cmd: string, args: string[] = []) => {
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      const target = String(args[2]);
      const row = database.prepare(`SELECT branch, reviewed_head_sha FROM managed_threads WHERE pr_url LIKE ? ORDER BY thread_id LIMIT 1`).get(`%/pull/${target.replace(/^.*\//, "")}`) as { branch: string | null; reviewed_head_sha: string | null } | undefined;
      if (!row?.reviewed_head_sha) throw new Error("snapshot: no such pull request");
      return { stdout: JSON.stringify({ headRefName: row.branch ?? "feature/x", headRefOid: row.reviewed_head_sha, baseRefName: "main" }), stderr: "" };
    }
    throw new Error(`snapshot: ${cmd} is stubbed`);
  };
  cp.execFile = execStub;
  syncBuiltinESMExports();

  // ----- fixtures: the copy has no live designer, planner with a design wave, or active child of each role.
  const notes: string[] = [];
  const chief = database.prepare(`SELECT thread_id, project_id FROM managed_threads WHERE role='chief' AND chief_thread_id IS NULL AND state='idle' ORDER BY thread_id LIMIT 1`).get() as { thread_id: string; project_id: string } | undefined;
  if (chief) {
    const at = clock - 100_000;
    const insert = (row: Record<string, unknown>, offset: number) => {
      const full = { project_id: chief.project_id, chief_thread_id: chief.thread_id, parent_thread_id: chief.thread_id, status: "idle", created_at: at + offset, updated_at: at + offset, ...row };
      const keys = Object.keys(full);
      database.prepare(`INSERT INTO managed_threads (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(full));
    };
    const waves = [
      { path: `${FILES_ROOT}/thr_fx_planner/plan-1.md`, contracts: "Fixture design contract", dependsOn: [], design: true },
      { path: `${FILES_ROOT}/thr_fx_planner/plan-2.md`, contracts: "Fixture build contract", dependsOn: [1] },
    ];
    insert({ thread_id: "thr_fx_planner", role: "planner", title: "Fixture planner", state: "ready", result: "Fixture plan", summary: "Fixture plan summary", plan_waves: JSON.stringify(waves), report_seq: 1, last_report_state: "ready", brief: "Fixture planner brief" }, 1);
    insert({ thread_id: "thr_fx_designer", role: "worker", kind: "designer", title: "Fixture designer", state: "ready", branch: "feature/fx-designer", pr_url: "https://github.com/o/r/pull/9001", plan_thread_id: "thr_fx_planner", plan_wave: 1, result: "Fixture designer result", summary: "Fixture designer summary", report_seq: 1, last_report_state: "ready", brief: "Fixture designer brief" }, 2);
    insert({ thread_id: "thr_fx_plain", role: "worker", title: "Fixture plain worker", state: "ready", branch: "feature/fx-plain", pr_url: "https://github.com/o/r/pull/9002", reviewed_head_sha: "a".repeat(40), result: "Fixture result", summary: "Fixture summary", report_seq: 1, last_report_state: "ready", brief: "Fixture worker brief" }, 3);
    // The reject-ladder fixtures: a plan of two independent branches (one review covers both) and its two ready workers, each with a pull request head.
    insert({ thread_id: "thr_fx_lad_planner", role: "planner", title: "Fixture ladder planner", state: "ready", result: "Fixture ladder plan", summary: "Fixture ladder plan summary", plan_waves: JSON.stringify([
      { path: `${FILES_ROOT}/thr_fx_lad_planner/plan-1.md`, contracts: "Fixture ladder contract 1", dependsOn: [] },
      { path: `${FILES_ROOT}/thr_fx_lad_planner/plan-2.md`, contracts: "Fixture ladder contract 2", dependsOn: [] },
    ]), report_seq: 1, last_report_state: "ready", brief: "Fixture ladder planner brief" }, 40);
    for (const [index, id] of ["a", "b"].entries()) {
      insert({ thread_id: `thr_fx_lad_${id}`, role: "worker", title: `Fixture ladder worker ${id}`, state: "ready", branch: `feature/fx-lad-${id}`, pr_url: `https://github.com/o/r/pull/${9003 + index}`, reviewed_head_sha: String(index + 1).repeat(40),
        plan_thread_id: "thr_fx_lad_planner", plan_wave: index + 1, result: "Fixture result", summary: "Fixture summary", report_seq: 1, last_report_state: "ready", brief: `Fixture ladder worker ${id} brief` }, 41 + index);
    }
    ROLES.filter((role) => role !== "chief").forEach((role, index) => insert({
      thread_id: `thr_fx_${role}_active`, role, title: `Fixture active ${role}`, state: "active", status: "active", active_since: clock - 5_000, active_cycle: 1,
      brief: `Fixture ${role} brief`, branch: role === "worker" ? "feature/fx-active" : null,
      worker_thread_id: role === "reviewer" || role === "advisor" ? "thr_fx_designer" : null,
    }, 10 + index));
    database.prepare(`INSERT OR REPLACE INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq, head_sha, pr_url, branch) VALUES ('thr_fx_reviewer_active', 'thr_fx_designer', 1, ?, 'https://github.com/o/r/pull/9001', 'feature/fx-designer')`).run("b".repeat(40));
    // A Designer with no pick of its own inherits the Worker's: only these four roles have one.
    for (const [role, model] of [["worker", "gpt-6-astra"], ["planner", "gpt-6-mini"], ["reviewer", "gpt-6-astra"], ["advisor", "gpt-6-mini"]]) {
      database.prepare(`INSERT OR REPLACE INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at) VALUES (?, ?, 'codex', ?, 'medium', ?)`).run(HOST, role, model, at);
    }
  } else {
    notes.push("NOTE: no idle Chief row in the copy; fixtures skipped");
  }

  // ----- fake host
  const events: string[] = [];
  const liveThreads = new Map<string, any>();
  const overrides = new Map<string, any>();
  const files = new Map<string, string>();
  const tabs = new Map<string, { revision: number; tabs: any[] }>();
  let spawnIndex = 0;
  let section: any = null;
  const thread = (overrides: object) => makeThreadResponse(overrides as never);
  const storedThread = (threadId: string) => {
    const row = database.prepare(`SELECT project_id, title, status, state FROM managed_threads WHERE thread_id=?`).get(threadId) as { project_id: string; title: string; status: string; state: string } | undefined;
    if (!row) return undefined;
    return thread({ id: threadId, projectId: row.project_id, environmentId: `env_${threadId}`, title: row.title, sectionId: "sec_snap", visibility: "visible", status: row.status, originPluginId: "chief",
      // Mirror the row, so the supervisor's load-time reconcile finds nothing to change (it would un-archive rows, one reload each).
      archivedAt: row.state === "archived" ? 1 : null, deletedAt: row.state === "deleted" ? 1 : null, ...overrides.get(threadId) });
  };
  const catalogModel = (model: string, isDefault = false) => ({
    id: model, model, displayName: model, description: "", isDefault, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: "" })),
  });
  const skillIds = existsSync(join(buildDir, "skills")) ? readdirSync(join(buildDir, "skills")).sort() : [];
  const { bb: fake, harness } = createFakePluginHost({
    pluginId: "chief",
    agentSkillIds: skillIds,
    sdk: {
      system: { usageLimits: async () => ({}) },
      threadSections: {
        list: async () => (section ? [section] : []),
        create: async ({ name }: { name: string }) => (section = { id: "sec_snap", name, createdAt: 1, updatedAt: 1 }),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({ id: projectId, name: `Project ${projectId}`, kind: "standard", sources: [{ path: `/snap/project/${projectId}`, hostId: HOST, isDefault: true }] }),
        fileContent: async () => { throw new Error("missing"); },
        defaultExecutionOptions: async () => null,
      },
      hosts: {
        list: async () => [{ id: HOST, name: "Snap", status: "connected" }],
        get: async ({ hostId }: { hostId: string }) => ({ id: hostId, name: "Snap", status: "connected", threadStorageRootPath: FILES_ROOT }),
      },
      files: {
        write: async ({ path, content }: { path: string; content: string }) => { files.set(path, content); return {}; },
        move: async ({ sourcePath, destinationPath }: { sourcePath: string; destinationPath: string }) => {
          files.set(destinationPath, files.get(sourcePath) ?? "");
          files.delete(sourcePath);
          return {};
        },
        remove: async ({ path }: { path: string }) => { files.delete(path); return {}; },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: HOST, workspaceProvisionType: "managed-worktree" }),
        status: async ({ mergeBaseBranch }: { mergeBaseBranch?: string }) => ({
          outcome: "available",
          workspace: {
            workingTree: { hasUncommittedChanges: false, files: [] },
            checkout: { kind: "branch", branchName: "feature/x" },
            mergeBase: mergeBaseBranch ? { baseRef: "abc", aheadCount: 0, behindCount: 0 } : null,
          },
        }),
        archiveThreads: async () => ({ ok: true, archivedThreadIds: [] }),
        diffFiles: async () => ({ outcome: "available", files: [{ path: "totals.ts" }] }),
        diffPatch: async () => ({ outcome: "available", patches: [{ patch: "diff --git a/totals.ts b/totals.ts\n+const total = subtotal - discount;", truncated: false }] }),
      },
      providers: {
        list: async () => [{ id: "codex", displayName: "Codex", available: true, capabilities: { permissionModes: ["accept-edits", "auto", "full"] } }],
        models: async () => ({ modelLoadError: null, providers: [], selectedOnlyModels: [], models: [catalogModel("gpt-6-astra", true), catalogModel("gpt-6-mini")] }),
      },
      threads: {
        events: { list: async () => [] },
        defaultExecutionOptions: async () => ({ permissionMode: "auto" }),
        spawn: async (args: any) => {
          spawnIndex += 1;
          const id = `thr_snap_${spawnIndex}`;
          events.push(`spawn ${id} ${stable(args)}`);
          const spawned = thread({
            id, projectId: args.projectId, title: args.title, sectionId: args.sectionId, visibility: args.visibility, status: "idle",
            environmentId: args.environment.type === "reuse" ? args.environment.environmentId : `env_snap_${spawnIndex}`,
            originPluginId: args.pluginMetadata ? "chief" : null, parentThreadId: args.parentThreadId ?? null,
          });
          liveThreads.set(id, spawned);
          return spawned;
        },
        list: async () => [],
        archive: async ({ threadId }: { threadId: string }) => { events.push(`archive ${threadId}`); return { ok: true }; },
        getPluginMetadata: async () => ({}),
        storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: "host_storage", storageRootPath: `${FILES_ROOT}/${threadId}` }),
        get: async ({ threadId }: { threadId: string }) => {
          const found = liveThreads.get(threadId) ?? storedThread(threadId);
          if (!found) throw new Error("not found");
          return { ...found, ...overrides.get(threadId) };
        },
        update: async ({ threadId, ...changes }: any) => {
          events.push(`update ${threadId} ${stable(changes)}`);
          overrides.set(threadId, { ...overrides.get(threadId), ...changes });
          const found = liveThreads.get(threadId) ?? storedThread(threadId);
          if (!found) throw new Error("not found");
          return { ...found, ...overrides.get(threadId) };
        },
        send: async (args: any) => { events.push(`send ${stable(args)}`); return { ok: true, delivery: "sent" as const }; },
        output: async ({ threadId }: { threadId: string }) => ({ output: `last output from ${threadId}` }),
        tabs: {
          get: async ({ threadId }: { threadId: string }) => tabs.get(threadId) ?? { revision: 0, tabs: [] },
          update: async ({ threadId, expectedRevision, tabs: next }: any) => {
            events.push(`tabs ${threadId} ${stable(next)}`);
            const current = tabs.get(threadId) ?? { revision: 0, tabs: [] };
            if (current.revision !== expectedRevision) throw new Error("revision conflict");
            const updated = { revision: current.revision + 1, tabs: next };
            tabs.set(threadId, updated);
            return updated;
          },
        },
        queuedMessages: { list: async () => [] },
        stop: async ({ threadId }: { threadId: string }) => {
          events.push(`stop ${threadId}`);
          overrides.set(threadId, { ...overrides.get(threadId), status: "idle" });
          return { ok: true as const };
        },
      },
    },
  } as never);
  // The plugin writes to the copy, not to the fake host's own temp database. Its migrations still run (and are verified) on it.
  const bb: any = Object.create(fake, { storage: { value: { ...fake.storage, database: () => database } } });

  const mod: any = await import(pathToFileURL(distPath).href);
  process.stderr.write("  plugin loading\n");
  await mod.default(bb);
  process.stderr.write("  plugin loaded\n");

  // ----- output plumbing
  const lines: string[] = [];
  const counts = new Map<string, number>();
  let category = "";
  let logged = 0;
  let stepCount = 0;
  const started = performance.now();
  const begin = (name: string) => { category = name; counts.set(name, counts.get(name) ?? 0); lines.push(`\n######## ${name}`); process.stderr.write(`  ${name}\n`); };
  const show = (value: unknown) => (typeof value === "string" ? value : stable(value) ?? String(value));
  async function step(label: string, fn: () => unknown) {
    events.length = 0;
    let outcome: string;
    try { outcome = `OK ${show(await fn())}`; }
    catch (error) { outcome = `ERR ${error instanceof Error ? error.message : String(error)}`; }
    lines.push(`## ${label}`, outcome);
    for (const event of events) lines.push(`  < ${event}`);
    for (const entry of harness.logEntries.slice(logged)) lines.push(`  ! log.${entry.level} ${entry.message}`);
    logged = harness.logEntries.length;
    counts.set(category, (counts.get(category) ?? 0) + 1);
    if (++stepCount % 250 === 0) process.stderr.write(`  ... ${stepCount} steps (${category}) ${((performance.now() - started) / 1000).toFixed(0)}s\n`);
  }
  const rows = () => database.prepare(`SELECT * FROM managed_threads ORDER BY thread_id`).all() as any[];
  const isLive = (row: any) => !TERMINAL.includes(row.state);
  const cli = (argv: string[], ctx?: object) => harness.behavior.runCli(argv, ctx as never);
  const tool = (name: string, input: unknown, threadId: string, projectId: string) => harness.behavior.callAgentTool(name, input, { threadId, projectId });
  const rpc = (method: string, input: unknown) => harness.behavior.callRpc(method, input);
  const configure = async (threadId: string, projectId: string, metadata?: object, pluginId = "chief") => {
    const resolved = await harness.behavior.resolveAgentConfiguration({
      thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: projectId, kind: "standard", name: `Project ${projectId}`, gitRemoteUrl: null },
      environment: { id: "env_1", name: "worktree", path: "/tmp/worktree", workspaceProvisionType: "managed-worktree", branchName: "chief/test" },
      host: { id: HOST, name: "Snap" },
      provider: { id: "codex", model: "model", capabilities: { supportsNativeUserQuestion: false } },
      origin: { kind: null, pluginId },
      ...(metadata ? { pluginMetadata: metadata } : {}),
    } as never);
    return resolved;
  };

  await captureScenarios();

  async function captureScenarios() {
    const all = rows();
    const chiefs = all.filter((row) => row.role === "chief");
    const live = all.filter(isLive);
    for (const role of ROLES) {
      const present = live.filter((row) => row.role === role).length;
      lines.push(`# live ${role} rows in the copy: ${present}`);
      if (!present) notes.push(`NOTE: no live ${role} rows in the copy`);
    }
    if (!all.some((row) => row.kind === "designer")) notes.push("NOTE: no designer rows in the copy");

    // a. migrations and registrations
    begin("a-migrations-and-registrations");
    await step("MIGRATIONS", () => `${mod.MIGRATIONS.length} entries\n${mod.MIGRATIONS.map((entry: string, index: number) => `[${index}] ${sha(entry)} ${JSON.stringify(entry)}`).join("\n")}`);
    await step("RESEARCH_SCRIPTS", () => stable(mod.RESEARCH_SCRIPTS));
    await step("registered tools", () => harness.registrations.agentTools.map((record: any) => `${record.name}\n${record.description}\n${record.instructions}\n${stable(record.inputSchema)}`).join("\n---\n"));
    await step("cli", () => stable({ cli: harness.registrations.cli?.name, rpc: harness.registrations.rpcMethods }));
    await step("cli help", async () => cli(["help"]));
    await step("rpc contract schemas", () => Object.entries(mod.rpcContract ?? {}).map(([method, spec]: [string, any]) => {
      const schema = (item: any) => { try { return stable(z.toJSONSchema(item)); } catch (error) { return `unavailable: ${error}`; } };
      return `${method}\n in ${schema(spec.input)}\n out ${schema(spec.output)}`;
    }).join("\n"));
    await step("rpc modelConfiguration", () => rpc("modelConfiguration", null));
    await step("rpc researchConfiguration", () => rpc("researchConfiguration", null));

    // b. per Chief reads
    begin("b-chief-reads");
    await step("rpc status", async () => ((await rpc("status", null)) as any).threads.map(stable).join("\n"));
    for (const row of chiefs) {
      const context = { threadId: row.thread_id, projectId: row.project_id };
      for (const [label, input] of [["", {}], [" includeComplete", { includeComplete: true }], [" includeWaiting", { includeWaiting: true }]] as const) {
        await step(`chief_roster${label} as ${row.thread_id}`, () => tool("chief_roster", input, row.thread_id, row.project_id));
      }
      for (const command of ["status", "stats"]) {
        for (const json of [[], ["--json"]]) {
          await step(`bb chief ${command} ${json.join(" ")} as ${row.thread_id}`, () => cli([command, ...json], context));
          await step(`bb chief ${command} ${json.join(" ")} operator ${row.project_id}`, () => cli([command, "--project", row.project_id, ...json], { projectId: row.project_id }));
        }
      }
      await step(`rpc pending ${row.thread_id}`, () => rpc("pending", { threadId: row.thread_id }));
    }
    for (const row of all) await step(`rpc role ${row.thread_id}`, () => rpc("role", { threadId: row.thread_id }));

    // c. inspect
    begin("c-inspect");
    for (const row of all) await step(`bb chief inspect ${row.thread_id}`, () => cli(["inspect", row.thread_id], { projectId: row.project_id }));

    // d. configure(): every row, then seeded metadata with no row
    begin("d-configure");
    const instructionsSeen = new Map<string, string>();
    const describeConfig = (resolved: any) => {
      const instructions = resolved.instructions ?? "";
      if (!instructionsSeen.has(sha(instructions))) instructionsSeen.set(sha(instructions), instructions);
      return `tools=${stable(resolved.tools.map((record: any) => record.name))} skills=${stable(resolved.skills)} instructions=${sha(instructions)} (${instructions.length} chars)`;
    };
    for (const row of all) await step(`configure row ${row.thread_id} ${row.role}/${row.kind ?? "-"}/${row.state}`, async () => describeConfig(await configure(row.thread_id, row.project_id)));
    const projectId = chief?.project_id ?? "proj_snap";
    for (const role of ROLES) {
      await step(`configure seeded ${role}`, async () => describeConfig(await configure(`thr_cfg_${role}`, projectId, { role, chiefThreadId: "thr_cfg_chief" })));
    }
    for (const kind of ["designer", "worker"]) {
      await step(`configure seeded worker kind ${kind}`, async () => describeConfig(await configure(`thr_cfg_${kind}`, projectId, { role: "worker", chiefThreadId: "thr_cfg_chief", kind })));
    }
    await step("configure seeded reviewer kind designer", async () => describeConfig(await configure("thr_cfg_rk", projectId, { role: "reviewer", chiefThreadId: "thr_cfg_chief", kind: "designer" })));
    await step("configure seeded designer, foreign plugin", async () => describeConfig(await configure("thr_cfg_foreign", projectId, { role: "worker", kind: "designer" }, "other-plugin")));
    await step("configure seeded invalid role", async () => describeConfig(await configure("thr_cfg_bad", projectId, { role: "bogus" })));
    await step("configure no row, no metadata", async () => describeConfig(await configure("thr_cfg_none", projectId)));
    for (const [hash, text] of instructionsSeen) lines.push(`## instructions ${hash}`, text);

    // e. mutations, in sequence on the one copy
    begin("e-mutations");
    // e1. chief_continue on every row (the read-only reminders ride on the live fixtures)
    for (const row of all) {
      await step(`chief_continue ${row.thread_id} ${row.role}/${row.state}`, () => tool("chief_continue", { threadId: row.thread_id, instruction: "Snapshot nudge" }, row.chief_thread_id ?? row.thread_id, row.project_id));
    }
    // e1b. the reject ladder, driven only through tools: a single branch (the plain fixture with its pull request),
    // then a plan review that covers two branches. Round 1 is fixed freely, round 2 needs a consult, round 3 needs
    // the user, and only an approve ends it. Every step records its text, alerts, and the three tables.
    begin("e1b-reject-ladder");
    const one = (sql: string, ...bind: unknown[]) => database.prepare(sql).get(...bind) as any;
    // Only this scenario's rows: the fixture workers, and every thread the ladder spawned (the copy's own rows are in section f).
    const spawnedBefore = spawnIndex;
    const mine = (column: string) => `(${column} LIKE 'thr_fx_lad_%' OR ${column}='thr_fx_plain' OR (${column} LIKE 'thr_snap_%' AND CAST(substr(${column}, 10) AS INTEGER) > ${spawnedBefore}))`;
    const tables = () => [["managed_threads", "thread_id", "thread_id"], ["reviewer_verdicts", "reviewer_thread_id", "id"], ["review_targets", "reviewer_thread_id", "reviewer_thread_id, worker_thread_id"]]
      .map(([table, column, order]) => `${table}\n${(database.prepare(`SELECT * FROM ${table} WHERE ${mine(column!)} ORDER BY ${order}`).all() as object[]).map(stable).join("\n")}`).join("\n");
    // Like step, but the three tables follow the outcome, a refusal included.
    const ladderStep = (label: string, fn: () => unknown) => step(label, async () => {
      let outcome: string;
      try { outcome = show(await fn()); } catch (error) { outcome = `ERR ${error instanceof Error ? error.message : String(error)}`; }
      return `${outcome}\n${tables()}`;
    });
    const reviewerOf = (workerId: string) => one(`SELECT r.thread_id FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id=? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`, workerId)?.thread_id as string | undefined;
    const successorOf = (workerId: string) => one(`SELECT thread_id FROM managed_threads WHERE role='worker' AND replaces_thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`, workerId)?.thread_id as string | undefined;
    const advisorOf = (workerId: string) => one(`SELECT thread_id FROM managed_threads WHERE role='advisor' AND worker_thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`, workerId)?.thread_id as string | undefined;
    const ladderReport = (id: string | undefined, params: unknown, project: string) => (id ? tool("chief_report", params, id, project) : "no such thread");
    const ladder = async (name: string, firstWorker: string, extraBranchWorker?: string) => {
      const start = one(`SELECT chief_thread_id, project_id FROM managed_threads WHERE thread_id=?`, firstWorker);
      if (!start) { await step(`ladder ${name}: no ${firstWorker} in the copy`, () => "skipped"); return; }
      const owner = start.chief_thread_id as string;
      const project = start.project_id as string;
      const verdict = (kind: string) => ({ state: "ready", verdict: kind, summary: `Snapshot ladder ${kind}`, result: `Snapshot ladder review: ${kind}.` });
      const replace = (id: string, extra: object = {}) => tool("chief_delegate", { title: "Snapshot ladder successor", mission: "Snapshot ladder mission", replaces: id, ...extra }, owner, project);
      // One review round: chief_review on the tip, then the reviewer's verdict.
      const round = async (tag: string, tip: string, kind: string) => {
        await ladderStep(`ladder ${name} ${tag} chief_review ${tip}`, () => tool("chief_review", { workerThreadId: tip }, owner, project));
        await ladderStep(`ladder ${name} ${tag} reviewer ${kind}`, () => ladderReport(reviewerOf(tip), verdict(kind), project));
      };
      // The workers send their ready reports once a successor exists, so the next review may start.
      const ready = async (tag: string, ...ids: (string | undefined)[]) => {
        for (const id of ids.filter(Boolean)) await ladderStep(`ladder ${name} ${tag} worker ready ${id}`, () => ladderReport(id, { state: "ready", summary: "Snapshot ladder worker summary", result: "Changed server.ts:1.\n\n## Deviations from plan\nNone\n\n## Verification\nAutomated: npm test; echo=0\nManual: none" }, project));
      };
      let tip = firstWorker;
      let other = extraBranchWorker;
      await round("round 1", tip, "request_changes");
      await ladderStep(`ladder ${name} round 1 replaces ${tip}`, () => replace(tip));
      tip = successorOf(tip) ?? tip;
      await ready("round 1", tip);
      await round("round 2", tip, "request_changes");
      await ladderStep(`ladder ${name} round 2 replaces ${tip} refused for consult`, () => replace(tip));
      await ladderStep(`ladder ${name} chief_consult ${tip}`, () => tool("chief_consult", { title: "Snapshot ladder consult", mission: "Snapshot ladder question", workerThreadId: tip }, owner, project));
      await ladderStep(`ladder ${name} advisor ready`, () => ladderReport(advisorOf(tip), { state: "ready", summary: "Snapshot ladder advice", result: "Snapshot ladder advice result" }, project));
      await ladderStep(`ladder ${name} round 2 replaces ${tip} after the consult`, () => replace(tip));
      if (other) {
        // One consult on the anchor worker unlocks every branch of the review.
        await ladderStep(`ladder ${name} round 2 replaces ${other} on the anchor's consult`, () => replace(other!));
        other = successorOf(other) ?? other;
      }
      tip = successorOf(tip) ?? tip;
      await ready("round 2", tip, other);
      await round("round 3", tip, "request_changes");
      await ladderStep(`ladder ${name} round 3 replaces ${tip} refused for stop`, () => replace(tip));
      if (other) await ladderStep(`ladder ${name} round 3 replaces ${other} refused for stop`, () => replace(other!));
      await ladderStep(`ladder ${name} round 3 replaces ${tip} userApprovedRound`, () => replace(tip, { userApprovedRound: true }));
      if (other) {
        await ladderStep(`ladder ${name} round 3 replaces ${other} userApprovedRound`, () => replace(other!, { userApprovedRound: true }));
      }
      const last = [successorOf(tip) ?? tip, ...(other ? [successorOf(other) ?? other] : [])];
      await ready("round 3", ...last);
      await round("final", last[0]!, "approve");
      for (const id of last) await ladderStep(`ladder ${name} chief_complete ${id}`, () => tool("chief_complete", { threadId: id }, owner, project));
    };
    await ladder("single", "thr_fx_plain");
    await ladder("two-branch", "thr_fx_lad_a", "thr_fx_lad_b");
    begin("e-mutations (continued)");

    // e2. every live worker: review, both replaces: calls, complete
    for (const row of rows().filter((item) => isLive(item) && item.role === "worker")) {
      const owner = row.chief_thread_id;
      const successor = { title: "Snapshot successor", mission: "Snapshot mission", replaces: row.thread_id };
      await step(`chief_review ${row.thread_id}`, () => tool("chief_review", { workerThreadId: row.thread_id }, owner, row.project_id));
      await step(`chief_delegate replaces ${row.thread_id}`, () => tool("chief_delegate", successor, owner, row.project_id));
      await step(`chief_delegate replaces ${row.thread_id} userApprovedRound`, () => tool("chief_delegate", { ...successor, userApprovedRound: true }, owner, row.project_id));
      await step(`chief_complete ${row.thread_id}`, () => tool("chief_complete", { threadId: row.thread_id }, owner, row.project_id));
    }
    // e3. every live planner: forge pre-flight and delegate per wave, plus one wave out of range
    for (const row of rows().filter((item) => isLive(item) && item.role === "planner")) {
      const owner = row.chief_thread_id;
      const waveCount = row.plan_waves ? (JSON.parse(row.plan_waves) as unknown[]).length : 0;
      for (let wave = 1; wave <= waveCount + 1; wave += 1) {
        const params = { title: `Snapshot wave ${wave}`, planThreadId: row.thread_id, wave };
        await step(`chief_forge_init ${row.thread_id} wave ${wave}`, () => tool("chief_forge_init", params, owner, row.project_id));
        await step(`chief_delegate ${row.thread_id} wave ${wave}`, () => tool("chief_delegate", { ...params, mission: "Snapshot mission" }, owner, row.project_id));
      }
    }
    // e4. canned chief_report per role, as each live row
    const contract = (n: number, extra = "") => `# Wave ${n}\nDo the work.\n\n## Contracts to verify\n- Wave ${n} keeps its invariant${extra}`;
    const notDoing = "\n\n## What we're NOT doing\n- Nothing else";
    const workerReport = (deviations: boolean) => ({
      state: "ready", summary: "Snapshot worker summary",
      result: `Changed server.ts:1.\n\n${deviations ? "## Deviations from plan\nNone\n\n" : ""}## Verification\nAutomated: npm test; echo=0\nManual: none`,
    });
    const reports: Record<string, [string, unknown][]> = {
      reviewer: [
        ["approve", { state: "ready", verdict: "approve", summary: "Snapshot approve", result: "Snapshot review: nothing blocks the merge." }],
        ["request_changes", { state: "ready", verdict: "request_changes", summary: "Snapshot reject", result: "Snapshot review: server.ts:1 is wrong." }],
        ["request_changes regression", { state: "ready", verdict: "request_changes", regression: true, summary: "Snapshot regression", result: "Snapshot review: server.ts:1 regressed." }],
      ],
      planner: [
        ["valid plan array", { state: "ready", summary: "Snapshot plan", result: "Snapshot plan result", plan: [{ body: contract(1) + notDoing }, { body: contract(2), dependsOn: [1] }] }],
        ["bad dependsOn", { state: "ready", summary: "Snapshot plan", result: "Snapshot plan result", plan: [{ body: contract(1) + notDoing, dependsOn: [2] }, { body: contract(2) }] }],
        ["missing NOT-doing heading", { state: "ready", summary: "Snapshot plan", result: "Snapshot plan result", plan: [{ body: contract(1) }, { body: contract(2) }] }],
      ],
      worker: [["ready with deviations", workerReport(true)], ["ready without deviations", workerReport(false)]],
      advisor: [["ready with lesson", { state: "ready", summary: "Snapshot advice", result: "Snapshot advice result", lesson: "Snapshot lesson: pin the clock in time tests." }]],
    };
    for (const row of rows().filter((item) => isLive(item) && item.role !== "chief")) {
      for (const [label, params] of [...(reports[row.role] ?? []), ["blocked without recommendation", { state: "blocked", blocker: "Snapshot blocker" }] as [string, unknown]]) {
        await step(`chief_report ${row.thread_id} ${row.role} ${label}`, () => tool("chief_report", params, row.thread_id, row.project_id));
      }
    }
    // e5. design-wave workers (live or just delegated): report ready, then the owner's approval
    const designWorkers = rows().filter((row) => {
      if (row.role !== "worker" || !row.plan_thread_id || row.plan_wave == null) return false;
      const planner = database.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(row.plan_thread_id) as { plan_waves: string | null } | undefined;
      return !!planner?.plan_waves && (JSON.parse(planner.plan_waves) as { design?: boolean }[])[row.plan_wave - 1]?.design === true;
    });
    for (const row of designWorkers.filter(isLive)) {
      await step(`chief_report ${row.thread_id} design worker ready`, () => tool("chief_report", workerReport(true), row.thread_id, row.project_id));
      await step(`chief_review ${row.thread_id} design worker`, () => tool("chief_review", { workerThreadId: row.thread_id }, row.chief_thread_id, row.project_id));
      await step(`chief_owner_approval ${row.thread_id}`, () => tool("chief_owner_approval", { workerThreadId: row.thread_id, approval: "Snapshot: approved, ship it" }, row.chief_thread_id, row.project_id));
    }
    // e6. per-machine model picks, then the settings view again
    for (const role of ["chief", "planner", "worker", "designer", "reviewer", "advisor"]) {
      await step(`rpc setRoleModel ${role}`, () => rpc("setRoleModel", { hostId: HOST, role, selection: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "high" } }));
    }
    await step("rpc modelConfiguration after picks", () => rpc("modelConfiguration", null));
    await step("rpc setRoleModel designer cleared", () => rpc("setRoleModel", { hostId: HOST, role: "designer", selection: null }));
    await step("rpc modelConfiguration designer cleared", () => rpc("modelConfiguration", null));

    // f. final state of every table the scenarios touch
    begin("f-final-state");
    const dump = (table: string, order: string) => async () => (database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as object[]).map(stable).join("\n");
    await step("managed_threads", dump("managed_threads", "thread_id"));
    await step("reviewer_verdicts", dump("reviewer_verdicts", "id"));
    await step("review_targets", dump("review_targets", "reviewer_thread_id, worker_thread_id"));
    await step("alert_outbox", dump("alert_outbox", "rowid"));
    await step("chief_todos", dump("chief_todos", "id"));
    await step("chief_lessons", dump("chief_lessons", "id"));
    await step("plan_log", dump("plan_log", "id"));
    await step("chief_models", dump("chief_models", "host_id, role"));
    await step("plugin_meta", dump("plugin_meta", "key"));
    await step("files written", async () => [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, content]) => `--- ${path}\n${content}`).join("\n"));
    await step("sections, tabs", () => stable({ section, tabs: [...tabs.entries()].sort() }));
  }

  // ----- write out
  writeFileSync(outPath, `${lines.join("\n")}\n`);
  for (const note of notes) console.log(note);
  const empty: string[] = [];
  for (const [name, count] of counts) {
    console.log(`${name}: ${count} items`);
    if (count === 0) empty.push(name);
  }
  await harness.lifecycle.dispose().catch(() => undefined);
  database.close();
  // Reaching here with open handles (the stubbed timers) is fine: the capture is done.
  process.exit(empty.length ? 2 : 0);
}

if (arg("--capture")) {
  await capture(arg("--capture")!, arg("--db")!, arg("--out")!);
} else {
  orchestrate();
}
