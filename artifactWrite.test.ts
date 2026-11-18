import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { heavyScript } from "./src/research/heavySlots";
import { createArtifacts } from "./src/runtime/artifacts";

// Contracts (docs/specs/observability.md, "Artifact writes"): a write replaces an existing file; only an "already exists" move error
// triggers remove-then-move; any other failure removes the tmp file and rethrows.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** createArtifacts over a real temp dir, with a host `move` that refuses an existing destination as the production host does. */
async function world(moveFails: (call: number) => Error | undefined = () => undefined, dataDirKnown = true) {
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
  const hosts = { get: async () => (dataDirKnown ? { threadStorageRootPath: join(root, "thread-storage") } : {}) };
  const bb = { onDispose: () => undefined, sdk: { files, hosts, threads: { storageLocation: async () => ({ hostId: "host_1", storageRootPath: root }) } } };
  const { writeStorageFile, publishHeavy } = createArtifacts({ bb, db: {}, state: { dataDirs: new Map() } } as never);
  return { root, calls, publishHeavy, write: (content: string) => writeStorageFile("thr_1", "out/file.md", content), path: join(root, "out/file.md") };
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
