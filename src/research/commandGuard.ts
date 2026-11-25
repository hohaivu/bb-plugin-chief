// Command guard for Chief worker threads. Pure text, no I/O: artifacts.ts publishes these files under <BB data dir>/chief/guard/,
// install.sh (run once by the owner) registers them in the owner's Claude Code settings and pi extensions.
// No `${` in the String.raw texts below except the interpolations: it would clash with the template.

/** `guard.sh`: the hook entry point. Exits 0 at once unless BB_THREAD_ID has a marker file in `threads/` beside the script, so the
 * owner's own threads never start node. Every failure (no node, no guard.mjs) lets the command run. */
export function guardShim(): string {
  return String.raw`#!/bin/sh
# Chief command guard: acts only for threads Chief marked in threads/<thread id> beside this script.
D=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || exit 0
[ -n "$BB_THREAD_ID" ] && [ -e "$D/threads/$BB_THREAD_ID" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
[ -f "$D/guard.mjs" ] || exit 0
exec node "$D/guard.mjs"
`;
}

/** `guard.mjs`: reads one Claude Code PreToolUse payload on stdin; exit 2 plus a `[chief-guard]` reason on stderr refuses a Bash call
 * that pipes into tail/head or runs in the background. Anything it cannot parse passes (exit 0).
 * shortcut: quoted text is skipped, so `bash -c "x | tail"` passes; add a recursive parse if workers start doing that. */
export function guardScript(): string {
  return String.raw`import { readFileSync, writeSync } from "node:fs";

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const args = input && input.tool_name === "Bash" && input.tool_input && typeof input.tool_input === "object" ? input.tool_input : null;
if (!args) process.exit(0);

const refuse = (reason) => { writeSync(2, "[chief-guard] " + reason + "\n"); process.exit(2); };
const BACKGROUND = "Background run refused: Chief workers run every command in the foreground so the owner sees progress in the thread. Rerun it in the foreground with a timeout, or through the heavy wrapper for builds and tests.";
const PIPE = "Pipe into tail or head refused: it hides progress from the owner watching the thread. Rerun without the pipe; for long output use the heavy wrapper (it already prints the last 40 lines and the log path), or redirect to a file under $BB_THREAD_STORAGE and grep it.";

if (args.run_in_background === true) refuse(BACKGROUND);
if (typeof args.command !== "string") process.exit(0);

// The command without heredoc bodies, quoted strings, escaped characters and comments.
const kept = [];
const ends = [];
for (const line of args.command.split("\n")) {
  if (ends.length) {
    const end = ends[0];
    if ((end.dash ? line.replace(/^\t+/, "") : line) === end.word) ends.shift();
    continue;
  }
  kept.push(line);
  for (const m of line.matchAll(/(?<!<)<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g)) ends.push({ dash: m[1] === "-", word: m[2] ?? m[3] ?? m[4] });
}
const text = kept.join("\n");
let bare = "";
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (c === "\\") { i++; bare += " "; }
  else if (c === "'") { i = text.indexOf("'", i + 1); if (i < 0) break; bare += " "; }
  else if (c === '"') { for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++; bare += " "; }
  else if (c === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) { const nl = text.indexOf("\n", i); if (nl < 0) break; i = nl - 1; }
  else bare += c;
}

if (/(?<!\|)\|&?\s*(?:\S*\/)?(?:tail|head)(?![\w./-])/.test(bare)) refuse(PIPE);
if (/(?<![&>|<])&(?![&>])/.test(bare) || /(?<![\w.-])(?:nohup|disown|setsid)(?![\w.-])/.test(bare)) refuse(BACKGROUND);
`;
}

/** `chief-guard.ts` for ~/.pi/agent/extensions/ (pi and OMP load it): runs guard.sh on every bash tool call and blocks on exit 2. Fails open. */
export function piExtension(guardShPath: string): string {
  return `// Chief command guard: refuses piped tail/head and background commands in Chief worker threads. Written by Chief's install.sh.
import { spawnSync } from "node:child_process"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const GUARD = ${JSON.stringify(guardShPath)}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return
    const command = (event.input as { command?: unknown }).command
    if (typeof command !== "string") return
    try {
      const run = spawnSync("/bin/sh", [GUARD], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        env: process.env,
        encoding: "utf8",
        timeout: 5000,
      })
      if (run.status === 2) return { block: true, reason: run.stderr }
    } catch {
      // fail open
    }
  })
}
`;
}

/** `install.sh`: the owner runs it once per host. Merges one PreToolUse Bash hook into ~/.claude/settings.json (every other key and hook
 * kept, original saved to settings.json.chief-guard.bak, a file that is not valid JSON is never written) and copies the pi extension. Idempotent. */
export function installScript(guardDir: string): string {
  const dir = guardDir.replace(/'/g, `'\\''`);
  return String.raw`#!/bin/sh
# Registers the Chief command guard for Claude Code and pi/OMP. Safe to run again.
GUARD_DIR='${dir}'
command -v node >/dev/null 2>&1 || { echo "install.sh: node is required"; exit 1; }
SETTINGS="$HOME/.claude/settings.json"
EXT_DIR="$HOME/.pi/agent/extensions"

GUARD_DIR="$GUARD_DIR" SETTINGS="$SETTINGS" node - <<'JS' || exit 1
const fs = require("fs");
const path = require("path");
const file = process.env.SETTINGS;
const guardDir = process.env.GUARD_DIR;
const guardSh = path.join(guardDir, "guard.sh");
const stop = (why) => { console.log("install.sh: " + file + " " + why + "; nothing changed"); process.exit(1); };
let text = null;
try { text = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") stop("cannot be read"); }
let data = {};
if (text !== null) {
  try { data = JSON.parse(text); } catch { stop("is not valid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) stop("is not a JSON object");
}
if (data.hooks === undefined) data.hooks = {};
if (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks)) stop("has a hooks value that is not an object");
if (data.hooks.PreToolUse === undefined) data.hooks.PreToolUse = [];
if (!Array.isArray(data.hooks.PreToolUse)) stop("has a hooks.PreToolUse value that is not a list");
if (data.hooks.PreToolUse.some((entry) => { const text = JSON.stringify(entry); return text.includes(guardSh) || text.includes("chief/guard/guard.sh"); })) {
  console.log("settings.json: guard hook already present");
} else {
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const command = "/bin/sh -c '[ -f \"$0\" ] || exit 0; exec /bin/sh \"$0\"' " + quote(guardSh);
  data.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (text !== null) fs.copyFileSync(file, file + ".chief-guard.bak");
  const tmp = file + ".chief-guard.tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
  console.log("settings.json: added the guard hook to " + file);
}
JS

mkdir -p "$EXT_DIR" || exit 1
if cmp -s "$GUARD_DIR/pi-extension.ts" "$EXT_DIR/chief-guard.ts" 2>/dev/null; then
  echo "pi extension: unchanged"
else
  cp "$GUARD_DIR/pi-extension.ts" "$EXT_DIR/chief-guard.ts" || exit 1
  echo "pi extension: wrote $EXT_DIR/chief-guard.ts"
fi
`;
}
