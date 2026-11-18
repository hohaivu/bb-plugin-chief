import { vi } from "vitest";

// Stands in for git/gh/glab so pull-request resolution tests never shell out for real.
// Kept in its own module with no other imports: each test file's hoisted vi.mock factory loads it lazily.
export const execFileMock = vi.fn();

export const childProcessMock = () => {
  const execFile: any = () => { throw new Error("execFile must be invoked through promisify"); };
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args: any[]) => builderGit(args) ?? execFileMock(...args);
  return { execFile };
};

/** The fakes' builder checkout root: harness and reviewWorld environments live under it. */
export const BUILDER_ROOT = "/repo/builder/";
// Git in a fake builder checkout answers clean and contained, so the gate's builder check passes there.
const builderGit = (args: any[]) => args[0] === "git" && String(args[2]?.cwd ?? "").startsWith(BUILDER_ROOT) ? Promise.resolve({ stdout: "", stderr: "" }) : null;

/** Real child_process, except git in a fake builder checkout. For test files that otherwise run real git. */
export const builderPassMock = async (actual: any) => {
  const { promisify } = await import("node:util");
  const real = promisify(actual.execFile);
  const execFile: any = (...args: any[]) => actual.execFile(...args);
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args: any[]) => builderGit(args) ?? real(...args);
  return { ...actual, execFile };
};
