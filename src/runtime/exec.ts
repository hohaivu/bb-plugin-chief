import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/** Races one call against a deadline. A synchronous throw becomes a rejection, and the timer never outlives the call.
 * A call that loses the race is abandoned, not cancelled. */
export async function bounded<T>(call: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => call())(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline passed")), Math.max(ms, 0)); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
