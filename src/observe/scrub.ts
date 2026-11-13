/** Replaces each configured secret with [secret], then every credential-shaped pattern with [redacted]. Idempotent. Commit SHAs and thr_ ids are left readable. */
const PATTERNS: [RegExp, string][] = [
  [/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/AKIA[0-9A-Z]{16}/g, "[redacted]"],
  [/Bearer\s+\S+/gi, "[redacted]"],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]"],
  // Keeps the key and separator; runs after Bearer so `authorization: Bearer x` is already one placeholder.
  [/\b((?:token|secret|password|passwd|api[_-]?key|authorization|dsn)\s*[:=]\s*)\S+/gi, "$1[redacted]"],
];

export function scrub(text: string, secrets: readonly string[] = []): string {
  // A secret inside a placeholder would rewrite it on a second pass, so it is skipped; longest first so a secret holding another is replaced whole.
  const literals = secrets.filter((secret) => secret && !"[redacted][secret]".includes(secret)).sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of literals) out = out.split(secret).join("[secret]");
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Collapses ids so one problem keeps one fingerprint. Only ever applied to already scrubbed text. */
export const normalize = (text: string): string => text
  .replace(/thr_\w+/g, "<id>")
  .replace(/wfr_[\w-]+/g, "<run>")
  .replace(/\b[0-9a-f]{7,}\b/gi, "<sha>")
  .replace(/\d+/g, "<n>");
