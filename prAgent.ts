// The review engine: how a Chief-managed worker reviewer forms its verdict for review targets pinned to a
// pull request head. Pure text and parsing, no I/O: reviewStart.ts reads the setting and writes the files,
// server.ts defines the settings. See docs/specs/review-engine.md.

import { quote } from "./forge";

export type ReviewMode = "reviewer" | "pr-agent" | "both";
export type ReviewEngine = { mode: ReviewMode; prAgentDir: string };

/** One target a review covers, in `covered` order; sha is the forge's head (null: not pinned). */
export type EngineTarget = { threadId: string; branch: string | null; prUrl: string | null; sha: string | null; since?: string };

export const PR_AGENT_DIR = "/Volumes/VuHo_T5/Develop/personal/research/pr-agent";

/** The reviewer's tool timeout is 570 s, 30 s above the script's own total, both under a 600 s tool cap. */
export const PR_AGENT_LIMITS = { totalSeconds: 540, checkSeconds: 30, translateSeconds: 60 };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The one validation point of the two settings: any value but the exact trimmed `pr-agent` or `both` gives `reviewer`. */
export function reviewEngine(raw: { reviewEngine?: unknown; prAgentDir?: unknown }): ReviewEngine {
  const mode = text(raw.reviewEngine);
  return { mode: mode === "pr-agent" || mode === "both" ? mode : "reviewer", prAgentDir: text(raw.prAgentDir) || PR_AGENT_DIR };
}

/** A target is pinned when the forge reported a head commit for its pull request. */
export const isPinned = (target: EngineTarget) => !!(target.sha && target.prUrl);

// Translates pr-agent's JSON file into one line. Reason on stderr, exit 6 on any invalid output.
const TRANSLATE = String.raw`import json, sys
path, url, sha = sys.argv[1], sys.argv[2], sys.argv[3]
def fail(reason):
    sys.stderr.write(reason + "\n")
    sys.exit(6)
def clip(value, limit):
    value = value[:limit]
    while len(value.encode("utf-16-le", "surrogatepass")) // 2 > limit:
        value = value[:-1]
    return value
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except Exception as error:
    fail("output unreadable: " + str(error)[:160])
review = data.get("review") if isinstance(data, dict) else None
if not isinstance(review, dict):
    fail("output has no review object")
recommendation = review.get("merge_recommendation")
if recommendation not in ("no_concerns_found", "needs_review", "changes_required"):
    fail("unknown merge_recommendation " + repr(recommendation)[:60])
issues = review.get("key_issues_to_review") or []
if not isinstance(issues, list):
    fail("key_issues_to_review is not a list")
severity = "blocking" if recommendation == "changes_required" else "nit"
findings = []
for issue in issues:
    if not isinstance(issue, dict):
        fail("a key issue is not an object")
    name = issue.get("relevant_file")
    name = clip(name.strip(), 300).strip() if isinstance(name, str) else ""
    if not name:
        fail("a key issue has no relevant_file")
    header = str(issue.get("issue_header") or "").strip()
    content = str(issue.get("issue_content") or "").strip()
    message = (header + ": " + content) if header and content else (header or content or "pr-agent issue")
    finding = {"file": name, "severity": severity, "message": clip(message, 900)}
    line = issue.get("start_line")
    if isinstance(line, int) and not isinstance(line, bool) and line >= 1:
        finding["line"] = line
    findings.append(finding)
if recommendation == "changes_required" and not findings:
    fail("changes_required with no key issues")
coverage = data.get("coverage")
skipped = coverage.get("files_not_reviewed") if isinstance(coverage, dict) else None
print(json.dumps({
    "prUrl": url, "sha": sha, "recommendation": recommendation,
    "verdict": "request_changes" if recommendation == "changes_required" else "approve",
    "findings": findings,
    "filesNotReviewed": [clip(str(item), 300) for item in skipped] if isinstance(skipped, list) else [],
}))
`;

/** The wrapper `pr-agent-review.sh`: runs pr-agent on a pinned pull request with publishing off and prints one translated JSON line.
 * bash 3.2 (macOS /bin/bash): no `wait -n`, no GNU `timeout`, so each external step runs in its own process group under a watcher.
 * Exit: 0 one JSON line; 2 usage, directory, uv, gh or non-GitHub; 3 head moved or unreadable; 4 timeout; 5 pr-agent failed; 6 invalid output. */
