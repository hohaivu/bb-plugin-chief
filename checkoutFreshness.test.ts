import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { delegate, disposeAll, execFileMock, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
// Chief's checkout is fast-forwarded before a researcher or planner reads it, and their reports say which commit they read.
// Real git runs against local bare remotes; every other CLI is refused. Git goes through execFileMock so each call is recorded
// with the number of threads spawned when it started, and so a test can hold one the way a slow network would.
describe("checkout freshness", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const PRIMARY = { config: async () => ({ primaryHostId: "host_1" }), usageLimits: async () => ({}) };
  const CTX = { projectId: "proj_1" };
  const SURVEY = (question: string) => ({ mode: "survey", question, items: ["a.ts"] });
  const FIRST_LINE = /^Started researcher thread thr_\d+ \(.*\)\. It runs the survey in your checkout and reports through chief_report; the report arrives as a lifecycle alert\. Do not poll: end your turn\.$/;
  const WARNING = /^Did not fast-forward your checkout to origin\/(main|the default branch): .+\. The (researcher|planner) reads it as it is\.$/;

  let realExecPromise: Promise<(file: string, args: string[], options: object) => Promise<{ stdout: string; stderr: string }>> | undefined;
  const realExec = async () => realExecPromise ??= (async () => {
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return (await import("node:util")).promisify(childProcess.execFile) as any;
  })();
  const git = async (cwd: string, ...args: string[]) =>
    (await (await realExec())("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();

  /** A bare origin with c0 on main, `chief` (the checkout under test, at c0) and `other` (a second clone that pushes). */
  async function repos() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chief-fresh-")));
    const origin = join(root, "origin.git");
    await git(root, "init", "-q", "--bare", "-b", "main", origin);
    const other = join(root, "other");
    await git(root, "clone", "-q", origin, other);
    await writeFile(join(other, "a.txt"), "c0\n");
    await git(other, "add", "-A");
    await git(other, "commit", "-q", "-m", "c0");
    await git(other, "push", "-q", "origin", "HEAD:main");
    const chief = join(root, "chief");
    await git(root, "clone", "-q", "-b", "main", origin, chief);
    let n = 0;
    return {
      root, chief, c0: await git(chief, "rev-parse", "HEAD"),
      /** Pushes one more commit to origin/main from `other`; returns its SHA. */
      push: async (file = "a.txt") => {
        await writeFile(join(other, file), `change ${n += 1}\n`);
        await git(other, "add", "-A");
        await git(other, "commit", "-q", "-m", `change ${n}`);
        await git(other, "push", "-q", "origin", "HEAD:main");
        return git(other, "rev-parse", "HEAD");
      },
      head: () => git(chief, "rev-parse", "HEAD"),
    };
  }

  type GitCall = { args: string[]; cwd: string; spawned: number };
  /**
   * A Chief whose environment is the clone `r.chief` (default branch main, on the primary host), plus a recorder for every git call.
   * `projectPath` is the project source path the server compares with Chief's path to decide whether a planner shares it.
   * `hold` may return a promise that delays a git call, or rejects like execFile's killed child; it sees the call's options.
   */
  async function world(opts: { projectPath?: "clone" | string; env?: "all"; r?: Awaited<ReturnType<typeof repos>> } = {}) {
    const r = opts.r ?? await repos();
    const projectPath = opts.projectPath === "clone" ? r.chief : opts.projectPath;
    const state = await setup({ projectPath, system: PRIMARY });
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const cfg = { env: { path: r.chief, defaultBranch: "main" } as Record<string, unknown>, hostId: "host_1", everyEnvironment: opts.env === "all" };
    state.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({
      id: environmentId, hostId: cfg.hostId, workspaceProvisionType: environmentId.startsWith("env_worker") ? "managed-worktree" : null,
      ...(cfg.everyEnvironment || environmentId.startsWith("env_default") ? cfg.env : {}),
    }));
    const chief = (await start(state)).threadId;
    state.live.set(chief, { ...state.live.get(chief)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    const calls: GitCall[] = [];
    let inflight = 0;
    const hold: { git?: (args: string[], options: any) => Promise<void> | undefined } = {};
    const real = await realExec();
    execFileMock.mockImplementation((file: string, args: string[], options: any) => {
      if (file !== "git") return Promise.reject(new Error(`unexpected CLI ${file}`));
      calls.push({ args, cwd: options.cwd, spawned: state.spawned.length });
      inflight += 1;
      const run = (async () => { await hold.git?.(args, options); return real(file, args, options); })();
      run.then(() => { inflight -= 1; }, () => { inflight -= 1; });
      return run;
    });
    const ctx = { threadId: chief, ...CTX };
    const tool = (name: string, params: object) => state.harness.behavior.callAgentTool(name, params, ctx) as Promise<string>;
    let q = 0;
    const w = {
      r, state, chief, cfg, calls, hold, ctx,
      inflight: () => inflight,
      research: () => tool("chief_research", SURVEY(`Question ${q += 1}`)),
      plan: () => tool("chief_plan", { title: `Plan ${q += 1}`, mission: "Propose how to fix totals" }),
      cliPlan: (...extra: string[]) => state.harness.behavior.runCli(["plan", "--title", `Plan ${q += 1}`, "--mission", "Propose how to fix totals", ...extra], ctx),
      /** Threads spawned by the call under test, excluding Chief itself. */
      spawnedRole: (role: string) => state.spawned.filter((args: any) => args.pluginMetadata?.role === role),
      rows: (role: string) => (state.db.prepare("SELECT thread_id FROM managed_threads WHERE role=? ORDER BY rowid").all(role) as { thread_id: string }[]).map((row) => row.thread_id),
      setLive: (threadId: string, status: string) => state.live.set(threadId, { ...state.live.get(threadId)!, status } as any),
    };
    return w;
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** Exactly the base reply, then one warning line. */
  function expectWarned(reply: string, base: RegExp, reason: RegExp) {
    const lines = reply.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(base);
    expect(lines[1]).toMatch(WARNING);
    expect(lines[1]).toMatch(reason);
  }
  const RESEARCH_BASE = FIRST_LINE;
  const PLAN_BASE = /^Started planner “Plan · Plan \d+” in thread thr_\d+\. Its ready alert lists the wave schedule and the exact next call\.$/;
  const CLI_PLAN_BASE = /^Started planner “Plan · Plan \d+” in thr_\d+\.$/;
  const noWarning = (reply: string, base: RegExp) => { expect(reply).toMatch(base); expect(reply).not.toContain("Did not fast-forward"); };

  const flush = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  };
  /** A git call that never answers on its own: it fails when execFile's `timeout` option elapses, as a killed child does. */
  const killedAfterTimeout = (options: any) => new Promise<void>((_, reject) => setTimeout(() => reject(Object.assign(new Error("Command failed: git (killed after timeout)"), { killed: true })), options.timeout));
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const withFakeTimers = async (body: () => Promise<void>) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try { await body(); } finally { vi.useRealTimers(); }
  };
  /** Starts a tool call and tracks whether it has resolved yet. */
  const track = <T>(promise: Promise<T>) => {
    const box = { done: false, value: undefined as T | undefined, error: undefined as unknown };
    const settled = promise.then((value) => { box.done = true; box.value = value; }, (error) => { box.done = true; box.error = error; });
    return Object.assign(box, { settled });
  };
  /** Spins real event-loop turns until `cond` holds, for up to `ms` of real time. Fake timers never move here, and performance.now is not faked. */
  const until = async (cond: () => boolean, ms = 3_000) => {
    const end = performance.now() + ms;
    while (!cond() && performance.now() < end) await new Promise((resolve) => setImmediate(resolve));
    expect(cond()).toBe(true);
  };

  describe("success", () => {
    test("chief_research fast-forwards a behind clone, spawns the researcher and adds no warning", async () => {
      const w = await world();
      const tip = await w.r.push();
      const reply = await w.research();
      noWarning(reply, RESEARCH_BASE);
      expect(await w.r.head()).toBe(tip);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(w.calls.every((call) => call.cwd === w.r.chief && call.spawned === 1)).toBe(true);
      expect(w.calls.some((call) => call.args[0] === "merge" && call.args.includes("--ff-only"))).toBe(true);
    });

    test("an already current clone is silent and never merges", async () => {
      const w = await world();
      noWarning(await w.research(), RESEARCH_BASE);
      expect(w.calls.some((call) => call.args[0] === "merge")).toBe(false);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("chief_plan in a project whose checkout is Chief's fast-forwards it and adds no warning", async () => {
      const w = await world({ projectPath: "clone" });
      const tip = await w.r.push();
      noWarning(await w.plan(), PLAN_BASE);
      expect(await w.r.head()).toBe(tip);
    });

    test("chief_plan for a confirmed separate planner checkout runs no git and adds no warning, whatever the host", async () => {
      for (const hostId of ["host_1", "host_2"]) {
        const w = await world({ projectPath: "/elsewhere/worktree-default" });
        w.cfg.hostId = hostId;
        await w.r.push();
        noWarning(await w.plan(), PLAN_BASE);
        expect(w.calls).toEqual([]);
        expect(await w.r.head()).toBe(w.r.c0);
        expect(w.spawnedRole("planner")).toHaveLength(1);
      }
    });
  });

  describe("skip causes never block the spawn", () => {
    test.each([
      ["a dirty clone", async (w: World) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); }, /uncommitted changes/],
      ["a local commit ahead", async (w: World) => {
        await writeFile(join(w.r.chief, "mine.txt"), "mine\n");
        await git(w.r.chief, "add", "-A");
        await git(w.r.chief, "commit", "-q", "-m", "mine");
      }, /1 commit\(s\) not on origin\/main/],
      ["a bad origin", async (w: World) => { await git(w.r.chief, "remote", "set-url", "origin", join(w.r.root, "gone.git")); }, /git fetch failed/],
      ["a remote host", async (w: World) => { w.cfg.hostId = "host_2"; }, /remote host/],
      ["an environment without a path", async (w: World) => { delete w.cfg.env.path; }, /no checkout path/],
      ["an environment without a default branch", async (w: World) => { delete w.cfg.env.defaultBranch; }, /default branch unknown/],
    ])("chief_research with %s", async (_name, arrange, reason) => {
      const w = await world();
      await w.r.push();
      await arrange(w);
      const head = await w.r.head();
      expectWarned(await w.research(), RESEARCH_BASE, reason);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await w.r.head()).toBe(head);
      if (/remote host|path|default branch/.test(String(reason))) expect(w.calls).toEqual([]);
    });

    test("an unreadable Chief thread or environment still spawns, with one warning and no git", async () => {
      const w = await world();
      await w.r.push();
      w.state.harness.sdk.stub("environments.get", async () => { throw new Error("env lookup failed"); });
      expectWarned(await w.research(), RESEARCH_BASE, /env lookup failed/);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(w.calls).toEqual([]);
    });

    test("an untracked file the fast-forward would overwrite is a merge-failed skip and the researcher still starts", async () => {
      const w = await world();
      await w.r.push("new.txt");
      await writeFile(join(w.r.chief, "new.txt"), "mine\n");
      expectWarned(await w.research(), RESEARCH_BASE, /git merge --ff-only failed/);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("an ignored untracked file that origin adds is not overwritten: merge-failed skip, the file and HEAD stay, the researcher still starts", async () => {
      const w = await world();
      await appendFile(join(w.r.chief, ".git", "info", "exclude"), "local.env\n");
      await writeFile(join(w.r.chief, "local.env"), "SECRET=mine\n");
      await w.r.push("local.env");
      expect(await git(w.r.chief, "status", "--porcelain", "--untracked-files=no")).toBe("");
      expectWarned(await w.research(), RESEARCH_BASE, /git merge --ff-only failed/);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await readFile(join(w.r.chief, "local.env"), "utf8")).toBe("SECRET=mine\n");
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a planner call whose shared checkout is dirty skips with one warning and the planner still starts", async () => {
      const w = await world({ projectPath: "clone" });
      await w.r.push();
      await writeFile(join(w.r.chief, "a.txt"), "dirty\n");
      expectWarned(await w.plan(), PLAN_BASE, /uncommitted changes/);
      expect(w.spawnedRole("planner")).toHaveLength(1);
      expect(await w.r.head()).toBe(w.r.c0);
    });
  });

  // chief_sync (PR 183): the Chief-only tool that runs the same fast-forward on Chief's own checkout, through the real tool handler.
  describe("chief_sync", () => {
    const sync = (w: World) => w.state.harness.behavior.callAgentTool("chief_sync", {}, w.ctx) as Promise<string>;
    const SKIPPED = /^Did not fast-forward your checkout to origin\/main: /;

    test("a checkout one commit behind is fast-forwarded and the reply names the old and the new commit", async () => {
      const w = await world();
      const tip = await w.r.push();
      const reply = await sync(w);
      expect(reply).toContain(w.r.c0.slice(0, 12));
      expect(reply).toContain(tip.slice(0, 12));
      expect(reply).not.toContain("Did not fast-forward");
      expect(await w.r.head()).toBe(tip);
      expect(w.calls.some((call) => call.args[0] === "merge" && call.args.includes("--ff-only"))).toBe(true);
    });

    test("an already current checkout names its commit, is no skip and never merges", async () => {
      const w = await world();
      const reply = await sync(w);
      expect(reply).toContain(w.r.c0.slice(0, 12));
      expect(reply).not.toContain("Did not fast-forward");
      expect(w.calls.some((call) => call.args[0] === "merge")).toBe(false);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test.each([
      ["a dirty checkout", async (w: World) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); }, /uncommitted changes/],
      ["a branch with a commit of its own", async (w: World) => {
        await writeFile(join(w.r.chief, "mine.txt"), "mine\n");
        await git(w.r.chief, "add", "-A");
        await git(w.r.chief, "commit", "-q", "-m", "mine");
      }, /1 commit\(s\) not on origin\/main/],
      ["a failing fetch", async (w: World) => { await git(w.r.chief, "remote", "set-url", "origin", join(w.r.root, "gone.git")); }, /git fetch failed/],
    ])("%s is a warning reply, not an error, and HEAD stays", async (_name, arrange, reason) => {
      const w = await world();
      await w.r.push();
      await arrange(w);
      const head = await w.r.head();
      const reply = await sync(w);
      expect(reply).toMatch(SKIPPED);
      expect(reply).toMatch(reason);
      expect(await w.r.head()).toBe(head);
    });

    test("a running researcher of this Chief is a warning naming it, runs no git and leaves HEAD", async () => {
      const w = await world();
      await w.research();
      const [researcher] = w.rows("researcher");
      w.setLive(researcher!, "active");
      await w.r.push();
      const before = w.calls.length;
      const reply = await sync(w);
      expect(reply).toMatch(SKIPPED);
      expect(reply).toContain(`researcher ${researcher} is still running in it`);
      expect(w.calls).toHaveLength(before);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a running planner that shares Chief's checkout is a warning naming it and leaves HEAD", async () => {
      const w = await world({ projectPath: "clone" });
      await w.plan();
      const [planner] = w.rows("planner");
      w.setLive(planner!, "active");
      await w.r.push();
      const reply = await sync(w);
      expect(reply).toMatch(SKIPPED);
      expect(reply).toContain(`planner ${planner} is still running in it`);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a caller that is not Chief is refused and nothing is fetched or moved", async () => {
      const w = await world();
      const { threadId: worker } = await delegate(w.state, w.chief);
      const tip = await w.r.push();
      const before = w.calls.length;
      const call = (ctx: object) => w.state.harness.behavior.callAgentTool("chief_sync", {}, ctx);
      await expect(call({ threadId: worker, projectId: "proj_1" })).rejects.toThrow(/Chief/);
      await expect(call({ threadId: "thr_unknown", projectId: "proj_1" })).rejects.toThrow(/Chief/);
      await expect(call({ projectId: "proj_1" })).rejects.toThrow(/Chief/);
      expect(w.calls).toHaveLength(before);
      expect(await w.r.head()).not.toBe(tip);
    });
  });

  describe("busy rule", () => {
    const NOT_BUSY = ["idle", "ready", "blocked"];
    test.each(["active", "starting", "stopping", "pending"])("a researcher of this Chief whose live status is %s makes chief_research skip, and the next researcher still starts", async (status) => {
      const w = await world();
      noWarning(await w.research(), RESEARCH_BASE);
      const [first] = w.rows("researcher");
      w.setLive(first!, status);
      await w.r.push();
      const before = w.calls.length;
      expectWarned(await w.research(), RESEARCH_BASE, new RegExp(`researcher ${first} is still running in it`));
      expect(w.spawnedRole("researcher")).toHaveLength(2);
      expect(w.calls).toHaveLength(before);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test.each(NOT_BUSY)("a researcher whose live status is %s does not block the fast-forward", async (status) => {
      const w = await world();
      await w.research();
      w.setLive(w.rows("researcher")[0]!, status);
      const tip = await w.r.push();
      noWarning(await w.research(), RESEARCH_BASE);
      expect(await w.r.head()).toBe(tip);
    });

    test("a researcher whose live read throws counts as running", async () => {
      const w = await world();
      await w.research();
      const [first] = w.rows("researcher");
      await w.r.push();
      w.state.failNextGet(first!);
      expectWarned(await w.research(), RESEARCH_BASE, new RegExp(`researcher ${first} is still running in it`));
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a researcher whose live read times out counts as running; releasing the read later starts no git", async () => {
      const w = await world();
      await w.research();
      const [first] = w.rows("researcher");
      await w.r.push();
      const before = w.calls.length;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let hits = 0;
      w.state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
        if (threadId === first) { hits += 1; await held; }
        const thread = w.state.live.get(threadId);
        if (!thread) throw new Error("not found");
        return thread;
      });
      await withFakeTimers(async () => {
        const call = track(w.research());
        await flush(4_900);
        expect(call.done).toBe(false);
        await flush(200);
        await call.settled;
        expect(hits).toBe(1);
        expectWarned(call.value!, RESEARCH_BASE, new RegExp(`researcher ${first} is still running in it`));
        release();
        await flush(0);
      });
      expect(w.calls).toHaveLength(before);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a researcher of another Chief never counts", async () => {
      const w = await world();
      const other = (await start(w.state, "proj_2")).threadId;
      w.state.live.set(other, { ...w.state.live.get(other)!, providerId: "codex" });
      await w.state.harness.behavior.callAgentTool("chief_research", SURVEY("Other chief question"), { threadId: other, projectId: "proj_2" });
      const foreign = w.state.db.prepare("SELECT thread_id FROM managed_threads WHERE role='researcher' AND chief_thread_id=?").get(other) as { thread_id: string };
      w.setLive(foreign.thread_id, "active");
      const tip = await w.r.push();
      noWarning(await w.research(), RESEARCH_BASE);
      expect(await w.r.head()).toBe(tip);
    });

    test("in a researcher call, a running planner whose sharing is unknown blocks", async () => {
      const w = await world();
      expectWarned(await w.plan(), PLAN_BASE, /could not tell whether the planner shares it/);
      const [planner] = w.rows("planner");
      w.setLive(planner!, "active");
      await w.r.push();
      expectWarned(await w.research(), RESEARCH_BASE, new RegExp(`planner ${planner} is still running in it`));
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("in a researcher call, a running planner on a confirmed separate checkout does not block", async () => {
      const w = await world({ projectPath: "/elsewhere/worktree-default" });
      noWarning(await w.plan(), PLAN_BASE);
      w.setLive(w.rows("planner")[0]!, "active");
      const tip = await w.r.push();
      noWarning(await w.research(), RESEARCH_BASE);
      expect(await w.r.head()).toBe(tip);
    });

    test("a running planner that shares Chief's checkout blocks the next chief_plan", async () => {
      const w = await world({ projectPath: "clone" });
      noWarning(await w.plan(), PLAN_BASE);
      w.setLive(w.rows("planner")[0]!, "active");
      await w.r.push();
      const before = w.calls.length;
      expectWarned(await w.plan(), PLAN_BASE, /planner thr_\d+ is still running in it/);
      expect(w.calls).toHaveLength(before);
      expect(w.spawnedRole("planner")).toHaveLength(2);
    });
  });

  describe("ordering: a refused call leaves Chief's checkout and git alone", () => {
    const ctxOf = (w: World) => w.ctx;
    test.each<[string, (w: World) => Promise<unknown>, RegExp]>([
      ["research on a cooling model", async (w) => {
        w.state.db.prepare("INSERT INTO provider_cooldowns (provider_id, model, until_at, reason, updated_at) VALUES ('codex', 'gpt-6-astra', ?, 'x', 0)").run(Date.now() + 600_000);
        return w.research();
      }, /cooling down/],
      ["research switched off", async (w) => {
        await w.state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
        return w.research();
      }, /chief_research is off/],
      ["planning switched off", async (w) => {
        await w.state.harness.behavior.setSettings({ plannerEnabled: false });
        return w.plan();
      }, /./],
      ["a revision of a plan that does not exist", async (w) => w.state.harness.behavior.callAgentTool("chief_plan", { title: "Revise", mission: "Propose again", revises: "thr_missing" }, ctxOf(w)), /./],
    ])("%s", async (_name, act, message) => {
      const w = await world({ projectPath: "clone" });
      await w.r.push();
      await expect(act(w)).rejects.toThrow(message);
      expect(w.calls).toEqual([]);
      expect(await w.r.head()).toBe(w.r.c0);
      expect(w.spawnedRole("researcher")).toHaveLength(0);
      expect(w.spawnedRole("planner")).toHaveLength(0);
    });
  });

  describe("planner sharing is three-valued, through the chief_plan tool and CLI plan", () => {
    const UNKNOWN = /could not tell whether the planner shares it/;
    const causes: [string, (w: World) => void][] = [
      ["projects.get throws", (w) => { w.state.harness.sdk.stub("projects.get", async () => { throw new Error("project lookup failed"); }); }],
      ["environments.get throws", (w) => { w.state.harness.sdk.stub("environments.get", async () => { throw new Error("env lookup failed"); }); }],
      ["environments.get has no path", (w) => { delete w.cfg.env.path; }],
    ];
    describe.each(causes)("%s", (_name, arrange) => {
      test("chief_plan warns once, spawns the planner and runs no git", async () => {
        const w = await world({ projectPath: "clone" });
        await w.r.push();
        arrange(w);
        expectWarned(await w.plan(), PLAN_BASE, UNKNOWN);
        expect(w.spawnedRole("planner")).toHaveLength(1);
        expect(w.calls).toEqual([]);
        expect(await w.r.head()).toBe(w.r.c0);
      });

      test("CLI plan warns once, spawns the planner and runs no git", async () => {
        const w = await world({ projectPath: "clone" });
        await w.r.push();
        arrange(w);
        const result = await w.cliPlan();
        expect(result.exitCode).toBe(0);
        expectWarned(result.stdout!.trim(), CLI_PLAN_BASE, UNKNOWN);
        expect(w.spawnedRole("planner")).toHaveLength(1);
        expect(w.calls).toEqual([]);
        expect(await w.r.head()).toBe(w.r.c0);
      });
    });

    test("CLI plan on a shared checkout fast-forwards it with no warning, and a remote host there is a remote-host warning", async () => {
      const w = await world({ projectPath: "clone" });
      const tip = await w.r.push();
      const ok = await w.cliPlan();
      expect(ok.stdout!.trim()).toMatch(CLI_PLAN_BASE);
      expect(await w.r.head()).toBe(tip);
      w.cfg.hostId = "host_2";
      const before = w.calls.length;
      expectWarned((await w.cliPlan()).stdout!.trim(), CLI_PLAN_BASE, /remote host/);
      expect(w.calls).toHaveLength(before);
    });
  });

  describe("deadlines: settled means stopped", () => {
    const named = (w: World, name: string) => w.calls.filter((call) => call.args[0] === name);

    test("a held git fetch is killed twice, becomes a fetch-failed skip, and no git runs when the researcher starts", async () => {
      const w = await world();
      await w.r.push();
      w.hold.git = (args, options) => (args[0] === "fetch" ? killedAfterTimeout(options) : undefined);
      await withFakeTimers(async () => {
        const call = track(w.research());
        await until(() => named(w, "fetch").length === 1);
        await flush(10_000);
        expect(call.done).toBe(false);
        await until(() => named(w, "fetch").length === 2);
        await flush(10_000);
        await call.settled;
        expect(w.inflight()).toBe(0);
        expectWarned(call.value!, RESEARCH_BASE, /git fetch failed: .*killed after timeout/);
      });
      expect(w.calls.every((call) => call.spawned === 1)).toBe(true);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a held first git command takes two killed tries, then the researcher starts with the failure as the reason", async () => {
      const w = await world();
      w.hold.git = (_args, options) => killedAfterTimeout(options);
      await withFakeTimers(async () => {
        const call = track(w.research());
        await until(() => w.calls.length === 1);
        await flush(10_000);
        await until(() => w.calls.length === 2);
        await flush(10_000);
        await call.settled;
        expect(w.inflight()).toBe(0);
        expectWarned(call.value!, RESEARCH_BASE, /killed after timeout/);
      });
      expect(w.calls.map((call) => call.args[0])).toEqual(["status", "status"]);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
    });

    test.each([
      ["3 s for the HEAD read leaves 9 s: skips before the merge", 3_000, false],
      ["1 s for the HEAD read leaves 11 s: merges", 1_000, true],
    ])("merge budget, %s", async (_name, headMs, merges) => {
      const w = await world();
      const tip = await w.r.push();
      // Each hold moves the clock instead of waiting: status 9 s + fetch 9 s + HEAD read.
      w.hold.git = (args) => {
        if (args[0] === "status" || args[0] === "fetch") vi.setSystemTime(Date.now() + 9_000);
        else if (args[0] === "rev-parse" && args[1] === "HEAD") vi.setSystemTime(Date.now() + headMs);
        return undefined;
      };
      await withFakeTimers(async () => {
        const reply = await w.research();
        if (merges) noWarning(reply, RESEARCH_BASE);
        else expectWarned(reply, RESEARCH_BASE, /timed out before the merge/);
      });
      expect(named(w, "merge")).toHaveLength(merges ? 1 : 0);
      expect(await w.r.head()).toBe(merges ? tip : w.r.c0);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
    });

    test.each([
      ["11 s left at the merge: the retry would start with 1 s, so there is none", 19_000, 1],
      ["30 s left at the merge: the retry starts with 20 s", 0, 2],
    ])("a merge killed at its 10 s timeout, %s", async (_name, usedMs, merges) => {
      const w = await world();
      await w.r.push();
      // The first git call moves the clock instead of waiting, leaving 30 s - usedMs for the merge.
      let moved = false;
      w.hold.git = (args, options) => {
        if (!moved) { moved = true; vi.setSystemTime(Date.now() + usedMs); }
        return args[0] === "merge" ? killedAfterTimeout(options) : undefined;
      };
      await withFakeTimers(async () => {
        const call = track(w.research());
        for (let n = 1; n <= merges; n += 1) {
          await until(() => named(w, "merge").length === n);
          expect(call.done).toBe(false);
          await flush(10_000);
        }
        await call.settled;
        expect(w.inflight()).toBe(0);
        expectWarned(call.value!, RESEARCH_BASE, /git merge --ff-only failed: .*killed after timeout/);
      });
      expect(named(w, "merge")).toHaveLength(merges);
      // Every git call, the merges included, finished before the researcher was launched, and the checkout is untouched.
      expect(w.calls.every((call) => call.spawned === 1)).toBe(true);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test.each([
      ["chief_research", "researcher", async (w: World) => w.research(), RESEARCH_BASE],
      ["chief_plan", "planner", async (w: World) => w.plan(), PLAN_BASE],
    ] as const)("a held system.config lookup in %s times out after 5 s; releasing it later starts no git", async (_name, role, act, base) => {
      const w = await world({ projectPath: "clone" });
      await w.r.push();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let hits = 0;
      w.state.harness.sdk.stub("system.config", async () => { hits += 1; await held; return { primaryHostId: "host_1" }; });
      await withFakeTimers(async () => {
        const call = track(act(w));
        await until(() => hits === 1);
        await flush(4_900);
        expect(call.done).toBe(false);
        await flush(200);
        await call.settled;
        expectWarned(call.value!, base, /timed out/);
        release();
        await flush(0);
      });
      expect(w.spawnedRole(role)).toHaveLength(1);
      expect(w.calls).toEqual([]);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a held project lookup in chief_plan times out after 5 s as unknown sharing: warning, planner spawned, no git", async () => {
      const w = await world({ projectPath: "clone" });
      await w.r.push();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let hits = 0;
      // Earlier project reads (name, host) are not part of the freshness call; hold only the one after its system.config read.
      let armed = false;
      w.state.harness.sdk.stub("system.config", async () => { armed = true; return { primaryHostId: "host_1" }; });
      w.state.harness.sdk.stub("projects.get", async () => {
        if (armed) hits += 1;
        if (armed && hits === 1) await held;
        return { id: "proj_1", name: "P", kind: "standard", sources: [{ path: w.r.chief, hostId: "host_1", isDefault: true }] };
      });
      await withFakeTimers(async () => {
        const call = track(w.plan());
        await until(() => hits === 1);
        await flush(5_100);
        await call.settled;
        expectWarned(call.value!, PLAN_BASE, /could not tell whether the planner shares it/);
        release();
        await flush(0);
      });
      expect(w.spawnedRole("planner")).toHaveLength(1);
      expect(w.calls).toEqual([]);
    });
  });

  describe("report stamp, through chief_report", () => {
    const alertText = (w: World) => w.state.sent.at(-1).input[0].text as string;
    const report = (w: World, threadId: string, extra: object = { state: "blocked", blocker: "stuck", recommendation: "retry" }) =>
      w.state.harness.behavior.callAgentTool("chief_report", extra, { threadId, projectId: "proj_1" });
    const stateOf = (w: World, threadId: string) => (w.state.db.prepare("SELECT last_report_state AS s FROM managed_threads WHERE thread_id=?").get(threadId) as { s: string }).s;
    /** The line after `State:` in an alert or report file. */
    const afterState = (text: string) => { const lines = text.split("\n"); return lines[lines.findIndex((line) => line.startsWith("State:")) + 1]; };

    describe.each([["researcher", async (w: World) => { await w.research(); return w.rows("researcher")[0]!; }],
      ["planner", async (w: World) => { await w.plan(); return w.rows("planner")[0]!; }]] as const)("%s", (role, spawn) => {
      test("the alert carries Read at <12 hex> right after State, with no stale clause when origin has not moved", async () => {
        const w = await world({ projectPath: "clone" });
        const id = await spawn(w);
        await report(w, id);
        expect(alertText(w)).toContain(`State: blocked\nRead at ${w.r.c0.slice(0, 12)}\n`);
        expect(alertText(w)).not.toContain("may be stale");
      });

      test("adds the stale clause exactly when ls-remote returns a different SHA", async () => {
        const w = await world({ projectPath: "clone" });
        const id = await spawn(w);
        const tip = await w.r.push();
        const spawnCalls = w.calls.length;
        await report(w, id);
        expect(afterState(alertText(w))).toBe(`Read at ${w.r.c0.slice(0, 12)}; main is now ${tip.slice(0, 12)}, so this answer may be stale`);
        expect(await w.r.head()).toBe(w.r.c0);
        expect(w.calls.slice(spawnCalls).map((call) => call.args)).toEqual([["rev-parse", "HEAD"], ["ls-remote", "origin", "refs/heads/main"]]);
      });

      test("keeps the local SHA when ls-remote fails, and the state and alert are still delivered", async () => {
        const w = await world({ projectPath: "clone" });
        const id = await spawn(w);
        await git(w.r.chief, "remote", "set-url", "origin", join(w.r.root, "gone.git"));
        await report(w, id);
        expect(afterState(alertText(w))).toBe(`Read at ${w.r.c0.slice(0, 12)}`);
        expect(stateOf(w, id)).toBe("blocked");
      });

      test("a long result puts the same stamp after State in the report file", async () => {
        const w = await world({ projectPath: "clone" });
        const id = await spawn(w);
        const tip = await w.r.push();
        await report(w, id, { state: "blocked", blocker: "stuck", recommendation: "retry", result: "word ".repeat(4_000) });
        const path = /Full report: (\S+)/.exec(alertText(w))![1]!;
        const expected = `Read at ${w.r.c0.slice(0, 12)}; main is now ${tip.slice(0, 12)}, so this answer may be stale`;
        expect(afterState(await readFile(path, "utf8"))).toBe(expected);
        expect(afterState(alertText(w))).toBe(expected);
      });

      test.each([
        ["an environment lookup that throws", (w: World) => { w.state.harness.sdk.stub("environments.get", async () => { throw new Error("env lookup failed"); }); }],
        ["an unreadable checkout path", (w: World) => { w.cfg.env.path = join(w.r.root, "missing"); }],
        ["a remote host", (w: World) => { w.cfg.hostId = "host_2"; }],
        ["no default branch", (w: World) => { delete w.cfg.env.defaultBranch; }],
      ])(`%s drops only the stamp from the ${role} report: it is still delivered`, async (_name, arrange) => {
        const w = await world({ projectPath: "clone", env: "all" });
        const id = await spawn(w);
        arrange(w);
        await report(w, id);
        expect(alertText(w)).toMatch(/^\[Chief lifecycle alert\]\n.* report from .*\nState: blocked\n/);
        expect(alertText(w)).not.toContain("Read at");
        expect(stateOf(w, id)).toBe("blocked");
      });
    });

    test("a held ls-remote on a long report: state, seq and pending alert are committed first; after 12 s the alert and the report file both keep Read at <sha> without the comparison", async () => {
      const w = await world();
      await w.research();
      const id = w.rows("researcher")[0]!;
      await w.r.push(); // origin moved, so a working ls-remote would add the comparison clause
      w.hold.git = (args, options) => (args[0] === "ls-remote" ? killedAfterTimeout(options) : undefined);
      const seqOf = () => (w.state.db.prepare("SELECT report_seq AS s FROM managed_threads WHERE thread_id=?").get(id) as { s: number }).s;
      await withFakeTimers(async () => {
        // Longer than SUMMARY_MAX, so a report file is written.
        const call = track(report(w, id, { state: "blocked", blocker: "stuck", recommendation: "retry", result: "word ".repeat(4_000) }));
        await until(() => w.calls.some((c) => c.args[0] === "ls-remote"));
        // Required result first: committed while the optional comparison is still running; no file or full alert yet.
        expect(stateOf(w, id)).toBe("blocked");
        expect(seqOf()).toBe(1);
        expect(w.state.db.prepare("SELECT 1 FROM alert_outbox WHERE dedupe_key LIKE ?").all(`${id}:report:%:pending-1`)).toHaveLength(1);
        expect(w.state.db.prepare("SELECT report_path AS p FROM managed_threads WHERE thread_id=?").get(id)).toEqual({ p: null });
        await flush(10_000);
        expect(call.done).toBe(false);
        await until(() => w.calls.filter((c) => c.args[0] === "ls-remote").length === 2);
        await flush(2_000);
        await call.settled;
        expect(call.error).toBeUndefined();
        expect(w.inflight()).toBe(0);
      });
      const path = /Full report: (\S+)/.exec(alertText(w))![1]!;
      expect(path).toMatch(/report-1\.md$/);
      const stamp = `Read at ${w.r.c0.slice(0, 12)}`;
      expect(afterState(await readFile(path, "utf8"))).toBe(stamp);
      expect(afterState(alertText(w))).toBe(stamp);
      expect(`${alertText(w)}\n${await readFile(path, "utf8")}`).not.toContain("is now");
      expect(stateOf(w, id)).toBe("blocked");
      expect(seqOf()).toBe(1);
      expect(w.state.db.prepare("SELECT report_path AS p FROM managed_threads WHERE thread_id=?").get(id)).toEqual({ p: path });
    });

    test("a held system.config read is bounded to 5 s: no stamp, no git, the report is delivered", async () => {
      const w = await world();
      await w.research();
      const id = w.rows("researcher")[0]!;
      const spawnCalls = w.calls.length;
      let hits = 0;
      w.state.harness.sdk.stub("system.config", async () => { hits += 1; await new Promise(() => undefined); return { primaryHostId: "host_1" }; });
      await withFakeTimers(async () => {
        const call = track(report(w, id));
        await until(() => hits === 1);
        await flush(4_900);
        expect(call.done).toBe(false);
        await flush(200);
        await call.settled;
        expect(call.error).toBeUndefined();
      });
      expect(alertText(w)).not.toContain("Read at");
      expect(w.calls).toHaveLength(spawnCalls);
      expect(stateOf(w, id)).toBe("blocked");
    });

    test("worker, reviewer and advisor alerts are unchanged: no stamp and no git", async () => {
      const w = await world({ projectPath: "clone", env: "all" });
      const delegated = await w.state.harness.behavior.runCli(["delegate", "--title", "Fix totals", "--mission", "Do it", "--unplanned-reason", "stamp test", "--json"], w.ctx);
      const worker = (JSON.parse(delegated.stdout!) as { threadId: string }).threadId;
      await report(w, worker);
      expect(alertText(w)).toContain("State: blocked");
      expect(alertText(w)).not.toContain("Read at");
      await report(w, worker, { state: "ready", result: "Done\n\n## Deviations from plan\nNone" });
      await w.state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker }, w.ctx);
      const reviewer = w.rows("reviewer")[0]!;
      await report(w, reviewer, { state: "ready", result: "Reviewed", verdict: "approve", findings: [] });
      expect(alertText(w)).not.toContain("Read at");
      await w.state.harness.behavior.runCli(["consult", "--title", "Rework", "--mission", "Explore"], w.ctx);
      await report(w, w.rows("advisor")[0]!, { state: "ready", result: "Sound", verdict: "approve" });
      expect(alertText(w)).not.toContain("Read at");
      expect(w.calls.filter((call) => ["ls-remote", "rev-parse"].includes(call.args[0]!))).toEqual([]);
    });
  });

  // Byte-equivalence with base 948c49c (before the fast-forward existed). The golden file was recorded on that commit by
  // running this same describe with ORACLE_OUT set; here the head output of the same fixture must equal it. With ORACLE_OUT
  // set, this describe writes {meta, outputs} to that path instead of comparing.
  describe("checkout equivalence with base 948c49c", () => {
    type Scenario = { name: string; projectPath: "clone" | "/elsewhere/worktree-default"; behind: boolean; call: "research" | "plan" | "cli-plan" | "cli-plan-json" };
    const FIXTURE: Scenario[] = [
      { name: "research, behind clone (fast-forward succeeds)", projectPath: "clone", behind: true, call: "research" },
      { name: "research, current clone", projectPath: "clone", behind: false, call: "research" },
      { name: "chief_plan, shared checkout, behind", projectPath: "clone", behind: true, call: "plan" },
      { name: "chief_plan, shared checkout, current", projectPath: "clone", behind: false, call: "plan" },
      { name: "chief_plan, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", behind: true, call: "plan" },
      { name: "CLI plan text, shared checkout, behind", projectPath: "clone", behind: true, call: "cli-plan" },
      { name: "CLI plan text, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", behind: true, call: "cli-plan" },
      { name: "CLI plan --json, shared checkout, behind", projectPath: "clone", behind: true, call: "cli-plan-json" },
      { name: "CLI plan --json, shared checkout, current", projectPath: "clone", behind: false, call: "cli-plan-json" },
      { name: "CLI plan --json, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", behind: true, call: "cli-plan-json" },
    ];
    const fixtureHash = createHash("sha256").update(JSON.stringify(FIXTURE)).digest("hex");
    const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "checkoutFreshness.oracle.json");

    async function outputs() {
      const out: Record<string, unknown> = {};
      for (const scenario of FIXTURE) {
        const w = await world({ projectPath: scenario.projectPath });
        if (scenario.behind) await w.r.push();
        if (scenario.call === "research") out[scenario.name] = await w.research();
        else if (scenario.call === "plan") out[scenario.name] = await w.plan();
        else {
          const result = await w.cliPlan(...(scenario.call === "cli-plan-json" ? ["--json"] : []));
          out[scenario.name] = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        }
      }
      return out;
    }

    test("tool results and CLI text and --json are byte-identical to the base recording for the same fixture", async () => {
      const actual = await outputs();
      if (process.env.ORACLE_OUT) {
        const meta = {
          cwd: process.cwd(), runnerRoot: dirname(fileURLToPath(import.meta.url)),
          head: await git(process.cwd(), "rev-parse", "HEAD"), fixtureHash, scenarios: FIXTURE.length,
        };
        await writeFile(process.env.ORACLE_OUT, `${JSON.stringify({ meta, outputs: actual }, null, 2)}\n`);
        return;
      }
      const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as { meta: { head: string; fixtureHash: string }; outputs: Record<string, unknown> };
      expect(golden.meta.head).toBe("948c49cb6cac6f2e3066fe0e2164e22c809c8a4f");
      expect(golden.meta.fixtureHash).toBe(fixtureHash);
      expect(actual).toEqual(golden.outputs);
    });
  });

  // Preservation of #181's callers (chief_research, chief_plan, CLI plan) across the chief_sync refactor. The golden file was
  // recorded on base 0e3ab0c by running this same describe there with ORACLE_OUT_FRESH set; here the head output of the same
  // fixture must equal it. Covers success and every skip path, recording reply, HEAD outcome, spawns and the git calls made.
  describe("checkout equivalence with base 0e3ab0c", () => {
    type Run = (w: World) => Promise<unknown>;
    type Scenario = { name: string; projectPath?: "clone" | string; run: Run };
    const ownCommit = async (w: World) => {
      await writeFile(join(w.r.chief, "mine.txt"), "mine\n");
      await git(w.r.chief, "add", "-A");
      await git(w.r.chief, "commit", "-q", "-m", "mine");
    };
    const badOrigin = (w: World) => git(w.r.chief, "remote", "set-url", "origin", join(w.r.root, "gone.git"));
    const cli = async (w: World, ...extra: string[]) => {
      const result = await w.cliPlan(...extra);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    };
    const FIXTURE: Scenario[] = [
      { name: "research, behind (fast-forward)", run: (w) => w.research() },
      { name: "research, current", run: async (w) => { await git(w.r.chief, "pull", "-q", "--ff-only"); return w.research(); } },
      { name: "research, dirty", run: async (w) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); return w.research(); } },
      { name: "research, own commit", run: async (w) => { await ownCommit(w); return w.research(); } },
      { name: "research, fetch fails", run: async (w) => { await badOrigin(w); return w.research(); } },
      { name: "research, remote host", run: async (w) => { w.cfg.hostId = "host_2"; return w.research(); } },
      { name: "research, no default branch", run: async (w) => { delete w.cfg.env.defaultBranch; return w.research(); } },
      { name: "research, environment lookup throws", run: async (w) => { w.state.harness.sdk.stub("environments.get", async () => { throw new Error("env lookup failed"); }); return w.research(); } },
      { name: "research, running researcher", run: async (w) => {
        const first = await w.research();
        w.setLive(w.rows("researcher")[0]!, "active");
        await w.r.push();
        return [first, await w.research()];
      } },
      { name: "research, running planner of unknown sharing", run: async (w) => {
        const first = await w.plan();
        w.setLive(w.rows("planner")[0]!, "active");
        await w.r.push();
        return [first, await w.research()];
      } },
      { name: "chief_plan, shared, behind (fast-forward)", projectPath: "clone", run: (w) => w.plan() },
      { name: "chief_plan, shared, current", projectPath: "clone", run: async (w) => { await git(w.r.chief, "pull", "-q", "--ff-only"); return w.plan(); } },
      { name: "chief_plan, shared, dirty", projectPath: "clone", run: async (w) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); return w.plan(); } },
      { name: "chief_plan, shared, own commit", projectPath: "clone", run: async (w) => { await ownCommit(w); return w.plan(); } },
      { name: "chief_plan, shared, fetch fails", projectPath: "clone", run: async (w) => { await badOrigin(w); return w.plan(); } },
      { name: "chief_plan, shared, remote host", projectPath: "clone", run: async (w) => { w.cfg.hostId = "host_2"; return w.plan(); } },
      { name: "chief_plan, shared, running planner", projectPath: "clone", run: async (w) => {
        const first = await w.plan();
        w.setLive(w.rows("planner")[0]!, "active");
        await w.r.push();
        return [first, await w.plan()];
      } },
      { name: "chief_plan, shared, running researcher", projectPath: "clone", run: async (w) => {
        const first = await w.research();
        w.setLive(w.rows("researcher")[0]!, "active");
        await w.r.push();
        return [first, await w.plan()];
      } },
      { name: "chief_plan, sharing unknown (projects.get throws)", projectPath: "clone", run: async (w) => {
        w.state.harness.sdk.stub("projects.get", async () => { throw new Error("project lookup failed"); });
        return w.plan();
      } },
      { name: "chief_plan, sharing unknown (environment has no path)", projectPath: "clone", run: async (w) => { delete w.cfg.env.path; return w.plan(); } },
      { name: "chief_plan, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", run: (w) => w.plan() },
      { name: "CLI plan text, shared, behind (fast-forward)", projectPath: "clone", run: (w) => cli(w) },
      { name: "CLI plan text, shared, current", projectPath: "clone", run: async (w) => { await git(w.r.chief, "pull", "-q", "--ff-only"); return cli(w); } },
      { name: "CLI plan text, shared, dirty", projectPath: "clone", run: async (w) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); return cli(w); } },
      { name: "CLI plan text, shared, own commit", projectPath: "clone", run: async (w) => { await ownCommit(w); return cli(w); } },
      { name: "CLI plan text, shared, fetch fails", projectPath: "clone", run: async (w) => { await badOrigin(w); return cli(w); } },
      { name: "CLI plan text, shared, remote host", projectPath: "clone", run: async (w) => { w.cfg.hostId = "host_2"; return cli(w); } },
      { name: "CLI plan text, sharing unknown", projectPath: "clone", run: async (w) => { delete w.cfg.env.path; return cli(w); } },
      { name: "CLI plan text, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", run: (w) => cli(w) },
      { name: "CLI plan --json, shared, behind (fast-forward)", projectPath: "clone", run: (w) => cli(w, "--json") },
      { name: "CLI plan --json, shared, dirty", projectPath: "clone", run: async (w) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); return cli(w, "--json"); } },
      { name: "CLI plan --json, sharing unknown", projectPath: "clone", run: async (w) => { delete w.cfg.env.path; return cli(w, "--json"); } },
    ];
    const fixtureHash = createHash("sha256").update(FIXTURE.map((s) => `${s.name}|${s.projectPath}`).join("\n")).digest("hex");
    const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "checkoutFreshness.base0e3ab0c.oracle.json");

    async function outputs() {
      const out: Record<string, unknown> = {};
      for (const scenario of FIXTURE) {
        const w = await world({ projectPath: scenario.projectPath });
        await w.r.push();
        const replies = await scenario.run(w);
        const head = await w.r.head();
        const originMain = await git(w.r.chief, "rev-parse", "origin/main");
        const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).split(w.r.root).join("<root>").replace(/\b[0-9a-f]{40}\b/g, "<sha>"));
        out[scenario.name] = normalize({
          replies,
          head: head === w.r.c0 ? "c0" : head === originMain ? "origin tip" : "local commit",
          threads: { researcher: w.spawnedRole("researcher").length, planner: w.spawnedRole("planner").length },
          gitCalls: w.calls.map((call) => ({ args: call.args, cwd: call.cwd, spawned: call.spawned })),
        });
      }
      return out;
    }

    test("research, chief_plan and CLI plan replies, HEAD, spawns and git calls are identical to base 0e3ab0c for every skip case and the fast-forward", async () => {
      const actual = await outputs();
      if (process.env.ORACLE_OUT_FRESH) {
        const meta = {
          cwd: process.cwd(), runnerRoot: dirname(fileURLToPath(import.meta.url)),
          head: await git(process.cwd(), "rev-parse", "HEAD"), fixtureHash, scenarios: FIXTURE.length,
        };
        await writeFile(process.env.ORACLE_OUT_FRESH, `${JSON.stringify({ meta, outputs: actual }, null, 2)}\n`);
        return;
      }
      const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as { meta: { head: string; fixtureHash: string }; outputs: Record<string, unknown> };
      expect(golden.meta.head).toBe("0e3ab0c4b7f6aa27cd2bba93ef757e19b3a57610");
      expect(golden.meta.fixtureHash).toBe(fixtureHash);
      expect(actual).toEqual(golden.outputs);
    }, 120_000);
  });
});
