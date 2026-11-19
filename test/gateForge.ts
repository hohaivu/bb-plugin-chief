import { execFileMock, ghHead } from "./harness";

/** A worker the review gate can pin: a branch and a pull request, as chief_forge_init leaves them. Pass it as delegate()'s `forge` argument. */
export const forged = (n = 7, branch = `feature/pr-${n}`) => ({ branch, prUrl: `https://github.com/o/r/pull/${n}` });

/** The forge answers `gh pr view` for any worker's pull request with that worker's own branch as the head: what the gate pins. Every other CLI answers empty. */
export function forgeAnswers(state: { db: any }) {
  execFileMock.mockImplementation(async (file: string, args: string[]) => {
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      const row = state.db.prepare("SELECT branch FROM managed_threads WHERE pr_url=? AND branch IS NOT NULL LIMIT 1").get(args[2]) as { branch: string } | undefined;
      return { stdout: ghHead(row?.branch ?? "main"), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

/** chief_review on a forged worker: opens its gate and returns the reviewer it started. */
export async function startGate(state: { harness: any }, chiefThreadId: string, workerThreadId: string) {
  const reply = (await state.harness.behavior.callAgentTool("chief_review", { workerThreadId }, { threadId: chiefThreadId, projectId: "proj_1" })) as string;
  return { reply, reviewerId: /reviewer (thr_\w+)/.exec(reply)?.[1] };
}
