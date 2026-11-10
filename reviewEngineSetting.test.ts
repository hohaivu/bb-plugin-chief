import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PR_AGENT_DIR } from "./prAgent";
import { readyIdle, report, tool } from "./test/testerHelpers";
import { disposeAll, execFileMock, setup, start } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  // Contracts (review engine): the stored reviewEngine / prAgentDir settings are read when the review starts and reach the
  // launched prompt and the reviewer's storage; an unset or unrecognised value is the base reviewer behaviour.
  describe("reviewEngine setting reaches a started review", () => {
    const PR = "https://github.com/acme/shop/pull/8";
    const SHA = "1".repeat(40);
    /** The project's reviewer runs on host_1 and every thread's storage (the worker's, the reviewer's) is on host_storage, so the engine files must
     * land on host_1's data dir. `reviewerHost: "unknown"` makes host_1's data dir unreadable. */
    async function review(settings: Record<string, unknown>, { reviewerHost = "known" }: { reviewerHost?: "known" | "unknown" } = {}) {
      const state = await setup({ projectPath: "/oracle/checkout", system: { usageLimits: async () => ({}), config: async () => ({ primaryHostId: "host_1" }) } });
      const reviewerData = join(state.storageRoot, "reviewer-host-data");
      const writes: { hostId?: string; path: string }[] = [];
      state.harness.sdk.stub("hosts.get", async ({ hostId }: { hostId: string }) => {
        if (hostId !== "host_1") return { id: hostId, threadStorageRootPath: join(state.storageRoot, "thread-storage") };
        if (reviewerHost === "unknown") throw new Error("host_1 is offline");
        return { id: hostId, threadStorageRootPath: join(reviewerData, "thread-storage") };
      });
      state.harness.sdk.stub("files.write", async ({ hostId, path, content }: { hostId?: string; path: string; content: string }) => {
        writes.push({ hostId, path: path.replace(/\.tmp-[0-9a-f-]+$/, "") }); // atomicWrite lands the file under a temp name first
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        return {};
      });
      execFileMock.mockImplementation(async (file: string, args: string[]) => {
        if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: SHA, baseRefName: "main" }), stderr: "" };
        throw new Error(`unexpected CLI ${file}`);
      });
      await state.harness.behavior.setSettings(settings);
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture", prUrl: PR }, chief);
      const worker = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, worker);
      await tool(state, "chief_review", { workerThreadId: worker }, chief);
      const reviewer = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer'`).get() as any).thread_id as string;
      // review-context.md is in the reviewer's storage; the engine files are in Chief's data folder for the worker on the reviewer's host, keyed by its
      // report and a fresh attempt id.
      const reportFolder = join(reviewerData, "chief", "proj_1", worker, "review-1");
      const attempts = await readdir(reportFolder).catch(() => [] as string[]);
      const engineDir = attempts.length === 1 ? join(reportFolder, attempts[0]!) : null;
      const file = (name: string) => readFile(join(name === "review-context.md" ? join(state.storageRoot, reviewer) : engineDir ?? join(reportFolder, "none"), name), "utf8").catch(() => null);
      return { prompt: String(state.spawned.at(-1).prompt), file, engineDir, attempts, writes, worker, state };
    }

    test("the two settings default to reviewer and PR_AGENT_DIR", async () => {
      const { state } = await review({});
      const descriptors = (state.harness.registrations.settingsDescriptors as any);
      expect(descriptors.reviewEngine).toMatchObject({ type: "select", options: ["reviewer", "pr-agent", "both"], default: "reviewer" });
      expect(descriptors.prAgentDir).toMatchObject({ type: "string", default: PR_AGENT_DIR });
    });

    // Contract: the settings page offers exactly the values already stored (reviewEngine reviewer|pr-agent|both, tracker none|bb-tasks), so no stored
    // value needs a migration; Tracker projects stays a string setting (same stored format) edited as a multiline field, one mapping per line.
    test("the tracker settings keep their stored formats: tracker is a select, trackerProjects a multiline string", async () => {
      const { state } = await review({});
      const descriptors = (state.harness.registrations.settingsDescriptors as any);
      expect(descriptors.tracker).toMatchObject({ type: "select", options: ["none", "bb-tasks"], default: "none" });
      expect(descriptors.trackerProjects).toMatchObject({ type: "string", experimental_multiline: true, default: "" });
    });

    // An unrecognised or empty reviewEngine can no longer be stored (the select rejects it); reviewEngine() in prAgent.test.ts still owns that fallback.
    test.each([["no stored value", {}]])("%s: reviewer mode, no section, no engine file", async (_name, settings) => {
      const { prompt, file } = await review(settings);
      expect(prompt).not.toContain("## Review engine");
      expect(await file("pr-agent-review.sh")).toBeNull();
      expect(await file("review-helper.md")).toBeNull();
      expect(await file("review-context.md")).not.toBeNull();
    });

    test("pr-agent: the section names the pinned pull request, the wrapper is written with the default directory", async () => {
      const { prompt, file, engineDir } = await review({ reviewEngine: "pr-agent" });
      expect(prompt).toContain("## Review engine: pr-agent");
      expect(prompt).toContain(`${PR} pinned to ${SHA} → pr-agent`);
      expect(engineDir).not.toBeNull();
      expect(prompt).toContain(`bash "${engineDir}/pr-agent-review.sh" ${PR} ${SHA}`);
      expect(prompt).not.toContain("$BB_THREAD_STORAGE/pr-agent-review.sh");
      expect(await file("pr-agent-review.sh")).toContain(PR_AGENT_DIR);
      expect(await file("review-helper.md")).toBeNull();
    });

    test("both: the configured directory reaches the wrapper and the helper prompt is written without the section", async () => {
      const { prompt, file, engineDir } = await review({ reviewEngine: "both", prAgentDir: "/opt/custom-pr-agent" });
      expect(prompt).toContain("## Review engine: both");
      expect(engineDir).not.toBeNull();
      expect(prompt).toContain(`--prompt-file "${engineDir}/review-helper.md"`);
      expect(await file("pr-agent-review.sh")).toContain("/opt/custom-pr-agent");
      expect(await file("pr-agent-review.sh")).not.toContain(PR_AGENT_DIR);
      const helper = (await file("review-helper.md"))!;
      expect(helper).toContain("## review-context.md");
      expect(helper).not.toContain("## Review engine");
    });

    // Contract (docs/specs/review-engine.md, Engine folder): the engine files are written on the host the reviewer runs on, under a fresh attempt id;
    // the reviewer's storage keeps only review-context.md. Regression: writing on the worker's thread-storage host leaves host_1 without the files.
    test("the engine files are written on the reviewer's host, not on the host of the worker's storage", async () => {
      const { prompt, engineDir, attempts, writes, worker, state } = await review({ reviewEngine: "both" });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatch(/^[0-9a-f]{8}$/);
      const engineWrites = writes.filter(({ path }) => path.includes("review-1"));
      expect(engineWrites.map(({ hostId, path }) => [hostId, path])).toEqual([
        ["host_1", join(engineDir!, "pr-agent-review.sh")],
        ["host_1", join(engineDir!, "review-helper.md")],
      ]);
      expect(writes.filter(({ path }) => path.endsWith("review-context.md")).map(({ hostId }) => hostId)).toEqual(["host_storage"]);
      expect(prompt).toContain(`bash "${engineDir}/pr-agent-review.sh"`);
      // The worker's own host (host_storage, whose data dir is the storage root) holds no engine folder.
      expect(await readdir(join(state.storageRoot, "chief", "proj_1", worker, "review-1")).catch(() => [])).toEqual([]);
    });

    // Contract (Flow 5): a wrapper that cannot be written leaves the prompt without an engine section. A reviewer host whose data dir cannot be read is
    // such a failure: the files are not written on another host. Regression: falling back to the worker's storage renders paths the reviewer's host lacks.
    test.each(["pr-agent", "both"])("%s: a reviewer host whose data dir is unknown gets a direct review: no section, no engine file anywhere, one alert", async (mode) => {
      const { prompt, attempts, writes, state } = await review({ reviewEngine: mode }, { reviewerHost: "unknown" });
      expect(prompt).not.toContain("## Review engine");
      expect(prompt).not.toContain("pr-agent-review.sh");
      expect(attempts).toEqual([]);
      expect(writes.filter(({ path }) => path.includes("pr-agent-review") || path.includes("review-helper"))).toEqual([]);
      expect(writes.filter(({ path }) => path.endsWith("review-context.md"))).toHaveLength(1);
      expect(state.sent.map((message) => String(message.input?.[0]?.text)).filter((text) => text.includes("pr-agent-review.sh"))).toHaveLength(1);
    }, 15_000);
  });
});
