import { access, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bbTasksTracker, trackerSelector } from "./trackerBbTasks";

// Contract (docs/specs/tracker.md, The bb Tasks adapter): the exact argv and env of every `bb tasks` call. The fake stands in
// for the CLI at the injected execFileAsync boundary; no real bb Tasks process runs and nothing is created in any tracker.
// The JSON shapes the fake answers with (`task.id`, `comments[]`, `labels[]`) are the plan's assumptions, not captured output.

type Call = { file: string; args: string[]; env: Record<string, string | undefined>; timeout: unknown };
const ok = (body: object = {}) => ({ stdout: JSON.stringify({ ok: true, ...body }), stderr: "" });

function fake(answer: (args: string[]) => unknown = () => ok()) {
  const calls: Call[] = [];
  const execFileAsync = vi.fn(async (file: string, args: string[], options: any) => {
    calls.push({ file, args, env: options.env, timeout: options.timeout });
    return (await answer(args.slice(1))) as { stdout: string; stderr: string };
  });
  const deps = { execFileAsync, serverPath: () => "/server/bin:/usr/bin" };
  return { calls, deps, tracker: bbTasksTracker(deps), argv: () => calls.map((c) => c.args) };
}

const saved = { thread: process.env.BB_THREAD_ID, project: process.env.BB_PROJECT_ID, cli: process.env.BB_CLI };
const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
beforeEach(() => { process.env.BB_THREAD_ID = "thr_agent"; process.env.BB_PROJECT_ID = "proj_agent"; delete process.env.BB_CLI; });
afterEach(() => {
  restore("BB_THREAD_ID", saved.thread); restore("BB_PROJECT_ID", saved.project); restore("BB_CLI", saved.cli);
  vi.useRealTimers();
});

describe("trackerSelector", () => {
  const deps = { execFileAsync: vi.fn(), serverPath: () => "" };
  test.each<[string, unknown, boolean]>([
    ["the exact name", "bb-tasks", true],
    ["a padded name", " bb-tasks ", true],
    ["upper case", "BB-TASKS", false],
    ["none", "none", false],
    ["an empty string", "", false],
    ["undefined", undefined, false],
    ["a number", 3, false],
    ["another tracker", "linear", false],
  ])("%s", (_name, raw, selected) => {
    expect(trackerSelector(deps)(raw) !== null).toBe(selected);
  });

  test("one selector hands out the same adapter instance each time, so its caches persist", () => {
    const select = trackerSelector(deps);
    expect(select("bb-tasks")).toBe(select(" bb-tasks "));
    expect(trackerSelector(deps)("bb-tasks")).not.toBe(select("bb-tasks"));
  });
});

describe("environment and command line of every call", () => {
  test("every method runs `bb tasks … --json` with the server PATH, a 30 s timeout and no thread identity", async () => {
    const { calls, tracker } = fake((args) => ok(args[0] === "list" ? { tasks: [] } : args[0] === "label" ? { labels: [] } : { id: "01X", task: { id: "01X", description: "" }, comments: [], comment: { id: "c1" }, labels: [] }));
    await tracker.available();
    await tracker.findTask("ABC", "m");
    await tracker.createTask({ project: "ABC", title: "t", description: "d" });
    await tracker.setStatus("01X", "done");
    await tracker.attachThread("01X", "thr_1");
    await tracker.detachThread("01X", "thr_1");
    await tracker.linkPullRequest("01X", "https://example.test/pr/1");
    await tracker.attachFile("01X", { name: "plan-1.md", content: "x" });
    await tracker.comments("01X");
    await tracker.postComment("01X", "body");
    await tracker.setDecisionFlag("ABC", "01X", true);
    await tracker.setDecisionFlag("ABC", "01X", false);
    expect(calls.length).toBeGreaterThan(12);
    for (const call of calls) {
      expect(call.file).toBe("bb");
      expect(call.args[0]).toBe("tasks");
      expect(call.args.at(-1)).toBe("--json");
      expect(call.timeout).toBe(30_000);
      expect(call.env.PATH).toBe("/server/bin:/usr/bin");
      expect(call.env).not.toHaveProperty("BB_THREAD_ID");
      expect(call.env).not.toHaveProperty("BB_PROJECT_ID");
      expect(call.env.HOME ?? "").toBe(process.env.HOME ?? "");
    }
  });

  test("BB_CLI names the binary", async () => {
    process.env.BB_CLI = "/opt/bb";
    const { calls, tracker } = fake();
    await tracker.available();
    expect(calls[0]!.file).toBe("/opt/bb");
  });
});

describe("status mapping", () => {
  test.each([["planning", "todo"], ["working", "in_progress"], ["review", "in_review"], ["done", "done"]] as const)("%s → --status %s", async (status, remote) => {
    const { argv, tracker } = fake();
    await tracker.setStatus("01X", status);
    expect(argv()).toEqual([["tasks", "update", "01X", "--status", remote, "--json"]]);
  });
});

