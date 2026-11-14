import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createArtifacts } from "./src/runtime/artifacts";
import { createManagedSpawn } from "./src/research/managedSpawn";

// Contracts (docs/specs/observability.md, "Durable brief"): the two brief copies are written independently; each retries
// while bb answers HTTP 409 (waits 1, 2, 4, 8, 15, 30 s; at most 7 attempts); any other error is not retried; the Chief
// artifact copy goes to the project's host without asking bb for the thread's storage location; persistBrief never rejects;
// launch does not wait for the brief.
const PROMPT = "# Brief\n\n  indented line with trailing space \nünïcode ✓\n";
const ARTIFACT = join("/data", "chief", "proj_1", "thr_1", "brief.md");
const STORAGE = join("/storage/thr_1", "brief.md");
const e409 = () => new Error("HTTP 409: Thread environment is unavailable");

/** createArtifacts over in-memory host files (fake timers cannot flush real disk I/O) and a scripted storageLocation. */
function world(opts: { projectHost?: string | null; projectHostId?: () => Promise<string | null>; storageLocation?: (call: number) => Error | undefined } = {}) {
  const files = new Map<string, string>();
  const warn = vi.fn();
  let storageLocationCalls = 0;
  const bb = {
    log: { warn },
    sdk: {
      files: {
        write: async ({ path, content }: { path: string; content: string }) => { files.set(path, content); return {}; },
        move: async ({ sourcePath, destinationPath }: { sourcePath: string; destinationPath: string }) => {
          files.set(destinationPath, files.get(sourcePath)!);
          files.delete(sourcePath);
          return {};
        },
        remove: async ({ path }: { path: string }) => { files.delete(path); return {}; },
      },
      threads: {
        storageLocation: async () => {
          storageLocationCalls += 1;
          const failure = opts.storageLocation?.(storageLocationCalls);
          if (failure) throw failure;
          return { hostId: "host_1", storageRootPath: "/storage/thr_1" };
        },
      },
    },
  };
  const ctx = {
    bb, db: {}, state: { dataDirs: new Map([["host_1", "/data"]]) },
    projectHostId: opts.projectHostId ?? (async () => (opts.projectHost === undefined ? "host_1" : opts.projectHost)),
  };
  const artifacts = createArtifacts(ctx as never);
  return { files, warn, artifacts, storageLocationCalls: () => storageLocationCalls, persist: () => artifacts.persistBrief("thr_1", "proj_1", PROMPT) };
}

