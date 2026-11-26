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

// One pass over the command as the shell reads it: quotes, escapes, comments, here-strings and heredoc bodies are skipped, operators are
// whole tokens, and a command word counts only in command position (so "cat ./nohup" and "true ||/usr/bin/head" pass). Redirection operands
// and fd prefixes are not command words. A refusal is only recorded while scanning: input the shell would reject (an unterminated quote or
// an unclosed parenthesis) passes, and the refusal is issued after the scan, once the parse succeeded.
const WORD_END = /[\s;&|<>()]/;
const PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=.*|!|\{|if|then|else|elif|do|while|until|time|exec|command|env|sudo)$/;
const text = args.command;
const heredocs = [];
let i = 0, word = "", inWord = false, cmdPos = true, afterPipe = false, redir = false, depth = 0, bad = false, refusal = null;
const hit = (reason) => { refusal ??= reason; };
const flush = () => {
  if (!inWord) return;
  const full = word, base = word.slice(word.lastIndexOf("/") + 1);
  word = ""; inWord = false;
  if (redir) { redir = false; return; }
  if (!cmdPos) return;
  if (afterPipe && (base === "tail" || base === "head")) hit(PIPE);
  if (base === "nohup" || base === "disown" || base === "setsid") hit(BACKGROUND);
  if (!PREFIX.test(full)) { cmdPos = false; afterPipe = false; }
};
while (i < text.length) {
  const c = text[i], n = text[i + 1];
  if (c === "\\") { if (n === "\n") {} else { word += n ?? ""; inWord = true; } i += 2; }
  else if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) { bad = true; break; } word += text.slice(i + 1, e); inWord = true; i = e + 1; }
  else if (c === '"') { let e = i + 1; for (; e < text.length && text[e] !== '"'; e++) if (text[e] === "\\") e++; if (e >= text.length) { bad = true; break; } word += text.slice(i + 1, e); inWord = true; i = e + 1; }
  else if (c === "#" && !inWord) { const e = text.indexOf("\n", i); if (e < 0) break; i = e; }
  else if (c === "\n") {
    flush(); i++; cmdPos = true;
    for (const h of heredocs.splice(0)) while (i < text.length) {
      let e = text.indexOf("\n", i); if (e < 0) e = text.length;
      const line = text.slice(i, e); i = e + 1;
      if ((h.dash ? line.replace(/^\t+/, "") : line) === h.word) break;
    }
  }
  else if (/\s/.test(c)) { flush(); i++; }
  else if (c === "<" && text.startsWith("<<<", i)) { flush(); i += 3; redir = true; }
  else if (c === "<" && n === "<") {
    flush(); i += 2;
    const dash = text[i] === "-"; if (dash) i++;
    while (text[i] === " " || text[i] === "\t") i++;
    // A delimiter starts with a letter, underscore or quote: "$((1<<2))" is arithmetic, not a heredoc.
    if (/[A-Za-z_'"\\]/.test(text[i] ?? "")) {
      // The delimiter is one shell word with its quotes removed: quoted whitespace belongs to it.
      let w = "";
      while (i < text.length && !WORD_END.test(text[i])) {
        const q = text[i];
        if (q === "'" || q === '"') { const e = text.indexOf(q, i + 1); if (e < 0) { bad = true; i = text.length; break; } w += text.slice(i + 1, e); i = e + 1; }
        else if (q === "\\") { w += text[i + 1] ?? ""; i += 2; }
        else { w += q; i++; }
      }
      heredocs.push({ dash, word: w });
    }
  }
  else if (c === "|") {
    flush(); cmdPos = true;
    if (n === "|") { i += 2; afterPipe = false; } else { i += n === "&" ? 2 : 1; afterPipe = true; }
  }
  else if (c === "&") {
    flush();
    if (n === "&") { i += 2; cmdPos = true; afterPipe = false; }
    else if (n === ">") i += text[i + 2] === ">" ? 3 : 2;
    else { hit(BACKGROUND); i++; cmdPos = true; afterPipe = false; }
    if (n === ">") redir = true;
  }
  else if (c === ";") { flush(); i++; cmdPos = true; afterPipe = false; }
  else if (c === "(") { flush(); i++; cmdPos = true; redir = false; depth++; }
  else if (c === ")") { flush(); i++; depth = Math.max(0, depth - 1); }
  else if (c === "<" || c === ">") {
    if (inWord && /^[0-9]+$/.test(word)) { word = ""; inWord = false; } else flush();
    i += n === "&" || (c === ">" && n === "|") ? 2 : 1; redir = true;
  }
  else { word += c; inWord = true; i++; }
}
flush();
if (bad || depth > 0) process.exit(0);
if (refusal) refuse(refusal);
`;
}

/** `chief-guard.ts` for ~/.pi/agent/extensions/ (pi and OMP load it): runs guard.sh on every bash tool call and blocks only on exit 2 with a [chief-guard] reason. Fails open. */
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
      // A shell failure (missing guard.sh exits 2 under dash) has no [chief-guard] reason and must let the command run.
      if (run.status === 2 && run.stderr.startsWith("[chief-guard]")) return { block: true, reason: run.stderr }
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
try { text = fs.readFileSync(file, "utf8"); } catch (error) {
  if (error.code !== "ENOENT") stop("cannot be read");
  if (fs.lstatSync(file, { throwIfNoEntry: false })) stop("is a link whose target is missing");
}
let data = {};
if (text !== null) {
  try { data = JSON.parse(text); } catch { stop("is not valid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) stop("is not a JSON object");
}
if (data.hooks === undefined) data.hooks = {};
if (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks)) stop("has a hooks value that is not an object");
if (data.hooks.PreToolUse === undefined) data.hooks.PreToolUse = [];
if (!Array.isArray(data.hooks.PreToolUse)) stop("has a hooks.PreToolUse value that is not a list");
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const command = "/bin/sh -c '[ -f \"$0\" ] || exit 0; exec /bin/sh \"$0\"' " + quote(guardSh);
const present = (entry) => entry && entry.matcher === "Bash" && Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook && hook.type === "command" && hook.command === command);
if (data.hooks.PreToolUse.some(present)) {
  console.log("settings.json: guard hook already present");
} else {
  data.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] });
  // Write the resolved file beside itself, so a symlinked settings.json (dotfiles checkout) stays a link; keep its mode, new files are private.
  const target = text !== null ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = text !== null ? fs.statSync(target).mode & 0o777 : 0o600;
  if (text !== null) fs.copyFileSync(target, target + ".chief-guard.bak");
  const tmp = target + ".chief-guard.tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
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