describe("threads", () => {
  test("attach and detach pass the task id and the thread", async () => {
    const { argv, tracker } = fake();
    await tracker.attachThread("01X", "thr_a");
    await tracker.detachThread("01X", "thr_b");
    expect(argv()).toEqual([["tasks", "attach", "01X", "--thread", "thr_a", "--json"], ["tasks", "detach", "01X", "--thread", "thr_b", "--json"]]);
  });
});

describe("createTask, findTask, linkPullRequest", () => {
  test("createTask passes title and description inline as argv and returns the task id", async () => {
    const { argv, tracker } = fake(() => ok({ task: { id: "01NEW" } }));
    expect(await tracker.createTask({ project: "ABC", title: "Fix totals", description: "Mission\n\nchief-unit:abc" })).toBe("01NEW");
    expect(argv()).toEqual([["tasks", "create", "--project", "ABC", "--title", "Fix totals", "--description", "Mission\n\nchief-unit:abc", "--json"]]);
  });

  test("findTask lists by marker and matches the marker in the description only (a title hit is no match)", async () => {
    const { argv, tracker } = fake(() => ok({ tasks: [
      { id: "01TITLE", title: "chief-unit:m1", description: "other" },
      { id: "01NODESC", title: "x" },
      { id: "01HIT", title: "y", description: "Mission\n\nchief-unit:m1" },
      { id: "01LATER", title: "z", description: "chief-unit:m1" },
    ] }));
    expect(await tracker.findTask("ABC", "chief-unit:m1")).toBe("01HIT");
    expect(argv()).toEqual([["tasks", "list", "--project", "ABC", "--search", "chief-unit:m1", "--json"]]);
  });

  test("findTask returns null when no description carries the marker", async () => {
    const { tracker } = fake(() => ok({ tasks: [{ id: "01A", title: "chief-unit:m1", description: "nope" }] }));
    expect(await tracker.findTask("ABC", "chief-unit:m1")).toBeNull();
  });

  test("linkPullRequest appends the URL to the description once and is idempotent", async () => {
    let description = "Mission text";
    const { argv, tracker } = fake((args) => {
      if (args[0] === "show") return ok({ task: { id: "01X", description } });
      description = args[args.indexOf("--description") + 1]!;
      return ok();
    });
    await tracker.linkPullRequest("01X", "https://example.test/pr/1");
    expect(argv()).toEqual([
      ["tasks", "show", "01X", "--json"],
      ["tasks", "update", "01X", "--description", "Mission text\nPull request: https://example.test/pr/1", "--json"],
    ]);
    await tracker.linkPullRequest("01X", "https://example.test/pr/1");
    expect(argv().filter((args) => args[1] === "update")).toHaveLength(1);
  });
});

describe("decisions", () => {
  test("postComment posts the body verbatim as Chief, never with --notify, and returns the comment id", async () => {
    const { argv, tracker } = fake(() => ok({ comment: { id: "01COMMENT" } }));
    const body = "**Decision #1** (Chief)\n\nPick one.\n\nchief-decision:abc";
    expect(await tracker.postComment("01X", body)).toBe("01COMMENT");
    expect(argv()).toEqual([["tasks", "comment", "01X", "--body", body, "--author", "Chief", "--json"]]);
    expect(argv()[0]).not.toContain("--notify");
  });

  test("the flag label is created only when missing, and the check is cached per project", async () => {
    let labels: { name: string }[] = [];
    const { argv, tracker } = fake((args) => args[1] === "list" ? ok({ labels }) : ok());
    await tracker.setDecisionFlag("ABC", "01X", true);
    expect(argv()).toEqual([
      ["tasks", "label", "list", "--project", "ABC", "--json"],
      ["tasks", "label", "create", "--project", "ABC", "--name", "needs-decision", "--json"],
      ["tasks", "update", "01X", "--add-label", "needs-decision", "--json"],
    ]);
    await tracker.setDecisionFlag("ABC", "01Y", true);
    expect(argv().slice(3)).toEqual([["tasks", "update", "01Y", "--add-label", "needs-decision", "--json"]]);
    // Another project is checked on its own; it already has the label, so nothing is created.
    labels = [{ name: "needs-decision" }];
    await tracker.setDecisionFlag("DEF", "01Z", true);
    expect(argv().slice(4)).toEqual([
      ["tasks", "label", "list", "--project", "DEF", "--json"],
      ["tasks", "update", "01Z", "--add-label", "needs-decision", "--json"],
    ]);
  });

  test("closing the flag only removes the label, with no label lookup", async () => {
    const { argv, tracker } = fake();
    await tracker.setDecisionFlag("ABC", "01X", false);
    expect(argv()).toEqual([["tasks", "update", "01X", "--remove-label", "needs-decision", "--json"]]);
  });

  test("a failed label lookup is not cached: the next open looks again", async () => {
    let fail = true;
    const { argv, tracker } = fake((args) => { if (fail && args[0] === "label") return { stdout: JSON.stringify({ ok: false, error: { code: "E", message: "down" } }), stderr: "" }; return args[1] === "list" ? ok({ labels: [] }) : ok(); });
    await expect(tracker.setDecisionFlag("ABC", "01X", true)).rejects.toThrow("E: down");
    fail = false;
    await tracker.setDecisionFlag("ABC", "01X", true);
    expect(argv().filter((args) => args[1] === "label")).toHaveLength(3);
  });
});

