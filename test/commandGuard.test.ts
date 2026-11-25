import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { guardScript, guardShim, installScript, piExtension } from "../src/research/commandGuard";

// Contracts (docs/specs/plan-chains.md "Command Guard"): for a marked Chief worker thread, a Bash call that pipes into tail/head or runs in the
// background exits 2 with a `[chief-guard]` reason on stderr; every other call exits 0. An unmarked thread never reaches node. Every failure
// lets the command run. install.sh merges one hook into the owner's settings, idempotently, and never writes a settings file it cannot parse.
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

/** A guard folder as publishGuard writes it, with a marker for thread thr_x. */
function guardDir() {
  const dir = temp("chief-guard-");
  writeFileSync(join(dir, "guard.sh"), guardShim());
  writeFileSync(join(dir, "guard.mjs"), guardScript());
  writeFileSync(join(dir, "pi-extension.ts"), piExtension(join(dir, "guard.sh")));
  writeFileSync(join(dir, "install.sh"), installScript(dir));
  mkdirSync(join(dir, "threads"));
  writeFileSync(join(dir, "threads", "thr_x"), "thr_x\n");
  return dir;
}

function run(dir: string, payload: unknown, threadId: string | null = "thr_x", env: Record<string, string> = {}) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const { BB_THREAD_ID: _ignored, ...base } = process.env;
  const result = spawnSync("/bin/sh", [join(dir, "guard.sh")], { input, encoding: "utf8", env: { ...base, ...(threadId ? { BB_THREAD_ID: threadId } : {}), ...env } });
  return { status: result.status, stderr: result.stderr };
}
const bash = (command: string, extra: object = {}) => ({ tool_name: "Bash", tool_input: { command, ...extra } });

const REFUSED = [
  "npm test | tail -20", "git log|head", "x |& tail", "echo $(ls | head -1)", "cmd | /usr/bin/tail -n 5",
  "sleep 60 &", "npm run dev & curl localhost", "nohup npm start", "(build) & wait", "foo; disown", "setsid foo",
  "echo ok\nnpm test | tail", "cat <<EOF\nbody\nEOF\nls | head",
];
const ALLOWED = [
  "a || head -n 3 f", "head -n 50 file", "tail -n 20 log", "make 2>&1", "cmd &> out.log", "a && b", "echo x >&2",
  'git commit -m "fix | head & tail"', "grep 'a|tail' f", "# run | tail later", "ls # | tail", "cat nohup.out", "echo $# ${#x}",
  "bb thread tell --message-file - <<'EOF'\nsent | tail and & more\nEOF", "bb thread tell --message-file - <<-EOF\n\tx | head\n\tEOF\nls",
  "bash /Users/x/.bb/chief/heavy/chief-heavy-0123456789ab.sh test -- npm test", "cat <<<'a | tail'",
];

describe("guard.sh with a marked thread", () => {
  test.each(REFUSED)("refuses %j with exit 2 and a [chief-guard] reason", (command) => {
    const dir = guardDir();
    const { status, stderr } = run(dir, bash(command));
    expect(status).toBe(2);
    expect(stderr.startsWith("[chief-guard]")).toBe(true);
    expect(stderr.length).toBeGreaterThan(30);
  });

  test.each(ALLOWED)("lets %j run", (command) => {
    expect(run(guardDir(), bash(command)).status).toBe(0);
  });

  test("run_in_background refuses whatever the command is", () => {
    const { status, stderr } = run(guardDir(), bash("npm test", { run_in_background: true }));
    expect(status).toBe(2);
    expect(stderr.startsWith("[chief-guard]")).toBe(true);
    expect(run(guardDir(), bash("npm test", { run_in_background: false })).status).toBe(0);
  });

  test.each([
    ["invalid JSON", "{not json"],
    ["empty input", ""],
    ["a non-Bash tool", { tool_name: "Read", tool_input: { file_path: "x | tail" } }],
    ["a Bash call without a command", { tool_name: "Bash", tool_input: {} }],
    ["a non-object tool input", { tool_name: "Bash", tool_input: "ls | tail" }],
  ])("fails open on %s", (_name, payload) => {
    expect(run(guardDir(), payload as never).status).toBe(0);
  });

  test("fails open when guard.mjs is missing", () => {
    const dir = guardDir();
    rmSync(join(dir, "guard.mjs"));
    expect(run(dir, bash("ls | tail")).status).toBe(0);
  });

  test("fails open when node is not on PATH", () => {
    const bin = temp("chief-nopath-"); // only dirname, so the script reaches its node check
    symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
    expect(run(guardDir(), bash("ls | tail"), "thr_x", { PATH: bin }).status).toBe(0);
  });
});

describe("guard.sh scope", () => {
  test.each([["unset", null], ["an id with no marker", "thr_other"]])("exits 0 for a refused command and never starts node when BB_THREAD_ID is %s", (_name, threadId) => {
    const dir = guardDir();
    const bin = temp("chief-fakebin-");
    const sentinel = join(bin, "node-ran");
    writeFileSync(join(bin, "node"), `#!/bin/sh\ntouch "${sentinel}"\nexit 2\n`, { mode: 0o755 });
    const { status } = run(dir, bash("ls | tail"), threadId, { PATH: `${bin}:${process.env.PATH}` });
    expect(status).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(run(dir, bash("sleep 1 &"), threadId).status).toBe(0);
    expect(run(dir, bash("ls", { run_in_background: true }), threadId).status).toBe(0);
  });
});

