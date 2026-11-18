import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { type WorkerBriefInput, workerBrief } from "./src/research/delegationBrief";
import { briefMatrix } from "./test/briefMatrix";

// Contracts (docs/specs/plan-chains.md "Heavy Command Slots"): the wrapper path is one literal shell word in both renderings; without a wrapper path every brief equals the one rendered at a5d01fe;
// with a path a Spec Writer gets nothing, every other kind gets `## Heavy commands`, the Verify fence stays and a wrapper fence wraps the exact command.
//
// Fixture test/fixtures/briefs-base-a5d01fe.json was rendered at a5d01fe306e898c97d2108e6ab8d497632dea1b6, in a separate `git archive` extract
// of that commit, by running briefMatrix() (test/briefMatrix.ts) through that commit's own workerBrief: for each cell, `full` is the sha256 of
// JSON.stringify({ prompt, brief, reviewerBrief }), `reviewer` the sha256 of JSON.stringify(reviewerBrief); tester cells also with evidenceOnly true.
const base = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "briefs-base-a5d01fe.json"), "utf8")) as { cells: Record<string, { full: string; reviewer: string }> };
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const PATH = "/data/chief/heavy/chief-heavy-0123456789ab.sh";
const cells = briefMatrix().flatMap(([label, input]): [string, WorkerBriefInput][] => [[label, input], ...(input.kind === "tester" ? [[`${label} evidenceOnly`, { ...input, evidenceOnly: true }] as [string, WorkerBriefInput]] : [])]);
const writers = cells.filter(([, input]) => input.kind === "spec-writer");
const others = cells.filter(([, input]) => input.kind !== "spec-writer");
const section = (text: string, heading: string) => text.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];

describe("without a wrapper path", () => {
  test("every cell of the matrix renders the bytes of a5d01fe, whether heavyPath is omitted or null", () => {
    expect(cells).toHaveLength(Object.keys(base.cells).length);
    for (const [label, input] of cells) {
      expect(sha(workerBrief(input)), label).toBe(base.cells[label]!.full);
      expect(sha(workerBrief({ ...input, heavyPath: null })), `${label} null`).toBe(base.cells[label]!.full);
    }
  });
});

describe("with a wrapper path", () => {
  test("the reviewer brief of every cell equals a5d01fe", () => {
    for (const [label, input] of cells) expect(sha(workerBrief({ ...input, heavyPath: PATH }).reviewerBrief), label).toBe(base.cells[label]!.reviewer);
  });

  test("a Spec Writer brief, in both lanes, is byte-identical to the one without a path and holds neither the section nor a wrapper fence", () => {
    expect(writers).toHaveLength(128);
    for (const [label, input] of writers) {
      const out = workerBrief({ ...input, heavyPath: PATH });
      expect(out, label).toEqual(workerBrief(input));
      expect(out.prompt, label).not.toContain("## Heavy commands");
      expect(out.prompt, label).not.toContain("<pool>");
      expect(out.prompt, label).not.toContain(PATH);
    }
  });

  test("a worker, designer, tester and evidence-only tester brief gets `## Heavy commands` naming the wrapper path, in every cell", () => {
    expect(others).toHaveLength(256);
    for (const [label, input] of others) {
      const heavy = section(workerBrief({ ...input, heavyPath: PATH }).prompt, "Heavy commands");
      expect(heavy, label).toBeDefined();
      expect(heavy, label).toContain(`bash '${PATH}' <sim|test|build> -- <command>`);
    }
  });

  test("the raw Verify fence is unchanged and a second fence wraps the exact command with the literal <pool>", () => {
    const withVerify = others.filter(([label, input]) => input.verifyCommand !== null && !label.endsWith("evidenceOnly"));
    expect(withVerify.length).toBeGreaterThan(0);
    for (const [label, input] of withVerify) {
      const before = section(workerBrief(input).prompt, "Verify command")!;
      const after = section(workerBrief({ ...input, heavyPath: PATH }).prompt, "Verify command")!;
      expect(after.startsWith(before), label).toBe(true);
      expect(after.slice(before.length), label).toContain(`bash '${PATH}' <pool> -- sh -c 'npm test'`);
    }
  });

  test("an evidence-only tester has the section but no Verify block, so no wrapper fence", () => {
    const [, input] = others.find(([label]) => label.endsWith("evidenceOnly") && label.includes("verify=npm test"))!;
    const prompt = workerBrief({ ...input, heavyPath: PATH }).prompt;
    expect(prompt).toContain("## Heavy commands");
    expect(prompt).not.toContain("## Verify command");
    expect(prompt).not.toContain("<pool>");
  });

  test("a simulator verify command renders the same <pool> fence, with sim named as a pool choice and never substituted", () => {
    const [, input] = cells.find(([label]) => label.startsWith("worker planned=false findings=false prior=false verify=npm test"))!;
    const verifyCommand = "xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 16'";
    const prompt = workerBrief({ ...input, verifyCommand, heavyPath: PATH }).prompt;
    const verify = section(prompt, "Verify command")!;
    expect(verify).toContain(`bash '${PATH}' <pool> -- sh -c 'xcodebuild test -destination '\\''platform=iOS Simulator,name=iPhone 16'\\'''`);
    expect(verify).not.toMatch(/bash '[^']+' (sim|test|build) -- sh -c/);
    expect(verify).toMatch(/\bsim\b/);
  });
});

