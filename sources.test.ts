import { promisify } from "node:util";
import { readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { delegate, disposeAll, execFileMock, setup } from "./test/harness";
import { dailyWorld, jsonl, putFile, restoreEnv } from "./test/dailyFixture";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(async () => { restoreEnv(); await disposeAll(); });

// Contracts (docs/specs/observability.md, "Evidence sources"): each adapter reads only its own files, inside the window,
// from the BB data dir / CLAUDE_CONFIG_DIR / HOME it is pointed at; a file last written before the window is never read;
// a thread whose provider file is not on this machine is counted, not guessed at; agy status 6 and 7 are failures.
// Every fixture lives in a temp dir; the adapters are observed through the daily report they feed.
const now = Date.now();
const iso = (at = now) => new Date(at).toISOString();
const old = (path: string) => utimes(path, new Date(now - 3 * 86_400_000), new Date(now - 3 * 86_400_000));
// child_process is mocked for the whole file; the agy adapter shells out to the real sqlite3 CLI (read-only, on a temp db), so that one binary passes through.
const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const hasSqlite = await promisify(real.execFile)("sqlite3", ["--version"]).then(() => true, () => false);
const realExec = promisify(real.execFile) as (file: string, args: string[], options: object) => Promise<{ stdout: string; stderr: string }>;
const passSqliteThrough = () => execFileMock.mockImplementation(async (file: string, args: string[], options: object) => file === "sqlite3" ? realExec(file, args, options) : { stdout: "", stderr: "" });
const sourcesRow = (report: string, name: string) => new RegExp(`^\\| ${name} \\| (\\w+) \\| (\\d+) \\| (.*) \\|$`, "m").exec(report)!;
const failures = (report: string) => /## Threads with failures\n([\s\S]*?)\n## /.exec(report)![1]!;

async function reportWith(build: (world: Awaited<ReturnType<typeof dailyWorld>>, state: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  passSqliteThrough();
  const state = await setup();
  const world = await dailyWorld(state);
  await build(world, state);
  const { path } = await world.run();
  return { state, world, report: await readFile(path!, "utf8") };
}

describe("Claude Code adapter", () => {
  const toolError = (text: string, at = now) => ({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "tool_result", is_error: true, content: text }] } });
  const assistant = (id: string, at = now) => ({ type: "assistant", timestamp: iso(at), message: { id, usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: "text", text: "ok" }] } });

  test("counts tool errors in the window, a compaction and a token total, and skips a file last written before the window", async () => {
    const { world, report } = await reportWith(async (world, state) => {
      const live = (await delegate(state, world.chief, "Live session")).threadId;
      const stale = (await delegate(state, world.chief, "Stale session")).threadId;
      const absent = (await delegate(state, world.chief, "Absent session")).threadId;
      world.identify(live, "claude-live"); world.identify(stale, "claude-stale"); world.identify(absent, "claude-absent");
      const projects = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-repo");
      await putFile(join(projects, "claude-live.jsonl"), jsonl(
        toolError("boom 11"), toolError("boom 22"), toolError("boom 33"), toolError("boom 44"), toolError("very old failure", now - 2 * 86_400_000),
        { type: "system", subtype: "compact_boundary", timestamp: iso() }, assistant("m1"), assistant("m1"), assistant("m2")));
      await putFile(join(projects, "claude-stale.jsonl"), jsonl(toolError("stale failure")));
      await old(join(projects, "claude-stale.jsonl"));
      Object.assign(world, { ids: { live, stale, absent } });
    });
    const { live, stale, absent } = (world as any).ids as Record<string, string>;
    // 4 equal errors group into one item with the count 4 (the 5th is outside the window), beside the compaction and the token total.
    expect(failures(report)).toContain(`- ${live} worker “Live session”: tool_error×4`);
    expect(failures(report)).not.toContain(stale);
    expect(report).not.toContain("stale failure");
    const row = sourcesRow(report, "claudeCode");
    expect(row[1]).toBe("ok");
    expect(row[2]).toBe("3"); // tool_error, compaction, tokens
    // Chief's own thread and the absent session have no file here: counted, not guessed at.
    expect(row[3]).toMatch(new RegExp(`not on this machine for 2 of 4 threads \\(.*${absent}`));
  });
});