describe("pi extension", () => {
  /** The extension text with its few type annotations stripped, evaluated with Node's require and a fake pi that records its handlers. */
  function load(guardShPath: string) {
    const code = piExtension(guardShPath)
      .replace(/^import type .*$/m, "")
      .replace(/^import \{ spawnSync \} from "node:child_process"$/m, 'const { spawnSync } = require("node:child_process")')
      .replace("export default function (pi: ExtensionAPI)", "exports.default = function (pi)")
      .replace(" as { command?: unknown }", "");
    const exported: { default?: (pi: unknown) => void } = {};
    new Function("require", "exports", code)(createRequire(import.meta.url), exported);
    const handlers: Record<string, (event: unknown) => Promise<unknown>> = {};
    exported.default!({ on: (name: string, handler: (event: unknown) => Promise<unknown>) => { handlers[name] = handler; } });
    return handlers.tool_call!;
  }
  const call = (command: unknown, toolName = "bash") => ({ toolName, input: { command } });

  test("blocks a refused bash call with the guard's reason and lets everything else through", async () => {
    const dir = guardDir();
    vi.stubEnv("BB_THREAD_ID", "thr_x");
    const handler = load(join(dir, "guard.sh"));
    const blocked = await handler(call("ls | head")) as { block: boolean; reason: string };
    expect(blocked.block).toBe(true);
    expect(blocked.reason.startsWith("[chief-guard]")).toBe(true);
    expect(await handler(call("head -n 3 f"))).toBeUndefined();
    expect(await handler(call("ls | head", "read"))).toBeUndefined();
    expect(await handler(call(42))).toBeUndefined();
  });

  test("fails open when guard.sh is missing", async () => {
    const handler = load(join(temp("chief-missing-"), "guard.sh"));
    expect(await handler(call("ls | head"))).toBeUndefined();
  });
});

describe("install.sh", () => {
  const hookOf = (command: string) => ({ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] });
  const unrelated = { matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] };

  function install(dir: string, home: string) {
    const result = spawnSync("/bin/sh", [join(dir, "install.sh")], { encoding: "utf8", env: { ...process.env, HOME: home } });
    return { status: result.status, stdout: result.stdout };
  }
  const settingsPath = (home: string) => join(home, ".claude", "settings.json");
  const extPath = (home: string) => join(home, ".pi", "agent", "extensions", "chief-guard.ts");
  function homeWith(settings: string | null) {
    const home = temp("chief-home-");
    if (settings !== null) { mkdirSync(join(home, ".claude")); writeFileSync(settingsPath(home), settings); }
    return home;
  }

  test("adds one hook entry, keeps every other key and hook, saves a backup and copies the pi extension; a second run changes nothing", () => {
    const dir = guardDir();
    const original = JSON.stringify({ model: "x", hooks: { PreToolUse: [unrelated], Stop: [{ hooks: [] }] } }, null, 2);
    const home = homeWith(original);
    expect(install(dir, home).status).toBe(0);
    const first = readFileSync(settingsPath(home), "utf8");
    const settings = JSON.parse(first);
    expect(settings.model).toBe("x");
    expect(settings.hooks.Stop).toEqual([{ hooks: [] }]);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0]).toEqual(unrelated);
    expect(settings.hooks.PreToolUse[1]).toEqual(hookOf(`/bin/sh -c '[ -f "$0" ] || exit 0; exec /bin/sh "$0"' '${join(dir, "guard.sh")}'`));
    expect(readFileSync(`${settingsPath(home)}.chief-guard.bak`, "utf8")).toBe(original);
    expect(readFileSync(extPath(home), "utf8")).toBe(readFileSync(join(dir, "pi-extension.ts"), "utf8"));

    expect(install(dir, home).status).toBe(0);
    expect(readFileSync(settingsPath(home), "utf8")).toBe(first);
    expect(readFileSync(extPath(home), "utf8")).toBe(readFileSync(join(dir, "pi-extension.ts"), "utf8"));
  });

  test("creates the settings file when it is missing, and the registered hook command passes a clean call, refuses a bad one and fails open without guard.sh", () => {
    const dir = guardDir();
    const home = homeWith(null);
    expect(install(dir, home).status).toBe(0);
    const command = JSON.parse(readFileSync(settingsPath(home), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
    const hook = (payload: unknown) => spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, BB_THREAD_ID: "thr_x" } });
    expect(hook(bash("ls")).status).toBe(0);
    expect(hook(bash("ls | tail")).status).toBe(2);
    rmSync(join(dir, "guard.sh"));
    expect(hook(bash("ls | tail")).status).toBe(0);
  });

  test.each([["invalid JSON", "{ nope"], ["a JSON list", "[]"], ["a hooks value that is not an object", '{"hooks":[]}']])("%s: the settings file is left untouched, exit 1, no backup, no extension", (_name, text) => {
    const dir = guardDir();
    const home = homeWith(text);
    const { status, stdout } = install(dir, home);
    expect(status).toBe(1);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(readFileSync(settingsPath(home), "utf8")).toBe(text);
    expect(existsSync(`${settingsPath(home)}.chief-guard.bak`)).toBe(false);
    expect(existsSync(extPath(home))).toBe(false);
  });
});
