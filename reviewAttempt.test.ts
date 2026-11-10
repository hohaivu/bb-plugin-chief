import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rename, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READY, plan, planWave, readyIdle, report, reviewed, rowOf, setLive, tool } from "./test/testerHelpers";
import { APPROVE, HEAD_SHA, TEST_WAVE, approvePlan, disposeAll, execFileMock, reviewContextOf, setup, snapshotText, start, status, wave, withReviewerLine } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { acceptOwnership, dropDocsLines, dropSkippedNote } from "./test/docsOwnership";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  describe("Spec Writer role", () => {
    // ---- Review attempt: characterization on cf92d9c (tests first, before the review attempt module is extracted) ----
    // Contract: for each case below, the real chief_review handler gives the outcome saved in
    // test/fixtures/review-attempt-cf92d9c.txt: the reply or the refusal, the reviewer's spawn environment, prompt and
    // review-context.md, the reviewer's row identity, its review_targets rows, and any Chief alert. The real handlers run;
    // nothing is observed through a production seam. The forge is execFileMock (gh pr view); git passes through to the real
    // git only in the cases that read a temp repository on the primary host.
    // Normalization is by fixture identity, never first-seen order: each thread id becomes its fixture label (<W1>, <R2>,
    // <chief>, ...; an unlabeled id fails the run), each fixture sha its label (<HEAD_SHA>, <shaB>, <c1>, ... and <label:12>
    // for the 12-character form), the storage root <storage> and the temp repository <repo>. A swapped head or a swapped
    // review changes the bytes.
    // Regression: moving the review attempt changes a reply sentence, the order of two refusals, a brief or context line,
    // the identity a row or a target records, or which review chief_review reuses.
    // <review-attempt-oracle-begin>
    const reviewAttemptFixture = async () => {
      const blocks: string[] = [];
      const PR = "https://github.com/acme/shop/pull/8";
      const PR_A = "https://github.com/acme/shop/pull/11";
      const PR_B = "https://github.com/acme/shop/pull/12";
      const SHA_B = "b".repeat(40);
      const SHA_C = "c".repeat(40);
      const SHA_F = "f".repeat(40);
      const PRIMARY = { config: async () => ({ primaryHostId: "host_1" }), usageLimits: async () => ({}) };
      const REMOTE = { config: async () => ({ primaryHostId: "host_2" }), usageLimits: async () => ({}) };
      const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const realExec = (await import("node:util")).promisify(childProcess.execFile) as (file: string, args: string[], options: object) => Promise<{ stdout: string; stderr: string }>;
      // A temp repository: c0 -> c1 -> c2 on main, a diverged c3 off c0, and origin/main at c0 (there is no remote).
      let built: Promise<{ dir: string; dirs: string[]; c0: string; c1: string; c2: string; c3: string }> | undefined;
      const repo = () => built ??= (async () => {
        const dir = await mkdtemp(join(tmpdir(), "chief-repo-"));
        const git = async (...args: string[]) => (await realExec("git", ["-c", "user.name=oracle", "-c", "user.email=oracle@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir })).stdout.trim();
        const commit = async (files: Record<string, string>, message: string) => {
          for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
          await git("add", "-A");
          await git("commit", "-q", "-m", message);
          return git("rev-parse", "HEAD");
        };
        await git("init", "-q", "-b", "main");
        const c0 = await commit({
          "lib.ts": "export function discount(total: number) {\n  return total * 0.9;\n}\n\nexport function tax(total: number) {\n  return total * 0.2;\n}\n",
          "main.ts": "export function sum(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n",
        }, "c0");
        await git("update-ref", "refs/remotes/origin/main", c0);
        const c1 = await commit({ "main.ts": "export function sum(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n\nexport function total(items: number[]) {\n  return discount(sum(items));\n}\n" }, "c1");
        const c2 = await commit({ "main.ts": "export function sum(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n\nexport function total(items: number[]) {\n  return tax(discount(sum(items)));\n}\n" }, "c2");
        await git("checkout", "-q", "-b", "side", c0);
        const c3 = await commit({ "lib.ts": "export function discount(total: number) {\n  return total * 0.8;\n}\n" }, "c3");
        await git("checkout", "-q", "main");
        return { dir, dirs: [dir, await realpath(dir)], c0, c1, c2, c3 };
      })();

      const reviewerIdsOf = (state: any) => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer' ORDER BY rowid`).all() as { thread_id: string }[]).map((row) => row.thread_id);
      const run = async (name: string, body: (k: any) => Promise<void>, where: "none" | "remote" | "local" = "none") => {
        const local = where === "local" ? await repo() : null;
        const state = await setup(local ? { projectPath: local.dir, system: PRIMARY } : where === "remote" ? { projectPath: "/oracle/checkout", system: REMOTE } : {});
        const lines: string[] = [];
        const names = new Map<string, string>();
        const shas = new Map<string, string>([[HEAD_SHA, "HEAD_SHA"], [SHA_B, "shaB"], [SHA_C, "shaC"], [SHA_F, "shaF"]]);
        if (local) for (const key of ["c0", "c1", "c2", "c3"] as const) shas.set(local[key], key);
        const norm = (text: string) => {
          let out = text.replaceAll(state.storageRoot, "<storage>");
          for (const dir of local?.dirs ?? []) out = out.replaceAll(dir, "<repo>");
          // git's own stderr after the failed ancestry check varies by version; the prefix bytes stay.
          // The write error's own text comes from the fake host (its unstubbed files.remove); the sentence around it stays.
          out = out.replace(/after 3 attempts: .*?\. The reviewer will/, "after 3 attempts: <error>. The reviewer will");
          out = out.replace(/(--is-ancestor [0-9a-f]{40} [0-9a-f]{40}) fatal:[^)]*/g, "$1 <git-error>");
          out = out.replace(/thr_\d+/g, (id) => {
            const label = names.get(id);
            if (!label) throw new Error(`unlabeled thread ${id}`);
            return `<${label}>`;
          });
          for (const [sha, label] of shas) out = out.replaceAll(sha, `<${label}>`).replaceAll(sha.slice(0, 12), `<${label}:12>`);
          return out;
        };
        const emit = (label: string, text: string) => lines.push(`--- ${label}\n${norm(text)}`);
        // gh pr view <number>: per-pull-request heads, default HEAD_SHA on feature/x; `unreadable` makes gh fail.
        const forge = { sha: HEAD_SHA, heads: {} as Record<string, { branch: string; sha: string }>, unreadable: new Set<string>() };
        execFileMock.mockReset();
        // Not async: the impact slice reads `.child` off the real git call's promise to kill it on its deadline.
        execFileMock.mockImplementation((file: string, args: string[], options: object) => {
          if (file === "git" && local) return realExec(file, args, options);
          return (async () => {
            if (file === "gh" && args[0] === "pr" && args[1] === "view") {
              if (forge.unreadable.has(args[2]!)) throw new Error("gh: forge unreachable");
              const head = forge.heads[args[2]!] ?? { branch: "feature/x", sha: forge.sha };
              return { stdout: JSON.stringify({ headRefName: head.branch, headRefOid: head.sha, baseRefName: "main" }), stderr: "" };
            }
            throw new Error(`unexpected CLI ${file}`);
          })();
        });
        const reviewerIds = () => reviewerIdsOf(state);
        const newestWorker = () => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        const command = (text: string, exitCode: number) => ({ type: "item/completed", seq: 1, data: { item: { type: "commandExecution", command: text, exitCode, status: exitCode ? "failed" : "completed" } } });
        const k = {
          state, forge, emit, local, command,
          label: (id: string, label: string) => { names.set(id, label); return id; },
          chief: async () => { const id = (await start(state)).threadId; names.set(id, "chief"); return id; },
          /** Chief plus a planner holding `waves`, approved when it has more than one implementation wave; test waves in `waived` are skipped. */
          mk: async (waves: object[], waived: number[] = []) => {
            const chief = await k.chief();
            const planner = (await plan(state, chief, waves)).threadId;
            names.set(planner, "P");
            if (waves.filter((entry: any) => !entry.test && !entry.design).length > 1) await approvePlan(state, chief, planner);
            for (const wave of waived) await tool(state, "chief_skip_tests", { planThreadId: planner, wave, reason: "oracle reason" }, chief);
            return { chief, planner };
          },
          /** Delegates a worker (unplanned unless `extra` carries a plan or replaces), reports ready and goes idle unless `ready` is false. */
          worker: async (label: string, chief: string, extra: object = {}, ready = true) => {
            await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", ...("replaces" in extra || "planThreadId" in extra ? {} : { unplannedReason: "Bounded oracle fixture" }), ...extra }, chief);
            const id = k.label(newestWorker(), label);
            if (ready) await readyIdle(state, id);
            return id;
          },
          wave: (label: string, c: any, wave: number, extra: object = {}) => k.worker(label, c.chief, { planThreadId: c.planner, wave, ...extra }),
          /** Two independent branches (waves 1 and 3), tests waived: one plan review covers both. */
          branches: () => k.mk([planWave(1), TEST_WAVE(2), planWave(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [2, 4]),
          /** A review of `id` that Chief does not look at: the reviewer reports `verdict` and goes idle with its row open. */
          reviewed: async (chief: string, id: string, label: string, verdict: "approve" | "request_changes" = "request_changes") => {
            const before = reviewerIds().length;
            await tool(state, "chief_review", { workerThreadId: id }, chief);
            const reviewer = k.label(reviewerIds()[before]!, label);
            await report(state, reviewer, {
              state: "ready", result: "The discount is applied twice", verdict,
              findings: verdict === "approve" ? [] : [{ file: "totals.ts", line: 3, severity: "blocking", message: "The discount is applied twice", fix: "Apply it once" }],
            });
            return reviewer;
          },
          review: (chief: string, params: object) => () => tool(state, "chief_review", params, chief),
          /** Runs a call and records what it did; `reviewers` labels the reviewers it launched, in order. `fake` runs it on fake timers for the 60 s busy-worker wait. */
          attempt: async (label: string, call: () => Promise<unknown>, options: { reviewers?: string[]; fake?: boolean } = {}) => {
            const before = { spawned: state.spawned.length, sent: state.sent.length, reviewers: reviewerIds().length };
            const settle = call().then((text) => `reply: ${text}`, (error: Error) => `refused: ${error.message}`);
            let out: string;
            if (options.fake) {
              vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
              // Real file and git calls take macrotask turns the fake clock does not wait for: step it until the call settles.
              try {
                let done = false;
                void settle.then(() => { done = true; });
                for (let step = 0; !done; step++) {
                  if (step > 200) throw new Error("the call never settled on the fake clock");
                  await vi.advanceTimersByTimeAsync(1_000);
                  await new Promise((resolve) => setImmediate(resolve));
                }
                out = await settle;
              } finally { vi.useRealTimers(); }
            } else out = await settle;
            const spawns = state.spawned.slice(before.spawned);
            const fresh = reviewerIds().slice(before.reviewers);
            fresh.forEach((id, index) => k.label(id, options.reviewers?.[index] ?? `unlabeled reviewer ${index}`));
            const parts = [out, `launched: ${spawns.length}`];
            for (const [index, id] of fresh.entries()) {
              const spawn = spawns[index];
              const environment = spawn.environment;
              const row = rowOf(state, id);
              const targets = state.db.prepare(`SELECT worker_thread_id, report_seq, head_sha, pr_url, branch FROM review_targets WHERE reviewer_thread_id=? ORDER BY rowid`).all(id) as any[];
              const context = await reviewContextOf(state, id).catch(() => null);
              parts.push(
                `reviewer ${id}`,
                `spawn environment: type=${environment.type} hostId=${environment.hostId ?? "-"} baseBranch=${environment.workspace?.baseBranch?.name ?? "-"} environmentId=${environment.environmentId ?? "-"}`,
                `row: worker_thread_id=${row.worker_thread_id} reviewed_report_seq=${row.reviewed_report_seq} reviewed_head_sha=${row.reviewed_head_sha} branch=${row.branch} pr_url=${row.pr_url} reject_streak=${row.reject_streak}`,
                ...targets.map((target) => `target: worker_thread_id=${target.worker_thread_id} report_seq=${target.report_seq} head_sha=${target.head_sha} pr_url=${target.pr_url} branch=${target.branch}`),
                "prompt:", spawn.prompt,
                "review-context.md:", context ?? "(none)",
              );
            }
            for (const text of state.sent.slice(before.sent).map((sent) => `to ${sent.threadId}: ${sent.input[0].text}`)) parts.push("chief alert:", text);
            parts.push(`reviewers: ${reviewerIds().map((id) => `${id}=${rowOf(state, id).state}/streak ${rowOf(state, id).reject_streak}`).join(", ") || "none"}`);
            emit(label, parts.join("\n"));
          },
        };
        try { await body(k); } catch (error) { (error as Error).message = `[${name}] ${(error as Error).message}`; throw error; }
        blocks.push(`=== ${name} ===\n${lines.join("\n")}\n`);
      };

      // 1. A single worker: where the reviewer runs and what the reply says about the head.
      await run("single worker, no pull request", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief);
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      });
      await run("single worker, pull request, head pinned", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      });
      await run("single worker, pull request, head unreadable", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        k.forge.unreadable.add("8");
        await k.attempt("review, gh fails", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      });

      // 2. Re-review scope.
      await run("re-review: equal head", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.reviewed(chief, w1, "R1");
        await k.attempt("second review at the same head", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });
      await run("re-review: different head, no project path", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.reviewed(chief, w1, "R1");
        k.forge.sha = SHA_B;
        await k.attempt("second review at a new head", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });
      await run("re-review: different head, checkout on a remote host", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.reviewed(chief, w1, "R1");
        k.forge.sha = SHA_B;
        await k.attempt("second review at a new head", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      }, "remote");
      await run("re-review: previous verdict, no pull request", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief);
        await k.reviewed(chief, w1, "R1");
        await k.attempt("second review of a worker with no pull request", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });
      await run("re-review: previous verdict recorded no head", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        k.forge.unreadable.add("8");
        await k.reviewed(chief, w1, "R1");
        k.forge.unreadable.delete("8");
        await k.attempt("second review once the forge answers", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });

      // 3. Plan review (two or more targets).
      await run("plan review: branches with no pull request", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1, { branch: "feature/a" });
        await k.wave("W2", c, 3, { branch: "feature/b" });
        await k.attempt("review from branch 1", k.review(c.chief, { workerThreadId: a }), { reviewers: ["R1"] });
      });
      await run("plan review: a target with no head and no branch", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1, { branch: "feature/a", prUrl: PR_A });
        await k.wave("W2", c, 3);
        await k.attempt("review refused", k.review(c.chief, { workerThreadId: a }));
      });
      await run("plan review: distinct pinned heads and report sequences", async (k) => {
        const c = await k.branches();
        k.forge.heads["11"] = { branch: "feature/a", sha: SHA_B };
        k.forge.heads["12"] = { branch: "feature/b", sha: SHA_C };
        const a = await k.wave("W1", c, 1, { branch: "feature/a", prUrl: PR_A });
        await readyIdle(k.state, a, `${READY} again`);
        const b = await k.wave("W2", c, 3, { branch: "feature/b", prUrl: PR_B });
        await k.attempt("review from branch 1", k.review(c.chief, { workerThreadId: a }), { reviewers: ["R1"] });
        const reviewer = reviewerIdsOf(k.state)[0]!;
        // Outside the normalization: each row binds its own worker's report and head, and the reviewer row the initiating worker's.
        expect(rowOf(k.state, a).report_seq).toBe(2);
        expect(rowOf(k.state, b).report_seq).toBe(1);
        expect(k.state.db.prepare(`SELECT worker_thread_id, report_seq, head_sha FROM review_targets WHERE reviewer_thread_id=? ORDER BY rowid`).all(reviewer))
          .toEqual([{ worker_thread_id: a, report_seq: 2, head_sha: SHA_B }, { worker_thread_id: b, report_seq: 1, head_sha: SHA_C }]);
        expect(rowOf(k.state, reviewer)).toMatchObject({ worker_thread_id: a, reviewed_report_seq: 2, reviewed_head_sha: SHA_B });
      });
      await run("plan review: one pull request head unreadable, its branch present", async (k) => {
        const c = await k.branches();
        k.forge.heads["11"] = { branch: "feature/a", sha: SHA_B };
        k.forge.unreadable.add("12");
        const a = await k.wave("W1", c, 1, { branch: "feature/a", prUrl: PR_A });
        await readyIdle(k.state, a, `${READY} again`);
        const b = await k.wave("W2", c, 3, { branch: "feature/b", prUrl: PR_B });
        await k.attempt("review from branch 1", k.review(c.chief, { workerThreadId: a }), { reviewers: ["R1"] });
        const reviewer = reviewerIdsOf(k.state)[0]!;
        expect(k.state.db.prepare(`SELECT worker_thread_id, report_seq, head_sha, branch FROM review_targets WHERE reviewer_thread_id=? ORDER BY rowid`).all(reviewer))
          .toEqual([{ worker_thread_id: a, report_seq: 2, head_sha: SHA_B, branch: "feature/a" }, { worker_thread_id: b, report_seq: 1, head_sha: null, branch: "feature/b" }]);
        expect(rowOf(k.state, reviewer)).toMatchObject({ worker_thread_id: a, reviewed_report_seq: 2, reviewed_head_sha: SHA_B });
      });

      // 4. The impact slice.
      await run("impact slice: skipped with no project path", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { branch: "feature/x" });
        await k.attempt("review of an unpinned branch", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      });
      await run("impact slice: real entries, one target", async (k) => {
        const chief = await k.chief();
        k.forge.heads["8"] = { branch: "feature/x", sha: k.local.c1 };
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      }, "local");
      await run("impact slice: real entries, two targets", async (k) => {
        const c = await k.branches();
        k.forge.heads["11"] = { branch: "feature/a", sha: k.local.c1 };
        k.forge.heads["12"] = { branch: "feature/b", sha: k.local.c2 };
        const a = await k.wave("W1", c, 1, { branch: "feature/a", prUrl: PR_A });
        await k.wave("W2", c, 3, { branch: "feature/b", prUrl: PR_B });
        await k.attempt("plan review", k.review(c.chief, { workerThreadId: a }), { reviewers: ["R1"] });
      }, "local");
      await run("impact slice: unpinned, branch not found locally", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { branch: "feature/none" });
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      }, "local");
      await run("impact slice: unpinned, origin/HEAD not set", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { branch: "side" });
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      }, "local");

      // 5. A branch or pull request no worker owns.
      await run("branch review: by branch", async (k) => {
        const chief = await k.chief();
        await k.attempt("review a branch", k.review(chief, { branch: "feature/z" }), { reviewers: ["R1"] });
      });
      await run("branch review: by pull request, the branch from gh", async (k) => {
        const chief = await k.chief();
        await k.attempt("review a pull request", k.review(chief, { pullRequest: PR }), { reviewers: ["R1"] });
      });
      await run("branch review: by pull request, gh fails", async (k) => {
        const chief = await k.chief();
        k.forge.unreadable.add("8");
        await k.attempt("review a pull request, the raw reference is the branch", k.review(chief, { pullRequest: PR }), { reviewers: ["R1"] });
      });
      await run("branch review: a branch a live worker owns", async (k) => {
        const chief = await k.chief();
        await k.worker("W1", chief, { branch: "feature/owned" });
        await k.attempt("review the owned branch", k.review(chief, { branch: "feature/owned" }));
      });
      await run("branch review: a second call", async (k) => {
        const chief = await k.chief();
        await k.attempt("first call", k.review(chief, { branch: "feature/z" }), { reviewers: ["R1"] });
        await k.attempt("second call", k.review(chief, { branch: "feature/z" }));
      });

      // 6. Concurrency, the context write, supersede and streak, earlier workers.
      await run("concurrency: two chief_review calls on one worker", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.attempt("two concurrent calls", () => Promise.all([k.review(chief, { workerThreadId: w1 })(), k.review(chief, { workerThreadId: w1 })()]).then((replies) => replies.join("\n")), { reviewers: ["R1"] });
      });
      await run("review-context.md write failure", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief);
        // A directory where the file goes makes every atomic rename fail: three attempts (1 s, 2 s backoff), then the alert.
        await mkdir(join(k.state.storageRoot, `thr_${k.state.spawned.length + 1}`, "review-context.md"), { recursive: true });
        await k.attempt("review, the context write fails", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"], fake: true });
      });
      await run("supersede and streak", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.reviewed(chief, w1, "R1");
        await k.attempt("review after R1 rejected", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });
      await run("earlier workers: implementer then tester", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, {}, false);
        k.state.seedEvents(w1, [k.command("npm run lint", 0), k.command("npm run build", 1)]);
        await readyIdle(k.state, w1);
        const w2 = await k.worker("W2", chief, { replaces: w1, kind: "tester" }, false);
        k.state.seedEvents(w2, [k.command("npm test", 0)]);
        await readyIdle(k.state, w2);
        await k.attempt("review the tester", k.review(chief, { workerThreadId: w2 }), { reviewers: ["R1"] });
      });

      // 7. Refusals.
      await run("refusal: a busy worker", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, {}, false);
        setLive(k.state, w1, "active");
        await k.attempt("review a worker that has not reported and is active", k.review(chief, { workerThreadId: w1 }));
      });
      for (const field of ["archivedAt", "deletedAt"]) {
        await run(`refusal: a worker with ${field} set`, async (k) => {
          const chief = await k.chief();
          const w1 = await k.worker("W1", chief);
          k.state.live.set(w1, { ...k.state.live.get(w1)!, [field]: 1_700_000_000_000 } as any);
          await k.attempt(`review a worker with ${field}`, k.review(chief, { workerThreadId: w1 }));
        });
      }
      await run("refusal: an id that is not a worker", async (k) => {
        const chief = await k.chief();
        await k.attempt("review Chief itself", k.review(chief, { workerThreadId: chief }));
      });
      await run("refusal: a design wave", async (k) => {
        const c = await k.mk([planWave(1, { design: true }), planWave(2), TEST_WAVE(3)], [3]);
        const designer = await k.wave("W1", c, 1);
        await k.attempt("review a design wave", k.review(c.chief, { workerThreadId: designer }));
      });
      await run("refusal: a superseded worker", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1, { branch: "feature/a" });
        await k.wave("W2", c, 1, { replaces: a });
        await k.attempt("review the superseded worker", k.review(c.chief, { workerThreadId: a }));
      });

      // 8. The advisor's adversarial cases.
      // 8.1 Chain order against creation order: a replaced unplanned chain (W1, W2 replaces W1), R2 on W2, then a newer R1 on W1.
      const chain = async (k: any) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief);
        const w2 = await k.worker("W2", chief, { replaces: w1 });
        await k.attempt("review of W2", k.review(chief, { workerThreadId: w2 }), { reviewers: ["R2"] });
        await k.attempt("review of the replaced W1", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
        const [r1, r2] = reviewerIdsOf(k.state).slice(-1).concat(reviewerIdsOf(k.state).slice(-2, -1));
        // Pin R1 as the newer review in SQL, so the order never depends on the clock.
        k.state.db.prepare(`UPDATE managed_threads SET created_at=(SELECT created_at FROM managed_threads WHERE thread_id=?)+1000 WHERE thread_id=?`).run(r2, r1);
        return { chief, w2, r1: r1!, r2: r2! };
      };
      await run("chain order: the newer review is busy", async (k) => {
        const { chief, w2 } = await chain(k);
        await k.attempt("chief_review on W2 reuses the newest busy review", k.review(chief, { workerThreadId: w2 }));
        await k.attempt("chief_complete with skipReview on W2 names the first busy review down its own chain", () => tool(k.state, "chief_complete", { threadId: w2, skipReview: "chain order", testsSkipped: "chain order" }, chief));
      });
      await run("chain order: the newer review is idle, the older one busy", async (k) => {
        const { chief, w2, r1 } = await chain(k);
        await report(k.state, r1, { state: "ready", result: "Looks right", ...APPROVE });
        await k.attempt("chief_review on W2 reuses the busy review, not the newer idle one", k.review(chief, { workerThreadId: w2 }));
      });
      // 8.2 Ancestry against a real local repository (c0 -> c1 -> c2, a diverged c3, and a sha the repository does not have).
      for (const [label, previous] of [["an ancestor", "c1"], ["a diverged commit", "c3"], ["a missing commit", "missing"]] as const) {
        await run(`real ancestry: the previous head is ${label}`, async (k) => {
          const chief = await k.chief();
          const w1 = await k.worker("W1", chief, { prUrl: PR });
          k.forge.sha = previous === "missing" ? SHA_F : k.local[previous];
          await k.reviewed(chief, w1, "R1");
          k.forge.sha = k.local.c2;
          await k.attempt("second review pinned at c2", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
        }, "local");
      }
      // 8.4 No reusable environment, and the order of the refusals.
      await run("no reusable environment: a single target with a pull request, gh fails", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        k.forge.unreadable.add("8");
        k.state.live.set(w1, { ...k.state.live.get(w1)!, environmentId: null } as any);
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }));
      });
      await run("refusal order: no reusable environment before a target with no head and no branch", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1);
        await k.wave("W2", c, 3);
        k.state.live.set(a, { ...k.state.live.get(a)!, environmentId: null } as any);
        await k.attempt("plan review", k.review(c.chief, { workerThreadId: a }));
      });
      await run("refusal order: a busy target before a target with no head and no branch", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1, { branch: "feature/a" });
        await k.wave("W2", c, 3);
        setLive(k.state, a, "active");
        await k.attempt("plan review", k.review(c.chief, { workerThreadId: a }), { fake: true });
      });
      return blocks.join("\n");
    };
    // <review-attempt-oracle-end>

    // Plan chains changed one thing of the base snapshot: a pinned reviewer's fetch line now also checks the pinned commit out detached (`git fetch origin <branch> && git checkout --detach <sha>`).
    test("review attempt oracle", async () => {
      const head = await reviewAttemptFixture();
      // The make-native reviewer line follows each of the 31 reviewer prompts' "Classify the change" line; the rest is base's bytes.
      expect(dropDocsLines(dropSkippedNote(acceptOwnership(head)))).toBe(dropDocsLines(withReviewerLine(await snapshotText("review-attempt-cf92d9c.txt"), 31)));
    }, 300_000);

    // A host lookup that never answers no longer holds chief_review (#177): the ancestry check's 20 s deadline covers the
    // lookup, then the impact slice's 30 s deadline covers its own lookup, and the review launches on the whole pull request
    // with both skip reasons. Regression: dropping either deadline holds the call past 50 s (no reviewer, call unsettled).
    test("review attempt: a pending host lookup skips ancestry at 20 s and the slice at 50 s, and chief_review launches", async () => {
      const PR = "https://github.com/acme/shop/pull/8";
      let held = false;
      let lookups = 0;
      const answer = { primaryHostId: "host_1" };
      const state = await setup({
        projectPath: "/oracle/checkout",
        system: { usageLimits: async () => ({}), config: () => held ? new Promise(() => { lookups += 1; }) : Promise.resolve(answer) },
      });
      let sha = HEAD_SHA;
      execFileMock.mockImplementation(async (file: string, args: string[]) => {
        if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: sha, baseRefName: "main" }), stderr: "" };
        throw new Error(`unexpected CLI ${file}`);
      });
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture", prUrl: PR }, chief);
      const w1 = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, w1);
      await tool(state, "chief_review", { workerThreadId: w1 }, chief);
      const reviewer = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer'`).get() as any).thread_id as string;
      await report(state, reviewer, { state: "ready", result: "Looks right", ...APPROVE });

      // The second review reaches the ancestry check (the previous head differs from the new one); every host lookup now hangs.
      sha = "b".repeat(40);
      held = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        let settled = false;
        const call = tool(state, "chief_review", { workerThreadId: w1 }, chief).finally(() => { settled = true; });
        const step = async (seconds: number) => {
          for (let i = 0; i < seconds; i++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await new Promise((resolve) => setImmediate(resolve));
          }
        };
        const reviewers = () => state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='reviewer'`).get();
        const nextReviewer = `thr_${state.spawned.length + 1}`;
        await step(19); // inside the ancestry deadline: only the ancestry lookup has started
        expect({ lookups, settled, spawned: state.spawned.length, reviewers: reviewers() }).toEqual({ lookups: 1, settled: false, spawned: 3, reviewers: { n: 1 } });
        await step(2); // the ancestry deadline passed at 20 s: the impact slice's own lookup has started
        expect({ lookups, settled, spawned: state.spawned.length, reviewers: reviewers() }).toEqual({ lookups: 2, settled: false, spawned: 3, reviewers: { n: 1 } });
        await step(28); // inside the slice's 30 s deadline (49 s in total): still no reviewer
        expect({ lookups, settled, spawned: state.spawned.length, reviewers: reviewers() }).toEqual({ lookups: 2, settled: false, spawned: 3, reviewers: { n: 1 } });
        await step(2); // the slice's deadline passed at 50 s: the review launches with no host answer
        expect({ lookups, spawned: state.spawned.length, reviewers: reviewers() }).toEqual({ lookups: 2, spawned: 4, reviewers: { n: 2 } });
        const reply = await call;
        expect(reply).toContain(`Impact slice skipped: ${w1}: deadline (30 s) passed.`);
        expect(reply).toContain(`Review scope: ${w1}: whole pull request (deadline (20 s) passed).`);
        const context = await reviewContextOf(state, nextReviewer);
        expect(context).toContain("## The previous review (");
        expect(context).toContain("Skipped: deadline (30 s) passed.");
      } finally { vi.useRealTimers(); }
    }, 120_000);

    // Handler contract: chief_review is Chief-only. The review attempt module no longer guards its caller, so the real
    // handler's requireChiefCaller is the only refusal. Regression: dropping or moving that guard lets a worker (or an
    // unregistered thread) start a reviewer.
    test("review attempt: chief_review is refused for a managed worker and an unregistered caller, with no reviewer started", async () => {
      const state = await setup();
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture" }, chief);
      const w1 = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, w1);
      const spawnedBefore = state.spawned.length;
      const asCaller = (threadId: string) => state.harness.behavior.callAgentTool("chief_review", { workerThreadId: w1 }, { threadId, projectId: "proj_1" });
      await expect(asCaller(w1)).rejects.toThrow("chief_review is for the active Chief only: a managed worker reports ready with chief_report, and Chief starts the review.");
      await expect(asCaller("thr_unregistered")).rejects.toThrow("chief_review is for the active Chief only: ask the active Chief to start it.");
      expect(state.spawned).toHaveLength(spawnedBefore);
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='reviewer'`).get()).toEqual({ n: 0 });
    });
  });
});