describe("pi adapter", () => {
  test("reads a pi session from the BB data dir: tool-result errors count, a compaction counts", async () => {
    const { report, world } = await reportWith(async (world, state) => {
      const id = (await delegate(state, world.chief, "Pi session")).threadId;
      world.identify(id, "pi-1");
      await putFile(join(world.dataDir, "pi-bridge-sessions", "pi-1.jsonl"), jsonl(
        { message: { role: "toolResult", isError: true, content: [{ type: "text", text: "pi failure" }] }, timestamp: iso() },
        { message: { role: "toolResult", isError: true, content: [{ type: "text", text: "pi failure" }] }, timestamp: iso() },
        { type: "compaction", timestamp: iso() }));
      Object.assign(world, { id });
    });
    expect(failures(report)).toContain(`${(world as any).id} worker “Pi session”: tool_error×2`);
    expect(sourcesRow(report, "pi")[1]).toBe("ok");
  });
});

describe("BB log adapter", () => {
  test("reads server, daemon, CLI and plugin logs in the window: errors, Chief warnings and plugin warns count; other warnings, info and out-of-window lines do not", async () => {
    const { report } = await reportWith(async (world) => {
      const logs = join(world.dataDir, "logs");
      await putFile(join(logs, "server.log"), jsonl(
        { level: 50, time: now, msg: "listen failed", err: { message: "EADDRINUSE" } },
        { level: 40, time: now, msg: "[plugin:chief] stalled thing" },
        { level: 40, time: now, msg: "some other warning" },
        { level: 30, time: now, msg: "all good" },
        { level: 50, time: now - 3 * 86_400_000, msg: "yesterday's failure" }));
      await putFile(join(logs, "host-daemon.log"), jsonl({ level: 60, time: now, msg: "daemon died" }));
      await putFile(join(logs, "cli-errors.jsonl"), jsonl({ ts: iso(), message: "cli broke" }));
      await putFile(join(world.dataDir, "plugins", "chief", "logs", "plugin.log"), jsonl({ level: "warn", ts: iso(), message: "chief warn" }, { level: "info", ts: iso(), message: "chief info" }));
      await putFile(join(logs, "server.1.log"), jsonl({ level: 50, time: now, msg: "rotated file failure" }));
      await old(join(logs, "server.1.log"));
    });
    const logs = /## Logs\n([\s\S]*?)\n(## |Triage)/.exec(report)![1]!;
    expect(logs).toContain("server_log: server.log: listen failed EADDRINUSE");
    expect(logs).toContain("server_log_warn: server.log: [plugin:chief] stalled thing");
    expect(logs).toContain("daemon_log: host-daemon.log: daemon died");
    expect(logs).toContain("cli_error: cli broke");
    expect(logs).toContain("plugin_log: chief warn");
    for (const left of ["some other warning", "all good", "yesterday's failure", "chief info", "rotated file failure"]) expect(logs).not.toContain(left);
  });

  test("with no logs directory the section is still ok and says where nothing was found", async () => {
    const { report } = await reportWith(async () => undefined);
    const row = sourcesRow(report, "bbLogs");
    expect(row[1]).toBe("ok");
    expect(row[3]).toMatch(/not on this machine/);
  });
});

describe("agy adapter", () => {
  function conversation(home: string, id: string, statuses: number[]) {
    const path = join(home, ".gemini", "antigravity-acp", "conversations", `${id}.db`);
    return putFile(path, "").then(() => {
      const db = new Database(path);
      db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB)");
      const insert = db.prepare("INSERT INTO steps VALUES (?, 5, ?, NULL, NULL)");
      statuses.forEach((status, idx) => insert.run(idx + 1, status));
      db.close();
      return path;
    });
  }

  test.skipIf(!hasSqlite)("steps with status 6 and 7 are failures and other statuses are not; reads only the temp HOME", async () => {
    const { report, world } = await reportWith(async (world, state) => {
      const id = (await delegate(state, world.chief, "Agy session")).threadId;
      world.identify(id, "agy-1");
      await conversation(world.home, "agy-1", [3, 3, 6, 7, 3]);
      Object.assign(world, { id });
    });
    expect(failures(report)).toContain(`${(world as any).id} worker “Agy session”: agy_error×2`);
    expect(sourcesRow(report, "agy")[1]).toBe("ok");
  });

  test.skipIf(!hasSqlite)("a conversation file last written before the window is never read", async () => {
    const { report } = await reportWith(async (world, state) => {
      const id = (await delegate(state, world.chief, "Old agy")).threadId;
      world.identify(id, "agy-old");
      await old(await conversation(world.home, "agy-old", [6, 6, 6]));
    });
    expect(report).not.toContain("agy_error");
  });
});
