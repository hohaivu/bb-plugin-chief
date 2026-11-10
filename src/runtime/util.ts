

/** A provider failure worth retrying on the same thread, or null. Text-matched: pi reports
 * 429s and connection drops only as provider/error detail, with no errorInfo. */
// ponytail: heuristic regexes; switch to errorInfo.category once providers populate it.
export function transientFailure(text: string): { usageLimit: boolean; resetSeconds: number | null } | null {
  const usageLimit = /\b429\b|usage[_ ]limit|rate[_ -]?limit|model_cooldown|quota/i.test(text);
  if (!usageLimit && !/connection error|connection-failed|stream-disconnected|overloaded|ECONNRESET|ETIMEDOUT|socket hang up|\b50[234]\b/i.test(text)) return null;
  const reset = /"?reset_seconds"?\s*[:=]\s*(\d+)/.exec(text);
  return { usageLimit, resetSeconds: reset ? Number(reset[1]) : null };
}
