import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { cliAdapters, createForgeComments, FORGE_COMMENTS_TABLE, type ForgeAdapter } from "./forgeComments";

// Stands in for gh/glab, as in server.test.ts: the real adapters keep calling the promisified execFile.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => {
  const execFile: any = () => { throw new Error("execFile must be invoked through promisify"); };
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args: any[]) => execFileMock(...args);
  return { execFile };
});

// Expected values are written here, never taken from the module: the marker is the documented sha1(key)[0:16] hidden comment.
const markerOf = (key: string) => `<!-- chief:${createHash("sha1").update(key).digest("hex").slice(0, 16)} -->`;
const URL_GH = "https://github.com/acme/shop/pull/8";
const T0 = 1_000_000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const transient = (stderr = "HTTP 502 bad gateway") => Object.assign(new Error("gh failed"), { stderr });
const deferred = () => {
  let resolve!: () => void; let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const disposals: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
afterEach(async () => {
  vi.useRealTimers();
  while (disposals.length) await disposals.pop()!();
  execFileMock.mockReset();
});

function makeDb() {
  const { bb, harness } = createFakePluginHost({ pluginId: "forge-comments-test" });
  disposals.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  db.exec(FORGE_COMMENTS_TABLE);
  return db;
}
type Db = ReturnType<typeof makeDb>;

/** A fake adapter that records every call and lets a test choose what each one does. */
function fakeAdapter() {
  const calls: string[] = [];
  const posts: string[] = [];
  const scans: string[] = [];
  const impl = {
    post: async (_body: string): Promise<void> => {},
    hasMarker: async (_marker: string): Promise<boolean> => false,
    login: async (): Promise<string> => "owner",
  };
  const adapter: ForgeAdapter = {
    post: async (_target, body) => { calls.push("post"); posts.push(body); await impl.post(body); },
    hasMarker: async (_target, marker) => { calls.push("scan"); scans.push(marker); return impl.hasMarker(marker); },
    login: async () => { calls.push("login"); return impl.login(); },
  };
  return { adapter, impl, calls, posts, scans };
}

function outbox(db: Db, fake: ReturnType<typeof fakeAdapter>, options: { owner?: string; escalate?: (...args: any[]) => Promise<unknown> } = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const escalate = vi.fn(options.escalate ?? (async () => {}));
  const instance = createForgeComments({
    db, adapters: { github: fake.adapter, gitlab: fake.adapter }, ownerHandle: async () => options.owner ?? "", escalate, log,
  });
  return { ...instance, log, escalate };
}

const input = (key = "complete:thr_w", extra: Record<string, unknown> = {}) => ({
  key, row: { project_id: "proj_1", thread_id: "thr_w" }, target: URL_GH,
  comment: { title: "Need you", lines: ["Please decide"] }, ...extra,
});
const rowOf = (db: Db, key: string) => db.prepare(`SELECT * FROM forge_comments WHERE dedupe_key=?`).get(key) as any;
const count = (db: Db) => (db.prepare(`SELECT COUNT(*) AS n FROM forge_comments`).get() as { n: number }).n;
function seed(db: Db, key: string, o: { attempts?: number; created_at?: number; posted_at?: number; gave_up_at?: number; target?: string; mention?: number } = {}) {
  db.prepare(`INSERT INTO forge_comments (dedupe_key, project_id, thread_id, target, body, mention, attempts, posted_at, gave_up_at, created_at) VALUES (?, 'proj_1', 'thr_w', ?, ?, ?, ?, ?, ?, ?)`)
    .run(key, o.target ?? URL_GH, `body ${key}\n\n${markerOf(key)}`, o.mention ?? 0, o.attempts ?? 0, o.posted_at ?? null, o.gave_up_at ?? null, o.created_at ?? T0);
}

describe("forge comment outbox with a fake adapter", () => {
  // Contract "Equivalence of stored rows" + "Idempotency" + "Never blocks": one golden row, one post, no adapter call before enqueue returns.
  // Regression: a changed body layout, a second row for a repeated key, or a post made on the caller's path.
  test("enqueue stores the golden body, makes no adapter call before it returns, and a repeated key adds no row and no post", async () => {
    const db = makeDb();
    const fake = fakeAdapter();
    const o = outbox(db, fake);
    const key = "complete:thr_w";
    expect(o.enqueue(input(key, { comment: { title: "Completed", round: 2, lines: ["**Fix totals** · wave 1 of 2", `Pull request: ${URL_GH}`], details: { summary: "Result", body: "All good\nsecond line" } } }))).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(o.enqueue(input(key))).toBe(true);
    await o.drain();
    const golden = ["**Chief · Completed** · round 2", "**Fix totals** · wave 1 of 2", `Pull request: ${URL_GH}`, "", "<details><summary>Result</summary>", "", "All good", "second line", "", "</details>", "", markerOf(key)].join("\n");
    expect(db.prepare(`SELECT * FROM forge_comments`).all()).toEqual([
      { dedupe_key: key, project_id: "proj_1", thread_id: "thr_w", target: URL_GH, body: golden, mention: 0, attempts: 1, last_error: null, posted_at: T0, gave_up_at: null, created_at: T0 },
    ]);
    expect(fake.posts).toEqual([golden]);
    expect(fake.scans).toEqual([]);
  });

  // Contract "Never throws, never blocks": no row for a target that is no forge URL.
  test.each([[null], [undefined], [""], ["https://example.com/acme/shop"], ["https://github.com/acme/shop"]])("enqueue returns false and writes no row for target %j", async (target) => {
    const db = makeDb();
    const fake = fakeAdapter();
    const o = outbox(db, fake);
    expect(o.enqueue(input("blocked:thr_w:1", { target }))).toBe(false);
    await o.drain();
    expect(count(db)).toBe(0);
    expect(o.log.info).toHaveBeenCalledTimes(1);
    expect(fake.calls).toEqual([]);
  });

  // Contract "Never throws": a failed insert returns false and defers one Chief alert; it never throws.
  // Regression: the alert written on the caller's path (inside a transaction that may roll back), or a thrown insert error.
  test("a failed insert returns false, never throws, and alerts Chief once after enqueue has returned", async () => {
    const db = makeDb();
    db.exec(`DROP TABLE forge_comments`);
    const fake = fakeAdapter();
    const o = outbox(db, fake);
    expect(o.enqueue(input("blocked:thr_w:1"))).toBe(false);
    expect(o.escalate).not.toHaveBeenCalled();
    await tick();
    const message = `Could not queue the forge comment blocked for ${URL_GH}: SqliteError: no such table: forge_comments. The local record is intact.`;
    expect(o.escalate.mock.calls).toEqual([["thr_w", "forge-comment:blocked:thr_w:1", message]]);
    expect(fake.calls).toEqual([]);
  });

  // Contract "Crash safety": attempts is in SQLite before the call; a first attempt posts without a scan.
  test("attempts is persisted before the post, and a first attempt posts without a marker scan", async () => {
    const db = makeDb();
    const fake = fakeAdapter();
    let seen: any;
    fake.impl.post = async () => { seen = rowOf(db, "blocked:thr_w:1"); };
    const o = outbox(db, fake);
    o.enqueue(input("blocked:thr_w:1"));
    await o.drain();
    expect(seen).toMatchObject({ attempts: 1, posted_at: null });
    expect(fake.calls).toEqual(["post"]);
  });

  // Contract "Crash safety and marker round-trip": a retried row scans for the exact marker, passed verbatim, before it posts.
  // Regression: the key or a re-hashed marker is passed to the adapter, or the scan result is ignored.
  test.each([
    ["marker present", async () => true, { posted: false, error: null }],
    ["marker absent", async () => false, { posted: true, error: null }],
    ["scan throws", async () => { throw transient("HTTP 500 scan failed"); }, { posted: false, error: "HTTP 500 scan failed" }],
  ])("a restarted row with earlier attempts scans for the exact marker first: %s", async (_name, scan, expected) => {
    const db = makeDb();
    const key = "blocked:thr_w:1";
    const first = fakeAdapter();
    first.impl.post = async () => { throw transient(); };
    const a = outbox(db, first);
    a.enqueue(input(key));
    await a.drain();
    expect(rowOf(db, key)).toMatchObject({ attempts: 1, posted_at: null, gave_up_at: null });

    const second = fakeAdapter();
    let attemptsAtScan: number | undefined;
    second.impl.hasMarker = async (marker) => { attemptsAtScan = rowOf(db, key).attempts; return scan(marker); };
    await outbox(db, second).drain();
    expect(second.scans).toEqual([markerOf(key)]);
    expect(attemptsAtScan).toBe(2);
    expect(second.posts).toHaveLength(expected.posted ? 1 : 0);
    const row = rowOf(db, key);
    expect(row.posted_at !== null).toBe(expected.posted || expected.error === null);
    expect(row.last_error).toBe(expected.error);
    expect(row.gave_up_at).toBeNull();
  });

  // Contract "Failure classes": each class is decided from the adapter error alone. Regression: any pattern moved to the other class.
  test.each([
    ["ENOENT", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }), "permanent"],
    ["HTTP 401", transient("gh: Bad credentials (HTTP 401)"), "permanent"],
    ["HTTP 403", transient("gh: Resource not accessible (HTTP 403)"), "permanent"],
    ["HTTP 404", transient("gh: Not Found (HTTP 404)"), "permanent"],
    ["not logged in", transient("You are not logged into any GitLab hosts. Run glab auth login"), "permanent"],
    ["rate limit beats 403", transient("HTTP 403: API rate limit exceeded"), "transient"],
    ["secondary abuse limit", transient("You have triggered an abuse detection mechanism"), "transient"],
    ["HTTP 429", transient("HTTP 429 Too Many Requests"), "transient"],
    ["anything else", transient("connection reset by peer"), "transient"],
  ])("a %s failure is %s on its first attempt", async (_name, failure, kind) => {
    const db = makeDb();
    const fake = fakeAdapter();
    fake.impl.post = async () => { throw failure; };
    const o = outbox(db, fake);
    o.enqueue(input("blocked:thr_w:1"));
    await o.drain();
    const row = rowOf(db, "blocked:thr_w:1");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBeTruthy();
    expect(row.gave_up_at).toBe(kind === "permanent" ? T0 : null);
    expect(o.log.info).toHaveBeenCalledTimes(kind === "permanent" ? 1 : 0);
    expect(o.escalate).not.toHaveBeenCalled();
  });

  test("a stored target that does not parse is a permanent failure with no adapter call", async () => {
    const db = makeDb();
    seed(db, "blocked:thr_w:1", { target: "not a url" });
    const fake = fakeAdapter();
    const o = outbox(db, fake);
    await o.drain();
    expect(rowOf(db, "blocked:thr_w:1")).toMatchObject({ attempts: 1, gave_up_at: T0, posted_at: null });
    expect(fake.calls).toEqual([]);
    expect(o.escalate).not.toHaveBeenCalled();
  });

  // Contract "Retry bounds (as base behaves)": the 25 s clock is per instance and in memory; five attempts, one escalation.
  // Regression: a retry before 25 s, a sixth attempt, a repeated alert, or an alert text that drifts.
  test("in one instance a transient row waits 25 s between tries, makes exactly 5 attempts, and alerts Chief exactly once", async () => {
    const db = makeDb();
    const fake = fakeAdapter();
    fake.impl.post = async () => { throw transient(); };
    const o = outbox(db, fake);
    const key = "verdict:thr_r:3";
    o.enqueue(input(key));
    await o.drain();
    expect(fake.posts).toHaveLength(1);
    vi.setSystemTime(T0 + 24_999);
    await o.drain();
    expect(fake.posts).toHaveLength(1);
    for (const [index, at] of [25_000, 50_000, 75_000, 100_000].entries()) {
      vi.setSystemTime(T0 + at);
      await o.drain();
      expect(fake.posts).toHaveLength(index + 2);
    }
    expect(rowOf(db, key)).toMatchObject({ attempts: 5, posted_at: null, gave_up_at: T0 + 100_000, last_error: "HTTP 502 bad gateway" });
    expect(o.escalate.mock.calls).toEqual([["thr_w", `forge-comment:${key}`, `Could not post the verdict comment to ${URL_GH} after 5 attempts: HTTP 502 bad gateway. The local record is intact.`]]);
    expect(fake.scans).toEqual(Array(4).fill(markerOf(key)));
    vi.setSystemTime(T0 + 200_000);
    await o.drain();
    expect(fake.posts).toHaveLength(5);
    expect(o.escalate).toHaveBeenCalledTimes(1);
  });

  // Contract "Retry bounds": an alert that throws or rejects is contained.
  test.each([
    ["rejects", async () => { throw new Error("alert down"); }],
    ["throws synchronously", () => { throw new Error("alert down"); }],
  ])("a Chief alert that %s is logged and drain still resolves", async (_name, escalate) => {
    const db = makeDb();
    seed(db, "blocked:thr_w:1", { attempts: 4 });
    const fake = fakeAdapter();
    fake.impl.post = async () => { throw transient(); };
    const o = outbox(db, fake, { escalate: escalate as any });
    await expect(o.drain()).resolves.toBeUndefined();
    const message = `Could not post the blocked comment to ${URL_GH} after 5 attempts: HTTP 502 bad gateway. The local record is intact.`;
    expect(o.log.error).toHaveBeenCalledWith(`${message} The Chief alert also failed: Error: alert down`);
    expect(rowOf(db, "blocked:thr_w:1").gave_up_at).toBe(T0);
  });

  // Contract "Retry bounds": at most 20 rows per pass, oldest first; terminal rows are never retried.
  test("a pass handles at most 20 pending rows, oldest first, and never touches a posted or given-up row", async () => {
    const db = makeDb();
    for (let index = 24; index >= 0; index -= 1) seed(db, `k${index}`, { created_at: 2_000 + index });
    seed(db, "done", { created_at: 1, posted_at: 5 });
    seed(db, "gone", { created_at: 2, gave_up_at: 5 });
    const fake = fakeAdapter();
    const o = outbox(db, fake);
    await o.drain();
    expect(fake.posts).toEqual(Array.from({ length: 20 }, (_, index) => `body k${index}\n\n${markerOf(`k${index}`)}`));
    expect(db.prepare(`SELECT dedupe_key FROM forge_comments WHERE posted_at IS NULL AND gave_up_at IS NULL ORDER BY created_at`).all())
      .toEqual(Array.from({ length: 5 }, (_, index) => ({ dedupe_key: `k${index + 20}` })));
    await o.drain();
    expect(fake.posts).toHaveLength(25);
    expect(rowOf(db, "done")).toMatchObject({ attempts: 0, posted_at: 5 });
    expect(rowOf(db, "gone")).toMatchObject({ attempts: 0, gave_up_at: 5 });
  });

  // Contract "Inherited limits kept (must not be 'fixed')": the retry clock does not survive a restart.
  // Regression: a persisted clock or an attempts filter that makes a fresh instance wait.
  test("a fresh instance retries a transiently failed row at once, scanning first", async () => {
    const db = makeDb();
    const key = "blocked:thr_w:1";
    const first = fakeAdapter();
    first.impl.post = async () => { throw transient(); };
    const a = outbox(db, first);
    a.enqueue(input(key));
    await a.drain();
    vi.setSystemTime(T0 + 1);
    const second = fakeAdapter();
    const b = outbox(db, second);
    await b.drain();
    expect(second.calls).toEqual(["scan", "post"]);
    expect(rowOf(db, key)).toMatchObject({ attempts: 2, posted_at: T0 + 1 });
  });

  // Contract "Inherited limits kept": an interrupted fifth attempt resumes as attempt 6 and escalates once. Regression: a restart-wide cap.
  test("a pending row left at attempts=5 is retried as attempt 6 and escalates once with the unchanged text", async () => {
    const db = makeDb();
    const key = "complete:thr_w";
    seed(db, key, { attempts: 5 });
    const fake = fakeAdapter();
    fake.impl.post = async () => { throw transient(); };
    const o = outbox(db, fake);
    await o.drain();
    expect(fake.scans).toEqual([markerOf(key)]);
    expect(fake.posts).toHaveLength(1);
    expect(rowOf(db, key)).toMatchObject({ attempts: 6, gave_up_at: T0, posted_at: null });
    expect(o.escalate.mock.calls).toEqual([["thr_w", `forge-comment:${key}`, `Could not post the complete comment to ${URL_GH} after 5 attempts: HTTP 502 bad gateway. The local record is intact.`]]);
    await o.drain();
    expect(fake.posts).toHaveLength(1);
  });

  // Contract "Single flight": concurrent drains coalesce into one more pass; an enqueue during a pass still gets a later pass.
  // Each post moves the clock 30 s, so a failing row is eligible in every pass and its attempts count the passes.
  // Regression: a counter instead of a flag (attempts would reach 4), or an enqueue that waits for the next supervisor tick.
  test("three drains during a pass add one pass, and an enqueue during that pass adds another", async () => {
    const db = makeDb();
    const fake = fakeAdapter();
    const gates: ReturnType<typeof deferred>[] = [];
    fake.impl.post = () => {
      vi.setSystemTime(Date.now() + 30_000);
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    };
    const o = outbox(db, fake);
    o.enqueue(input("k1"));
    await tick();
    expect(gates).toHaveLength(1);
    const drains = [o.drain(), o.drain(), o.drain()];
    gates[0]!.reject(transient());
    await tick();
    expect(gates).toHaveLength(2);
    expect(rowOf(db, "k1").attempts).toBe(2);

    o.enqueue(input("k2"));
    await tick();
    gates[1]!.reject(transient());
    await tick();
    expect(gates).toHaveLength(3);
    expect(rowOf(db, "k1").attempts).toBe(3);
    gates[2]!.resolve();
    await tick();
    expect(gates).toHaveLength(4);
    gates[3]!.resolve();
    await Promise.all(drains);
    expect(rowOf(db, "k1")).toMatchObject({ attempts: 3, posted_at: expect.any(Number) });
    expect(rowOf(db, "k2")).toMatchObject({ attempts: 1, posted_at: expect.any(Number) });
  });

  // Contract "Single flight": drain never rejects. Regression: a failing SELECT escapes into the supervisor tick.
  test("drain resolves when the pass itself throws", async () => {
    const db = makeDb();
    db.exec(`DROP TABLE forge_comments`);
    const o = outbox(db, fakeAdapter());
    await expect(o.drain()).resolves.toBeUndefined();
    expect(o.log.warn).toHaveBeenCalledWith(expect.stringContaining("Forge comment drain failed"));
  });

  // Contract "Mention".
  test("a configured @handle is stripped and placed on its own line before the marker, with no login call", async () => {
    const db = makeDb();
    const fake = fakeAdapter();
    const o = outbox(db, fake, { owner: " @octo " });
    o.enqueue(input("escalate:thr_w:abc", { mention: true }));
    await o.drain();
    expect(fake.posts).toEqual([`**Chief · Need you**\nPlease decide\n\n@octo\n\n${markerOf("escalate:thr_w:abc")}`]);
    expect(fake.calls).toEqual(["post"]);
  });

  test("with no configured handle the login is used and cached per host, not per post", async () => {
    const db = makeDb();
    const fake = fakeAdapter();
    const o = outbox(db, fake);
    const hosts = ["https://github.com/acme/shop/pull/8", "https://github.com/acme/shop/pull/9", "https://git.example.com/acme/shop/pull/1"];
    for (const [index, target] of hosts.entries()) {
      vi.setSystemTime(T0 + index);
      o.enqueue(input(`escalate:thr_w:${index}`, { mention: true, target }));
    }
    await o.drain();
    expect(fake.calls.filter((call) => call === "login")).toHaveLength(2);
    expect(fake.posts).toHaveLength(3);
    for (const body of fake.posts) expect(body).toContain("\n\n@owner\n\n<!-- chief:");
  });

  test.each([
    ["an invalid login", { owner: "", login: async () => "not a login" }],
    ["a login that fails", { owner: "", login: async () => { throw new Error("no auth"); } }],
    ["an invalid configured handle", { owner: "@bad handle", login: async () => "owner" }],
  ])("%s adds no mention and the comment is still posted", async (_name, { owner, login }) => {
    const db = makeDb();
    const fake = fakeAdapter();
    fake.impl.login = login;
    const o = outbox(db, fake, { owner });
    o.enqueue(input("escalate:thr_w:abc", { mention: true }));
    await o.drain();
    expect(fake.posts).toEqual([`**Chief · Need you**\nPlease decide\n\n${markerOf("escalate:thr_w:abc")}`]);
  });
});

