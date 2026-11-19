import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { heavyScript } from "../src/research/heavySlots";
import { createArtifacts } from "../src/runtime/artifacts";

// Contracts (docs/specs/observability.md, "Artifact writes"): a write replaces an existing file; only an "already exists" move error
// triggers remove-then-move; any other failure removes the tmp file and rethrows.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** createArtifacts over a real temp dir, with a host `move` that refuses an existing destination as the production host does. */
async function world(moveFails: (call: number) => Error | undefined = () => undefined, dataDirKnown = true,
  extra: { hosts?: (root: string) => { get: (args: { hostId: string }) => Promise<{ threadStorageRootPath?: string }> }; db?: object; storage?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "chief-artifact-"));
  roots.push(root);
  const calls: string[] = [];
  let moves = 0;
  const files = {
    write: async ({ path, content }: { path: string; content: string }) => { calls.push(`write ${path}`); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); return {}; },
    move: async ({ sourcePath, destinationPath }: { sourcePath: string; destinationPath: string }) => {
      calls.push(`move ${destinationPath}`);
      const injected = moveFails(++moves);
      if (injected) throw injected;
      if (await access(destinationPath).then(() => true, () => false)) throw new Error(`HTTP 502: Destination already exists: ${destinationPath}`);
      await rename(sourcePath, destinationPath);
      return {};
    },
    remove: async ({ path }: { path: string }) => { calls.push(`remove ${path}`); await unlink(path); return {}; },
    read: async ({ path }: { path: string }) => ({ content: await readFile(path, "utf8") }), // a missing path rejects, as on the host
  };
  // The BB data dir is the parent of the host's thread storage root.
  const hosts = extra.hosts?.(root) ?? { get: async () => (dataDirKnown ? { threadStorageRootPath: join(root, "thread-storage") } : {}) };
  const warnings: string[] = [];
  const storageCalls: string[] = [];
  const bb = {
    onDispose: () => undefined, log: { warn: (message: string) => warnings.push(message) },
    sdk: { files, hosts, threads: { storageLocation: async () => { storageCalls.push("storageLocation"); return { hostId: "host_1", storageRootPath: extra.storage ?? root }; } } },
  };
  const { writeStorageFile, publishHeavy, writeArtifact } = createArtifacts({ bb, db: extra.db ?? {}, state: { dataDirs: new Map() } } as never);
  return { root, calls, warnings, storageCalls, publishHeavy, writeArtifact, write: (content: string) => writeStorageFile("thr_1", "out/file.md", content), path: join(root, "out/file.md") };
}

