// The forge pre-flight Chief runs before delegating: tracking issue, task branch,
// draft pull request. The server runs the script in the project checkout when it
// can; Chief runs it only on fallback. Every value is substituted and quoted here,
// once, instead of being re-derived by a model on every delegation.

import { createHash } from "node:crypto";

/** POSIX single-quoting: the only interpolation this script does. */
function quote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function slug(title: string) {
  // NFKD splits "é" into "e" plus a combining mark, so accented titles keep their letters.
  const ascii = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const full = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Two titles that differ only in letters the slug drops (a non-Latin title) or in what
  // the length cut drops would share one branch; a hash of the whole title keeps them apart.
  const lossy = full.length > 60 || /[\p{L}\p{N}]/u.test(ascii.replace(/[a-z0-9]/g, ""));
  if (!lossy) return full || "task";
  const hash = createHash("sha256").update(title).digest("hex").slice(0, 8);
  return `${full.slice(0, 51).replace(/-+$/, "") || "task"}-${hash}`;
}

export function forgeInitScript(input: { title: string; base?: string; body?: string }) {
  const branch = `feature/${slug(input.title)}`;
  const script = [
    "set -u",
    `TITLE=${quote(input.title)}`,
    `BRANCH=${quote(branch)}`,
    `BODY=${quote(input.body ?? `Tracking work for ${input.title}.`)}`,
    `BASE=${quote(input.base ?? "")}`,
    "ISSUE_URL=''",
    "PR_URL=''",
    "",
    "git fetch origin --quiet 2>/dev/null || true",
    "",
    "# The project default branch. Never `git rev-parse HEAD`: Chief runs on its own BB",
    "# thread branch, so reading HEAD would cut every task branch — and point every draft",
    "# pull request — at a throwaway branch.",
    'if [ -z "$BASE" ]; then',
    "  BASE=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')",
    "fi",
    "# origin/HEAD is unset in some clones; `git remote set-head origin -a` repairs it.",
    'if [ -z "$BASE" ]; then',
    '  if git rev-parse --verify -q origin/main >/dev/null 2>&1; then BASE=main; else BASE=master; fi',
    "fi",
    "",
    "# Every forge step below is best-effort: a missing or unauthenticated CLI, or a",
    "# repository with issues disabled, leaves a value empty and never stops the branch",
    "# from being created.",
    "FORGE=''",
    "# https://host/..., ssh://git@host:port/... and git@host:org/repo all reduce to host.",
    "HOST=$(git remote get-url origin 2>/dev/null | sed -E 's#^[a-z+]+://##; s#^[^@/]*@##; s#[:/].*##')",
    'case "$HOST" in',
    "  *github*) command -v gh >/dev/null 2>&1 && FORGE=gh ;;",
    "  *gitlab*) command -v glab >/dev/null 2>&1 && FORGE=glab ;;",
    "  # A self-hosted forge under another name belongs to whichever CLI is logged in to it.",
    '  ?*) if command -v gh >/dev/null 2>&1 && gh auth status --hostname "$HOST" >/dev/null 2>&1; then FORGE=gh',
    "      elif command -v glab >/dev/null 2>&1; then FORGE=glab; fi ;;",
    "esac",
    "",
    "# Reuse an issue whose title matches exactly. A bare term search returns near",
    "# matches, so comparing titles is what stops a second issue opening every time the",
    "# same task is re-delegated.",
    'if [ "$FORGE" = gh ]; then',
    '  ISSUE_URL=$(TITLE="$TITLE" gh issue list --search "$TITLE" --state all --json title,url \\',
    "    --jq '[.[] | select(.title == env.TITLE)][0].url // \"\"' 2>/dev/null || true)",
    '  if [ -z "$ISSUE_URL" ]; then',
    '    ISSUE_URL=$(gh issue create --title "$TITLE" --body "$BODY" 2>/dev/null | grep -o "https://[^ ]*" | tail -1 || true)',
    "  fi",
    'elif [ "$FORGE" = glab ] && command -v jq >/dev/null 2>&1; then',
    '  ISSUE_URL=$(glab issue list --all --search "$TITLE" --in title -O json 2>/dev/null \\',
    "    | TITLE=\"$TITLE\" jq -r '[.[] | select(.title == env.TITLE)][0].web_url // \"\"' 2>/dev/null || true)",
    '  if [ -z "$ISSUE_URL" ]; then',
    '    ISSUE_URL=$(glab issue create -t "$TITLE" -d "$BODY" --yes 2>/dev/null | grep -o "https://[^ ]*" | tail -1 || true)',
    "  fi",
    "fi",
    "",
    "# Plumbing, deliberately: the checkout never moves, so the branch the worker is",
    "# about to take is never held by another worktree, and no failure here can strand",
    "# Chief on the task branch. `git switch -c` breaks every delegation.",
    "# The empty starting commit exists because a draft pull request cannot open from a",
    "# branch identical to its base.",
    'if ! git rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null 2>&1; then',
    '  TREE=$(git rev-parse -q --verify "origin/$BASE^{tree}" 2>/dev/null || git rev-parse -q --verify "$BASE^{tree}")',
    '  PARENT=$(git rev-parse -q --verify "origin/$BASE" 2>/dev/null || git rev-parse -q --verify "$BASE")',
    '  START=$(git commit-tree "$TREE" -p "$PARENT" -m "Start: $TITLE")',
    '  git branch "$BRANCH" "$START"',
    "fi",
    '# A failed push is survivable: the worker still commits to the right local branch.',
    'git push -u origin "$BRANCH" 2>/dev/null || true',
    "",
    "# The tracking line goes in only when there is an issue to track.",
    'PR_BODY="$BODY"',
    'if [ -n "$ISSUE_URL" ]; then PR_BODY="$PR_BODY',
    "",
    'Tracking: $ISSUE_URL"; fi',
    "",
    'if [ "$FORGE" = gh ]; then',
    '  PR_URL=$(gh pr list --head "$BRANCH" --state open --json url --jq \'.[0].url // ""\' 2>/dev/null || true)',
    '  if [ -z "$PR_URL" ]; then',
    '    PR_URL=$(gh pr create --draft --base "$BASE" --head "$BRANCH" --title "$TITLE" --body "$PR_BODY" 2>/dev/null \\',
    '      | grep -o "https://[^ ]*" | tail -1 || true)',
    "  fi",
    'elif [ "$FORGE" = glab ]; then',
    "  # Reuse the open merge request a partial earlier run left; glab mr list lists open ones.",
    '  if command -v jq >/dev/null 2>&1; then',
    '    PR_URL=$(glab mr list --source-branch "$BRANCH" -F json 2>/dev/null | jq -r \'.[0].web_url // ""\' 2>/dev/null || true)',
    "  fi",
    '  if [ -z "$PR_URL" ]; then',
    '    PR_URL=$(glab mr create --draft --source-branch "$BRANCH" --target-branch "$BASE" -t "$TITLE" -d "$PR_BODY" --yes 2>/dev/null \\',
    '      | grep -o "https://[^ ]*" | tail -1 || true)',
    "  fi",
    "fi",
    "",
    "# A branch that could not be cut at all is reported empty rather than handed to a",
    "# worktree that would fail to check it out.",
    'git rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null 2>&1 || BRANCH=\'\'',
    "",
    "printf 'CHIEF_FORGE branch=%s base=%s issue_url=%s pr_url=%s forge=%s\\n' \"$BRANCH\" \"$BASE\" \"$ISSUE_URL\" \"$PR_URL\" \"$FORGE\"",
  ].join("\n");
  return { branch, script };
}
