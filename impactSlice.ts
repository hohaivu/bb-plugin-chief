import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Node built-ins only and erasable types only, so `node` can import this file directly.
const execFileAsync = promisify(execFile);

export type ImpactSlice = { lines: string[] } | { skipped: string };

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

/** The defined name on a definition line, else (headers only) the last identifier before the first `(`. */
function nameOf(text: string, fallback: boolean): string | null {
  const match = DEF.exec(text);
  if (match) return match[1] ?? match[2] ?? null;
  if (!fallback) return null;
  const ids = text.split("(")[0]!.match(/[A-Za-z_$][\w$]*/g);
  return text.includes("(") && ids?.length ? ids[ids.length - 1]! : null;
}

/** Bounded file:line pointers to code just outside a commit's diff: definitions of what the added lines call, and callers
 * of symbols whose definition line changed. Pure git at `sha`; never throws, any failure is `{ skipped }`. */
export async function computeImpactSlice(opts: {
  cwd: string; sha: string; baseRef: string; fetchRef?: string; env: NodeJS.ProcessEnv; maxEntries: number; deadlineMs: number;
}): Promise<ImpactSlice> {
  const deadline = Date.now() + opts.deadlineMs;
  let attrDir: string | null = null;
  const git = async (args: string[], noMatchOk = false) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("deadline");
      try {
        return (await execFileAsync("git", args, { cwd: opts.cwd, env: opts.env, timeout: Math.min(10_000, left), maxBuffer: 8 * 1024 * 1024 })).stdout;
      } catch (error) {
        if (noMatchOk && (error as { code?: unknown }).code === 1) return "";
        lastError = error;
      }
    }
    throw lastError;
  };
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
    const signature = new Set<string>();
    const callees = new Map<string, string>();
    let file: string | null = null;
    let inHunk = false;
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git ")) { inHunk = false; file = null; continue; }
      if (!inHunk && line.startsWith("+++ ")) { file = line.startsWith("+++ b/") ? line.slice(6) : null; continue; }
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
    if (!touched.size && !callees.size) return { lines: [header, "No touched symbols or calls found in the diff."] };

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
    const callers: string[] = [];
    for (const name of [...signature].slice(0, MAX_SIGNATURES)) {
      for (const hit of (await hits(name)).filter((hit) => !DEF.test(hit.text)).slice(0, 5)) {
        seen.add(hit.key);
        callers.push(`- \`${hit.key}\` — caller of \`${name}\` (signature changed)`);
      }
    }
    const definitions: string[] = [];
    for (const [name, from] of callees) {
      for (const hit of (await hits(name)).filter((hit) => nameOf(hit.text, false) === name).slice(0, 2)) {
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
    const omitted = callers.length + definitions.length - entries.length;
    const names = [...touched];
    const tail = [
      ...(omitted ? [`${omitted} more omitted`] : []),
      ...(tooCommon.length ? [`too common: ${tooCommon.map((name) => `\`${name}\``).join(", ")}`] : []),
    ];
    return {
      lines: [
        header,
        `Touched: ${names.slice(0, 20).map((name) => `\`${name}\``).join(", ")}${names.length > 20 ? ` and ${names.length - 20} more` : ""}${signature.size ? ` (signature changed: ${[...signature].slice(0, MAX_SIGNATURES).map((name) => `\`${name}\``).join(", ")})` : ""}`,
        ...(entries.length ? entries : ["No pointers outside the diff were found."]),
        ...(tail.length ? [`${tail.join("; ")}.`] : []),
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipped: message.replace(/\s+/g, " ").slice(0, 200) };
  } finally {
    if (attrDir) await rm(attrDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
