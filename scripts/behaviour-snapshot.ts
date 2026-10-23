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

  // git, gh and glab never run. `gh pr view` answers prHead with the row's reviewed_head_sha (no pr_url: it fails),
  // or, for a pull request number in `forgePulls`, with that entry (a pull request no managed worker carries).
  const forgePulls: Record<string, { branch: string; sha: string }> = { "9510": { branch: "feature/fx-rv-free", sha: "9".repeat(40) } };
  const cp = createRequire(import.meta.url)("node:child_process");
  const customPromisify = Symbol.for("nodejs.util.promisify.custom");
  const execStub: any = () => { throw new Error("execFile must be invoked through promisify"); };
  execStub[customPromisify] = async (cmd: string, args: string[] = []) => {
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      const target = String(args[2]);
      const forged = forgePulls[target.replace(/^.*\//, "")];
      if (forged) return { stdout: JSON.stringify({ headRefName: forged.branch, headRefOid: forged.sha, baseRefName: "main" }), stderr: "" };
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
  let seedStacked: (() => void) | undefined;
  let seedStackedFix: (() => void) | undefined;
  let seedE7: (() => void) | undefined;
  let seedAbsorbed: (() => void) | undefined;
  let seedStall: ((agedMs: number) => void) | undefined;
  let seedFe: (() => void) | undefined;
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
    insert({ thread_id: "thr_fx_lad_c", role: "worker", title: "Fixture ladder worker c", state: "ready", branch: "feature/fx-lad-c", pr_url: "https://github.com/o/r/pull/9005", reviewed_head_sha: "3".repeat(40), result: "Fixture result", summary: "Fixture summary", report_seq: 1, last_report_state: "ready", brief: "Fixture ladder worker c brief" }, 43);
    // The idle-ready fixture: a plan of two independent waves whose workers both reported ready (e1d idles the first).
    insert({ thread_id: "thr_fx_id_planner", role: "planner", title: "Fixture idle-ready planner", state: "ready", result: "Fixture idle-ready plan", summary: "Fixture idle-ready plan summary", plan_waves: JSON.stringify([
      { path: `${FILES_ROOT}/thr_fx_id_planner/plan-1.md`, contracts: "Fixture idle-ready contract 1", dependsOn: [] },
      { path: `${FILES_ROOT}/thr_fx_id_planner/plan-2.md`, contracts: "Fixture idle-ready contract 2", dependsOn: [] },
    ]), report_seq: 1, last_report_state: "ready", brief: "Fixture idle-ready planner brief" }, 60);
    for (const [index, id] of ["a", "b"].entries()) {
      insert({ thread_id: `thr_fx_id_${id}`, role: "worker", title: `Fixture idle-ready worker ${id}`, state: "ready", branch: `feature/fx-id-${id}`, pr_url: `https://github.com/o/r/pull/${9201 + index}`, reviewed_head_sha: String(index + 5).repeat(40),
        plan_thread_id: "thr_fx_id_planner", plan_wave: index + 1, result: "Fixture result", summary: "Fixture summary", report_seq: 1, last_report_state: "ready", brief: `Fixture idle-ready worker ${id} brief` }, 61 + index);
    }
    // The stacked-plan fixture: a chain of three waves, each on its own branch and pull request (no replaces:), all ready.
    // Seeded by e1e itself, so the earlier categories read the same rows as before it existed.
    seedStacked = () => {
      insert({ thread_id: "thr_fx_st_planner", role: "planner", title: "Fixture stacked planner", state: "ready", result: "Fixture stacked plan", summary: "Fixture stacked plan summary", plan_waves: JSON.stringify([
        { path: `${FILES_ROOT}/thr_fx_st_planner/plan-1.md`, contracts: "Fixture stacked contract 1", dependsOn: [] },
        { path: `${FILES_ROOT}/thr_fx_st_planner/plan-2.md`, contracts: "Fixture stacked contract 2", dependsOn: [1] },
        { path: `${FILES_ROOT}/thr_fx_st_planner/plan-3.md`, contracts: "Fixture stacked contract 3", dependsOn: [2] },
      ]), report_seq: 1, last_report_state: "ready", brief: "Fixture stacked planner brief" }, 70);
      for (const [index, id] of ["a", "b", "c"].entries()) {
        insert({ thread_id: `thr_fx_st_${id}`, role: "worker", title: `Fixture stacked worker ${id}`, state: "ready", branch: `feature/fx-st-${id}`, pr_url: `https://github.com/o/r/pull/${9301 + index}`, reviewed_head_sha: String(index + 7).repeat(40),
          plan_thread_id: "thr_fx_st_planner", plan_wave: index + 1, result: "Fixture result", summary: "Fixture summary", report_seq: 1, last_report_state: "ready", brief: `Fixture stacked worker ${id} brief` }, 71 + index);
      }
    };
    // The stacked fix-round fixture: the same chain of three stacked waves (no replaces:), all ready, for e1f.
    // Seeded by e1f itself, like e1e's, so the earlier categories read the same rows as before it existed.
    seedStackedFix = () => {
      insert({ thread_id: "thr_fx_sf_planner", role: "planner", title: "Fixture stacked fix planner", state: "ready", result: "Fixture stacked fix plan", summary: "Fixture stacked fix plan summary", plan_waves: JSON.stringify([
        { path: `${FILES_ROOT}/thr_fx_sf_planner/plan-1.md`, contracts: "Fixture stacked fix contract 1", dependsOn: [] },
        { path: `${FILES_ROOT}/thr_fx_sf_planner/plan-2.md`, contracts: "Fixture stacked fix contract 2", dependsOn: [1] },
        { path: `${FILES_ROOT}/thr_fx_sf_planner/plan-3.md`, contracts: "Fixture stacked fix contract 3", dependsOn: [2] },
      ]), report_seq: 1, last_report_state: "ready", brief: "Fixture stacked fix planner brief" }, 80);
      for (const [index, id] of ["a", "b", "c"].entries()) {
        insert({ thread_id: `thr_fx_sf_${id}`, role: "worker", title: `Fixture stacked fix worker ${id}`, state: "ready", branch: `feature/fx-sf-${id}`, pr_url: `https://github.com/o/r/pull/${9401 + index}`, reviewed_head_sha: "def"[index]!.repeat(40),
          plan_thread_id: "thr_fx_sf_planner", plan_wave: index + 1, result: "Fixture result", summary: "Fixture summary", report_seq: 1, last_report_state: "ready", brief: `Fixture stacked fix worker ${id} brief` }, 81 + index);
      }
    };
    // The e7 fixtures (review start-up, task chain, thread store): seeded by e7 itself, like e1e's, so the earlier
    // categories read the same rows as before they existed.
    seedE7 = () => {
      const worker = (id: string, offset: number, extra: Record<string, unknown> = {}) => insert({ thread_id: id, role: "worker", title: `Fixture ${id}`, state: "ready", result: "Fixture result", summary: "Fixture summary", report_seq: 1, last_report_state: "ready", brief: `Fixture ${id} brief`, ...extra }, offset);
      // Review start-up: a ready worker with a pull request head, one without any, one that turns busy, one that is archived.
      worker("thr_fx_rv_a", 100, { branch: "feature/fx-rv-a", pr_url: "https://github.com/o/r/pull/9501", reviewed_head_sha: "5".repeat(40) });
      worker("thr_fx_rv_b", 101, { branch: "feature/fx-rv-b" });
      worker("thr_fx_rv_c", 102, { branch: "feature/fx-rv-c" });
      worker("thr_fx_rv_c2", 103, { branch: "feature/fx-rv-c2", state: "idle" });
      worker("thr_fx_rv_d", 104, { branch: "feature/fx-rv-d" });
      // Task chain. bc: two branchless workers, the second replacing the first. sb: three workers on one branch, the third replacing the first.
      const reviewer = (id: string, workerId: string, offset: number, fails?: object[]) => {
        insert({ thread_id: id, role: "reviewer", title: `Fixture review of ${workerId}`, state: "ready", verdict: "request_changes", worker_thread_id: workerId, result: `Fixture review result of ${workerId}`, summary: `Fixture review summary of ${workerId}`, report_seq: 1, last_report_state: "ready", ...(fails ? { fails: JSON.stringify(fails) } : {}) }, offset);
        database.prepare(`INSERT OR REPLACE INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq, head_sha, pr_url, branch) VALUES (?, ?, 1, NULL, NULL, NULL)`).run(id, workerId);
      };
      worker("thr_fx_bc_a", 110, { fails: JSON.stringify([{ text: "Fixture ruled out by bc_a", scope: "server.ts", basis: "tried it", at: at + 1_000 }]) });
      reviewer("thr_fx_bc_a_r", "thr_fx_bc_a", 111, [{ text: "Fixture ruled out by bc_a's reviewer", scope: "app.tsx", basis: "read it", at: at + 2_000 }]);
      worker("thr_fx_bc_b", 112, { replaces_thread_id: "thr_fx_bc_a" });
      worker("thr_fx_sb_a", 120, { branch: "feature/fx-sb" });
      reviewer("thr_fx_sb_a_r", "thr_fx_sb_a", 121);
      worker("thr_fx_sb_b", 122, { branch: "feature/fx-sb" });
      worker("thr_fx_sb_a2", 123, { branch: "feature/fx-sb", replaces_thread_id: "thr_fx_sb_a" });
      reviewer("thr_fx_sb_a2_r", "thr_fx_sb_a2", 124);
      // Thread store. rc: rows reconcileThread moves (live view differs). lc: rows lifecycle events move. stop: a running worker.
      // lg: a plan worker that reads the log. ab: rows the absorbed sweep completes (and one it must leave, because it is busy).
      for (const [index, id] of ["del", "arc", "par", "run"].entries()) worker(`thr_fx_rc_${id}`, 130 + index, { state: "idle" });
      worker("thr_fx_rc_idle", 134, { state: "active", status: "active", active_since: at + 134, active_cycle: 1 });
      worker("thr_fx_rc_stale", 135, { state: "active", status: "active", active_since: at + 135, active_cycle: 1 });
      worker("thr_fx_lc_w", 136, { state: "idle" });
      worker("thr_fx_lc_x", 137);
      worker("thr_fx_stop_w", 138, { state: "active", status: "active", active_since: at + 138, active_cycle: 1 });
      worker("thr_fx_lg_w", 139, { plan_thread_id: "thr_fx_wv_planner", plan_wave: 1 });
      // oa: a design-only wave and its ready designer, for the owner's approval.
      insert({ thread_id: "thr_fx_oa_planner", role: "planner", title: "Fixture approval planner", state: "ready", result: "Fixture approval plan", summary: "Fixture approval plan summary", plan_waves: JSON.stringify([
        { path: `${FILES_ROOT}/thr_fx_oa_planner/plan-1.md`, contracts: "Fixture approval design contract", dependsOn: [], design: true },
        { path: `${FILES_ROOT}/thr_fx_oa_planner/plan-2.md`, contracts: "Fixture approval build contract", dependsOn: [1] },
      ]), report_seq: 1, last_report_state: "ready", brief: "Fixture approval planner brief" }, 144);
      worker("thr_fx_oa_w", 145, { kind: "designer", plan_thread_id: "thr_fx_oa_planner", plan_wave: 1 });
    };
    // The absorbed-sweep fixtures: a complete worker with two advisors and a ready researcher. Seeded by the store category
    // itself, because a Chief idle event (the reload) sweeps them at once.
    seedAbsorbed = () => {
      insert({ thread_id: "thr_fx_ab_w", role: "worker", title: "Fixture absorbed worker", state: "complete", result: "Fixture result", summary: "Fixture summary", report_seq: 1, last_report_state: "ready", brief: "Fixture absorbed worker brief" }, 140);
      insert({ thread_id: "thr_fx_ab_adv", role: "advisor", title: "Fixture absorbed advisor", state: "idle", worker_thread_id: "thr_fx_ab_w", brief: "Fixture absorbed advisor brief" }, 141);
      insert({ thread_id: "thr_fx_ab_busy", role: "advisor", title: "Fixture busy advisor", state: "idle", worker_thread_id: "thr_fx_ab_w", brief: "Fixture busy advisor brief" }, 142);
      insert({ thread_id: "thr_fx_ab_res", role: "researcher", title: "Fixture ready researcher", state: "ready", result: "Fixture research result", brief: "Fixture researcher brief" }, 143);
    };
    // The stall fixture: a worker whose turn began agedMs ago. Seeded with the clock at seed time, aged again by the caller.
    seedStall = (agedMs: number) => {
      insert({ thread_id: "thr_fx_stall_w", role: "worker", title: "Fixture stalled worker", state: "active", status: "active", active_since: clock - agedMs, active_cycle: 1, brief: "Fixture stalled worker brief", branch: "feature/fx-stall" }, 150);
    };
    // The failure-event fixtures: workers whose failures and stalls category g drives. Seeded by g itself, so earlier categories read the same rows.
    // The lg rows are the sources of the legacy alerts seeded before the plugin loads.
    seedFe = () => {
      const worker = (id: string, offset: number, extra: Record<string, unknown>) => insert({ thread_id: id, role: "worker", title: `Fixture ${id}`, brief: `Fixture ${id} brief`, ...extra }, offset);
      worker("thr_fx_fe_w", 160, { state: "idle" });
      worker("thr_fx_fe_title", 161, { state: "idle", title: "Fixture fe usage limit dashboard" });
      for (const [offset, id] of [[162, "thr_fx_fe_st_a"], [163, "thr_fx_fe_st_b"]] as const) worker(id, offset, { state: "active", status: "active", active_since: clock - 20 * 60_000, active_cycle: 1 });
      worker("thr_fx_fe_lg_a", 164, { state: "complete", title: "Fixture fe legacy a" });
      worker("thr_fx_fe_lg_b", 165, { state: "complete", title: "Fixture fe legacy b" });
    };
    // The wave-schedule fixture: a planner that has not reported its plan yet (e1c drives it through tools).
    insert({ thread_id: "thr_fx_wv_planner", role: "planner", title: "Fixture wave planner", state: "active", status: "idle", active_since: clock - 5_000, active_cycle: 1, brief: "Fixture wave planner brief" }, 50);
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
  const commandEvents = new Map<string, any[]>(); // a worker's recorded commands (item/completed events, newest first)
  const pluginMetadata = new Map<string, object>(); // spawn-seeded metadata of a thread no managed row carries yet
  const getHooks = new Map<string, () => Promise<unknown>>(); // runs once, while a threads.get is in flight (a stale-row race)
  const providerErrors = new Map<string, any[] | "throw">(); // a thread's provider/error events (newest first); "throw" fails the read
  let failSend = false; // while set, every threads.send fails after recording `send-failed`
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
  const sdk = {
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
        events: { list: async ({ threadId, types }: { threadId: string; types?: string[] }) => {
          if (types?.includes("item/completed")) return commandEvents.get(threadId) ?? [];
          if (types?.includes("provider/error")) {
            const found = providerErrors.get(threadId);
            if (found === "throw") throw new Error("snapshot: provider error read failed");
            return found ?? [];
          }
          return [];
        } },
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
        getPluginMetadata: async ({ threadId }: { threadId: string }) => pluginMetadata.get(threadId) ?? {},
        storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: "host_storage", storageRootPath: `${FILES_ROOT}/${threadId}` }),
        get: async ({ threadId }: { threadId: string }) => {
          const found = liveThreads.get(threadId) ?? storedThread(threadId);
          if (!found) throw new Error("not found");
          const snapshot = { ...found, ...overrides.get(threadId) };
          const hook = getHooks.get(threadId);
          if (hook) { getHooks.delete(threadId); await hook(); }
          return snapshot;
        },
        update: async ({ threadId, ...changes }: any) => {
          events.push(`update ${threadId} ${stable(changes)}`);
          overrides.set(threadId, { ...overrides.get(threadId), ...changes });
          const found = liveThreads.get(threadId) ?? storedThread(threadId);
          if (!found) throw new Error("not found");
          return { ...found, ...overrides.get(threadId) };
        },
        send: async (args: any) => {
          if (failSend) { events.push(`send-failed ${stable(args)}`); throw new Error("snapshot: send failed"); }
          events.push(`send ${stable(args)}`);
          return { ok: true, delivery: "sent" as const };
        },
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
  };
  // The plugin writes to the copy, not to the fake host's own temp database. Its migrations still run (and are verified) on it.
  const host = (storage: Database.Database) => {
    const { bb: fake, harness: built } = createFakePluginHost({ pluginId: "chief", agentSkillIds: skillIds, sdk } as never);
    return { bb: Object.create(fake, { storage: { value: { ...fake.storage, database: () => storage } } }) as any, harness: built };
  };
  const { bb, harness } = host(database);

  // Legacy failure alerts, written before the plugin loads so a build that backfills them finds them. Literal values only.
  // The pending one is created in the future, so no retry pass in this capture delivers it.
  if (chief) {
    const legacy = (key: string, message: string, createdAt: number, delivered: boolean) => database.prepare(
      `INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, delivered_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(key, chief.thread_id, key.slice(0, key.indexOf(":")), `[Chief lifecycle alert]\n${message}`, delivered ? createdAt + 1_000 : null, delivered ? 1 : 0, createdAt);
    const failed = (reason: string) => `worker “Fixture legacy” (thr_fx_fe_lg_a) failed on a transient provider error: ${reason}.`;
    legacy("thr_fx_fe_lg_a:failed:1", failed("provider usage limit (HTTP 429)"), clock - 50_000, true);
    legacy("thr_fx_fe_lg_a:failed:2", failed("connection/provider error"), clock + 86_400_000, false);
    legacy("thr_fx_fe_lg_b:stall:1", "worker “Fixture legacy b” (thr_fx_fe_lg_b) has been active for 20 minutes (stall threshold 15).", clock - 40_000, true);
    legacy("thr_fx_fe_lg_b:stall:1:hard", "worker “Fixture legacy b” (thr_fx_fe_lg_b) has been active for 40 minutes, twice the 15-minute stall threshold.", clock - 30_000, true);
    legacy("thr_fx_fe_lg_b:error:3", "worker “Fixture legacy b” (thr_fx_fe_lg_b) failed.", clock - 20_000, true);
    legacy("thr_fx_fe_lg_b:report:1:abc", "worker “Fixture legacy b” (thr_fx_fe_lg_b) reported ready.", clock - 10_000, true);
  }

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
    // Literal fixtures: never import the plugin's limits, so both builds read the same input.
    const snapFindings = (kind: string) => kind === "approve" ? [] : [{ file: "server.ts", line: 1, severity: "blocking", message: "Snapshot blocking finding.", fix: "Snapshot complete fix." }];
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
    const ladder = async (name: string, firstWorker: string, extraBranchWorker?: string, repointedOnly = false) => {
      const start = one(`SELECT chief_thread_id, project_id FROM managed_threads WHERE thread_id=?`, firstWorker);
      if (!start) { await step(`ladder ${name}: no ${firstWorker} in the copy`, () => "skipped"); return; }
      const owner = start.chief_thread_id as string;
      const project = start.project_id as string;
      const verdict = (kind: string) => ({ state: "ready", verdict: kind, findings: snapFindings(kind), summary: `Snapshot ladder ${kind}`, result: `Snapshot ladder review: ${kind}.` });
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
      if (repointedOnly) {
        // The reviewer is still open and now points at the fresh worker (report_seq NULL): its next verdict row binds report -1.
        await ladderStep(`ladder ${name} reviewer approves after the re-point`, () => ladderReport(reviewerOf(tip), verdict("approve"), project));
        await ready("round 1", tip);
        await ladderStep(`ladder ${name} chief_complete ${tip}`, () => tool("chief_complete", { threadId: tip }, owner, project));
        return;
      }
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
    await ladder("re-pointed", "thr_fx_lad_c", undefined, true);
    // e1c. the wave schedule, driven only through tools: a planner reports 4 waves (a two-wave chain, then a
    // design-only wave and the wave that implements it), the waves are delegated once the owner approves the design,
    // one review covers both chain tips, one tip is replaced, and every worker completes. Each step records its
    // text, alerts, spawn prompts and the tables, a refusal included.
    begin("e1c-wave-schedule");
    {
      const planner = "thr_fx_wv_planner";
      const start = one(`SELECT chief_thread_id, project_id FROM managed_threads WHERE thread_id=?`, planner);
      if (!start) { await step("wave schedule: no planner fixture in the copy", () => "skipped"); }
      else {
        const owner = start.chief_thread_id as string;
        const project = start.project_id as string;
        const spawnedBeforeWaves = spawnIndex;
        const mineWave = (column: string) => `(${column}='${planner}' OR ${column} IN (SELECT thread_id FROM managed_threads WHERE plan_thread_id='${planner}') OR (${column} LIKE 'thr_snap_%' AND CAST(substr(${column}, 10) AS INTEGER) > ${spawnedBeforeWaves}))`;
        const waveTables = () => [["managed_threads", "thread_id", "thread_id"], ["reviewer_verdicts", "reviewer_thread_id", "id"], ["review_targets", "reviewer_thread_id", "reviewer_thread_id, worker_thread_id"], ["alert_outbox", "source_thread_id", "rowid"]]
          .map(([table, column, order]) => `${table}\n${(database.prepare(`SELECT * FROM ${table} WHERE ${mineWave(column!)} ORDER BY ${order}`).all() as object[]).map(stable).join("\n")}`)
          .concat(`plan_log\n${(database.prepare(`SELECT * FROM plan_log WHERE plan_thread_id=? ORDER BY id`).all(planner) as object[]).map(stable).join("\n")}`).join("\n");
        const waveStep = (label: string, fn: () => unknown) => step(`waves: ${label}`, async () => {
          let outcome: string;
          try { outcome = show(await fn()); } catch (error) { outcome = `ERR ${error instanceof Error ? error.message : String(error)}`; }
          return `${outcome}\n${waveTables()}`;
        });
        const workerOf = (wave: number) => one(`SELECT thread_id FROM managed_threads WHERE role='worker' AND plan_thread_id=? AND plan_wave=? ORDER BY created_at DESC, rowid DESC LIMIT 1`, planner, wave)?.thread_id as string | undefined;
        const reviewerOfWave = (workerId: string | undefined) => (workerId ? one(`SELECT r.thread_id FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id=? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`, workerId)?.thread_id as string | undefined : undefined);
        const as = (id: string | undefined, name: string, params: unknown, chiefCalls = false) => (id ? tool(name, params, chiefCalls ? owner : id, project) : "no such thread");
        const body = (n: number) => `# Wave ${n}\nDo the work of wave ${n}.\n\n## Contracts to verify\n- Wave ${n} keeps its invariant\n\n## What we're NOT doing\n- Nothing else`;
        const ready = { state: "ready", summary: "Snapshot wave worker summary", result: "Changed server.ts:1.\n\n## Deviations from plan\nNone\n\n## Verification\nAutomated: npm test; echo=0\nManual: none" };
        const verdict = (kind: string) => ({ state: "ready", verdict: kind, findings: snapFindings(kind), summary: `Snapshot wave ${kind}`, result: `Snapshot wave review: ${kind}.` });
        const delegate = (n: number, extra: object = {}) => tool("chief_delegate", { title: `Snapshot plan wave ${n}`, mission: `Snapshot mission, wave ${n}`, planThreadId: planner, wave: n, ...extra }, owner, project);
        const review = (workerId: string | undefined) => as(workerId, "chief_review", { workerThreadId: workerId }, true);
        const roster = (label: string) => waveStep(`chief_roster ${label}`, () => tool("chief_roster", { includeComplete: true }, owner, project));

        await waveStep("planner reports 4 waves", () => tool("chief_report", { state: "ready", summary: "Snapshot wave plan", result: "Snapshot wave plan result", plan: [
          { body: body(1) }, { body: body(2), dependsOn: [1] }, { body: body(3), dependsOn: [], design: true }, { body: body(4), dependsOn: [3] },
        ] }, planner, project));
        await roster("after the plan");
        // Each chain has its own branch and pull request; the forge stub answers a head for the first worker row of each.
        await waveStep("delegate wave 1", () => delegate(1, { branch: "feature/wv-a", prUrl: "https://github.com/o/r/pull/9101" }));
        await waveStep("delegate wave 3", () => delegate(3, { branch: "feature/wv-b", prUrl: "https://github.com/o/r/pull/9102" }));
        await waveStep("delegate wave 4 before the design wave is ready", () => delegate(4));
        await roster("after waves 1 and 3");
        const [w1, w3] = [workerOf(1), workerOf(3)];
        for (const [id, head] of [[w1, "c"], [w3, "d"]] as const) database.prepare(`UPDATE managed_threads SET reviewed_head_sha=? WHERE thread_id=?`).run(head.repeat(40), id);
        await waveStep("worker 3 ready", () => as(w3, "chief_report", ready));
        await waveStep("worker 1 ready", () => as(w1, "chief_report", ready));
        await roster("after both are ready");
        await waveStep("chief_review the design wave refused", () => review(w3));
        await waveStep("chief_review wave 1 between waves refused", () => review(w1));
        await waveStep("chief_owner_approval on a non-design worker refused", () => as(w1, "chief_owner_approval", { workerThreadId: w1, approval: "Snapshot: approved" }, true));
        await waveStep("delegate wave 4 unapproved", () => delegate(4, { replaces: w3 }));
        await waveStep("chief_owner_approval the design worker", () => as(w3, "chief_owner_approval", { workerThreadId: w3, approval: "Snapshot: approved, ship it" }, true));
        await waveStep("worker 3 reports again, which clears the approval", () => as(w3, "chief_report", ready));
        await waveStep("delegate wave 4 after the approval was cleared", () => delegate(4, { replaces: w3 }));
        await waveStep("chief_owner_approval the design worker again", () => as(w3, "chief_owner_approval", { workerThreadId: w3, approval: "Snapshot: approved again" }, true));
        await waveStep("delegate wave 2 replaces wave 1", () => delegate(2, { replaces: w1 }));
        await waveStep("delegate wave 4 replaces the design worker", () => delegate(4, { replaces: w3 }));
        const [w2, w4] = [workerOf(2), workerOf(4)];
        await roster("after all four waves are delegated");
                for (const [name, id] of [["1", w1], ["2", w2], ["3", w3], ["4", w4]] as const) {
          await waveStep(`chief_log wave ${name} worker`, () => as(id, "chief_log", name === "2" ? { entries: [{ kind: "FACT", text: "Snapshot fact", scope: "server.ts", basis: "read it" }] } : {}));
        }
        await waveStep("worker 2 ready", () => as(w2, "chief_report", ready));
        await waveStep("chief_review wave 2, wave 4 not ready", () => review(w2));
        await waveStep("worker 4 ready", () => as(w4, "chief_report", ready));
        await waveStep("chief_review the tip: one review of the plan", () => review(w4));
        await waveStep("chief_review wave 2 again", () => review(w2));
        await roster("in review");
        await waveStep("reviewer request_changes", () => as(reviewerOfWave(w4), "chief_report", verdict("request_changes")));
        await waveStep("delegate replaces wave 4's worker", () => delegate(4, { replaces: w4 }));
        const w5 = workerOf(4);
        await waveStep("chief_review the superseded tip refused", () => review(w4));
        await waveStep("replacement ready", () => as(w5, "chief_report", ready));
        await waveStep("chief_review the replaced tip", () => review(w5));
        await waveStep("reviewer approves", () => as(reviewerOfWave(w5), "chief_report", verdict("approve")));
        await roster("approved");
        // Replaced workers are complete already; the two tips remain, and the planner completes with the last.
        for (const id of [w2, w5]) {
          await waveStep(`chief_complete ${id}`, () => as(id, "chief_complete", { threadId: id }, true));
          await waveStep(`planner state after ${id}`, () => one(`SELECT state FROM managed_threads WHERE thread_id=?`, planner)?.state);
        }
        await roster("complete");
      }
    }
    // e1d. an idle worker whose last report was ready, driven through lifecycle events: the first tip of a two-branch
    // plan goes active and idle again without a report (its row leaves ready, its last report stays ready), while the
    // later tip is ready. The plan's one review must still start, and must be named on the ready tip.
    begin("e1d-idle-ready");
    {
      const planner = "thr_fx_id_planner";
      const start = one(`SELECT chief_thread_id, project_id FROM managed_threads WHERE thread_id=?`, planner);
      if (!start) { await step("idle-ready: no planner fixture in the copy", () => "skipped"); }
      else {
        const owner = start.chief_thread_id as string;
        const project = start.project_id as string;
        const spawnedBeforeIdle = spawnIndex;
        const mineIdle = (column: string) => `(${column} LIKE 'thr_fx_id_%' OR (${column} LIKE 'thr_snap_%' AND CAST(substr(${column}, 10) AS INTEGER) > ${spawnedBeforeIdle}))`;
        const idleTables = () => [["managed_threads", "thread_id", "thread_id"], ["reviewer_verdicts", "reviewer_thread_id", "id"], ["review_targets", "reviewer_thread_id", "reviewer_thread_id, worker_thread_id"]]
          .map(([table, column, order]) => `${table}\n${(database.prepare(`SELECT * FROM ${table} WHERE ${mineIdle(column!)} ORDER BY ${order}`).all() as object[]).map(stable).join("\n")}`).join("\n");
        const idleStep = (label: string, fn: () => unknown) => step(`idle-ready: ${label}`, async () => {
          let outcome: string;
          try { outcome = show(await fn()); } catch (error) { outcome = `ERR ${error instanceof Error ? error.message : String(error)}`; }
          return `${outcome}\n${idleTables()}`;
        });
        const lifecycle = async (event: "thread.active" | "thread.idle", id: string) => {
          overrides.set(id, { status: event === "thread.active" ? "active" : "idle" });
          const result = await harness.emitThreadEvent(event, { thread: storedThread(id)! } as never);
          return `${event} ${id}: ${result.errors.length} errors`;
        };
        const reviewerOfIdle = (workerId: string) => one(`SELECT r.thread_id FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id=? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`, workerId)?.thread_id as string | undefined;
        await idleStep("chief_roster before", () => tool("chief_roster", { includeComplete: true }, owner, project));
        await idleStep("worker a turn starts", () => lifecycle("thread.active", "thr_fx_id_a"));
        await idleStep("worker a turn ends without a report", () => lifecycle("thread.idle", "thr_fx_id_a"));
        await idleStep("chief_roster with the first tip idle", () => tool("chief_roster", { includeComplete: true }, owner, project));
        await idleStep("chief_review the first tip", () => tool("chief_review", { workerThreadId: "thr_fx_id_a" }, owner, project));
        await idleStep("chief_review the ready tip", () => tool("chief_review", { workerThreadId: "thr_fx_id_b" }, owner, project));
        await idleStep("reviewer approves", () => { const id = reviewerOfIdle("thr_fx_id_b"); return id ? tool("chief_report", { state: "ready", verdict: "approve", findings: snapFindings("approve"), summary: "Snapshot idle-ready approve", result: "Snapshot idle-ready review: approve." }, id, project) : "no reviewer"; });
        for (const id of ["thr_fx_id_a", "thr_fx_id_b"]) {
          await idleStep(`chief_complete ${id}`, () => tool("chief_complete", { threadId: id }, owner, project));
          await idleStep(`planner state after ${id}`, () => one(`SELECT state FROM managed_threads WHERE thread_id=?`, planner)?.state);
        }
      }
    }
    // e1e. a stacked plan: three waves on their own branches and pull requests, none delegated with replaces:. The tip's one
    // review must record an approve for every wave (each at its own head), so each earlier wave completes without an override;
    // a moved head on one wave must still refuse it. The last step completes any leftover with an override, so both builds
    // leave the same live rows for e2 onward.
    begin("e1e-stacked-review");
    seedStacked?.();
    {
      const planner = "thr_fx_st_planner";
      const start = one(`SELECT chief_thread_id, project_id FROM managed_threads WHERE thread_id=?`, planner);
      // The server caches rows; an idle event on the Chief (already idle) makes it reload, and nothing else changes.
      if (start) await harness.emitThreadEvent("thread.idle", { thread: storedThread(start.chief_thread_id as string)! } as never);
      if (!start) { await step("stacked: no planner fixture in the copy", () => "skipped"); }
      else {
        const owner = start.chief_thread_id as string;
        const project = start.project_id as string;
        const spawnedBeforeStacked = spawnIndex;
        const mineStacked = (column: string) => `(${column} LIKE 'thr_fx_st_%' OR (${column} LIKE 'thr_snap_%' AND CAST(substr(${column}, 10) AS INTEGER) > ${spawnedBeforeStacked}))`;
        const stackedTables = () => [["managed_threads", "thread_id", "thread_id"], ["reviewer_verdicts", "reviewer_thread_id", "id"], ["review_targets", "reviewer_thread_id", "reviewer_thread_id, worker_thread_id"]]
          .map(([table, column, order]) => `${table}\n${(database.prepare(`SELECT * FROM ${table} WHERE ${mineStacked(column!)} ORDER BY ${order}`).all() as object[]).map(stable).join("\n")}`).join("\n");
        const stackedStep = (label: string, fn: () => unknown) => step(`stacked: ${label}`, async () => {
          let outcome: string;
          try { outcome = show(await fn()); } catch (error) { outcome = `ERR ${error instanceof Error ? error.message : String(error)}`; }
          return `${outcome}\n${stackedTables()}`;
        });
        const reviewerOfStacked = (workerId: string) => one(`SELECT r.thread_id FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id=? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`, workerId)?.thread_id as string | undefined;
        const setHead = (id: string, head: string) => database.prepare(`UPDATE managed_threads SET reviewed_head_sha=? WHERE thread_id=?`).run(head.repeat(40), id);
        await stackedStep("chief_roster before", () => tool("chief_roster", { includeComplete: true }, owner, project));
        await stackedStep("chief_review the first wave", () => tool("chief_review", { workerThreadId: "thr_fx_st_a" }, owner, project));
        await stackedStep("chief_review the tip", () => tool("chief_review", { workerThreadId: "thr_fx_st_c" }, owner, project));
        await stackedStep("reviewer approves", () => { const id = reviewerOfStacked("thr_fx_st_c"); return id ? tool("chief_report", { state: "ready", verdict: "approve", findings: snapFindings("approve"), summary: "Snapshot stacked approve", result: "Snapshot stacked review: approve." }, id, project) : "no reviewer"; });
        await stackedStep("chief_complete thr_fx_st_a", () => tool("chief_complete", { threadId: "thr_fx_st_a" }, owner, project));
        setHead("thr_fx_st_b", "e");
        await stackedStep("chief_complete thr_fx_st_b with its head moved", () => tool("chief_complete", { threadId: "thr_fx_st_b" }, owner, project));
        setHead("thr_fx_st_b", "8");
        for (const id of ["thr_fx_st_b", "thr_fx_st_c"]) {
          await stackedStep(`chief_complete ${id}`, () => tool("chief_complete", { threadId: id }, owner, project));
          await stackedStep(`planner state after ${id}`, () => one(`SELECT state FROM managed_threads WHERE thread_id=?`, planner)?.state);
        }
        for (const id of ["thr_fx_st_a", "thr_fx_st_b", "thr_fx_st_c"]) {
          if (one(`SELECT state FROM managed_threads WHERE thread_id=?`, id)?.state !== "complete") {
            await stackedStep(`converge ${id}`, () => tool("chief_complete", { threadId: id, override: "Snapshot: converge stacked fixture" }, owner, project));
          }
        }
      }
    }
    // e1f. a stacked plan's fix round: the tip's one review requests changes on the chain of three waves, each on its own
    // branch and pull request. Each wave is then fixed with replaces: and reports ready, the review is refused, and the
    // second round reaches the consult rung. Every step records its text, the alerts and the tables. The last step completes
    // any leftover with an override, so both builds leave the same live rows for e2 onward.
    begin("e1f-stacked-fix-round");
    seedStackedFix?.();
    {
      const planner = "thr_fx_sf_planner";
      const start = one(`SELECT chief_thread_id, project_id FROM managed_threads WHERE thread_id=?`, planner);
      // The server caches rows; an idle event on the Chief (already idle) makes it reload, and nothing else changes.
      if (start) await harness.emitThreadEvent("thread.idle", { thread: storedThread(start.chief_thread_id as string)! } as never);
      if (!start) { await step("stacked fix: no planner fixture in the copy", () => "skipped"); }
      else {
        const owner = start.chief_thread_id as string;
        const project = start.project_id as string;
        const spawnedBeforeFix = spawnIndex;
        const mineFix = (column: string) => `(${column} LIKE 'thr_fx_sf_%' OR (${column} LIKE 'thr_snap_%' AND CAST(substr(${column}, 10) AS INTEGER) > ${spawnedBeforeFix}))`;
        const fixTables = () => [["managed_threads", "thread_id", "thread_id"], ["reviewer_verdicts", "reviewer_thread_id", "id"], ["review_targets", "reviewer_thread_id", "reviewer_thread_id, worker_thread_id"], ["alert_outbox", "source_thread_id", "rowid"]]
          .map(([table, column, order]) => `${table}\n${(database.prepare(`SELECT * FROM ${table} WHERE ${mineFix(column!)} ORDER BY ${order}`).all() as object[]).map(stable).join("\n")}`).join("\n");
        const fixStep = (label: string, fn: () => unknown) => step(`stacked fix: ${label}`, async () => {
          let outcome: string;
          try { outcome = show(await fn()); } catch (error) { outcome = `ERR ${error instanceof Error ? error.message : String(error)}`; }
          return `${outcome}\n${fixTables()}`;
        });
        const reviewerOfFix = (workerId: string) => one(`SELECT r.thread_id FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id=? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`, workerId)?.thread_id as string | undefined;
        const replacementOf = (workerId: string) => one(`SELECT thread_id FROM managed_threads WHERE role='worker' AND replaces_thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`, workerId)?.thread_id as string | undefined;
        const as = (id: string | undefined, params: unknown) => (id ? tool("chief_report", params, id, project) : "no such thread");
        const ready = { state: "ready", summary: "Snapshot stacked fix worker summary", result: "Changed server.ts:1.\n\n## Deviations from plan\nNone\n\n## Verification\nAutomated: npm test; echo=0\nManual: none" };
        const verdict = { state: "ready", verdict: "request_changes", findings: snapFindings("request_changes"), summary: "Snapshot stacked fix request_changes", result: "Snapshot stacked fix review: request_changes." };
        const fix = (id: string) => tool("chief_delegate", { title: "Snapshot stacked fix", mission: "Snapshot stacked fix mission", replaces: id }, owner, project);
        await fixStep("chief_review the tip", () => tool("chief_review", { workerThreadId: "thr_fx_sf_c" }, owner, project));
        await fixStep("reviewer request_changes", () => as(reviewerOfFix("thr_fx_sf_c"), verdict));
        await fixStep("chief_roster before the fix", () => tool("chief_roster", { includeComplete: true }, owner, project));
        await fixStep("chief_delegate replaces wave 1", () => fix("thr_fx_sf_a"));
        const f1 = replacementOf("thr_fx_sf_a");
        await fixStep("wave 1 fix ready", () => as(f1, ready));
        await fixStep("chief_review the wave 1 fix refused", () => (f1 ? tool("chief_review", { workerThreadId: f1 }, owner, project) : "no such thread"));
        await fixStep("chief_roster after the wave 1 fix", () => tool("chief_roster", { includeComplete: true }, owner, project));
        await fixStep("chief_delegate replaces wave 2", () => fix("thr_fx_sf_b"));
        const f2 = replacementOf("thr_fx_sf_b");
        await fixStep("wave 2 fix ready", () => as(f2, ready));
        await fixStep("chief_delegate replaces wave 3", () => fix("thr_fx_sf_c"));
        const f3 = replacementOf("thr_fx_sf_c");
        await fixStep("wave 3 fix ready", () => as(f3, ready));
        await fixStep("chief_review the new tip", () => (f3 ? tool("chief_review", { workerThreadId: f3 }, owner, project) : "no such thread"));
        await fixStep("second reviewer request_changes", () => as(f3 ? reviewerOfFix(f3) : undefined, verdict));
        await fixStep("chief_roster after the second review", () => tool("chief_roster", { includeComplete: true }, owner, project));
        for (const { thread_id: id } of database.prepare(`SELECT thread_id FROM managed_threads WHERE ${mineFix("thread_id")} AND state NOT IN ('complete','archived','deleted') ORDER BY thread_id`).all() as { thread_id: string }[]) {
          await fixStep(`converge ${id}`, () => tool("chief_complete", { threadId: id, override: "Snapshot: converge stacked fix fixture" }, owner, project));
        }
      }
    }
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
        ["approve", { state: "ready", verdict: "approve", findings: snapFindings("approve"), summary: "Snapshot approve", result: "Snapshot review: nothing blocks the merge." }],
        ["request_changes", { state: "ready", verdict: "request_changes", findings: snapFindings("request_changes"), summary: "Snapshot reject", result: "Snapshot review: server.ts:1 is wrong." }],
        ["request_changes regression", { state: "ready", verdict: "request_changes", findings: snapFindings("request_changes"), regression: true, summary: "Snapshot regression", result: "Snapshot review: server.ts:1 regressed." }],
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

    // e2-research: chief_research. Every `bb workflows` call throws "snapshot: … is stubbed", so the failure paths are
    // deterministic. The one stop timer armed here (the spawned researcher's hard deadline, about 10 minutes out) is
    // longer than 10 s, so the clock stub leaves it a real, unref'd timer that cannot fire during a capture.
    begin("e2-research");
    {
      const callsBefore = (database.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM chief_research_calls`).get() as { m: number }).m;
      const owner = chief ? { id: chief.thread_id, project: chief.project_id } : null;
      const askedAs = (id: string | undefined, project: string | undefined, params: unknown) => (id && project ? tool("chief_research", params, id, project) : "no such thread");
      const survey = { mode: "survey", question: "Snapshot question", items: ["a.ts", "b.ts"], batchSize: 1 };
      const investigate = { mode: "investigate", question: "Snapshot question", questions: ["Snapshot sub-question one", "Snapshot sub-question two"] };
      const live = (role: string) => rows().find((row) => row.role === role && row.thread_id.startsWith(`thr_fx_${role}_`));
      // 1. Refusals by role: worker, reviewer and advisor, and a thread that has no managed row.
      for (const role of ["worker", "reviewer", "advisor"]) {
        const row = live(role);
        await step(`chief_research as a ${role} (${row?.thread_id ?? "none"}, ${row?.state ?? "-"})`, () => askedAs(row?.thread_id, row?.project_id, survey));
      }
      await step("chief_research as an unmanaged thread", () => askedAs("thr_unmanaged", owner?.project ?? "proj_snap", survey));
      const planner = live("planner");
      await step(`planner ${planner?.thread_id ?? "none"} state before research`, () => planner && `${planner.state}/${planner.status}`);
      // 2. A planner starts a survey, then an investigate; the server cannot start either, so each says to run it by hand.
      await step("planner survey: start_failed fallback", () => askedAs(planner?.thread_id, planner?.project_id, survey));
      await step("planner investigate: start_failed fallback (Combine kept)", () => askedAs(planner?.thread_id, planner?.project_id, investigate));
      await step("planner call with an invalid mode", () => askedAs(planner?.thread_id, planner?.project_id, { ...survey, mode: "nonsense" }));
      // 3. Over the agent-call cap: 40 scan agents and a verify agent.
      await step("planner survey over the cap", () => askedAs(planner?.thread_id, planner?.project_id, { ...survey, items: Array.from({ length: 40 }, (_, i) => `file${i}.ts`) }));
      // 5a. A planner resumes a run that does not exist: three status reads fail, and the call says so at once.
      await step("planner resumes a fabricated runId: status read fails", () => askedAs(planner?.thread_id, planner?.project_id, { mode: "survey", runId: "run_fabricated" }));
      // 4. Chief starts a survey. It needs a researcher pick (else Chief's own model, which the stub cannot read).
      await step("rpc setResearchModel survey", () => rpc("setResearchModel", { hostId: HOST, mode: "survey", selection: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "high" } }));
      await step("chief survey: researcher thread spawned", () => askedAs(owner?.id, owner?.project, survey));
      await step("chief investigate: no investigate pick, so Chief's own model is needed and refused", () => askedAs(owner?.id, owner?.project, investigate));
      const researcher = () => database.prepare(`SELECT thread_id, project_id FROM managed_threads WHERE role='researcher' AND title LIKE 'Research · survey%' AND thread_id LIKE 'thr_snap_%' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { thread_id: string; project_id: string } | undefined;
      const spawned = researcher();
      // The researcher's own calls: investigate (Combine stripped, because the researcher merges), a resume of a run that
      // does not exist (the hard deadline is its spawn plus 10 minutes, so it waits 4 minutes and says it is still running),
      // and a resume with no mode.
      await step("researcher investigate: start_failed fallback (Combine stripped)", () => askedAs(spawned?.thread_id, spawned?.project_id, investigate));
      await step("researcher resumes a fabricated runId: reads retry, then still running", () => askedAs(spawned?.thread_id, spawned?.project_id, { mode: "survey", runId: "run_fabricated" }));
      await step("researcher resumes with no mode", () => askedAs(spawned?.thread_id, spawned?.project_id, { runId: "run_fabricated" }));
      await step("rpc setResearchModel survey cleared", () => rpc("setResearchModel", { hostId: HOST, mode: "survey", selection: null }));
      // 7. Research off, then on again with the original settings: no research line or tool while it is off.
      let original: any;
      await step("rpc researchConfiguration settings", async () => (original = ((await rpc("researchConfiguration", null)) as any).settings));
      const researchConfigured = async (id: string | undefined, project: string | undefined) => {
        if (!id || !project) return "no such thread";
        const resolved = await configure(id, project);
        return `tools=${stable(resolved.tools.map((record: any) => record.name))} research lines=${stable((resolved.instructions ?? "").split("\n").filter((line: string) => line.includes("chief_research")))}`;
      };
      const configureAll = async () => {
        await step("configure Chief", () => researchConfigured(owner?.id, owner?.project));
        await step("configure the planner", () => researchConfigured(planner?.thread_id, planner?.project_id));
        await step("configure the researcher", () => researchConfigured(spawned?.thread_id, spawned?.project_id));
      };
      await configureAll();
      await step("rpc setResearchSettings off", () => rpc("setResearchSettings", { enabled: false }));
      await step("chief_research with research off", () => askedAs(planner?.thread_id, planner?.project_id, survey));
      await configureAll();
      await step("rpc setResearchSettings restore", () => rpc("setResearchSettings", { enabled: original.enabled, maxAgentCalls: original.maxAgentCalls, timeoutMinutes: original.timeoutMinutes }));
      await configureAll();
      // 6. One chief_research_calls row per call that reached the tool (the invalid-mode call fails the schema first).
      await step("chief_research_calls rows added by this category", async () => (database.prepare(`SELECT * FROM chief_research_calls WHERE id > ? ORDER BY id`).all(callsBefore) as object[]).map(stable).join("\n"));
      await step("bb chief stats --json after the research calls", () => (owner ? cli(["stats", "--json"], { threadId: owner.id, projectId: owner.project }) : "no chief"));
    }

    // e3. the start-up sites no earlier category reaches: chief_plan and a branch review (a fresh-worktree reviewer).
    // The ledger and research categories reach the other four; the full spawn arguments and rows land in "f".
    begin("e3-start-sites");
    {
      const owner = chief ? { id: chief.thread_id, project: chief.project_id } : null;
      const asChief = (name: string, input: unknown) => (owner ? tool(name, input, owner.id, owner.project) : "no chief");
      await step("chief_plan", () => asChief("chief_plan", { title: "Snapshot start-site plan", mission: "Snapshot plan mission", context: "Snapshot plan context" }));
      await step("chief_review of a branch no worker carries", () => asChief("chief_review", { branch: "feature/snapshot-branch-review", focus: "Snapshot focus" }));
      await step("chief_review of the same branch again", () => asChief("chief_review", { branch: "feature/snapshot-branch-review" }));
    }

    // e7. the paths later waves move, one category each. Every step label begins with the server.ts function it covers.
    // The fixtures are seeded here (seedE7), so the earlier categories read the same rows as before. Each step records its
    // text, the spawn arguments and alerts, and the rows its fixtures (and any thread it spawned) hold afterwards.
    const e7 = (prefixes: string[]) => {
      const spawnedBefore = spawnIndex;
      const mine = (column: string) => `(${prefixes.map((prefix) => `substr(${column}, 1, ${prefix.length}) = '${prefix}'`).join(" OR ")} OR (${column} LIKE 'thr_snap_%' AND CAST(substr(${column}, 10) AS INTEGER) > ${spawnedBefore}))`;
      const tables = () => [["managed_threads", "thread_id", "thread_id"], ["review_targets", "reviewer_thread_id", "reviewer_thread_id, worker_thread_id"], ["alert_outbox", "source_thread_id", "rowid"]]
        .map(([table, column, order]) => `${table}\n${(database.prepare(`SELECT * FROM ${table} WHERE ${mine(column!)} ORDER BY ${order}`).all() as object[]).map(stable).join("\n")}`).join("\n");
      return (label: string, fn: () => unknown) => step(label, async () => {
        let outcome: string;
        try { outcome = show(await fn()); } catch (error) { outcome = `ERR ${error instanceof Error ? error.message : String(error)}`; }
        return `${outcome}\n${tables()}`;
      });
    };
    const e7Owner = chief ? { id: chief.thread_id, project: chief.project_id } : null;
    const e7Tool = (name: string, input: unknown, as?: string) => (e7Owner ? tool(name, input, as ?? e7Owner.id, e7Owner.project) : "no chief");
    // The server caches rows; an idle event on the Chief (already idle) makes it reload, and nothing else changes.
    const e7Reload = async () => { if (chief) await harness.emitThreadEvent("thread.idle", { thread: storedThread(chief.thread_id)! } as never); };

    begin("e7-review-start");
    {
      seedE7?.();
      await e7Reload();
      const reviewStep = e7(["thr_fx_rv_"]);
      commandEvents.set("thr_fx_rv_b", [
        { type: "item/completed", seq: 3, createdAt: clock, data: { item: { type: "commandExecution", command: "npm run check", exitCode: 1, status: "failed" } } },
        { type: "item/completed", seq: 2, createdAt: clock, data: { item: { type: "commandExecution", command: "npm run build", exitCode: 0, status: "completed" } } },
        { type: "item/completed", seq: 1, createdAt: clock, data: { item: { type: "agentMessage", text: "not a command" } } },
      ]);
      await reviewStep("startReview: ready worker with a pull request head and a focus", () => e7Tool("chief_review", { workerThreadId: "thr_fx_rv_a", focus: "Snapshot focus: the totals rounding" }));
      await reviewStep("startReview: single ready worker with no pull request and recorded commands", () => e7Tool("chief_review", { workerThreadId: "thr_fx_rv_b" }));
      // A ready worker whose turn has not ended waits (the clock pinned: the 60 s deadline passes at once), then is refused.
      overrides.set("thr_fx_rv_c", { status: "active" });
      await reviewStep("waitIdleAfterReport, busyRejection: ready worker still busy, busy_rejections counted", () => e7Tool("chief_review", { workerThreadId: "thr_fx_rv_c" }));
      overrides.delete("thr_fx_rv_c");
      // Not ready: no wait, refused at once.
      overrides.set("thr_fx_rv_c2", { status: "active" });
      await reviewStep("waitIdleAfterReport, busyRejection: idle worker still busy, no wait", () => e7Tool("chief_review", { workerThreadId: "thr_fx_rv_c2" }));
      overrides.delete("thr_fx_rv_c2");
      overrides.set("thr_fx_rv_d", { archivedAt: 1 });
      await reviewStep("startReview: archived worker is not reviewable", () => e7Tool("chief_review", { workerThreadId: "thr_fx_rv_d" }));
      overrides.delete("thr_fx_rv_d");
      await reviewStep("startBranchReview: pull request whose branch a live worker owns", () => e7Tool("chief_review", { pullRequest: "https://github.com/o/r/pull/9501" }));
      await reviewStep("resolvePullRequestBranch, startBranchReview: pull request no managed worker owns (pullRequestRef subject)", () => e7Tool("chief_review", { pullRequest: "https://github.com/o/r/pull/9510", focus: "Snapshot focus: the pull request" }));
      await reviewStep("startBranchReview: the same pull request again (existingBranchReview)", () => e7Tool("chief_review", { pullRequest: "https://github.com/o/r/pull/9510" }));
      await reviewStep("resolvePullRequestBranch: a reference the forge cannot answer falls back to the raw value as the branch", () => e7Tool("chief_review", { pullRequest: "feature/fx-raw-ref" }));
    }

    begin("e7-chain");
    {
      const chainStep = e7(["thr_fx_bc_", "thr_fx_sb_"]);
      const consult = (workerThreadId: string) => e7Tool("chief_consult", { title: `Snapshot chain consult of ${workerThreadId}`, mission: "Snapshot chain question", workerThreadId });
      await chainStep("taskReviews: branchless replaces chain, consult on the replacement (bc_b)", () => consult("thr_fx_bc_b"));
      await chainStep("taskReviews: unrelated worker on the same branch, no replaces link (sb_b)", () => consult("thr_fx_sb_b"));
      await chainStep("taskReviews: a successor's reviewer on the same branch (consult on sb_a, sb_a2 replaces it)", () => consult("thr_fx_sb_a"));
      await chainStep("chainFails: replacement across a branchless chain, the ruled-out section of the prompt", () => e7Tool("chief_delegate", { title: "Snapshot chain replacement", mission: "Snapshot chain mission", replaces: "thr_fx_bc_b" }));
    }

    begin("e7-store");
    {
      const storeStep = e7(["thr_fx_rc_", "thr_fx_lc_", "thr_fx_stop_", "thr_fx_lg_", "thr_fx_ab_", "thr_fx_ad_", "thr_fx_oa_", "thr_fx_stall_"]);
      const tick = async () => {
        const run = harness.runService("supervisor");
        run.controller.abort(); // the first pass runs to its wait, which the abort ends
        await run.done;
        return "supervisor pass done";
      };
      const event = async (kind: "thread.active" | "thread.idle" | "thread.failed" | "thread.archived" | "thread.deleted", id: string) => {
        const status = { "thread.active": "active", "thread.idle": "idle", "thread.failed": "error", "thread.archived": "idle", "thread.deleted": "idle" }[kind];
        overrides.set(id, { status });
        const result = await harness.emitThreadEvent(kind, { thread: storedThread(id)! } as never);
        return `${kind} ${id}: ${result.errors.length} errors`;
      };
      const rowOf = (id: string) => stable(database.prepare(`SELECT thread_id, state, status, thread_errors, busy_rejections, owner_approval, log_read_id, active_since, active_cycle, stall_alerted_cycle, stop_alerted_cycle FROM managed_threads WHERE thread_id=?`).get(id));
      if (!chief) await step("store: no chief in the copy", () => "skipped");
      else {
        // a. completeAbsorbed: first through the sweep a Chief idle event starts (a busy advisor is left alone), then the supervisor's own.
        seedAbsorbed?.();
        overrides.set("thr_fx_ab_busy", { status: "active" });
        await e7Reload();
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); // the sweep is fire-and-forget: let it finish
        await storeStep("completeAbsorbed: the sweep after an idle event completes the advisor and the researcher, and leaves the busy advisor", () => "sweep ran");
        overrides.delete("thr_fx_ab_busy");
        // b. reconcileThread, through one supervisor pass (the sweep runs in it too, and now finds the advisor idle).
        overrides.set("thr_fx_rc_del", { deletedAt: 1 });
        overrides.set("thr_fx_rc_arc", { archivedAt: 1 });
        overrides.set("thr_fx_rc_par", { parentThreadId: "thr_fx_rc_other" });
        overrides.set("thr_fx_rc_run", { status: "active" });
        overrides.set("thr_fx_rc_idle", { status: "idle" });
        // The #127 race: the worker reports ready while reconcile's threads.get is in flight, so its row is not the one reconcile read.
        overrides.set("thr_fx_rc_stale", { status: "idle" });
        getHooks.set("thr_fx_rc_stale", () => tool("chief_report", workerReport(true), "thr_fx_rc_stale", chief.project_id));
        await storeStep("reconcileThread, completeAbsorbed: one supervisor pass over deleted, archived, re-parented, running, idle, stale rows and the advisor the sweep had left", tick);
        for (const id of ["thr_fx_rc_del", "thr_fx_rc_arc", "thr_fx_rc_par", "thr_fx_rc_run", "thr_fx_rc_idle", "thr_fx_rc_stale"]) overrides.delete(id);
        await storeStep("reconcileThread: a second pass with the live views back to the rows", tick);
        // c. lifecycle
        await storeStep("lifecycle: thread.active on an idle worker", () => event("thread.active", "thr_fx_lc_w"));
        await storeStep("lifecycle: thread.idle ends its turn", () => event("thread.idle", "thr_fx_lc_w"));
        await storeStep("lifecycle: thread.failed counts a thread error and alerts Chief", () => event("thread.failed", "thr_fx_lc_w"));
        await storeStep("lifecycle: a repeated thread.failed is the same failure, not counted again", () => event("thread.failed", "thr_fx_lc_w"));
        await storeStep("lifecycle: thread.active on a ready worker leaves ready", () => event("thread.active", "thr_fx_lc_x"));
        await storeStep("lifecycle: thread.idle after the active turn", () => event("thread.idle", "thr_fx_lc_x"));
        await storeStep("lifecycle: thread.archived", () => event("thread.archived", "thr_fx_lc_x"));
        await storeStep("lifecycle: thread.deleted", () => event("thread.deleted", "thr_fx_lc_x"));
        // d. tool writes
        await storeStep("stopThread: chief_stop on a running worker", () => e7Tool("chief_stop", { threadId: "thr_fx_stop_w", reason: "Snapshot: looping" }));
        await storeStep("stopThread: chief_stop on a worker that is no longer running", () => e7Tool("chief_stop", { threadId: "thr_fx_stop_w" }));
        overrides.set("thr_fx_oa_w", { status: "active" });
        await storeStep("recordOwnerApproval: design worker still busy, busy_rejections counted", () => e7Tool("chief_owner_approval", { workerThreadId: "thr_fx_oa_w", approval: "Snapshot: approved while busy" }));
        overrides.delete("thr_fx_oa_w");
        await storeStep("recordOwnerApproval: design worker idle, approval recorded", () => e7Tool("chief_owner_approval", { workerThreadId: "thr_fx_oa_w", approval: "Snapshot: approved, e7" }));
        await storeStep("recordOwnerApproval: worker not on a design wave refused", () => e7Tool("chief_owner_approval", { workerThreadId: "thr_fx_lc_w", approval: "Snapshot: approved" }));
        for (const role of ["reviewer", "advisor", "planner"]) {
          const id = `thr_fx_${role}_active`;
          overrides.set(id, { status: "idle" });
          await storeStep(`markComplete: chief_complete on a ${role} (${id})`, async () => `${await e7Tool("chief_complete", { threadId: id })}\n${rowOf(id)}`);
          overrides.delete(id);
        }
        await storeStep("planLog: chief_log read marks for a plan worker (log_read_id)", async () => `${await e7Tool("chief_log", {}, "thr_fx_lg_w")}\n${rowOf("thr_fx_lg_w")}`);
        await storeStep("planLog: chief_log again, nothing unread", async () => `${await e7Tool("chief_log", {}, "thr_fx_lg_w")}\n${rowOf("thr_fx_lg_w")}`);
        // e. touchCallerChief: a failed Chief that calls a tool returns to active.
        await storeStep("touchCallerChief: thread.failed on the Chief", async () => `${await event("thread.failed", chief.thread_id)}\n${rowOf(chief.thread_id)}`);
        await storeStep("touchCallerChief: the failed Chief calls a tool, which returns it to active", async () => `${await e7Tool("chief_continue", { threadId: "thr_fx_lc_w", instruction: "Snapshot nudge" })}\n${rowOf(chief.thread_id)}`);
        await storeStep("lifecycle: thread.idle on the Chief restores it", async () => `${await event("thread.idle", chief.thread_id)}\n${rowOf(chief.thread_id)}`);
        overrides.delete(chief.thread_id);
        // f. resolveTarget, insertThread: a thread no row carries is adopted only when this plugin spawned it under this Chief.
        const adoptable = (id: string, extra: object, metadata: object) => {
          liveThreads.set(id, thread({ id, projectId: chief.project_id, environmentId: `env_${id}`, title: `Fixture ${id}`, sectionId: "sec_snap", visibility: "visible", status: "idle", parentThreadId: chief.thread_id, originPluginId: "chief", ...extra }));
          pluginMetadata.set(id, metadata);
        };
        adoptable("thr_fx_ad_user", { originPluginId: null }, { role: "worker", chiefThreadId: chief.thread_id });
        adoptable("thr_fx_ad_foreign", {}, { role: "worker", chiefThreadId: "thr_fx_other_chief" });
        adoptable("thr_fx_ad_chief", {}, { role: "chief", chiefThreadId: chief.thread_id });
        adoptable("thr_fx_ad_ok", {}, { role: "worker", chiefThreadId: chief.thread_id });
        for (const id of ["thr_fx_ad_user", "thr_fx_ad_foreign", "thr_fx_ad_chief", "thr_fx_ad_ok"]) {
          await storeStep(`resolveTarget, insertThread: chief_inspect on an unmanaged thread (${id})`, () => e7Tool("chief_inspect", { threadId: id }));
        }
        // g. the supervisor's stall alert, soft then hard, on a worker whose turn began long ago.
        seedStall?.(20 * 60_000);
        await e7Reload();
        await storeStep("supervisor stall alert: a worker active for 20 minutes (soft)", tick);
        database.prepare(`UPDATE managed_threads SET active_since=? WHERE thread_id='thr_fx_stall_w'`).run(clock - 40 * 60_000);
        await e7Reload();
        await storeStep("supervisor stall alert: the same turn at 40 minutes (hard)", tick);
        await storeStep("supervisor stall alert: a third pass sends nothing new", tick);
      }
    }

    // g. failure events: provider failures and stalls are recorded when detected, whether or not their alert was delivered.
    // Every step prints its action, the fixture rows, their alerts and their failure events; the stats steps print the
    // text and the JSON (the fixture's tasks only). The step labels say what each one proves.
    begin("g-failure-events");
    {
      const eventRows = (db: Database.Database) => (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='chief_failure_events'`).get()
        ? (db.prepare(`SELECT * FROM chief_failure_events WHERE substr(source_thread_id, 1, 10) = 'thr_fx_fe_' ORDER BY source_thread_id, active_cycle, kind`).all() as object[]).map(stable).join("\n")
        : "(no table)");
      if (!chief) await step("failure events: no chief in the copy", () => "skipped");
      else {
        seedFe?.();
        await e7Reload();
        const fe = e7(["thr_fx_fe_"]);
        const feStep = (label: string, fn: () => unknown) => fe(label, async () => {
          const outcome = await fn();
          return `${show(outcome)}\nchief_failure_events\n${eventRows(database)}`;
        });
        const context = { threadId: chief.thread_id, projectId: chief.project_id };
        // The fixture's tasks only: every other task in the copy is category b's business.
        const fixtureStats = async (run: (argv: string[], ctx?: object) => Promise<unknown> | unknown) => {
          const out = async (argv: string[]) => {
            const result = (await run(argv, context)) as { exitCode: number; stdout: string; stderr: string };
            if (result.exitCode !== 0) throw new Error(`bb chief ${argv.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
            return result.stdout;
          };
          const text = await out(["stats"]);
          const json = JSON.parse(await out(["stats", "--json"]));
          json.perTask = json.perTask.filter((task: { title: string }) => task.title.startsWith("Fixture fe"));
          return `${text.split("\n").filter((line) => line.startsWith("Failures:") || line.startsWith("- ") && line.includes("Fixture fe")).join("\n")}\n${stable(json)}`;
        };
        const statsStep = (label: string, run: typeof cli = cli) => step(`stats: ${label}`, () => fixtureStats(run));
        const fire = async (h: typeof harness, kind: "thread.active" | "thread.failed", id: string) => {
          overrides.set(id, { status: kind === "thread.active" ? "active" : "error" });
          const result = await h.emitThreadEvent(kind, { thread: storedThread(id)! } as never);
          return `${kind} ${id}: ${result.errors.length} errors`;
        };
        const failedWith = (id: string, message: string | "throw") => providerErrors.set(id, message === "throw" ? "throw"
          : [{ type: "provider/error", seq: 1, createdAt: clock, data: { message, detail: null, errorInfo: undefined } }]);
        const tick = async (h: typeof harness) => {
          const run = h.runService("supervisor");
          run.controller.abort(); // the first pass runs to its wait, which the abort ends
          await run.done;
          return "supervisor pass done";
        };
        // 1. The legacy rows seeded before the load: usage limit 1, connection 1, stall 1, hard stall 1; the error: and report: rows are never counted.
        await feStep("g1 legacy alerts as the plugin loaded them", () => "legacy rows");
        await statsStep("g1 legacy migrated DB");
        // 2. A failed send still records the event.
        await feStep("g2 thread.active thr_fx_fe_w", () => fire(harness, "thread.active", "thr_fx_fe_w"));
        failedWith("thr_fx_fe_w", "usage_limit 429 Rate limit reached");
        failSend = true;
        await feStep("g2 thread.failed (usage limit), the send fails", () => fire(harness, "thread.failed", "thr_fx_fe_w"));
        await statsStep("g2 failed send");
        // 3. A duplicate failed event in the same cycle adds nothing.
        await feStep("g3 duplicate thread.failed in the same cycle", () => fire(harness, "thread.failed", "thr_fx_fe_w"));
        await statsStep("g3 duplicate");
        // 4. A new cycle: its alert supersedes the pending one, and the first event stays counted.
        failSend = false;
        await feStep("g4 thread.active starts a new cycle", () => fire(harness, "thread.active", "thr_fx_fe_w"));
        failedWith("thr_fx_fe_w", "connection error ECONNRESET");
        await feStep("g4 thread.failed (connection), sent", () => fire(harness, "thread.failed", "thr_fx_fe_w"));
        await statsStep("g4 new cycle");
        // 5. The task title names a usage limit; the provider error is a connection error.
        await feStep("g5 thread.active thr_fx_fe_title", () => fire(harness, "thread.active", "thr_fx_fe_title"));
        failedWith("thr_fx_fe_title", "connection error ECONNRESET");
        await feStep("g5 thread.failed (connection) on a task titled with a usage limit", () => fire(harness, "thread.failed", "thr_fx_fe_title"));
        await statsStep("g5 title");
        // 6. The provider error read throws: a thread error and no failure event.
        failedWith("thr_fx_fe_w", "throw");
        await feStep("g6 thread.active thr_fx_fe_w", () => fire(harness, "thread.active", "thr_fx_fe_w"));
        await feStep("g6 thread.failed with an unreadable provider error", () => fire(harness, "thread.failed", "thr_fx_fe_w"));
        await statsStep("g6 provider error read throws");
        // 7. Stalls, first pass: both soft alerts stay pending because the send fails.
        failSend = true;
        await feStep("g7 supervisor pass, both stalls (soft), sends fail", () => tick(harness));
        await statsStep("g7 stalls, first pass");
        // 8. Stalls, second pass: st_a is now twice the threshold and its hard alert supersedes the pending soft one;
        // st_b's soft alert is re-sent on retry and delivered once.
        database.prepare(`UPDATE managed_threads SET active_since=? WHERE thread_id='thr_fx_fe_st_a'`).run(clock - 40 * 60_000);
        failSend = false;
        await e7Reload();
        await feStep("g8 supervisor pass: st_a hard, st_b soft retried", () => tick(harness));
        await statsStep("g8 stalls, second pass");
        // 9. A restart: a second instance over the same DB changes nothing, and a duplicate failed event after it adds nothing.
        // (The duplicate is on thr_fx_fe_title: g6 deliberately left thr_fx_fe_w's cycle without an event.)
        const second = host(database);
        await mod.default(second.bb);
        await feStep("g9 restart: the second instance's log", () => second.harness.logEntries.map((entry: any) => `${entry.level} ${entry.message}`).join("\n") || "(no log entries)");
        await statsStep("g9 restart", (argv, ctx) => second.harness.behavior.runCli(argv, ctx as never));
        failedWith("thr_fx_fe_title", "connection error ECONNRESET");
        await feStep("g9 duplicate thread.failed after the restart", () => fire(second.harness, "thread.failed", "thr_fx_fe_title"));
        await statsStep("g9 duplicate after restart", (argv, ctx) => second.harness.behavior.runCli(argv, ctx as never));
        await feStep("g9 thread.active, the retry starts a new cycle", () => fire(second.harness, "thread.active", "thr_fx_fe_title"));
        await feStep("g9 thread.failed in the new cycle", () => fire(second.harness, "thread.failed", "thr_fx_fe_title"));
        await statsStep("g9 retry after restart", (argv, ctx) => second.harness.behavior.runCli(argv, ctx as never));
        await second.harness.lifecycle.dispose().catch(() => undefined);
        // 10. A fresh install: the schema, the metadata keys and an empty stats.
        await step("g10 fresh install", async () => {
          const freshPath = `${outPath}.fresh.db`;
          for (const suffix of ["", "-wal", "-shm"]) rmSync(freshPath + suffix, { force: true });
          const fresh = new Database(freshPath);
          const third = host(fresh);
          try {
            await mod.default(third.bb);
            const schema = (fresh.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all() as object[]).map((row) => Object.values(row).join(",")).join("\n");
            const keys = (fresh.prepare(`SELECT key FROM plugin_meta ORDER BY key`).all() as { key: string }[]).map((row) => row.key).join(",");
            const json = JSON.parse(((await third.harness.behavior.runCli(["stats", "--project", chief.project_id, "--json"], { projectId: chief.project_id } as never)) as { stdout: string }).stdout);
            const { statsSince: _since, notes: _notes, ...rest } = json;
            return `${schema}\nplugin_meta keys: ${keys}\n${stable(rest)}`;
          } finally {
            await third.harness.lifecycle.dispose().catch(() => undefined);
            fresh.close();
            for (const suffix of ["", "-wal", "-shm"]) rmSync(freshPath + suffix, { force: true });
          }
        });
      }
    }

    // f. final state of every table the scenarios touch
    begin("f-final-state");
    const dump = (table: string, order: string) => async () => (database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as object[]).map(stable).join("\n");
    await step("managed_threads", dump("managed_threads", "thread_id"));
    await step("reviewer_verdicts", dump("reviewer_verdicts", "id"));
    await step("review_targets", dump("review_targets", "reviewer_thread_id, worker_thread_id"));
    await step("alert_outbox", dump("alert_outbox", "rowid"));
    await step("chief_failure_events", async () => (database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='chief_failure_events'`).get()
      ? (database.prepare(`SELECT * FROM chief_failure_events ORDER BY source_thread_id, active_cycle, kind`).all() as object[]).map(stable).join("\n") : "(no table)"));
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
