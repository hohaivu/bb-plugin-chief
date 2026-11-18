import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { heavyScript, heavySlotCount } from "./src/research/heavySlots";

// Contracts (docs/specs/plan-chains.md "Heavy Command Slots"): the setting maps to 1-8 or 2; the wrapper admits a command into a pool slot of
// the host `slots` capacity, passes the exit status through, never reads a payload's own exit 75 as "busy", frees a SIGKILLed holder's slot,
// runs nested calls directly, waits with a heartbeat and gives up with exit 75, and refuses to run a command whose admission it cannot record.
describe("heavySlotCount", () => {
  test.each([["1", 1], ["2", 2], ["3", 3], ["4", 4], ["5", 5], ["6", 6], ["7", 7], ["8", 8],
    ["", 2], ["0", 2], ["9", 2], ["abc", 2], ["2.5", 2], ["10", 2], [" 3", 2], [undefined, 2]])("setting %j gives %i", (heavySlots, count) => {
    expect(heavySlotCount({ heavySlots })).toBe(count);
  });
  test("a settings object with no heavySlots key gives 2", () => {
    expect(heavySlotCount({})).toBe(2);
  });
});

// The wrapper runs against the real macOS lockf: its locking is the contract, and a fake would implement the behaviour under test.
describe.skipIf(!existsSync("/usr/bin/lockf"))("heavy wrapper with real /usr/bin/lockf (skipped when /usr/bin/lockf is absent: macOS only)", { timeout: 40_000 }, () => {
  const groups: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) for (const name of "ABCDEFGHIJ") try { writeFileSync(join(dir, `release.${name}`), ""); } catch { /* the folder is gone */ }
    for (const child of groups.splice(0)) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A temp folder with the wrapper, a `slots` file and a payload that logs, signals entry and optionally holds until `release.<name>` exists. */
  function world(slots: string | null = "1", limits = { waitSeconds: 3, beatSeconds: 1, pollSeconds: 1 }) {
    const dir = mkdtempSync(join(tmpdir(), "chief-heavy-test-"));
    dirs.push(dir);
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const script = join(dir, "chief-heavy-test.sh");
    writeFileSync(script, heavyScript(limits));
    if (slots !== null) writeFileSync(join(dir, "slots"), `${slots}\n`);
    const payload = join(dir, "payload.sh");
    writeFileSync(payload, [
      "#!/bin/bash", // $1 name, $2 exit code, $3 hold: 1 waits for release.<name>
      'echo x >> "$DIR/count.$1"',
      'echo "start $1" >> "$DIR/events"',
      ': > "$DIR/entered.$1"',
      'if [ "$3" = 1 ]; then while [ ! -e "$DIR/release.$1" ]; do sleep 0.05; done; fi',
      'echo "end $1" >> "$DIR/events"',
      'exit "$2"',
    ].join("\n"));
    chmodSync(payload, 0o755);
    const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
    const events = () => read("events").split("\n").filter(Boolean);
    return {
      dir, script, tmp, read,
      entered: (name: string) => existsSync(join(dir, `entered.${name}`)),
      runs: (name: string) => read(`count.${name}`).split("\n").filter(Boolean).length,
      release: (name: string) => writeFileSync(join(dir, `release.${name}`), ""),
      /** The highest number of the named payloads that were running at once, from the order of their start and end lines. */
      overlap: (names: string[]) => events().filter((line) => names.includes(line.split(" ")[1]!)).reduce((state, line) => {
        const running = state.running + (line.startsWith("start") ? 1 : -1);
        return { running, max: Math.max(state.max, running) };
      }, { running: 0, max: 0 }).max,
      events,
      /** Runs the wrapper in its own process group; `done` settles when the process has exited and its output is read. */
      run: (args: string[], env: Record<string, string | undefined> = {}, via = script) => {
        const child = spawn("/bin/bash", [via, ...args], {
          cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"],
          // This run may itself sit inside a slot: a wrapped child must not inherit that.
          env: { ...process.env, CHIEF_HEAVY_HELD: undefined, BB_THREAD_ID: undefined, TMPDIR: tmp, DIR: dir, ...env },
        });
        groups.push(child);
        const out = { stdout: "", stderr: "" };
        child.stdout!.on("data", (chunk) => { out.stdout += chunk; });
        child.stderr!.on("data", (chunk) => { out.stderr += chunk; });
        const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
        return { child, out, done };
      },
      /** `pool -- ./payload.sh <name> <exit code> <hold>` */
      pay: (pool: string, name: string, code = 0, hold = false) => [pool, "--", "./payload.sh", name, String(code), hold ? "1" : "0"],
    };
  }
  type World = ReturnType<typeof world>;

  async function until(what: string, ready: () => boolean, ms = 15_000) {
    const end = Date.now() + ms;
    while (!ready()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const beats = (run: { out: { stderr: string } }) => run.out.stderr.split("\n").filter((line) => line.startsWith("[chief-heavy] waiting")).length;
  /** Starts a gated holder and waits until its payload is running. */
  async function hold(w: World, name: string, pool = "test", args: string[] = [], env: Record<string, string> = {}) {
    const run = w.run(args.length ? args : w.pay(pool, name, 0, true), env);
    await until(`${name} to enter`, () => w.entered(name));
    return run;
  }
  /** Starts a gated caller and waits until it has printed its first heartbeat while waiting. */
  async function waiter(w: World, name: string, pool = "test", args: string[] = w.pay(pool, name, 0, true), env: Record<string, string> = {}) {
    const run = w.run(args, env);
    await until(`${name} to wait`, () => beats(run) > 0);
    return run;
  }

  // Contract: the exit status passes through; a started command is never retried and prints no busy line.
  test.each([0, 3, 75])("a free slot runs the command once and exits with its own status %i, with no busy line", async (code) => {
    const w = world("2");
    const run = w.run(w.pay("test", "A", code));
    expect(await run.done).toEqual({ code, signal: null });
    expect(w.runs("A")).toBe(1);
    expect(run.out.stderr).not.toContain("[chief-heavy]");
  });

  // Regression: lockf -t 0 exits 75 for a busy lock AND for a payload that exits 75; reading the status alone retried a finished payload.
  test("a payload that exits 75 while another caller waits is dispatched once, exits 75 without a busy line, and never overlaps the waiter", async () => {
    const w = world("1");
    const a = await hold(w, "A", "test", w.pay("test", "A", 75, true));
    const b = await waiter(w, "B", "test", w.pay("test", "B", 0, false));
    expect(w.entered("B")).toBe(false);
    w.release("A");
    expect(await a.done).toEqual({ code: 75, signal: null });
    expect(await b.done).toEqual({ code: 0, signal: null });
    expect(w.runs("A")).toBe(1);
    expect(w.runs("B")).toBe(1);
    expect(a.out.stderr).not.toMatch(/\[chief-heavy\]/);
    expect(b.out.stderr).toMatch(/\[chief-heavy\] got test slot 1 after \d+s/);
    expect(w.events()).toEqual(["start A", "end A", "start B", "end B"]);
    expect(w.overlap(["A", "B"])).toBe(1);
  });

  test("with one slot a second caller waits, its heartbeat names the holder's thread and command, and it runs after the holder ends", async () => {
    const w = world("1");
    await hold(w, "A", "test", [], { BB_THREAD_ID: "thr_holder" });
    const b = await waiter(w, "B", "test", w.pay("test", "B"));
    expect(b.out.stderr).toMatch(/\[chief-heavy\] waiting \d+s for test \(1 busy\): thr_holder \.\/payload\.sh A 0 1 \d+s;/);
    expect(w.entered("B")).toBe(false);
    w.release("A");
    expect((await b.done).code).toBe(0);
    expect(w.overlap(["A", "B"])).toBe(1);
  });

  test("a holder with no note shows as unknown in the heartbeat", async () => {
    const w = world("1");
    await hold(w, "A");
    rmSync(join(w.dir, "locks", "test.1.who"));
    const b = await waiter(w, "B", "test", w.pay("test", "B"));
    expect(b.out.stderr).toMatch(/\(1 busy\): unknown;/);
  });

  test("with two slots two callers run together and a third waits until one ends", async () => {
    const w = world("2");
    await hold(w, "A");
    await hold(w, "B");
    const c = await waiter(w, "C");
    expect(w.entered("C")).toBe(false);
    expect(c.out.stderr).toContain("(2 busy)");
    w.release("A");
    await until("C to enter", () => w.entered("C"));
    expect(w.overlap(["A", "B", "C"])).toBe(2);
  });

  test("a holder that outlasts waitSeconds makes the waiter exit 75 with the run-again line, a bounded heartbeat, and its command never runs", async () => {
    const w = world("1", { waitSeconds: 3, beatSeconds: 1, pollSeconds: 1 });
    await hold(w, "A");
    const b = w.run(w.pay("test", "B"));
    expect(await b.done).toEqual({ code: 75, signal: null });
    expect(b.out.stderr).toMatch(/\[chief-heavy\] test: all 1 slots busy for \d+s; run the same command again in the foreground/);
    expect(beats(b)).toBeGreaterThanOrEqual(1);
    expect(beats(b)).toBeLessThanOrEqual(3);
    expect(w.entered("B")).toBe(false);
    expect(w.runs("B")).toBe(0);
  });

  test("a SIGKILLed holder frees its slot at once, with no cleanup of the lock file", async () => {
    const w = world("1");
    const a = await hold(w, "A");
    process.kill(-a.child.pid!, "SIGKILL");
    expect((await a.done).signal).toBe("SIGKILL");
    const b = w.run(w.pay("test", "B"));
    expect(await b.done).toEqual({ code: 0, signal: null });
    expect(w.runs("B")).toBe(1);
    expect(existsSync(join(w.dir, "locks", "test.1"))).toBe(true);
  });

  test("a wrapper run inside a wrapped command at one slot runs at once and its exit status passes through the outer one", async () => {
    const w = world("1");
    const run = w.run(["test", "--", "bash", w.script, "test", "--", "./payload.sh", "N", "7", "0"]);
    expect(await run.done).toEqual({ code: 7, signal: null });
    expect(w.runs("N")).toBe(1);
    expect(run.out.stderr).not.toContain("waiting");
  });

  test("without lockf on the PATH the command runs unthrottled after one notice", async () => {
    const w = world("1");
    const run = w.run(["test", "--", "/bin/echo", "hello"], { PATH: "/nonexistent" });
    expect(await run.done).toEqual({ code: 0, signal: null });
    expect(run.out.stdout).toBe("hello\n");
    expect(run.out.stderr).toBe("[chief-heavy] no lockf: running unthrottled\n");
  });

  test.each([
    ["no arguments", []],
    ["a pool and no separator", ["test"]],
    ["a pool and a separator but no command", ["test", "--"]],
    ["a wrong separator", ["test", "run", "./payload.sh", "U", "0", "0"]],
    ["an unknown pool", ["bogus", "--", "./payload.sh", "U", "0", "0"]],
  ])("usage error with %s exits 2 and runs nothing", async (_name, args) => {
    const w = world("1");
    const run = w.run(args);
    expect((await run.done).code).toBe(2);
    expect(run.out.stderr).toContain("usage:");
    expect(w.entered("U")).toBe(false);
  });

  describe("capacity", () => {
    test.each([["missing", null], ["abc", "abc"], ["0", "0"], ["9", "9"]])("a `slots` file that is %s gives one slot", async (_name, slots) => {
      const w = world(slots);
      await hold(w, "A");
      const b = await waiter(w, "B", "test", w.pay("test", "B"));
      expect(b.out.stderr).toContain("(1 busy)");
      expect(w.entered("B")).toBe(false);
      w.release("A");
      expect((await b.done).code).toBe(0);
    });

    test("sim stays at one slot when `slots` is 2, and the other pools are independent of it", async () => {
      const w = world("2");
      await hold(w, "A", "sim");
      const b = await waiter(w, "B", "sim");
      expect(w.entered("B")).toBe(false);
      expect((await w.run(w.pay("test", "T")).done).code).toBe(0); // an idle pool still admits while sim is full
      expect((await w.run(w.pay("build", "U")).done).code).toBe(0);
      w.release("A");
      await until("B to enter", () => w.entered("B"));
      expect(b.out.stderr).toContain("(1 busy)");
    });

    test("two script versions with different limits in one folder share one cap and one locks folder", async () => {
      const w = world("2", { waitSeconds: 8, beatSeconds: 1, pollSeconds: 1 });
      const second = join(w.dir, "chief-heavy-other.sh");
      writeFileSync(second, heavyScript({ waitSeconds: 9, beatSeconds: 1, pollSeconds: 1 }));
      const run2 = (name: string) => w.run(w.pay("test", name, 0, true), {}, second); // version 2: another file of the same folder
      await hold(w, "A"); // version 1
      run2("B");
      await until("B to enter", () => w.entered("B")); // version 2, second slot
      const c = await waiter(w, "C");
      const d = run2("D");
      await until("D to wait", () => d.out.stderr.includes("waiting"));
      expect(w.entered("C") || w.entered("D")).toBe(false);
      w.release("A");
      await until("one waiter to enter", () => w.entered("C") || w.entered("D"));
      const other = w.entered("C") ? d : c;
      const before = other.out.stderr.split("\n").filter((line) => line.includes("waiting")).length;
      await until("another round of the other waiter", () => other.out.stderr.split("\n").filter((line) => line.includes("waiting")).length > before);
      expect(w.entered("C") && w.entered("D")).toBe(false);
      expect(w.overlap(["A", "B", "C", "D"])).toBe(2);
    });

    test("a lowered cap lets the holder above it finish, then admits at most one at a time and never uses slot 2", async () => {
      const w = world("2", { waitSeconds: 20, beatSeconds: 1, pollSeconds: 1 });
      const a = await hold(w, "A"); // slot 1
      const b = await hold(w, "B"); // slot 2
      writeFileSync(join(w.dir, "slots"), "1\n");
      w.release("A");
      await a.done;
      const c = await hold(w, "C"); // slot 1 is free again: C runs while B still holds slot 2
      expect(w.events()).not.toContain("end B");
      w.release("B");
      await b.done;
      const d = await waiter(w, "D");
      const e = await waiter(w, "E");
      expect(w.entered("D") || w.entered("E")).toBe(false); // slot 2 is free, the cap is 1, C holds slot 1
      w.release("C");
      await c.done;
      await until("one of D and E to enter", () => w.entered("D") || w.entered("E"));
      const other = w.entered("D") ? e : d;
      const before = beats(other);
      await until("another round of the other waiter", () => beats(other) > before);
      expect(w.entered("D") && w.entered("E")).toBe(false);
      w.release(w.entered("D") ? "D" : "E");
      await until("both to run", () => w.entered("D") && w.entered("E"));
      expect(w.overlap(["D", "E"])).toBe(1);
    });
  });

  // Contract: a marker that cannot be created means the command never runs, with a `[chief-heavy]` line and a non-zero exit.
  // Not tested: a marker that cannot be removed inside the lock (needs a failure between two script steps; the unwritable folder covers creation).
  test.skipIf(process.getuid?.() === 0)("an unwritable TMPDIR means the command never runs and the wrapper exits non-zero with a [chief-heavy] line", async () => {
    const w = world("1");
    const locked = join(w.dir, "readonly");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    const run = w.run(w.pay("test", "A"), { TMPDIR: locked });
    const { code } = await run.done;
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(run.out.stderr).toContain("[chief-heavy]");
    expect(w.entered("A")).toBe(false);
    chmodSync(locked, 0o700);
  });
});
