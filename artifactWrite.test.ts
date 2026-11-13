import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createArtifacts } from "./src/runtime/artifacts";

// Contracts (docs/specs/observability.md, "Artifact writes"): a write replaces an existing file; only an "already exists" move error
// triggers remove-then-move; any other failure removes the tmp file and rethrows.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** createArtifacts over a real temp dir, with a host `move` that refuses an existing destination as the production host does. */
async function world(moveFails: (call: number) => Error | undefined = () => undefined) {
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
  };
  const bb = { sdk: { files, threads: { storageLocation: async () => ({ hostId: "host_1", storageRootPath: root }) } } };
  const { writeStorageFile } = createArtifacts({ bb, db: {}, state: { dataDirs: new Map() } } as never);
  return { root, calls, write: (content: string) => writeStorageFile("thr_1", "out/file.md", content), path: join(root, "out/file.md") };
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