describe("the wrapper fence runs the exact verify command", () => {
  const dir = mkdtempSync(join(tmpdir(), "chief-heavybrief-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // A stand-in wrapper that only drops `<pool> --`, so the test isolates the quoting of the fence from locking.
  const standIn = join(dir, "wrapper.sh");
  writeFileSync(standIn, '#!/bin/sh\nshift 2\nexec "$@"\n');
  chmodSync(standIn, 0o755);

  test("a command with a single quote, && and backticks has the same effect through the fence as run directly", () => {
    const tick = "`";
    const verifyCommand = `printf '%s\\n' "it's" > "$OUT" && echo ${tick}echo tick${tick} >> "$OUT" && echo a'b'c >> "$OUT"`;
    const [, input] = cells.find(([label]) => label.startsWith("worker planned=false findings=false prior=false verify=npm test"))!;
    const prompt = workerBrief({ ...input, verifyCommand, heavyPath: standIn }).prompt;
    const line = prompt.split("\n").find((text) => text.startsWith(`bash '${standIn}' <pool> -- sh -c `))!;
    expect(line).toBeDefined();
    const direct = join(dir, "direct.txt");
    const wrapped = join(dir, "wrapped.txt");
    execFileSync("sh", ["-c", verifyCommand], { env: { ...process.env, OUT: direct } });
    execFileSync("sh", ["-c", line.replace("<pool>", "build")], { env: { ...process.env, OUT: wrapped } });
    expect(readFileSync(wrapped, "utf8")).toBe(readFileSync(direct, "utf8"));
    expect(readFileSync(direct, "utf8")).toBe("it's\ntick\nabc\n");
  });

  // Regression: the path sat inside double quotes, so a data dir with a `$` component expanded in the shell and the script could not be opened.
  test("a wrapper path with a `$` component runs as written, in the Verify fence and in the standalone example", () => {
    const folder = join(dir, "Build$Lab", "a b");
    mkdirSync(folder, { recursive: true });
    const wrapper = join(folder, "wrapper.sh");
    copyFileSync(standIn, wrapper);
    const [, input] = cells.find(([label]) => label.startsWith("worker planned=false findings=false prior=false verify=npm test"))!;
    const prompt = workerBrief({ ...input, verifyCommand: 'printf fence > "$OUT"', heavyPath: wrapper }).prompt;
    const fence = prompt.split("\n").find((text) => text.startsWith("bash ") && text.includes("<pool>"))!;
    const span = prompt.match(/^Slot wrapper: (`+) (.+) \1\./m)?.[2];
    expect(fence).toBeDefined();
    expect(span).toBeDefined();
    const fenced = join(dir, "fence.txt");
    const spanned = join(dir, "span.txt");
    execFileSync("sh", ["-c", fence.replace("<pool>", "build")], { env: { ...process.env, OUT: fenced } });
    execFileSync("sh", ["-c", span!.replace("<sim|test|build>", "build").replace("<command>", 'printf span > "$OUT"')], { env: { ...process.env, OUT: spanned } });
    expect(readFileSync(fenced, "utf8")).toBe("fence");
    expect(readFileSync(spanned, "utf8")).toBe("span");
  });
});
