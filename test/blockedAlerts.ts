import { MAX_NUDGE_LENGTH } from "../src/runtime/constants";

/** The in-place route every blocked worker and Spec Writer alert offers (plan wave 1 step 6), for the row `id`. */
export const inPlaceLine = (id: string) => `If the blocker is an environment or permission problem (a blocked command, a dirty build-cache file, a needed permission), not a code, test or spec defect: answer it in place with chief_continue (threadId: ${id}, instruction: the allowed step, at most ${MAX_NUDGE_LENGTH} characters); it keeps its worktree.`;
