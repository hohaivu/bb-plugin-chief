// Test helper: extracts a commit of this repo with `git archive` into a fresh temp dir and imports its server.ts,
// so a differential test can run one fixture against the base source and this checkout. Dev tooling, never shipped.
import { createRequire } from "node:module";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// createRequire gets the real child_process even when a test file mocks the ESM one.
const { execFileSync } = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");

export async function loadBaseBuild(repoRoot: string, sha: string) {
  const sourceRoot = await mkdtemp(join(tmpdir(), "coord-base-"));
  execFileSync("sh", ["-c", `git -C "${repoRoot}" archive ${sha} | tar -x -C "${sourceRoot}"`]);
  await symlink(join(repoRoot, "node_modules"), join(sourceRoot, "node_modules"));
  const module = await import(pathToFileURL(join(sourceRoot, "server.ts")).href);
  return { sourceRoot, module: module as { default: (bb: any) => Promise<void>; MIGRATIONS: string[] } };
}
