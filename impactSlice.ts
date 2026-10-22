import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Node built-ins only and erasable types only, so `node` can import this file directly.
const execFileAsync = promisify(execFile);

/** `entries` counts the `path:line` pointers in `lines`; the other lines are header and notes. */
export type ImpactSlice = { lines: string[]; entries: number; guidelines: string[] } | { skipped: string };
export type ImpactSliceSuccess = Exclude<ImpactSlice, { skipped: string }>;

/** git with a 10 s timeout and 2 attempts, each bounded by the absolute `deadline`; past it, throws `deadline`.
 * `stop` optionally cancels the command with a hard kill. */
export function gitWithin(cwd: string, env: NodeJS.ProcessEnv, deadline: number, stop?: AbortSignal) {
  return async (args: string[], noMatchOk = false) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("deadline");
      try {
        if (stop?.aborted) throw new Error("stopped");
        const run = execFileAsync("git", args, { cwd, env, timeout: Math.min(10_000, left), maxBuffer: 8 * 1024 * 1024 });
        // execFile's own `signal` option sends SIGTERM only; a git that ignores it must still die.
        stop?.addEventListener("abort", () => run.child.kill("SIGKILL"), { once: true });
        return (await run).stdout;
      } catch (error) {
        if (noMatchOk && (error as { code?: unknown }).code === 1) return "";
        lastError = error;
      }
    }
    throw lastError;
  };
}

const MODS = "export|default|async|public|private|protected|internal|static|override|final|abstract|open";
const KEYWORDS = "function\\*?|class|interface|type|enum|struct|protocol|extension|def|func|fn";
const ID = "[A-Za-z_$][A-Za-z0-9_$]*";
/** One definition line, as git's xfuncname ERE; the first group (the line minus its indent) becomes the hunk header. */
const DEF_ERE = `^[[:space:]]*(((${MODS})[[:space:]]+)*((${KEYWORDS})[[:space:]]+${ID}|(const|let|var)[[:space:]]+${ID}[[:space:]]*=[[:space:]]*(async[[:space:]]+)?(function|\\()).*)$`;
const DEF = new RegExp(`^\\s*(?:(?:${MODS})\\s+)*(?:(?:${KEYWORDS})\\s+(${ID})|(?:const|let|var)\\s+(${ID})\\s*=\\s*(?:async\\s+)?(?:function|\\())`);
const DRIVERS: [string, string][] = [
  ["*", "chiefslice"], ["*.py", "python"], ["*.go", "golang"], ["*.rs", "rust"], ["*.java", "java"], ["*.kt", "kotlin"],
  ["*.rb", "ruby"], ["*.php", "php"], ["*.c", "cpp"], ["*.h", "cpp"], ["*.cc", "cpp"], ["*.cpp", "cpp"], ["*.hpp", "cpp"],
  ["*.cs", "csharp"], ["*.m", "objc"],
];
const STOP = new Set(("if for while switch async catch return function typeof new await super require import print len "
  + "else do try throw delete void yield case in of instanceof sizeof elif def class func fn let var const self this "
  + "String Number Boolean Array Object Promise Error Map Set JSON Math Date Symbol parseInt parseFloat isNaN "
  + "range str int float list dict tuple isinstance").split(" "));
const MAX_CALLEES = 20;
const MAX_SIGNATURES = 10;
const MAX_HITS = 200;
const GUIDELINE_NAMES = ["CLAUDE.md", "AGENTS.md"];
/** 100 directories give 200 pathspecs, far below ARG_MAX. */
const MAX_GUIDELINE_DIRS = 100;
/** The guideline listing runs beside the pointer lookup, is never awaited, and is killed when the slice is ready. */
const GUIDELINE_BUDGET_MS = 5_000;
const GUIDELINE_PENDING = "Not listed: the guideline lookup did not finish before the impact slice was ready.";

/** The defined name on a definition line, else (headers only) the last identifier before the first `(`. */
function nameOf(text: string, fallback: boolean): string | null {
  const match = DEF.exec(text);
  if (match) return match[1] ?? match[2] ?? null;
  if (!fallback) return null;
  const ids = text.split("(")[0]!.match(/[A-Za-z_$][\w$]*/g);
  return text.includes("(") && ids?.length ? ids[ids.length - 1]! : null;
}

/** The CLAUDE.md and AGENTS.md paths at `sha` in the repository root and in each directory on a changed path, as rendered
 * lines. Paths only, never contents. Best-effort: a failure becomes a note, never a thrown error. */
