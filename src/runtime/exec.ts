import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/** Races one call against a deadline. A synchronous throw becomes a rejection, and the timer never outlives the call.
 * A call that loses the race is abandoned, not cancelled. An aborted `signal` ends the race at once and clears the deadline; an already aborted one never starts the call. */
export async function bounded<T>(call: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("abandoned");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  try {
    // The deadline and abort listener come first in the array so a call that aborts synchronously is heard.
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline passed")), Math.max(ms, 0));
        onAbort = () => reject(new Error("abandoned"));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
      (async () => call())(),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