describe("comments", () => {
  test("kind user is the owner; agent and system comments are not", async () => {
    const { argv, tracker } = fake(() => ok({ comments: [
      { id: "c1", kind: "user", body: "owner text", createdAt: "2026-11-09T10:00:00.000Z" },
      { id: "c2", kind: "agent", body: "agent text", createdAt: "2026-11-09T10:01:00.000Z" },
      { id: "c3", kind: "system", body: "system text", createdAt: "2026-11-09T10:02:00.000Z" },
    ] }));
    expect(await tracker.comments("01X")).toEqual([
      { id: "c1", byOwner: true, body: "owner text", at: Date.parse("2026-11-09T10:00:00.000Z") },
      { id: "c2", byOwner: false, body: "agent text", at: Date.parse("2026-11-09T10:01:00.000Z") },
      { id: "c3", byOwner: false, body: "system text", at: Date.parse("2026-11-09T10:02:00.000Z") },
    ]);
    expect(argv()).toEqual([["tasks", "show", "01X", "--json"]]);
  });
});

describe("attachFile", () => {
  test("writes a temp file with the exact name and content, attaches it by path and name, and removes it", async () => {
    let seen: { path: string; content: string } | undefined;
    const { argv, tracker } = fake(async (args) => {
      const path = args[args.indexOf("--file") + 1]!;
      seen = { path, content: await readFile(path, "utf8") };
      return ok();
    });
    await tracker.attachFile("01X", { name: "plan-1.md", content: "# Plan\n\nbody\n" });
    expect(argv()).toEqual([["tasks", "attachment", "add", "01X", "--file", seen!.path, "--name", "plan-1.md", "--json"]]);
    expect(seen!.path.endsWith("/plan-1.md")).toBe(true);
    expect(seen!.content).toBe("# Plan\n\nbody\n");
    await expect(access(seen!.path)).rejects.toThrow();
  });

  test("removes the temp file even when the CLI fails", async () => {
    let path = "";
    const { tracker } = fake((args) => { path = args[args.indexOf("--file") + 1]!; return { stdout: JSON.stringify({ ok: false, error: { code: "E_FAIL", message: "no" } }), stderr: "" }; });
    await expect(tracker.attachFile("01X", { name: "verdict-1.md", content: "v" })).rejects.toThrow("E_FAIL: no");
    expect(path).not.toBe("");
    await expect(access(path)).rejects.toThrow();
  });
});

describe("failures", () => {
  test("{ok:false} on stdout throws the code and message", async () => {
    const { tracker } = fake(() => ({ stdout: JSON.stringify({ ok: false, error: { code: "TASK_NOT_FOUND", message: "no such task" } }), stderr: "" }));
    await expect(tracker.setStatus("01X", "done")).rejects.toThrow("TASK_NOT_FOUND: no such task");
  });

  test("a nonzero exit with the error JSON on stdout throws the code and message", async () => {
    const { tracker } = fake(() => { throw Object.assign(new Error("Command failed: bb tasks"), { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "BAD_INPUT", message: "bad id" } }) }); });
    await expect(tracker.attachThread("01X", "thr_1")).rejects.toThrow("BAD_INPUT: bad id");
  });

  test("a nonzero exit with no JSON throws the process error", async () => {
    const { tracker } = fake(() => { throw Object.assign(new Error("spawn bb ENOENT"), { code: "ENOENT" }); });
    await expect(tracker.attachThread("01X", "thr_1")).rejects.toThrow("spawn bb ENOENT");
  });
});

describe("available", () => {
  test("caches a success for 5 minutes, then asks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { calls, tracker } = fake();
    expect(await tracker.available()).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([["tasks", "status", "--json"]]);
    vi.setSystemTime(1_000_000 + 5 * 60_000 - 1);
    expect(await tracker.available()).toBe(true);
    expect(calls).toHaveLength(1);
    vi.setSystemTime(1_000_000 + 5 * 60_000);
    await tracker.available();
    expect(calls).toHaveLength(2);
  });

  test("caches a failure for 5 minutes too, then recovers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    let up = false;
    const { calls, tracker } = fake(() => { if (!up) throw new Error("bb tasks is not installed"); return ok(); });
    expect(await tracker.available()).toBe(false);
    up = true;
    vi.setSystemTime(2_000_000 + 4 * 60_000);
    expect(await tracker.available()).toBe(false);
    expect(calls).toHaveLength(1);
    vi.setSystemTime(2_000_000 + 5 * 60_000);
    expect(await tracker.available()).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