describe("persistBrief", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test("while storageLocation always answers 409, the artifact copy still lands at once, byte-identical, at the project host's data dir", async () => {
    const w = world({ storageLocation: e409 });
    const done = w.persist();
    await vi.advanceTimersByTimeAsync(0); // no backoff elapsed: the artifact copy did not wait for the storage copy's retries
    expect(w.files.get(ARTIFACT)).toBe(PROMPT);
    expect(w.files.has(STORAGE)).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    await done;
  });

  test("a storage copy whose storageLocation answers 409 twice lands byte-identical after the 1 s and 2 s waits, with no warning", async () => {
    const w = world({ storageLocation: (call) => (call <= 2 ? e409() : undefined) });
    const done = w.persist();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(w.files.has(STORAGE)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(w.files.get(STORAGE)).toBe(PROMPT);
    expect(w.files.get(ARTIFACT)).toBe(PROMPT);
    expect(w.warn).not.toHaveBeenCalled();
  });

  test("a storage copy that always answers 409 stops after 7 attempts over 60 s with one warning, persistBrief resolves and the artifact copy landed", async () => {
    const w = world({ storageLocation: e409 });
    const done = w.persist();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(w.storageLocationCalls()).toBe(6); // waits 1+2+4+8+15+30 = 60 s precede the 7th
    expect(w.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    // The artifact copy asked bb for no location, so every storageLocation call is the storage copy's.
    expect(w.storageLocationCalls()).toBe(7);
    expect(w.warn).toHaveBeenCalledTimes(1);
    expect(w.warn.mock.calls[0][0]).toMatch(/^Could not write thr_1's brief: .*HTTP 409/);
    expect(w.files.has(STORAGE)).toBe(false);
    expect(w.files.get(ARTIFACT)).toBe(PROMPT);
  });

  test("a non-409 error is not retried: one attempt, one warning", async () => {
    const w = world({ storageLocation: () => new Error("HTTP 500: boom") });
    const done = w.persist();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(done).resolves.toBeUndefined();
    expect(w.storageLocationCalls()).toBe(1);
    expect(w.warn).toHaveBeenCalledTimes(1);
    expect(w.warn.mock.calls[0][0]).toMatch(/^Could not write thr_1's brief: .*HTTP 500/);
    expect(w.files.get(ARTIFACT)).toBe(PROMPT);
  });

  test("when the project host is unknown the artifact copy falls back to storageLocation and retries on 409 until it lands", async () => {
    let provisioning = true;
    const w = world({ projectHost: null, storageLocation: () => (provisioning ? e409() : undefined) });
    const done = w.persist();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(w.files.has(ARTIFACT)).toBe(false);
    provisioning = false;
    await vi.advanceTimersByTimeAsync(1); // the 3 s retry (after the 1 s and 2 s waits) now succeeds
    await done;
    expect(w.files.get(ARTIFACT)).toBe(PROMPT);
    expect(w.files.get(STORAGE)).toBe(PROMPT);
    expect(w.warn).not.toHaveBeenCalled();
  });

  test("while the project host lookup is still pending the storage copy has already landed; once released the artifact copy lands and persistBrief resolves with no warning", async () => {
    let release!: (hostId: string) => void;
    const w = world({ projectHostId: () => new Promise<string>((resolve) => { release = resolve; }) });
    const done = w.persist();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.files.get(STORAGE)).toBe(PROMPT);
    expect(w.files.has(ARTIFACT)).toBe(false);
    release("host_1");
    await expect(done).resolves.toBeUndefined();
    expect(w.files.get(ARTIFACT)).toBe(PROMPT);
    expect(w.warn).not.toHaveBeenCalled();
  });

  test("a project host lookup that rejects costs only the artifact copy: one artifact warning, the storage copy landed and persistBrief resolves", async () => {
    const w = world({ projectHostId: async () => { throw new Error("projects.get failed"); } });
    await expect(w.persist()).resolves.toBeUndefined();
    expect(w.files.get(STORAGE)).toBe(PROMPT);
    expect(w.files.has(ARTIFACT)).toBe(false);
    expect(w.warn).toHaveBeenCalledTimes(1);
    expect(w.warn.mock.calls[0][0]).toMatch(/^Could not write thr_1's brief artifact: .*projects\.get failed/);
  });
});

describe("writeArtifact with a named host", () => {
  test("asks bb for no storage location and lands at the host's data dir; without a named host it asks once and lands at the same path", async () => {
    const w = world({ storageLocation: e409 });
    await expect(w.artifacts.writeArtifact("thr_1", "proj_1", "brief.md", PROMPT, "host_1")).resolves.toBe(ARTIFACT);
    expect(w.storageLocationCalls()).toBe(0);
    expect(w.files.get(ARTIFACT)).toBe(PROMPT);

    const control = world();
    await expect(control.artifacts.writeArtifact("thr_1", "proj_1", "brief.md", PROMPT)).resolves.toBe(ARTIFACT);
    expect(control.storageLocationCalls()).toBe(1);
  });
});

describe("managedSpawn launch", () => {
  test("resolves with the spawned thread after the row insert while persistBrief never settles", async () => {
    const order: string[] = [];
    const persistBrief = vi.fn(() => { order.push("persistBrief"); return new Promise<void>(() => undefined); });
    const spawn = { id: "thr_new", status: "running" };
    const { launch } = createManagedSpawn({
      bb: { sdk: { threads: { spawn: async () => spawn } } } as never,
      db: {} as never,
      spawnExecution: async () => ({}),
      ensureSection: async () => "sec_1",
      readRules: async () => undefined,
      lifecycleOwner: async () => ({}),
      insertThread: () => { order.push("insert"); },
      persistBrief,
    });
    const thread = await launch(
      { execution: {}, sectionId: "sec_1" },
      { projectId: "proj_1", environment: { type: "newWorktree" } as never, title: "t", prompt: PROMPT },
      { role: "worker", chiefThreadId: "thr_chief" },
    );
    expect(thread).toBe(spawn);
    expect(order).toEqual(["insert", "persistBrief"]);
    expect(persistBrief).toHaveBeenCalledWith("thr_new", "proj_1", PROMPT);
  });
});
