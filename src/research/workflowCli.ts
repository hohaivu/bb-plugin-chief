import type { ExecFileOptions } from "node:child_process";

export interface WorkflowCliDeps {
  serverPath: () => string;
  execFileAsync: (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
}

/** Runs `bb workflows <sub>` as the calling thread: the CLI resolves its origin from these env vars. Shared by research and the retro grader. */
export function createWorkflowCli({ serverPath, execFileAsync }: WorkflowCliDeps) {
  return async function runWorkflowCli(sub: string, args: string[], context: { threadId: string; projectId: string }) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(process.env.BB_CLI ?? "bb", ["workflows", sub, ...args, "--json"], {
        env: { ...process.env, PATH: serverPath(), BB_THREAD_ID: context.threadId, BB_PROJECT_ID: context.projectId },
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      // With --json a failure still prints {"ok":false,"error":{…}} on stdout.
      const out = String((error as { stdout?: unknown }).stdout ?? "");
      const parsed = (() => { try { return JSON.parse(out); } catch { return null; } })();
      throw new Error(parsed?.error?.message ?? (error instanceof Error ? error.message : String(error)));
    }
    // `history` prints JSON Lines, one record per line; the other subcommands print one document.
    const parsed = (() => {
      try { return JSON.parse(stdout); } catch { return stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)); }
    })();
    if (parsed?.ok === false) throw new Error(parsed.error?.message ?? JSON.stringify(parsed.error));
    return parsed;
  };
}