// The real gh and glab adapters, with only the child process replaced. They share one dedupe protocol, so each case runs on both forges.
const OPTS = (env: object) => ({ timeout: 30_000, env, maxBuffer: 32 * 1024 * 1024 });
const FORGES = [
  {
    name: "GitHub", url: URL_GH, cli: "gh",
    postArgs: (body: string) => ["api", "--hostname", "github.com", "--method", "POST", "repos/acme/shop/issues/8/comments", "-f", `body=${body}`],
    listArgs: (_page: number) => ["api", "--hostname", "github.com", "--paginate", "repos/acme/shop/issues/8/comments", "--jq", ".[].body"],
    loginArgs: ["api", "--hostname", "github.com", "user", "--jq", ".login"],
    loginOut: "octo-cat\n",
    // GitHub's --jq prints one body per line, in thread order: the earlier comments come first.
    list: (_page: number, bodies: string[], filler: boolean) => ({ stdout: [...(filler ? ["an earlier comment", "another\nmulti-line one"] : []), ...bodies].join("\n") }),
  },
  {
    name: "GitLab", url: "https://gitlab.com/acme/group/shop/-/merge_requests/8", cli: "glab",
    postArgs: (body: string) => ["api", "--hostname", "gitlab.com", "--method", "POST", "projects/acme%2Fgroup%2Fshop/merge_requests/8/notes", "--raw-field", `body=${body}`],
    listArgs: (page: number) => ["api", "--hostname", "gitlab.com", `projects/acme%2Fgroup%2Fshop/merge_requests/8/notes?per_page=100&page=${page}`],
    loginArgs: ["api", "--hostname", "gitlab.com", "user"],
    loginOut: JSON.stringify({ username: "octo-cat" }),
    // GitLab pages hold 100 notes; the match sits on page 2, behind a full first page.
    list: (page: number, bodies: string[], filler: boolean) => ({
      stdout: JSON.stringify(page === 1 && filler ? Array.from({ length: 100 }, (_, index) => ({ body: `note ${index}` })) : bodies.map((body) => ({ body }))),
    }),
  },
] as const;
const isPost = (args: string[]) => args.includes("POST");
const bodyOf = (args: string[]) => args.find((arg) => arg.startsWith("body="))!.slice(5);

