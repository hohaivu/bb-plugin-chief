// The forge pre-flight Chief runs before delegating: tracking issue, task branch,
// draft pull request. The server runs the script in the project checkout when it
// can; Chief runs it only on fallback. Every value is substituted and quoted here,
// once, instead of being re-derived by a model on every delegation.

import { createHash } from "node:crypto";
import { clip } from "./text";
import { execFileAsync } from "./src/runtime/exec";

/** POSIX single-quoting: the only interpolation this script does. */
export function quote(value: string) {
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

/** issueUrl reuses a plan's shared tracking issue; issueTitle and issueBody replace the task's own title and body on a newly created issue (the pull request keeps title and body). */
export function forgeInitScript(input: { title: string; base?: string; body?: string; issueUrl?: string; issueTitle?: string; issueBody?: string }) {
  const branch = `feature/${slug(input.title)}`;
  const script = [
    "set -u",
    `TITLE=${quote(input.title)}`,
    `BRANCH=${quote(branch)}`,
    `BODY=${quote(input.body ?? `Tracking work for ${input.title}.`)}`,
    `ISSUE_TITLE=${quote(input.issueTitle ?? input.title)}`,
    `ISSUE_BODY=${quote(input.issueBody ?? input.body ?? `Tracking work for ${input.title}.`)}`,
    `BASE=${quote(input.base ?? "")}`,
    `ISSUE_URL=${quote(input.issueUrl ?? "")}`,
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
    "# A plan's shared issue arrives preset in ISSUE_URL; then none of this runs.",
    'if [ -n "$ISSUE_URL" ]; then :',
    'elif [ "$FORGE" = gh ]; then',
    '  ISSUE_URL=$(TITLE="$ISSUE_TITLE" gh issue list --search "$ISSUE_TITLE" --state all --json title,url \\',
    "    --jq '[.[] | select(.title == env.TITLE)][0].url // \"\"' 2>/dev/null || true)",
    '  if [ -z "$ISSUE_URL" ]; then',
    '    ISSUE_URL=$(gh issue create --title "$ISSUE_TITLE" --body "$ISSUE_BODY" 2>/dev/null | grep -o "https://[^ ]*" | tail -1 || true)',
    "  fi",
    'elif [ "$FORGE" = glab ] && command -v jq >/dev/null 2>&1; then',
    '  ISSUE_URL=$(glab issue list --all --search "$ISSUE_TITLE" --in title -O json 2>/dev/null \\',
    "    | TITLE=\"$ISSUE_TITLE\" jq -r '[.[] | select(.title == env.TITLE)][0].web_url // \"\"' 2>/dev/null || true)",
    '  if [ -z "$ISSUE_URL" ]; then',
    '    ISSUE_URL=$(glab issue create -t "$ISSUE_TITLE" -d "$ISSUE_BODY" --yes 2>/dev/null | grep -o "https://[^ ]*" | tail -1 || true)',
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

export const FORGE_CLI_TIMEOUT_MS = 10_000;

/** Homebrew bins appended to the server's PATH.
 * ponytail: heuristic for GUI-launched servers whose PATH lacks Homebrew; upgrade path is a configured PATH. */
export function serverPath() {
  return `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;
}

/** The environment every forge CLI call runs with: the server's PATH plus Homebrew, so a GUI-launched server still finds gh and glab. */
export const forgeEnv = () => ({ ...process.env, PATH: serverPath() });

export const FORGE_SCRIPT_TIMEOUT_MS = 120_000;

export type Forge = "github" | "gitlab";

/** Pulls the forge target (and, when the reference names its own repo, the repo
 * to pass alongside it) out of a PR number, an owner/repo#123 reference, or a
 * PR/MR URL. An explicit URL also names its forge, so callers don't need to
 * re-derive it from a repo checkout that may not even be the right one. */
export function parsePullRequestRef(input: string): { target: string; repo: string | null; forge: Forge | null } {
  const githubUrl = input.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (githubUrl) return { target: githubUrl[3], repo: `${githubUrl[1]}/${githubUrl[2]}`, forge: "github" };
  const gitlabUrl = input.match(/\/([^/\s]+)\/([^/\s]+)\/-\/merge_requests\/(\d+)/);
  if (gitlabUrl) return { target: gitlabUrl[3], repo: `${gitlabUrl[1]}/${gitlabUrl[2]}`, forge: "gitlab" };
  const shortRef = input.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (shortRef) return { target: shortRef[2], repo: shortRef[1], forge: null };
  return { target: input.replace(/^#/, ""), repo: null, forge: null };
}

/** The forge targets a pull request reference could live on, with its number and repo. */
export async function pullRequestForges(pullRequest: string, cwd: string | null) {
  const { target, repo, forge } = parsePullRequestRef(pullRequest);
  let forges: Forge[] = forge ? [forge] : [];
  if (!forges.length) {
    const remote = cwd
      ? await execFileAsync("git", ["remote", "get-url", "origin"], { cwd, timeout: FORGE_CLI_TIMEOUT_MS, env: forgeEnv() })
          .then((result) => result.stdout.trim())
          .catch(() => "")
      : "";
    // A self-hosted forge under another name could be either; ask gh, then glab.
    forges = remote.includes("github") ? ["github"] : remote.includes("gitlab") ? ["gitlab"] : ["github", "gitlab"];
  }
  return { target, repo, forges };
}

/** Best-effort live head of a pull request: its branch, the commit the forge says
 * the branch is at right now, and the branch it targets. Any failure returns null
 * (callers either fall back or fail closed, as their contract says). */
export async function prHead(pullRequest: string, cwd: string | null): Promise<{ branch: string; sha: string; base: string } | null> {
  try {
    const { target, repo, forges } = await pullRequestForges(pullRequest, cwd);
    for (const candidate of forges) {
      const head = await (candidate === "github" ? githubHead : gitlabHead)(target, repo, cwd).catch(() => null);
      if (head) return head;
    }
    return null;
  } catch {
    return null;
  }
}

export const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export async function githubHead(target: string, repo: string | null, cwd: string | null) {
  const args = ["pr", "view", target, "--json", "headRefName,headRefOid,baseRefName", ...(repo ? ["--repo", repo] : [])];
  const { stdout } = await execFileAsync("gh", args, { cwd: cwd ?? undefined, timeout: FORGE_CLI_TIMEOUT_MS, env: forgeEnv() });
  const parsed = JSON.parse(stdout) as { headRefName?: string; headRefOid?: string; baseRefName?: string };
  return headOf(parsed.headRefName, parsed.headRefOid, parsed.baseRefName);
}

export async function gitlabHead(target: string, repo: string | null, cwd: string | null) {
  const args = ["mr", "view", target, "-F", "json", ...(repo ? ["--repo", repo] : [])];
  const { stdout } = await execFileAsync("glab", args, { cwd: cwd ?? undefined, timeout: FORGE_CLI_TIMEOUT_MS, env: forgeEnv() });
  const parsed = JSON.parse(stdout) as { source_branch?: string; sha?: string; diff_refs?: { head_sha?: string }; target_branch?: string };
  return headOf(parsed.source_branch, parsed.sha ?? parsed.diff_refs?.head_sha, parsed.target_branch);
}

export function headOf(branch?: string, sha?: string, base?: string) {
  const head = { branch: branch?.trim() ?? "", sha: sha?.trim().toLowerCase() ?? "", base: base?.trim() ?? "" };
  return head.branch && head.base && SHA_PATTERN.test(head.sha) ? head : null;
}

/** Best-effort: flips a draft pull request to ready for review with whichever forge
 * CLI hosts it. Never throws: the result says whether it worked, with the error text when not. */
export async function markPrReady(pullRequest: string, cwd: string | null): Promise<{ ready: boolean; error?: string }> {
  let error = "no forge CLI could mark it ready";
  try {
    const { target, repo, forges } = await pullRequestForges(pullRequest, cwd);
    for (const candidate of forges) {
      const [cli, args] = candidate === "github"
        ? ["gh", ["pr", "ready", target, ...(repo ? ["--repo", repo] : [])]]
        : ["glab", ["mr", "update", target, "--ready", "--yes", ...(repo ? ["--repo", repo] : [])]];
      try {
        await execFileAsync(cli as string, args as string[], { cwd: cwd ?? undefined, timeout: FORGE_CLI_TIMEOUT_MS, env: forgeEnv() });
        return { ready: true };
      } catch (failure) {
        error = clip(String((failure as { stderr?: unknown }).stderr || failure).trim(), 200);
      }
    }
  } catch (failure) {
    error = clip(String(failure), 200);
  }
  return { ready: false, error };
}

/** Whether a pull request is merged, with whichever forge CLI hosts it. Null when no forge CLI could say. */
export async function prMerged(pullRequest: string, cwd: string | null): Promise<boolean | null> {
  try {
    const { target, repo, forges } = await pullRequestForges(pullRequest, cwd);
    for (const candidate of forges) {
      const [cli, args] = candidate === "github"
        ? ["gh", ["pr", "view", target, "--json", "state", ...(repo ? ["--repo", repo] : [])]]
        : ["glab", ["mr", "view", target, "-F", "json", ...(repo ? ["--repo", repo] : [])]];
      try {
        const { stdout } = await execFileAsync(cli as string, args as string[], { cwd: cwd ?? undefined, timeout: FORGE_CLI_TIMEOUT_MS, env: forgeEnv() });
        return String((JSON.parse(stdout) as { state?: unknown }).state).toLowerCase() === "merged";
      } catch {
        // Try the next forge.
      }
    }
  } catch {
    // Unknown: the caller changes nothing.
  }
  return null;
}