async function guidelineLines(git: ReturnType<typeof gitWithin>, sha: string, changed: Set<string>): Promise<string[]> {
  try {
    const dirs = new Set([""]);
    for (const path of changed) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
    }
    const searched = [...dirs].slice(0, MAX_GUIDELINE_DIRS);
    const specs = searched.flatMap((dir) => GUIDELINE_NAMES.map((name) => dir ? `${dir}/${name}` : name));
    const out = await git(["--literal-pathspecs", "ls-tree", "--name-only", sha, "--", ...specs]);
    const found = out.split("\n").filter(Boolean).map((path) => `- \`${path}\``);
    return [
      ...(found.length ? found : ["None in the repository root or on the changed files' paths."]),
      ...(dirs.size > searched.length ? [`${dirs.size - searched.length} more directories not searched.`] : []),
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`Not listed: ${message.replace(/\s+/g, " ").slice(0, 200)}.`];
  }
}

/** Bounded file:line pointers to code just outside a commit's diff: definitions of what the added lines call, and callers
 * of symbols whose definition line changed. Pure git at `sha`; never throws, any failure is `{ skipped }`.
 * `onReady` receives the finished slice before cleanup, so a caller with its own deadline can keep it. */
export async function computeImpactSlice(opts: {
  cwd: string; sha: string; baseRef: string; fetchRef?: string; env: NodeJS.ProcessEnv; maxEntries: number; deadlineMs: number;
  onReady?: (slice: ImpactSliceSuccess) => void;
}): Promise<ImpactSlice> {
  const deadline = Date.now() + opts.deadlineMs;
  let attrDir: string | null = null;
  const stopGuidelines = new AbortController();
  let guidelines: string[] | null = null;
  const git = gitWithin(opts.cwd, opts.env, deadline);
  const resolve = async (ref: string, fetchRef: string | undefined) => {
    const verify = () => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then((out) => out.trim(), () => null);
    let sha = await verify();
    if (!sha && fetchRef) {
      await git(["fetch", "origin", fetchRef]).catch(() => undefined);
      sha = await verify();
    }
    if (!sha && Date.now() >= deadline) throw new Error("deadline");
    return sha;
  };
  try {
    const sha = await resolve(opts.sha, opts.fetchRef);
    if (!sha) return { skipped: `commit ${opts.sha} not found locally` };
    const base = await resolve(opts.baseRef, opts.baseRef.replace(/^origin\//, ""));
    if (!base) return { skipped: `commit ${opts.baseRef} not found locally` };
    const mb = (await git(["merge-base", base, sha])).trim();
    attrDir = await mkdtemp(join(tmpdir(), "chief-slice-"));
    const attributes = join(attrDir, "attributes");
    await writeFile(attributes, DRIVERS.map(([glob, driver]) => `${glob} diff=${driver}`).join("\n") + "\n");
    const diff = await git(["-c", `core.attributesFile=${attributes}`, "-c", `diff.chiefslice.xfuncname=${DEF_ERE}`,
      "diff", "--no-color", "--no-ext-diff", "--no-renames", "-U0", mb, sha]);

    const ranges = new Map<string, [number, number][]>();
    const touched = new Set<string>();
    const changed = new Set<string>();
    const signature = new Set<string>();
    const callees = new Map<string, string>();
    let file: string | null = null;
    let inHunk = false;
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git ")) { inHunk = false; file = null; continue; }
      if (!inHunk && line.startsWith("--- a/")) { changed.add(line.slice(6)); continue; }
      if (!inHunk && line.startsWith("+++ ")) {
        file = line.startsWith("+++ b/") ? line.slice(6) : null;
        if (file) changed.add(file);
        continue;
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
      if (hunk) {
        inHunk = true;
        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        if (file && count > 0) ranges.set(file, [...ranges.get(file) ?? [], [start, start + count - 1]]);
        const name = hunk[3] ? nameOf(hunk[3], true) : null;
        if (name) touched.add(name);
        continue;
      }
      if (!inHunk || !(line.startsWith("+") || line.startsWith("-"))) continue;
      const text = line.slice(1);
      const defined = nameOf(text, false);
      if (defined) { touched.add(defined); signature.add(defined); }
      if (line.startsWith("+")) {
        for (const call of text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
          const name = call[1]!;
          if (name.length < 3 || STOP.has(name) || callees.has(name) || callees.size >= MAX_CALLEES) continue;
          callees.set(name, file ?? "a deleted file");
        }
      }
    }
    const header = `Computed at ${sha} against merge-base ${mb.slice(0, 12)} with ${opts.baseRef}, by name match (git grep -w): overloads, dynamic dispatch and same-named symbols can mislead.`;
    // Best-effort and never awaited: whatever it has settled when the pointers are done is used, else a note.
    void guidelineLines(gitWithin(opts.cwd, opts.env, Math.min(deadline, Date.now() + GUIDELINE_BUDGET_MS), stopGuidelines.signal), sha, changed)
      .then((lines) => { guidelines = lines; }, () => undefined);
    const ready = (slice: { lines: string[]; entries: number }): ImpactSliceSuccess => {
      const success = { ...slice, guidelines: [...guidelines ?? [GUIDELINE_PENDING]] };
      // A throwing callback must not downgrade the finished slice.
      try { opts.onReady?.(success); } catch { /* the slice is still returned */ }
      return success;
    };
    if (!touched.size && !callees.size) return ready({ lines: [header, "No touched symbols or calls found in the diff."], entries: 0 });

    const inDiff = (path: string, n: number) => (ranges.get(path) ?? []).some(([from, to]) => n >= from && n <= to);
    const seen = new Set<string>();
    const tooCommon: string[] = [];
    const hits = async (name: string) => {
      const out = await git(["grep", "-n", "-I", "-w", "-F", "-e", name, sha, "--"], true);
      const rows = out.split("\n").filter(Boolean);
      if (rows.length > MAX_HITS) { tooCommon.push(name); return []; }
      return rows.flatMap((row) => {
        const match = /^(.+?):(\d+):(.*)$/.exec(row.slice(sha.length + 1));
        if (!match) return [];
        const [, path, n, text] = match;
        const key = `${path}:${n}`;
        if (inDiff(path!, Number(n)) || seen.has(key)) return [];
        return [{ key, text: text! }];
      });
    };
    // Candidates dropped by the per-symbol caps, so the omission notice counts them too.
    let capped = 0;
    const callers: string[] = [];
    for (const name of [...signature].slice(0, MAX_SIGNATURES)) {
      const found = (await hits(name)).filter((hit) => !DEF.test(hit.text));
      capped += Math.max(0, found.length - 5);
      for (const hit of found.slice(0, 5)) {
        seen.add(hit.key);
        callers.push(`- \`${hit.key}\` — caller of \`${name}\` (signature changed)`);
      }
    }
    const definitions: string[] = [];
    for (const [name, from] of callees) {
      const found = (await hits(name)).filter((hit) => nameOf(hit.text, false) === name);
      capped += Math.max(0, found.length - 2);
      for (const hit of found.slice(0, 2)) {
        seen.add(hit.key);
        definitions.push(`- \`${hit.key}\` — \`${name}\` defined here (called by changed code in ${from})`);
      }
    }
    const firstCallers = Math.min(callers.length, Math.ceil(opts.maxEntries / 2));
    const firstDefinitions = Math.min(definitions.length, opts.maxEntries - firstCallers);
    const entries = [
      ...callers.slice(0, firstCallers), ...definitions.slice(0, firstDefinitions),
      ...callers.slice(firstCallers, firstCallers + opts.maxEntries - firstCallers - firstDefinitions),
    ];
    const omitted = callers.length + definitions.length - entries.length + capped;
    const names = [...touched];
    const tail = [
      ...(omitted ? [`${omitted} more omitted`] : []),
      ...(tooCommon.length ? [`too common: ${tooCommon.map((name) => `\`${name}\``).join(", ")}`] : []),
    ];
    return ready({
      lines: [
        header,
        `Touched: ${names.slice(0, 20).map((name) => `\`${name}\``).join(", ")}${names.length > 20 ? ` and ${names.length - 20} more` : ""}${signature.size ? ` (signature changed: ${[...signature].slice(0, MAX_SIGNATURES).map((name) => `\`${name}\``).join(", ")})` : ""}`,
        ...(entries.length ? entries : ["No pointers outside the diff were found."]),
        ...(tail.length ? [`${tail.join("; ")}.`] : []),
      ],
      entries: entries.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipped: message.replace(/\s+/g, " ").slice(0, 200) };
  } finally {
    stopGuidelines.abort();
    if (attrDir) await rm(attrDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
