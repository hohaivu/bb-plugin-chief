import { vi } from "vitest";

// Stands in for git/gh/glab so pull-request resolution tests never shell out for real.
// Kept in its own module with no other imports: each test file's hoisted vi.mock factory loads it lazily.
export const execFileMock = vi.fn();

export const childProcessMock = () => {
  const execFile: any = () => { throw new Error("execFile must be invoked through promisify"); };
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args: any[]) => execFileMock(...args);
  return { execFile };
};
