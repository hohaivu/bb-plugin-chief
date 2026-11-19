import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/** Races one call against a deadline. A synchronous throw becomes a rejection, and the timer never outlives the call.
 * A call that loses the race is abandoned, not cancelled. An aborted `signal` ends the race at once and clears the deadline. */
export async function bounded<T>(call: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  try {
    return await Promise.race([
      (async () => call())(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline passed")), Math.max(ms, 0));
        onAbort = () => reject(new Error("abandoned"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