describe.each(FORGES)("the real $name adapter through the outbox", (forge) => {
  const ENV = { PATH: "/x" };
  const KEY = "blocked:thr_w:1";
  const comment = { title: "Blocked", lines: ["**Blocker:** tests fail"] };
  const golden = `**Chief · Blocked**\n**Blocker:** tests fail\n\n${markerOf(KEY)}`;
  const real = (db: Db, escalate?: any) => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { ...createForgeComments({ db, adapters: cliAdapters(() => ENV), ownerHandle: async () => "", escalate: escalate ?? (async () => {}), log }), log };
  };

  // Contract "Marker round-trip (R2)": the body the real adapter posted is found by the real adapter on a fresh instance.
  // Regression: the adapter hashes the marker again (the scan never matches and the comment is posted twice), or the argv drifts.
  test("a lost response is found by the scan on a fresh instance: no second post, later-page match", async () => {
    const db = makeDb();
    let posted = "";
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (isPost(args)) { posted = bodyOf(args); throw transient(); }
      throw new Error("unexpected call");
    });
    const a = real(db);
    a.enqueue({ key: KEY, row: { project_id: "proj_1", thread_id: "thr_w" }, target: forge.url, comment });
    await a.drain();
    expect(posted).toBe(golden);
    expect(execFileMock.mock.calls).toEqual([[forge.cli, forge.postArgs(golden), OPTS(ENV)]]);
    expect(rowOf(db, KEY)).toMatchObject({ attempts: 1, posted_at: null });

    execFileMock.mockReset();
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (isPost(args)) throw new Error("a second post was made");
      return forge.list(Number(/&page=(\d+)/.exec(args.at(-1)!)?.[1] ?? 1), [posted], true);
    });
    vi.setSystemTime(T0 + 1);
    await real(db).drain();
    expect(execFileMock.mock.calls.map(([file, args]) => [file, args])).toEqual(
      forge.name === "GitHub" ? [[forge.cli, forge.listArgs(1)]] : [[forge.cli, forge.listArgs(1)], [forge.cli, forge.listArgs(2)]]);
    expect(rowOf(db, KEY)).toMatchObject({ attempts: 2, posted_at: T0 + 1, last_error: null });
  });

  test("a scan that reaches the end without the marker posts once, and every call reads the environment fresh", async () => {
    const db = makeDb();
    seed(db, KEY, { attempts: 1, target: forge.url });
    let envReads = 0;
    execFileMock.mockImplementation(async (_file: string, args: string[]) => isPost(args) ? { stdout: "" } : forge.list(1, ["someone else's comment"], false));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const o = createForgeComments({ db, adapters: cliAdapters(() => ({ READ: String(++envReads) })), ownerHandle: async () => "", escalate: async () => {}, log });
    await o.drain();
    expect(execFileMock.mock.calls.map(([file, args, options]) => [file, args, options.env])).toEqual([
      [forge.cli, forge.listArgs(1), { READ: "1" }],
      [forge.cli, forge.postArgs(`body ${KEY}\n\n${markerOf(KEY)}`), { READ: "2" }],
    ]);
    expect(rowOf(db, KEY)).toMatchObject({ attempts: 2, posted_at: T0 });
  });

  test("a scan that cannot read the list posts nothing and counts as a failed attempt", async () => {
    const db = makeDb();
    seed(db, KEY, { attempts: 1, target: forge.url });
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (isPost(args)) throw new Error("posted blind");
      throw transient("HTTP 500 list failed");
    });
    await real(db).drain();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(rowOf(db, KEY)).toMatchObject({ attempts: 2, posted_at: null, gave_up_at: null, last_error: "HTTP 500 list failed" });
  });

  test("the logged-in user is read through the real adapter for the mention", async () => {
    const db = makeDb();
    execFileMock.mockImplementation(async (_file: string, args: string[]) => args.includes("user") ? { stdout: forge.loginOut } : { stdout: "" });
    const o = real(db);
    o.enqueue({ key: KEY, row: { project_id: "proj_1", thread_id: "thr_w" }, target: forge.url, comment, mention: true });
    await o.drain();
    const withMention = `**Chief · Blocked**\n**Blocker:** tests fail\n\n@octo-cat\n\n${markerOf(KEY)}`;
    expect(execFileMock.mock.calls).toEqual([[forge.cli, forge.loginArgs, OPTS(ENV)], [forge.cli, forge.postArgs(withMention), OPTS(ENV)]]);
  });
});

describe("the real GitLab adapter scan limit", () => {
  // Contract "Crash safety": 50 full pages is an incomplete scan, not proof of absence. Regression: posting after page 50.
  test("50 full pages without the marker post nothing and count as a failed attempt", async () => {
    const db = makeDb();
    seed(db, "blocked:thr_w:1", { attempts: 1, target: "https://gitlab.com/acme/group/shop/-/merge_requests/8" });
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (isPost(args)) throw new Error("posted blind");
      return { stdout: JSON.stringify(Array.from({ length: 100 }, () => ({ body: "note" }))) };
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await createForgeComments({ db, adapters: cliAdapters(() => ({})), ownerHandle: async () => "", escalate: async () => {}, log }).drain();
    expect(execFileMock).toHaveBeenCalledTimes(50);
    const row = rowOf(db, "blocked:thr_w:1");
    expect(row).toMatchObject({ attempts: 2, posted_at: null, gave_up_at: null });
    expect(row.last_error).toContain("Marker scan stopped after 50 pages");
  });
});