export function prAgentScript(dir: string, limits = PR_AGENT_LIMITS): string {
  return String.raw`#!/bin/bash
# Usage: bash pr-agent-review.sh <pr_url> <pinned_sha>
# shortcut: GitHub only (gh head check); add glab when a GitLab project needs pr-agent.
# shortcut: a SIGKILL of the wrapper itself cannot be trapped; pr-agent then runs to its own end, still with publishing off.
set -u
set -m
SECONDS=0
TOTAL=${limits.totalSeconds}
CHECK=${limits.checkSeconds}
TRANSLATE=${limits.translateSeconds}
DIR=${quote(dir)}
PY=${quote(TRANSLATE)}
CUR_PID=""
WATCH_PID=""
TMP=""

cleanup() {
  if [ -n "$CUR_PID" ]; then kill -KILL -- "-$CUR_PID" 2>/dev/null; fi
  if [ -n "$WATCH_PID" ]; then kill -KILL -- "-$WATCH_PID" 2>/dev/null; fi
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

die() {
  code=$1
  shift
  printf 'pr-agent-review: %s\n' "$*" >&2
  exit "$code"
}

last_line() {
  tail -n 1 "$1" 2>/dev/null | cut -c1-200
}

# budget <step limit> <reserve>: the step limit, cut to what is left of the total after the reserve.
budget() {
  left=$(( TOTAL - SECONDS - $2 ))
  if [ "$left" -lt "$1" ]; then echo "$left"; else echo "$1"; fi
}

# run_bounded <seconds> <cmd...>: runs the command in its own process group; TERM to the group at the
# deadline, KILL 5 s later. Sets RB_STATUS (exit status) and RB_TIMEOUT (1 at the deadline).
# Redirections on the call apply to the command.
run_bounded() {
  RB_TIMEOUT=0
  RB_STATUS=0
  rb_limit=$1
  shift
  if [ "$rb_limit" -le 0 ]; then RB_TIMEOUT=1; RB_STATUS=124; return 0; fi
  rm -f "$TMP/timeout"
  "$@" &
  CUR_PID=$!
  ( sleep "$rb_limit"; : > "$TMP/timeout"; kill -TERM -- "-$CUR_PID" 2>/dev/null; sleep 5; kill -KILL -- "-$CUR_PID" 2>/dev/null ) >/dev/null 2>&1 &
  WATCH_PID=$!
  wait "$CUR_PID" 2>/dev/null
  RB_STATUS=$?
  if [ -e "$TMP/timeout" ]; then
    RB_TIMEOUT=1
    wait "$WATCH_PID" 2>/dev/null
  else
    kill -TERM -- "-$WATCH_PID" 2>/dev/null
    wait "$WATCH_PID" 2>/dev/null
  fi
  CUR_PID=""
  WATCH_PID=""
}

# head_check <label> <reserve>: the pull request head must equal the pinned sha.
head_check() {
  run_bounded "$(budget "$CHECK" "$2")" gh pr view "$URL" --json headRefOid -q .headRefOid >"$TMP/head" 2>"$TMP/head.err" </dev/null
  if [ "$RB_TIMEOUT" = 1 ]; then die 4 "$1: head check timed out"; fi
  if [ "$RB_STATUS" -ne 0 ]; then die 3 "$1: gh pr view failed: $(last_line "$TMP/head.err")"; fi
  got=$(tr -d '[:space:]' <"$TMP/head" | tr 'A-F' 'a-f')
  if [ "$got" != "$SHA_LC" ]; then die 3 "$1: pull request head is $got, pinned to $SHA_LC"; fi
}

pr_agent_call() {
  cd "$DIR" || exit 2
  exec env CONFIG__PUBLISH_OUTPUT=false CONFIG__PROPAGATE_TOOL_ERRORS=true PR_REVIEWER__REQUIRE_MERGE_RECOMMENDATION=true CONFIG__USE_REPO_SETTINGS_FILE=false CONFIG__USE_GLOBAL_SETTINGS_FILE=false uv run pr-agent --pr_url "$URL" --json-output "$OUT" review
}

# 1. Validate.
if [ "$#" -ne 2 ]; then die 2 "usage: pr-agent-review.sh <pr_url> <pinned_sha>"; fi
URL=$1
SHA=$2
case "$URL" in https://github.com/*) ;; *) die 2 "usage: only github.com pull requests are supported" ;; esac
case "$SHA" in ""|*[!0-9a-fA-F]*) die 2 "usage: the pinned sha must be hex" ;; esac
if [ ! -d "$DIR" ]; then die 2 "usage: pr-agent directory not found: $DIR"; fi
command -v uv >/dev/null 2>&1 || die 2 "uv not found on PATH"
command -v gh >/dev/null 2>&1 || die 2 "gh not found on PATH"
TMP=$(mktemp -d /tmp/pr-agent-review.XXXXXX) || die 2 "cannot create a temp directory"
SHA_LC=$(printf %s "$SHA" | tr 'A-F' 'a-f')
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/pr-agent-$(printf %s "$SHA_LC" | cut -c1-12).json"
LOG="$HERE/pr-agent-$(printf %s "$SHA_LC" | cut -c1-12).log"
rm -f "$OUT"

# 2. The head must still be the pinned commit before pr-agent runs.
head_check "head check before" 0

# 3. pr-agent, publishing off, with the time the two later steps leave.
run_bounded $(( TOTAL - SECONDS - CHECK - TRANSLATE )) pr_agent_call >"$LOG" 2>&1 </dev/null
if [ "$RB_TIMEOUT" = 1 ]; then die 4 "pr-agent: timed out"; fi
if [ "$RB_STATUS" -ne 0 ]; then die 5 "pr-agent: exit $RB_STATUS: $(last_line "$LOG")"; fi

# 4. The head must still be the pinned commit after it ran, even when pr-agent succeeded.
head_check "head check after" "$TRANSLATE"

# 5. Translate.
run_bounded "$(budget "$TRANSLATE" 0)" uv run --directory "$DIR" python -c "$PY" "$OUT" "$URL" "$SHA_LC" >"$TMP/tr" 2>"$TMP/tr.err" </dev/null
if [ "$RB_TIMEOUT" = 1 ]; then die 4 "translate: timed out"; fi
if [ "$RB_STATUS" -ne 0 ]; then die 6 "translate: $(last_line "$TMP/tr.err")"; fi
if [ "$(wc -l <"$TMP/tr" | tr -d ' ')" != 1 ]; then die 6 "translate: output is not exactly one line"; fi
cat "$TMP/tr"
exit 0
`;
}