describe("atomicWrite", () => {
  test("a path with no file takes one write and one move, and never removes the destination", async () => {
    const w = await world();
    expect(await w.write("A")).toBe(w.path);
    expect(await readFile(w.path, "utf8")).toBe("A");
    expect(w.calls.map((call) => call.split(" ")[0])).toEqual(["write", "move"]);
  });

  test("writing A and then B to one path succeeds both times, the file holds B and no tmp file remains", async () => {
    const w = await world();
    await w.write("A");
    await expect(w.write("B")).resolves.toBe(w.path);
    expect(await readFile(w.path, "utf8")).toBe("B");
    expect(await readdir(dirname(w.path))).toEqual(["file.md"]);
    expect(w.calls.filter((call) => call === `remove ${w.path}`)).toHaveLength(1);
  });

  test("a move error that is not 'already exists' leaves the destination alone, removes the tmp file and throws that error", async () => {
    const w = await world((call) => (call === 2 ? new Error("HTTP 500: disk full") : undefined));
    await w.write("A");
    await expect(w.write("B")).rejects.toThrow("HTTP 500: disk full");
    expect(await readFile(w.path, "utf8")).toBe("A");
    expect(w.calls.filter((call) => call.startsWith("remove "))).toHaveLength(1); // the tmp file only
    expect(w.calls.filter((call) => call === `remove ${w.path}`)).toEqual([]);
    expect(await readdir(dirname(w.path))).toEqual(["file.md"]);
  });

  test("a failed second move removes the tmp file and throws", async () => {
    const w = await world((call) => (call === 3 ? new Error("HTTP 500: second move failed") : undefined));
    await w.write("A");
    await expect(w.write("B")).rejects.toThrow("second move failed");
    expect((await readdir(dirname(w.path))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

// Contracts (docs/specs/plan-chains.md "Heavy Command Slots"): the wrapper `chief-heavy-<hash12>.sh` and the capacity file `slots` live in
// <BB data dir>/chief/heavy/; a published script is never removed or rewritten; `slots` is written only when its text differs.
describe("publishHeavy", () => {
  const hash12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
  const heavyOf = (root: string) => join(root, "chief", "heavy");
  const scriptPath = (root: string) => join(heavyOf(root), `chief-heavy-${hash12(heavyScript())}.sh`);

  test("publishes the wrapper under a name carrying its own content hash, plus the capacity file", async () => {
    const w = await world();
    const path = await w.publishHeavy("host_1", 2);
    expect(path).toBe(scriptPath(w.root));
    const text = await readFile(path, "utf8");
    expect(text).toBe(heavyScript());
    expect(path).toBe(join(heavyOf(w.root), `chief-heavy-${hash12(text)}.sh`));
    expect(await readFile(join(heavyOf(w.root), "slots"), "utf8")).toBe("2\n");
    expect((await readdir(heavyOf(w.root))).sort()).toEqual([`chief-heavy-${hash12(text)}.sh`, "slots"]);
  });

  test("a second publish of the same script and capacity writes, moves and removes nothing", async () => {
    const w = await world();
    const first = await w.publishHeavy("host_1", 2);
    w.calls.length = 0;
    await expect(w.publishHeavy("host_1", 2)).resolves.toBe(first);
    expect(w.calls).toEqual([]);
  });

  test("an existing file with other content at the script path throws and is left untouched, never removed", async () => {
    const w = await world();
    const path = scriptPath(w.root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "#!/bin/sh\necho someone else's file\n");
    await expect(w.publishHeavy("host_1", 2)).rejects.toThrow(/not overwriting/);
    expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho someone else's file\n");
    expect(w.calls.filter((call) => call === `remove ${path}` || call === `move ${path}`)).toEqual([]);
  });

  test("a move that loses a race to an equal publisher removes only the temp file and returns the path", async () => {
    let dest = "";
    const w = await world((call) => {
      // Move 1 is the capacity file; move 2 is the script, and another publisher's identical file lands just before it.
      if (call !== 2) return undefined;
      writeFileSync(dest, heavyScript());
      return new Error(`HTTP 502: Destination already exists: ${dest}`);
    });
    dest = scriptPath(w.root);
    await expect(w.publishHeavy("host_1", 2)).resolves.toBe(dest);
    expect(await readFile(dest, "utf8")).toBe(heavyScript());
    expect(w.calls.filter((call) => call === `remove ${dest}`)).toEqual([]);
    expect((await readdir(heavyOf(w.root))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("the capacity file is rewritten only when its text differs, and the script is not touched by that", async () => {
    const w = await world();
    const script = await w.publishHeavy("host_1", 2);
    w.calls.length = 0;
    await w.publishHeavy("host_1", 3);
    expect(await readFile(join(heavyOf(w.root), "slots"), "utf8")).toBe("3\n");
    expect(w.calls.filter((call) => call.includes(script))).toEqual([]);
    expect(w.calls.some((call) => call.endsWith("/slots") || call.includes("/slots.tmp-"))).toBe(true);
    w.calls.length = 0;
    await w.publishHeavy("host_1", 3);
    expect(w.calls).toEqual([]);
  });

  test("an unknown data dir throws and writes nothing", async () => {
    const w = await world(undefined, false);
    await expect(w.publishHeavy("host_1", 2)).rejects.toThrow(/data dir is unavailable/);
    expect(w.calls).toEqual([]);
  });
});

// Contracts (docs/specs/observability.md, "Artifact writes"; unchanged since a5d01fe306e898c97d2108e6ab8d497632dea1b6): an artifact lands in
// <BB data dir>/chief/<project>/<thread>/ of the host; the data dir is the parent of the host's thread storage root, looked up once per host;
// when it is unknown, a write with a named host throws, and a write without one warns, records artifact_fallbacks and uses the thread's storage root.
// Every expected value below is what a5d01fe's artifactDir gives for the same lookup inputs (the same cases were run against that commit).
describe("artifactDir through writeArtifact", () => {
  type Host = { threadStorageRootPath?: string };
  const unknownRoot = "its thread storage root is unknown";
  const recorder = () => {
    const rows: unknown[][] = [];
    return { rows, db: { prepare: (sql: string) => ({ run: (...args: unknown[]) => { rows.push([sql.replace(/\s+/g, " "), args[0]]); } }) } };
  };
  const waitFor = async (ready: () => boolean) => {
    for (let i = 0; i < 400 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ready()).toBe(true);
  };
  /** A host lookup whose first answer the test settles by hand; every later lookup answers with the host at <root>/thread-storage. */
  const cold = () => {
    const gate: { lookups: number; reject: (error: Error) => void } = { lookups: 0, reject: () => undefined };
    const hosts = (root: string) => ({
      get: (): Promise<Host> => (++gate.lookups === 1 ? new Promise<Host>((_, reject) => { gate.reject = reject; }) : Promise.resolve({ threadStorageRootPath: join(root, "thread-storage") })),
    });
    return { gate, hosts };
  };

  test("a known host: the artifact lands under data dir, project and thread without asking for the thread's storage, and the lookup runs once", async () => {
    let lookups = 0;
    const w = await world(undefined, true, { hosts: (root) => ({ get: async () => { lookups++; return { threadStorageRootPath: join(root, "thread-storage") }; } }) });
    expect(await w.writeArtifact("thr_1", "proj_1", "a.md", "A", "host_1")).toBe(join(w.root, "chief", "proj_1", "thr_1", "a.md"));
    expect(await w.writeArtifact("thr_1", "proj_1", "b.md", "B", "host_1")).toBe(join(w.root, "chief", "proj_1", "thr_1", "b.md"));
    expect(await readFile(join(w.root, "chief", "proj_1", "thr_1", "a.md"), "utf8")).toBe("A");
    expect(lookups).toBe(1);
    expect(w.storageCalls).toEqual([]);
  });

  test.each([
    ["no thread storage root", async (): Promise<Host> => ({}), unknownRoot],
    ["a rejected lookup", async (): Promise<Host> => { throw new Error("boom"); }, "reading it failed: Error: boom"],
  ])("a named host with %s throws the unavailable-data-dir error, writes nothing and records no fallback", async (_name, get, reason) => {
    const { rows, db } = recorder();
    const w = await world(undefined, true, { hosts: () => ({ get }), db });
    await expect(w.writeArtifact("thr_1", "proj_1", "a.md", "A", "host_9")).rejects.toThrow(`Host host_9's BB data dir is unavailable (${reason})`);
    expect(w.calls).toEqual([]);
    expect(w.warnings).toEqual([]);
    expect(w.storageCalls).toEqual([]);
    expect(rows).toEqual([]);
  });

  test.each([
    ["no thread storage root", async (): Promise<Host> => ({}), unknownRoot],
    ["a rejected lookup", async (): Promise<Host> => { throw new Error("boom"); }, "reading it failed: Error: boom"],
  ])("with no named host and %s, it warns with that reason, records artifact_fallbacks for the thread and writes into the thread's storage root", async (_name, get, reason) => {
    const { rows, db } = recorder();
    const storage = await mkdtemp(join(tmpdir(), "chief-artifact-storage-"));
    roots.push(storage);
    const w = await world(undefined, true, { hosts: () => ({ get }), db, storage });
    expect(await w.writeArtifact("thr_1", "proj_1", "a.md", "A")).toBe(join(storage, "a.md"));
    expect(await readFile(join(storage, "a.md"), "utf8")).toBe("A");
    expect(w.warnings).toEqual([`Host host_1's BB data dir is unavailable (${reason}); writing Chief artifacts to thread storage instead.`]);
    expect(rows).toEqual([["INSERT OR IGNORE INTO artifact_fallbacks (thread_id, at) VALUES (?, ?)", "thr_1"]]);
  });

  test("a failed lookup is not cached: the next write of the host looks again", async () => {
    let lookups = 0;
    const w = await world(undefined, true, { hosts: (root) => ({ get: async () => { if (++lookups === 1) throw new Error("boom"); return { threadStorageRootPath: join(root, "thread-storage") }; } }) });
    await expect(w.writeArtifact("thr_1", "proj_1", "a.md", "A", "host_1")).rejects.toThrow("reading it failed");
    expect(await w.writeArtifact("thr_1", "proj_1", "a.md", "A", "host_1")).toBe(join(w.root, "chief", "proj_1", "thr_1", "a.md"));
    expect(lookups).toBe(2);
  });

  // Regression: a cold-cache lookup that fails kept its own failure only while no other call had filled the cache first.
  test("a named-host write whose own lookup rejects still throws when another call of the host fills the cache before the rejection", async () => {
    const { gate, hosts } = cold();
    const w = await world(undefined, true, { hosts });
    const first = w.writeArtifact("thr_1", "proj_1", "a.md", "A", "host_1");
    const outcome = first.then(() => "wrote", (error: Error) => error.message);
    await waitFor(() => gate.lookups === 1);
    await w.writeArtifact("thr_2", "proj_1", "b.md", "B", "host_1"); // the second lookup succeeds and fills the cache
    gate.reject(new Error("late failure"));
    expect(await outcome).toBe("Host host_1's BB data dir is unavailable (reading it failed: Error: late failure)");
    expect(w.calls.filter((call) => call.includes("thr_1"))).toEqual([]);
  });

  test("a write with no named host whose own lookup rejects still warns, records the fallback and uses thread storage when another call fills the cache first", async () => {
    const { rows, db } = recorder();
    const storage = await mkdtemp(join(tmpdir(), "chief-artifact-storage-"));
    roots.push(storage);
    const { gate, hosts } = cold();
    const w = await world(undefined, true, { hosts, db, storage });
    const first = w.writeArtifact("thr_1", "proj_1", "a.md", "A");
    await waitFor(() => gate.lookups === 1);
    await w.writeArtifact("thr_2", "proj_1", "b.md", "B"); // the second lookup succeeds and fills the cache
    expect(rows).toEqual([]);
    gate.reject(new Error("late failure"));
    expect(await first).toBe(join(storage, "a.md"));
    expect(w.warnings).toEqual(["Host host_1's BB data dir is unavailable (reading it failed: Error: late failure); writing Chief artifacts to thread storage instead."]);
    expect(rows).toEqual([["INSERT OR IGNORE INTO artifact_fallbacks (thread_id, at) VALUES (?, ?)", "thr_1"]]);
    expect(await readFile(join(w.root, "chief", "proj_1", "thr_2", "b.md"), "utf8")).toBe("B");
  });
});
