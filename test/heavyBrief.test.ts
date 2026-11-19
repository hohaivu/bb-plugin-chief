import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { type WorkerBriefInput, workerBrief } from "../src/research/delegationBrief";
import { briefMatrix } from "./briefMatrix";

const PATH = "/data/chief/heavy/chief-heavy-0123456789ab.sh";
const cells = briefMatrix();
const writers = cells.filter(([, input]) => input.kind === "spec-writer");
const others = cells.filter(([, input]) => input.kind !== "spec-writer");
const section = (text: string, heading: string) => text.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];

describe("wrapper path in briefs", () => {
  test("a Spec Writer brief omits the wrapper section and path in both lanes", () => {
    expect(writers).toHaveLength(128);
    for (const [label, input] of writers) {
      const out = workerBrief({ ...input, heavyPath: PATH });
      expect(out.prompt, label).not.toContain("## Heavy commands");
      expect(out.prompt, label).not.toContain("<pool>");
      expect(out.prompt, label).not.toContain(PATH);
    }
  });

  test("a worker and designer brief gets `## Heavy commands` naming the wrapper path, in every cell", () => {
    expect(others).toHaveLength(128);
    for (const [label, input] of others) {
      const heavy = section(workerBrief({ ...input, heavyPath: PATH }).prompt, "Heavy commands");
      expect(heavy, label).toBeDefined();
      expect(heavy, label).toContain(PATH);
    }
  });

  test("the raw Verify fence is unchanged and a second fence wraps the exact command with the literal <pool>", () => {
    const withVerify = others.filter(([, input]) => input.verifyCommand !== null);
    expect(withVerify.length).toBeGreaterThan(0);
    for (const [label, input] of withVerify) {
      const before = section(workerBrief(input).prompt, "Verify command")!;
      const after = section(workerBrief({ ...input, heavyPath: PATH }).prompt, "Verify command")!;
      expect(after.startsWith(before), label).toBe(true);
      expect(after.slice(before.length), label).toContain(`bash '${PATH}' <pool> -- sh -c 'npm test'`);
    }
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