const BAN = "The ban on running builds, linters, typecheckers and tests still holds.";

/** The lines appended to the reviewer prompt for mode `pr-agent` or `both`. Every target appears once; with no pinned target only the heading and the direct line remain.
 * `dir` is the absolute directory holding `pr-agent-review.sh` and `review-helper.md`, written before the reviewer is spawned and rendered literally into every command. */
export function prAgentSection(mode: "pr-agent" | "both", targets: EngineTarget[], dir: string): string[] {
  const heading = `## Review engine: ${mode}`;
  const pinned = targets.filter(isPinned);
  if (!pinned.length) {
    return [heading, `No target has a pinned pull request head: review directly as described above, and start your result with \`Engine: ${mode} → direct (no pinned pull request head)\`.`];
  }
  const both = mode === "both";
  const pairs = [...new Set(pinned.map((target) => `${target.prUrl} ${target.sha}`))];
  const spawn = `bb thread spawn --project "$BB_PROJECT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --environment "$BB_ENVIRONMENT_ID" --parent-notifications off --title "Review helper" --prompt-file "${dir}/review-helper.md" --json`;
  return [
    heading,
    `This section adds to the review above: every rule above holds unless this section names an exception. You may also run the commands named here. ${BAN} The reads a direct review needs (git fetch, git checkout, git diff, gh pr view, glab mr view) stay allowed.`,
    "Targets:",
    ...targets.map((target) => {
      const where = `- worker ${target.threadId} (branch ${target.branch ?? "none"})`;
      return isPinned(target)
        ? `${where}: ${target.prUrl} pinned to ${target.sha} → pr-agent${target.since ? `; re-review since ${target.since}` : ""}`
        : `${where}: not pinned → direct review (no pinned pull request head)`;
    }),
    ...(both ? [
      "Helper (start it first): a plain child thread does the direct review of every target in this checkout while you run pr-agent. If `${dir}/review-helper.md` is missing, wait 10 s and look once more; still missing: the direct half fails (`helper prompt missing`). Otherwise run, once:",
      spawn,
      "The helper id is `.id` of its output. A failed spawn or no id: the direct half fails (`helper spawn failed: <reason>`). While the helper may be running, run no git command that changes this checkout (fetch, checkout, reset): it shares the checkout.",
    ] : []),
    "Run pr-agent once for each pull request and commit pair below, each as a foreground Bash call with a tool timeout of 570000 ms (the script stops itself within 540 s):",
    ...pairs.map((pair) => `bash "${dir}/pr-agent-review.sh" ${pair}`),
    "If the script file is missing, wait 10 s and look once more; still missing: the outcome of every pinned target is failure `wrapper missing`. A pair's outcome applies to every target that names it.",
    "Give every target exactly one outcome:",
    "- definitive: exit 0, exactly one JSON line on stdout, recommendation `changes_required` or `no_concerns_found`. Use its findings as given. Do not re-verify them in the code: this overrides \"inspect the pinned commit\" for this target only.",
    `- needs_review: exit 0 with recommendation \`needs_review\`. ${both ? "Its findings stay nits; the direct half covers the target." : "Review this target directly as described above, starting from its findings: confirm, drop or reclassify each."}`,
    `- failure: any non-zero exit, a tool error or tool timeout, or stdout that is not exactly one JSON line even with exit 0. The reason is the stderr line, else what you saw. ${both ? "The target has only the direct half." : "Review this target directly as described above."}`,
    `- not pinned: ${both ? "the direct half only." : "review it directly as described above."}`,
    "Re-review scope: for a definitive target with a re-review range, run `git diff --name-only <since>..<sha>`; translated findings on files outside that list go to result as nits, not to findings.",
    ...(both ? [
      "Direct half: after the last pr-agent call, run `bb thread wait <helper id> --status idle --timeout 540s` (tool timeout 570000 ms), then `bb thread show <helper id> --json` and read `.thread.status`. `idle`: read its result. `failed`: the direct half fails (`helper failed`). Anything else: wait the same way once more, then read the status again. Still not idle or failed: run `bb thread stop <helper id>`, then `bb thread show <helper id> --json`; `idle` or `failed` confirms the stop (reason `helper timeout`), else wait 10 s and check once more. Never use the checkout before the helper is idle, failed or confirmed stopped. If the stop cannot be confirmed, report blocked naming helper `<helper id>` (shared checkout): this is the only blocked path of this section.",
      "Read the result with `bb thread output <helper id>` and take the last fenced `json` block. It is valid only when: `verdict` is approve or request_changes; `findings` is an array whose items have file of 1-300 characters, message of 1-1000 characters, severity blocking or nit, and line an integer of 1 or more or absent; the verdict is request_changes if and only if a finding is blocking; `result` is a string; `regression`, when present, is a boolean. A `{\"blocked\": …}` block, no block, or any violation: the direct half fails (`helper result invalid: <what>`).",
      "Combine: the direct half is the helper's findings, or, when it failed, your own direct review of every target as described above, done only after the stop rule. The pr-agent half follows the outcomes above. Set `regression: true` when the helper or your own review found a regression.",
    ] : []),
    "Aggregate once: findings are the union over all targets. Merge two findings only when target, file, line and problem are the same; a merged finding is blocking if either was. Never merge across targets. With more than one target, start each message with `[<branch>] `. The verdict is request_changes if and only if a blocking finding remains. Over 40 findings: keep every blocking finding, fill with nits, and name the dropped nit count in result; if blocking findings alone exceed 40, fold the blocking findings of one target and file into one finding that names the lines in its message, until 40 fit. Never drop a blocking finding.",
    `Result: the first line is \`Engine: ${mode}\`, then one line per target: \`<branch>: pr-agent <recommendation>\` or \`<branch>: direct (<reason>)\`.${both ? " Add `direct half: helper` or `direct half: reviewer (<reason>)`." : ""}`,
    "Send one chief_report.",
    ...(both ? ["After chief_report is accepted, run `bb thread archive <helper id>`; if it fails, say so in your final message (the helper is archived with you as its lifecycle owner). Never archive the helper before the report is accepted."] : []),
  ];
}

/** The content of `review-helper.md` for `both` mode: a header, the reviewer-mode prompt byte for byte, and the context under `## review-context.md`. */
export function helperPrompt(reviewerPrompt: string, context: string | null): string {
  const header = [
    "You are a review helper for a Chief reviewer: you do the direct review of every target below in this checkout and hand the result back to it. Do not call chief_report or any chief_* tool, spawn threads, run pr-agent, or edit, commit or push files.",
    "Wherever the brief below says to send chief_report, end your turn with a final response whose last block is a fenced `json` object `{\"verdict\", \"findings\", \"result\", \"regression\"?}` under the same verdict and finding rules. Wherever it says to report blocked, end with a fenced `json` object `{\"blocked\": \"<reason>\"}`.",
    "The review context is inline below under `## review-context.md`: it replaces the brief's instruction to read `$BB_THREAD_STORAGE/review-context.md` and its missing-file rule (your storage has no such file). Ignore the brief's summary and lesson fields.",
  ];
  return [...header, "", reviewerPrompt, ...(context ? ["", "## review-context.md", context] : [])].join("\n");
}
