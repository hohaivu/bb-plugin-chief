import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { helperPrompt, PR_AGENT_DIR, prAgentScript, prAgentSection as renderSection, reviewEngine, type EngineTarget } from "./src/review/prAgent";

// Contract: docs/specs/review-engine.md, "Engine Behaviour". prAgent.ts owns the setting parse, the wrapper script, the
// translation table, the engine section and the helper prompt. The wrapper is executed for real with /bin/bash (3.2 on
// macOS) and the real python3 translation; only `gh` and `uv` are stubs on PATH (the network, pr-agent and the forge are
// the boundary this plugin does not own). Hang tests prove the whole-budget bound and that no process of the step survives.

const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
if (!python) throw new Error("prAgent.test.ts needs python3 on PATH to run the wrapper's translation step. Install it: this suite never skips silently.");

describe("reviewEngine(): the one validation point of the two settings", () => {
  test.each([
    ["pr-agent", "pr-agent"], ["both", "both"], ["reviewer", "reviewer"], [" both ", "both"], ["\tpr-agent\n", "pr-agent"],
  ])("%j gives mode %s", (value, mode) => {
    expect(reviewEngine({ reviewEngine: value }).mode).toBe(mode);
  });

  test.each([["PR-AGENT"], ["Both"], ["pr agent"], ["pr-agent,both"], [""], ["   "], [undefined], [null], [3], [true], [{}], [["both"]]])(
    "%j gives reviewer",
    (value) => { expect(reviewEngine({ reviewEngine: value }).mode).toBe("reviewer"); },
  );

  test("an absent setting object member gives reviewer and the default directory", () => {
    expect(reviewEngine({})).toEqual({ mode: "reviewer", prAgentDir: PR_AGENT_DIR });
  });

  test.each([[""], ["  "], [undefined], [null], [42], [{}]])("directory %j gives the default", (value) => {
    expect(reviewEngine({ reviewEngine: "both", prAgentDir: value }).prAgentDir).toBe(PR_AGENT_DIR);
  });

  test("a configured directory is trimmed and kept", () => {
    expect(reviewEngine({ prAgentDir: "  /opt/pr-agent " }).prAgentDir).toBe("/opt/pr-agent");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The wrapper script, executed for real.

const URL_ = "https://github.com/acme/shop/pull/7";
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const OUT_NAME = `pr-agent-${SHA.slice(0, 12)}.json`;
const FIVE_ENV = [
  "CONFIG__PROPAGATE_TOOL_ERRORS=true",
  "CONFIG__PUBLISH_OUTPUT=false",
  "CONFIG__USE_GLOBAL_SETTINGS_FILE=false",
  "CONFIG__USE_REPO_SETTINGS_FILE=false",
  "PR_REVIEWER__REQUIRE_MERGE_RECOMMENDATION=true",
];
// The parent environment is poisoned with the opposite of every required value: the script must set them itself.
const POISON = {
  CONFIG__PUBLISH_OUTPUT: "true", CONFIG__PROPAGATE_TOOL_ERRORS: "false", PR_REVIEWER__REQUIRE_MERGE_RECOMMENDATION: "false",
  CONFIG__USE_REPO_SETTINGS_FILE: "true", CONFIG__USE_GLOBAL_SETTINGS_FILE: "true",
};

type Limits = { totalSeconds: number; checkSeconds: number; translateSeconds: number };
type Plan = {
  /** What `gh pr view` answers on its 1st, 2nd, … call: a sha, `fail` (exit 1) or `hang`. */
  gh?: string[];
  /** What `uv run pr-agent` does: write the fixture, write nothing, exit 1, hang, or hang while ignoring TERM. */
  agent?: "ok" | "nowrite" | "fail" | "hang" | "stubborn";
  translate?: "ok" | "hang";
  /** The file pr-agent writes: an object (as JSON) or the raw text. */
  output?: unknown;
  /** A valid-looking file already at the output path from an earlier run. */
  stale?: boolean;
  limits?: Limits;
  args?: string[];
  missingDir?: boolean;
  tools?: ("gh" | "uv")[];
};

const BASIC: Limits = { totalSeconds: 20, checkSeconds: 5, translateSeconds: 10 };
const TIGHT: Limits = { totalSeconds: 4, checkSeconds: 1, translateSeconds: 1 };

const HANG = `hang() {
  echo $$ >> "$STATE/pids"
  bash -c 'echo $$ >> "$STATE/pids"; sleep 300 & echo $! >> "$STATE/pids"; wait' &
  wait
}`;
const GH = `#!/bin/bash
${HANG}
n=$(cat "$STATE/gh.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STATE/gh.n"
echo "$*" >> "$STATE/gh.log"
step=$(sed -n "\${n}p" "$STATE/gh.seq")
case "$step" in
  fail) echo "gh: HTTP 502" >&2; exit 1 ;;
  hang) hang ;;
  *) echo "$step" ;;
esac
`;
const UV = `#!/bin/bash
${HANG}
echo "$*" >> "$STATE/uv.log"
if [ "$1 $2" = "run pr-agent" ]; then
  { echo "---"; echo "PWD=$PWD"; env | grep -E '^(CONFIG__PUBLISH_OUTPUT|CONFIG__PROPAGATE_TOOL_ERRORS|PR_REVIEWER__REQUIRE_MERGE_RECOMMENDATION|CONFIG__USE_REPO_SETTINGS_FILE|CONFIG__USE_GLOBAL_SETTINGS_FILE)=' | sort; } >> "$STATE/uv.env"
  out=""; prev=""
  for a in "$@"; do if [ "$prev" = "--json-output" ]; then out="$a"; fi; prev="$a"; done
  case "$(cat "$STATE/agent.mode")" in
    ok) cp "$STATE/agent.json" "$out" ;;
    nowrite) ;;
    fail) echo "pr-agent: provider quota exceeded" >&2; exit 1 ;;
    hang) hang ;;
    stubborn) trap '' TERM; hang ;;
  esac
  exit 0
elif [ "$1 $2" = "run --directory" ]; then
  echo "$3" > "$STATE/translate.dir"
  if [ "$(cat "$STATE/translate.mode")" = hang ]; then hang; fi
  shift 4
  exec "$PYTHON3" "$@"
fi
echo "unexpected uv call: $*" >&2
exit 99
`;

type Run = {
  code: number | null; stdout: string; stderr: string; ms: number; hardKilled: boolean;
  pids: number[]; alive: number[]; uvLog: string[]; ghLog: string[]; uvEnv: string; translateDir: string | null;
  outFile: string | null; dir: string; runDir: string;
};

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readOr = async (path: string) => readFile(path, "utf8").catch(() => null);

/** Writes the script, the stubs and the state into a fresh temp tree, runs `/bin/bash script <url> <sha>`, and cleans up. */
async function runScript(plan: Plan = {}): Promise<Run> {
  const limits = plan.limits ?? BASIC;
  const root = await realpath(await mkdtemp(join(tmpdir(), "pr-agent-test-")));
  const dir = join(root, "pr agent's dir");
  const stub = join(root, "stub");
  const state = join(root, "state");
  const runDir = join(root, "run");
  await Promise.all([mkdir(dir), mkdir(stub), mkdir(state), mkdir(runDir)]);
  const script = join(runDir, "pr-agent-review.sh");
  await writeFile(script, prAgentScript(plan.missingDir ? join(root, "no such dir") : dir, limits));
  const tools = plan.tools ?? ["gh", "uv"];
  if (tools.includes("gh")) { await writeFile(join(stub, "gh"), GH); await chmod(join(stub, "gh"), 0o755); }
  if (tools.includes("uv")) { await writeFile(join(stub, "uv"), UV); await chmod(join(stub, "uv"), 0o755); }
  const output = plan.output ?? { review: { merge_recommendation: "no_concerns_found", key_issues_to_review: [] } };
  await writeFile(join(state, "gh.seq"), `${(plan.gh ?? [SHA, SHA]).join("\n")}\n`);
  await writeFile(join(state, "agent.mode"), plan.agent ?? "ok");
  await writeFile(join(state, "translate.mode"), plan.translate ?? "ok");
  await writeFile(join(state, "agent.json"), typeof output === "string" ? output : JSON.stringify(output));
  if (plan.stale) await writeFile(join(runDir, OUT_NAME), JSON.stringify({ review: { merge_recommendation: "changes_required", key_issues_to_review: [{ relevant_file: "stale.ts", issue_header: "Old", issue_content: "from an earlier run" }] } }));

  const hardKillMs = Math.min(limits.totalSeconds + 8, 40) * 1000;
  const started = performance.now();
  let hardKilled = false;
  const child = spawn("/bin/bash", [script, ...(plan.args ?? [URL_, SHA])], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${stub}:/usr/bin:/bin`, STATE: state, PYTHON3: python, HOME: root, ...POISON },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { hardKilled = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, hardKillMs);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const ms = performance.now() - started;
  clearTimeout(timer);

  const pids = ((await readOr(join(state, "pids"))) ?? "").split("\n").filter(Boolean).map(Number);
  for (let waited = 0; pids.some(isAlive) && waited < 3_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  const alive = pids.filter(isAlive);
  for (const pid of alive) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  const lines = async (name: string) => ((await readOr(join(state, name))) ?? "").split("\n").filter(Boolean);
  const result: Run = {
    code, stdout, stderr, ms, hardKilled, pids, alive, uvLog: await lines("uv.log"), ghLog: await lines("gh.log"),
    uvEnv: (await readOr(join(state, "uv.env"))) ?? "", translateDir: ((await readOr(join(state, "translate.dir"))) ?? "").trim() || null,
    outFile: await readOr(join(runDir, OUT_NAME)), dir, runDir,
  };
  await rm(root, { recursive: true, force: true });
  return result;
}

const agentCalls = (run: Run) => run.uvLog.filter((line) => line.startsWith("run pr-agent"));
const issue = (over: Record<string, unknown> = {}) => ({ relevant_file: "src/a.ts", issue_header: "Header", issue_content: "Content", start_line: 5, end_line: 6, ...over });
const review = (merge_recommendation: unknown, issues?: unknown, extra: Record<string, unknown> = {}) =>
  ({ review: { ...(merge_recommendation === undefined ? {} : { merge_recommendation }), ...(issues === undefined ? {} : { key_issues_to_review: issues }) }, ...extra });

/** Contract 6: the invariants every exit-0 line holds, whatever pr-agent wrote. Returns the parsed line. */
function translated(run: Run, recommendation: string) {
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout.endsWith("\n")).toBe(true);
  expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
  const line = JSON.parse(run.stdout);
  expect(line).toMatchObject({ prUrl: URL_, sha: SHA, recommendation });
  const blocking = line.findings.some((finding: any) => finding.severity === "blocking");
  expect(line.verdict === "request_changes").toBe(blocking);
  // The table: only changes_required blocks.
  expect(line.verdict).toBe(recommendation === "changes_required" ? "request_changes" : "approve");
  for (const finding of line.findings) {
    expect(finding.severity).toBe(recommendation === "changes_required" ? "blocking" : "nit");
    expect(finding.file.length).toBeGreaterThanOrEqual(1);
    expect(finding.file.length).toBeLessThanOrEqual(300);
    expect(finding.message.length).toBeGreaterThanOrEqual(1);
    expect(finding.message.length).toBeLessThanOrEqual(900);
    if ("line" in finding) expect(Number.isInteger(finding.line) && finding.line >= 1).toBe(true);
    expect(finding).not.toHaveProperty("fix");
  }
  expect(Array.isArray(line.filesNotReviewed)).toBe(true);
  return line;
}

/** A failed run: its code, nothing on stdout, and exactly one `pr-agent-review:` line on stderr. */
function failed(run: Run, code: number) {
  expect(run.hardKilled, "the script had to be killed by the test").toBe(false);
  expect(run.code, run.stderr).toBe(code);
  expect(run.stdout).toBe("");
  expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
  expect(run.stderr).toMatch(/^pr-agent-review: /);
}

describe("prAgentScript: translation of a definitive or inconclusive pr-agent result", () => {
  test("changes_required with two issues: request_changes, both blocking, file, line and message mapped, evidence file kept", async () => {
    const output = review("changes_required", [
      issue({ relevant_file: "src/a.ts", issue_header: "Null deref", issue_content: "x is null here", start_line: 12, end_line: 14 }),
      issue({ relevant_file: "  src/b.ts ", issue_header: "Leak", issue_content: "closes too late", start_line: 3 }),
    ], { coverage: { files_not_reviewed: ["docs/big.md"], files_partially_reviewed: [] } });
    const run = await runScript({ output });
    const line = translated(run, "changes_required");
    expect(line.findings).toEqual([
      { file: "src/a.ts", line: 12, severity: "blocking", message: "Null deref: x is null here" },
      { file: "src/b.ts", line: 3, severity: "blocking", message: "Leak: closes too late" },
    ]);
    expect(line.filesNotReviewed).toEqual(["docs/big.md"]);
    expect(JSON.parse(run.outFile!)).toEqual(output);
  });

  test("no_concerns_found with one issue: approve, the issue is a nit", async () => {
    const line = translated(await runScript({ output: review("no_concerns_found", [issue()]) }), "no_concerns_found");
    expect(line.findings).toHaveLength(1);
  });

  test("needs_review with two issues: approve, nits, the recommendation is kept for the reviewer", async () => {
    const line = translated(await runScript({ output: review("needs_review", [issue(), issue({ relevant_file: "src/c.ts" })]) }), "needs_review");
    expect(line.findings.map((finding: any) => finding.severity)).toEqual(["nit", "nit"]);
  });

  test.each([
    ["no_concerns_found without the issues key", review("no_concerns_found")],
    ["needs_review with a null issues list", review("needs_review", null)],
    ["no_concerns_found with an empty list", review("no_concerns_found", [])],
  ])("%s: approve with no findings", async (_name, output) => {
    const run = await runScript({ output });
    const line = translated(run, (output.review as any).merge_recommendation);
    expect(line.findings).toEqual([]);
  });

  test("hostile fields never break the finding limits: a 5,000-char content, a 400-char path, bad start_line values, a clip inside an emoji", async () => {
    const issues = [
      issue({ issue_content: "c".repeat(5_000) }),
      issue({ relevant_file: `${"p/".repeat(200)}x.ts`, start_line: 7 }),
      issue({ relevant_file: "zero.ts", start_line: 0 }),
      issue({ relevant_file: "string.ts", start_line: "12" }),
      issue({ relevant_file: "negative.ts", start_line: -3 }),
      issue({ relevant_file: "float.ts", start_line: 2.5 }),
      issue({ relevant_file: "bool.ts", start_line: true }),
      issue({ relevant_file: "absent.ts", start_line: undefined }),
      issue({ relevant_file: "emoji.ts", issue_header: "H", issue_content: `${"x".repeat(895)}😀😀😀😀` }),
      issue({ relevant_file: "bare.ts", issue_header: "", issue_content: "" }),
    ];
    for (const recommendation of ["changes_required", "needs_review", "no_concerns_found"]) {
      const line = translated(await runScript({ output: review(recommendation, issues) }), recommendation);
      const byFile = Object.fromEntries(line.findings.map((finding: any) => [finding.file.slice(0, 12), finding]));
      expect(line.findings).toHaveLength(issues.length);
      expect(line.findings[0].message.startsWith("Header: ccc")).toBe(true);
      expect(line.findings[1].file.length).toBe(300);
      expect(line.findings[1].line).toBe(7);
      for (const name of ["zero.ts", "string.ts", "negative.ts", "float.ts", "bool.ts", "absent.ts"]) expect(byFile[name]).not.toHaveProperty("line");
      // A lone surrogate half would make the message invalid UTF-16 text.
      expect(byFile["emoji.ts"].message).not.toMatch(/[\ud800-\udbff]$/);
    }
  }, 30_000);
});

describe("prAgentScript: invalid output is exit 6, never a guess", () => {
  const cases: [string, Plan][] = [
    ["changes_required with 0 issues", { output: review("changes_required", []) }],
    ["changes_required with no issues key", { output: review("changes_required") }],
    ["an empty file", { output: "" }],
    ["a malformed file", { output: "{not json" }],
    ["pr-agent writing nothing", { agent: "nowrite" }],
    ["a stale file from an earlier run while pr-agent writes nothing", { agent: "nowrite", stale: true }],
    ["a recommendation outside the three values", { output: review("looks_good", []) }],
    ["no recommendation", { output: review(undefined, []) }],
    ["an issue without relevant_file", { output: review("changes_required", [issue({ relevant_file: undefined })]) }],
    ["an issue with a blank relevant_file", { output: review("needs_review", [issue({ relevant_file: "   " })]) }],
    ["no review object", { output: [] }],
  ];
  test.each(cases)("%s", async (_name, plan) => {
    const run = await runScript(plan);
    failed(run, 6);
    // Translation ran (or pr-agent wrote nothing) after both head checks: the failure is the output's, not the head's.
    expect(run.ghLog).toHaveLength(2);
  });
});

describe("prAgentScript: pr-agent never publishes", () => {
  test("every pr-agent call carries all five variables with the stated values, in argument order, in the configured directory", async () => {
    const run = await runScript({ output: review("no_concerns_found", []) });
    expect(run.code, run.stderr).toBe(0);
    const calls = agentCalls(run);
    expect(calls).toEqual([`run pr-agent --pr_url ${URL_} --json-output ${join(run.runDir, OUT_NAME)} review`]);
    // The directory name holds a space and an apostrophe: the configured path is quoted, not split.
    const blocks = run.uvEnv.split("---\n").filter(Boolean);
    expect(blocks).toHaveLength(calls.length);
    for (const block of blocks) {
      const lines = block.trimEnd().split("\n");
      expect(lines[0]).toBe(`PWD=${run.dir}`);
      expect(lines.slice(1)).toEqual(FIVE_ENV);
    }
    expect(run.translateDir).toBe(run.dir);
  });

  test.each([
    ["pr-agent fails", { agent: "fail" } as Plan],
    ["the output is invalid", { output: "nope" } as Plan],
  ])("the variables are set on the call even when %s", async (_name, plan) => {
    const run = await runScript(plan);
    expect(run.uvEnv.split("---\n").filter(Boolean).map((block) => block.trimEnd().split("\n").slice(1))).toEqual([FIVE_ENV]);
  });
});

describe("prAgentScript: a moved head never yields exit 0", () => {
  test("the head is read before and after pr-agent, with the exact gh command", async () => {
    const run = await runScript();
    expect(run.code, run.stderr).toBe(0);
    expect(run.ghLog).toEqual([`pr view ${URL_} --json headRefOid -q .headRefOid`, `pr view ${URL_} --json headRefOid -q .headRefOid`]);
  });

  test("a head that differs before the run: exit 3, pr-agent is never called", async () => {
    const run = await runScript({ gh: [OTHER] });
    failed(run, 3);
    expect(agentCalls(run)).toEqual([]);
    expect(run.ghLog).toHaveLength(1);
  });

  test("a gh failure before the run: exit 3, pr-agent is never called", async () => {
    const run = await runScript({ gh: ["fail"] });
    failed(run, 3);
    expect(agentCalls(run)).toEqual([]);
  });

  test("a head that moved while pr-agent ran: exit 3 although pr-agent succeeded with a valid result", async () => {
    const run = await runScript({ gh: [SHA, OTHER], output: review("no_concerns_found", []) });
    failed(run, 3);
    expect(agentCalls(run)).toHaveLength(1);
    expect(run.stderr).toContain("head check after");
  });

  test("a gh failure after pr-agent ran: exit 3 although pr-agent succeeded", async () => {
    const run = await runScript({ gh: [SHA, "fail"], output: review("no_concerns_found", []) });
    failed(run, 3);
    expect(agentCalls(run)).toHaveLength(1);
  });
});

describe("prAgentScript: the other exit codes", () => {
  test("pr-agent exits non-zero: exit 5 with its stderr line as the reason", async () => {
    const run = await runScript({ agent: "fail" });
    failed(run, 5);
    expect(run.stderr).toContain("provider quota exceeded");
    // No second head check or translation after a failed run.
    expect(run.ghLog).toHaveLength(1);
  });

  test.each([
    ["a gitlab.com URL", { args: ["https://gitlab.com/acme/shop/-/merge_requests/7", SHA] }],
    ["one argument", { args: [URL_] }],
    ["three arguments", { args: [URL_, SHA, "extra"] }],
    ["a missing pr-agent directory", { missingDir: true }],
    ["uv missing from PATH", { tools: ["gh"] }],
    ["gh missing from PATH", { tools: ["uv"] }],
  ] as [string, Plan][])("%s: exit 2 before any external call", async (_name, plan) => {
    const run = await runScript(plan);
    failed(run, 2);
    expect(run.ghLog).toEqual([]);
    expect(run.uvLog).toEqual([]);
  });
});

describe("prAgentScript: the whole budget holds and no process of a hung step survives", () => {
  // TIGHT: total 4 s, 1 s per head check, 1 s translation. Every case must end within total + 6 s with exit 4.
  const bound = (run: Run) => {
    expect(run.hardKilled, "the script ran past its budget and the test killed it").toBe(false);
    expect(run.ms).toBeLessThan((TIGHT.totalSeconds + 6) * 1_000);
    failed(run, 4);
    expect(run.pids.length, "the stub recorded no process: the step never hung").toBeGreaterThanOrEqual(3);
    expect(run.alive, "processes of the hung step survived the script").toEqual([]);
  };

  test.concurrent("the head check before the run hangs", async () => {
    const run = await runScript({ gh: ["hang"], limits: TIGHT });
    bound(run);
    expect(agentCalls(run)).toEqual([]);
  }, 30_000);

  test.concurrent("pr-agent hangs: its whole process group is killed", async () => {
    const run = await runScript({ agent: "hang", limits: TIGHT });
    bound(run);
    expect(run.stderr).toContain("pr-agent");
  }, 30_000);

  test.concurrent("pr-agent hangs and ignores TERM: the KILL after the 5 s grace still ends it inside total + 5", async () => {
    const run = await runScript({ agent: "stubborn", limits: TIGHT });
    bound(run);
    expect(run.ms).toBeGreaterThan(5_000);
  }, 30_000);

  test.concurrent("the head check after the run hangs", async () => {
    const run = await runScript({ gh: [SHA, "hang"], limits: TIGHT });
    bound(run);
    expect(agentCalls(run)).toHaveLength(1);
    expect(run.stderr).toContain("head check after");
  }, 30_000);

  test.concurrent("the translation hangs", async () => {
    const run = await runScript({ translate: "hang", limits: TIGHT });
    bound(run);
    expect(run.stderr).toContain("translate");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The engine section and the helper prompt: text contracts of docs/specs/review-engine.md.

const URL2 = "https://github.com/acme/shop/pull/8";
const target = (over: Partial<EngineTarget> = {}): EngineTarget => ({ threadId: "wrk-one", branch: "feature/one", prUrl: URL_, sha: SHA, ...over });
const unpinned = (over: Partial<EngineTarget> = {}) => target({ threadId: "wrk-loose", branch: "feature/loose", prUrl: null, sha: null, ...over });
const text = (lines: string[]) => lines.join("\n");
const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** The engine folder Chief writes both files to before the reviewer exists: an absolute path, rendered literally into every command. */
const ENGINE_DIR = "/data/chief/proj_1/wrk-one/review-2";
const prAgentSection = (mode: "pr-agent" | "both", targets: EngineTarget[]) => renderSection(mode, targets, ENGINE_DIR);
const runLines = (lines: string[]) => lines.filter((line) => line.startsWith(`bash "${ENGINE_DIR}/pr-agent-review.sh"`));
/** The one line that names a target, whatever its state. */
const lineOf = (lines: string[], threadId: string) => {
  const found = lines.filter((line) => line.includes(`worker ${threadId} `));
  expect(found, `target ${threadId} must be listed exactly once`).toHaveLength(1);
  return found[0]!;
};

describe("prAgentSection: totality over the targets", () => {
  test.each(["pr-agent", "both"] as const)("%s, a single pinned target: heading, target line, one run command", (mode) => {
    const lines = prAgentSection(mode, [target()]);
    expect(lines[0]).toBe(`## Review engine: ${mode}`);
    expect(lineOf(lines, "wrk-one")).toBe(`- worker wrk-one (branch feature/one): ${URL_} pinned to ${SHA} → pr-agent`);
    expect(runLines(lines)).toEqual([`bash "${ENGINE_DIR}/pr-agent-review.sh" ${URL_} ${SHA}`]);
  });

  test("two pinned targets on different pull requests: both listed, one run command each", () => {
    const lines = prAgentSection("pr-agent", [target(), target({ threadId: "wrk-two", branch: "feature/two", prUrl: URL2, sha: OTHER })]);
    expect(lineOf(lines, "wrk-one")).toContain(`${URL_} pinned to ${SHA}`);
    expect(lineOf(lines, "wrk-two")).toContain(`${URL2} pinned to ${OTHER}`);
    expect(runLines(lines)).toEqual([
      `bash "${ENGINE_DIR}/pr-agent-review.sh" ${URL_} ${SHA}`,
      `bash "${ENGINE_DIR}/pr-agent-review.sh" ${URL2} ${OTHER}`,
    ]);
  });

  test("two targets on the same pull request and commit: both listed, the pair is named once for the run step", () => {
    const lines = prAgentSection("pr-agent", [target(), target({ threadId: "wrk-twin", branch: "feature/twin" })]);
    lineOf(lines, "wrk-one");
    lineOf(lines, "wrk-twin");
    expect(runLines(lines)).toHaveLength(1);
    expect(countOf(text(lines), `${URL_} ${SHA}`)).toBe(1);
  });

  test("a mixed review lists the unpinned target as direct and still runs pr-agent for the pinned one", () => {
    const lines = prAgentSection("pr-agent", [target(), unpinned()]);
    expect(lineOf(lines, "wrk-loose")).toBe("- worker wrk-loose (branch feature/loose): not pinned → direct review (no pinned pull request head)");
    expect(lineOf(lines, "wrk-one")).toContain("→ pr-agent");
    expect(runLines(lines)).toHaveLength(1);
  });

  test("a target with a forge URL but no head, and one with a head but no URL, are both unpinned", () => {
    const lines = prAgentSection("pr-agent", [target(), unpinned({ prUrl: URL2 }), unpinned({ threadId: "wrk-nourl", prUrl: null, sha: OTHER })]);
    expect(lineOf(lines, "wrk-loose")).toContain("not pinned → direct review");
    expect(lineOf(lines, "wrk-nourl")).toContain("not pinned → direct review");
    expect(runLines(lines)).toHaveLength(1);
  });

  test("a re-review range is named on its target line", () => {
    const since = "c".repeat(40);
    expect(lineOf(prAgentSection("pr-agent", [target({ since })]), "wrk-one")).toContain(`re-review since ${since}`);
  });

  test.each(["pr-agent", "both"] as const)("%s with no pinned target: only the heading and the direct line, no wrapper, no helper command", (mode) => {
    const lines = prAgentSection(mode, [unpinned(), unpinned({ threadId: "wrk-second", prUrl: URL2 })]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`## Review engine: ${mode}`);
    expect(lines[1]).toContain("no pinned pull request head");
    expect(lines[1]).toContain(`Engine: ${mode} → direct (no pinned pull request head)`);
    expect(text(lines)).not.toContain("pr-agent-review.sh");
    expect(text(lines)).not.toContain("bb thread");
  });
});

describe("prAgentSection: precedence and rules", () => {
  const body = text(prAgentSection("pr-agent", [target(), unpinned()]));

  test("adds to the review above: no exclusive list of allowed commands, direct review reads stay allowed", () => {
    expect(body).toMatch(/adds to the review above/);
    expect(body).not.toMatch(/nothing else/i);
    expect(body).not.toMatch(/\bonly (these|the following|the commands?|those)\b/i);
    expect(body).not.toMatch(/no other commands?/i);
    for (const read of ["git fetch", "git checkout", "git diff", "gh pr view"]) expect(body).toContain(read);
  });

  test("restates the ban on builds, linters, typecheckers and tests", () => {
    expect(body).toMatch(/ban on running builds, linters, typecheckers and tests still holds/);
  });

  test("the run step: 570000 ms tool timeout, the missing-wrapper retry and its failure reason", () => {
    expect(body).toContain("570000 ms");
    expect(body).toMatch(/missing, wait 10 s and look once more; still missing: .*`wrapper missing`/);
  });

  test("one outcome per target: definitive, needs_review, failure (tool error, unusable stdout), not pinned", () => {
    expect(body).toMatch(/- definitive: exit 0, exactly one JSON line on stdout.*`changes_required` or `no_concerns_found`.*Do not re-verify/);
    expect(body).toMatch(/- needs_review: exit 0 with recommendation `needs_review`.*Review this target directly/);
    expect(body).toMatch(/- failure: any non-zero exit, a tool error or tool timeout, or stdout that is not exactly one JSON line even with exit 0/);
    expect(body).toMatch(/- not pinned: review it directly/);
  });

  test("aggregation: never merge across targets, branch prefix, never drop a blocking finding at the 40 cap", () => {
    expect(body).toContain("Never merge across targets");
    expect(body).toContain("start each message with `[<branch>] `");
    expect(body).toMatch(/request_changes if and only if a blocking finding remains/);
    expect(body).toMatch(/Over 40 findings: keep every blocking finding, fill with nits/);
    expect(body).toContain("Never drop a blocking finding");
    expect(body).toContain("Engine: pr-agent");
    expect(body).toContain("Send one chief_report");
  });

  test("pr-agent mode names no helper command and no archive", () => {
    expect(body).not.toContain("bb thread");
    expect(body).not.toContain("review-helper.md");
  });
});

describe("prAgentSection: engine files are named by their literal absolute path", () => {
  // Contract: a command whose script path is a shell variable is blocked by CC Safety Net (dynamic-shell-source), so the section
  // renders the folder the plugin wrote the files to, not `$BB_THREAD_STORAGE`.
  const FOLDERS = ["/data/chief/proj_1/wrk-one/review-2", "/Volumes/Other Disk/.bb/chief/proj_9/wrk-nine/review-11"];
  const executed = (lines: string[]) => lines.filter((line) => line.startsWith("bash ") || line.startsWith("bb thread spawn"));

  test.each(FOLDERS.flatMap((dir) => (["pr-agent", "both"] as const).map((mode) => [mode, dir] as const)))(
    "%s, folder %s: every executed line names the folder and none uses $BB_THREAD_STORAGE",
    (mode, dir) => {
      const lines = renderSection(mode, [target(), unpinned()], dir);
      const commands = executed(lines);
      expect(commands).toHaveLength(mode === "both" ? 2 : 1);
      for (const command of commands) {
        expect(command).not.toContain("$BB_THREAD_STORAGE");
        expect(command).toContain(`"${dir}/`);
      }
      expect(commands.filter((command) => command.startsWith("bash "))).toEqual([`bash "${dir}/pr-agent-review.sh" ${URL_} ${SHA}`]);
      expect(text(lines)).not.toContain("$BB_THREAD_STORAGE");
    },
  );

  test("both: the helper spawn's --prompt-file and the missing-file line name the same literal helper path", () => {
    const [dir] = FOLDERS;
    const lines = renderSection("both", [target()], dir!);
    const spawnLine = lines.find((line) => line.startsWith("bb thread spawn"))!;
    expect(spawnLine).toContain(`--prompt-file "${dir}/review-helper.md"`);
    expect(lines.find((line) => line.startsWith("Helper (start it first)"))).toContain(`If \`${dir}/review-helper.md\` is missing`);
  });

  test("the wrapper's missing-file rule does not name a path variable", () => {
    const line = prAgentSection("pr-agent", [target()]).find((candidate) => candidate.startsWith("If the script file is missing"))!;
    expect(line).toBeDefined();
    expect(line).not.toContain("$");
  });
});

describe("prAgentSection: both mode helper lifecycle", () => {
  const lines = prAgentSection("both", [target(), unpinned()]);
  const body = text(lines);

  test("the spawn command: reviewer's environment, lifecycle owner, notifications off, json", () => {
    const spawnLine = lines.find((line) => line.startsWith("bb thread spawn"))!;
    expect(spawnLine).toContain('--environment "$BB_ENVIRONMENT_ID"');
    expect(spawnLine).toContain('--lifecycle-owner-thread "$BB_THREAD_ID"');
    expect(spawnLine).toContain("--parent-notifications off");
    expect(spawnLine).toContain("--json");
    expect(spawnLine).toContain(`--prompt-file "${ENGINE_DIR}/review-helper.md"`);
    expect(spawnLine).toContain("--parent-self");
    expect(countOf(body, "bb thread spawn")).toBe(1);
  });

  test("the helper starts before pr-agent runs", () => {
    expect(body.indexOf("bb thread spawn")).toBeLessThan(body.indexOf(`bash "${ENGINE_DIR}/pr-agent-review.sh"`));
  });

  test("each wait is its own command with a 540 s timeout and a 570000 ms tool timeout", () => {
    const waits = body.match(/bb thread wait [^`]*`/g)!;
    expect(waits.length).toBeGreaterThanOrEqual(1);
    for (const wait of waits) expect(wait).toContain("--timeout 540s");
    expect(body).toMatch(/bb thread wait <helper id> --status idle --timeout 540s` \(tool timeout 570000 ms\)/);
  });

  test("bb thread stop and its confirmation come before the reviewer's own direct fallback", () => {
    const stop = body.indexOf("bb thread stop");
    const confirm = body.indexOf("confirms the stop");
    const fallback = body.indexOf("your own direct review");
    expect(stop).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(stop);
    expect(fallback).toBeGreaterThan(confirm);
    expect(body).toContain("Never use the checkout before the helper is idle, failed or confirmed stopped");
    expect(body).toMatch(/run no git command that changes this checkout/);
  });

  test("an unconfirmable stop is the one blocked path, naming the helper", () => {
    expect(body).toMatch(/If the stop cannot be confirmed, report blocked naming helper `<helper id>`/);
    expect(body).toContain("the only blocked path of this section");
  });

  test("archive appears once, last, and only after chief_report is accepted", () => {
    expect(countOf(body, "bb thread archive")).toBe(1);
    const last = lines.at(-1)!;
    expect(last).toContain("bb thread archive <helper id>");
    expect(last.startsWith("After chief_report is accepted")).toBe(true);
    expect(last).toContain("Never archive the helper before the report is accepted");
    expect(body.slice(0, body.indexOf("After chief_report is accepted"))).not.toContain("archive");
  });

  test("the result also names the direct half, and a helper result is validated", () => {
    expect(body).toContain("direct half: helper");
    expect(body).toContain("helper result invalid");
    expect(body).toMatch(/the verdict is request_changes if and only if a finding is blocking/);
  });
});

describe("helperPrompt()", () => {
  const prompt = "Invariant rules.\n\n## This review\nReview worker W1.\n\nread `$BB_THREAD_STORAGE/review-context.md` in full.";
  const context = "## Worker brief\nDo the thing.\n\n## Recorded\nnpm test → exit 0";

  test("holds the reviewer prompt byte for byte, then the context under its own heading", () => {
    const helper = helperPrompt(prompt, context);
    expect(helper).toContain(`\n\n${prompt}\n\n## review-context.md\n${context}`);
    expect(helper.endsWith(context)).toBe(true);
    expect(helper).not.toContain("## Review engine");
  });

  test("tells the helper the inline context replaces the file read and its missing-file rule", () => {
    const helper = helperPrompt(prompt, context);
    expect(helper).toContain("it replaces the brief's instruction to read `$BB_THREAD_STORAGE/review-context.md` and its missing-file rule");
  });

  test("forbids chief_report and names the two endings: the verdict object and the blocked object", () => {
    const helper = helperPrompt(prompt, context);
    expect(helper).toMatch(/Do not call chief_report or any chief_\* tool, spawn threads, run pr-agent, or edit, commit or push files/);
    expect(helper).toContain('fenced `json` object `{"verdict", "findings", "result", "regression"?}`');
    expect(helper).toContain('fenced `json` object `{"blocked": "<reason>"}`');
  });

  test("with no context there is no context section", () => {
    const helper = helperPrompt(prompt, null);
    expect(helper.split("\n")).not.toContain("## review-context.md");
    expect(helper.endsWith(prompt)).toBe(true);
  });

  test("does not add the engine section of the prompt it was given", () => {
    const withSection = [prompt, ...prAgentSection("both", [target()])].join("\n");
    // A helper built from the engine prompt would carry the section and spawn another helper: the caller passes the plain prompt.
    expect(helperPrompt(prompt, null)).not.toContain(withSection.slice(prompt.length));
  });
});
