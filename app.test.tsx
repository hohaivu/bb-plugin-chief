// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract, TodoItem } from "./server";

const app = await loadPluginApp(() => import("./app"));
const unmounts: Array<() => void> = [];
const emptyStatus = { sectionId: null, threads: [] };

afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
});

test("creates a fresh Chief from the project-aware New Thread screen", async () => {
  expect(app.navPanels).toHaveLength(0);
  expect(app.homepageSections).toHaveLength(1);
  expect(app.homepageSections[0]).toMatchObject({ id: "start-chief", title: "Chief" });

  const rendered = renderSlot<{ projectId: string | null }, typeof rpcContract>(
    app.homepageSections[0]!,
    { projectId: "proj_2" },
    {
      rpc: {
        status: () => emptyStatus,
        start: () => ({ threadId: "thr_existing", created: false }),
        create: ({ projectId }) => ({ threadId: `thr_${projectId}_new`, created: true }),
      },
    },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  expect(rendered.container.firstElementChild?.className).toContain("rounded-lg border border-border bg-card");
  const startButton = rendered.getByRole("button", { name: "Start Chief" });
  expect(startButton.className).toContain("h-7");
  expect(startButton.className).toContain("border-input");
  expect(startButton.className).toContain("text-xs");
  expect(rendered.queryByText("Start a Chief")).toBeNull();

  fireEvent.click(startButton);

  await vi.waitFor(() =>
    expect(rendered.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_proj_2_new",
    }),
  );
  expect(rendered.rpcCalls).toEqual([
    { method: "create", input: { projectId: "proj_2" } },
  ]);
});

test("falls back to the default Chief project on the projectless root screen", async () => {
  const rendered = renderSlot<{ projectId: string | null }, typeof rpcContract>(
    app.homepageSections[0]!,
    { projectId: null },
    {
      settings: { chiefProject: "proj_default" },
      rpc: {
        status: () => emptyStatus,
        start: () => ({ threadId: "thr_existing", created: false }),
        create: ({ projectId }) => ({ threadId: `thr_${projectId}_new`, created: true }),
      },
    },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  // The copy must admit which project it is about to use, since the screen shows none.
  expect(rendered.getByText(/default Chief project/)).toBeTruthy();
  fireEvent.click(rendered.getByRole("button", { name: "Start Chief" }));

  await vi.waitFor(() =>
    expect(rendered.rpcCalls).toEqual([{ method: "create", input: { projectId: "proj_default" } }]),
  );
});

test("asks for a project when the root screen has no default", async () => {
  const rendered = renderSlot<{ projectId: string | null }, typeof rpcContract>(
    app.homepageSections[0]!,
    { projectId: null },
    {
      rpc: {
        status: () => emptyStatus,
        start: () => ({ threadId: "thr_existing", created: false }),
        create: () => ({ threadId: "thr_new", created: true }),
      },
    },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  expect(rendered.getByRole("button", { name: "Start Chief" })).toHaveProperty("disabled", true);
  expect(rendered.getByText(/set a default Chief project in Settings/)).toBeTruthy();
});

test("marks Chief conversations with a compact header badge", async () => {
  expect(app.threadHeaderActions).toHaveLength(1);
  const chief = {
    threadId: "thr_chief",
    role: "chief" as const,
    projectId: "proj_1",
    chiefThreadId: null,
    workerThreadId: null,
    title: "Chief · Asha",
    state: "idle" as const,
    status: "idle",
    result: null,
    blocker: null,
    recommendation: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const rendered = renderSlot<
    { threadId: string; projectId: string; isCompactViewport: boolean },
    typeof rpcContract
  >(
    app.threadHeaderActions[0]!,
    { threadId: chief.threadId, projectId: chief.projectId, isCompactViewport: false },
    {
      rpc: {
        status: () => ({ sectionId: "sec_chief", threads: [chief] }),
        start: () => ({ threadId: chief.threadId, created: false }),
        create: () => ({ threadId: "thr_new", created: true }),
      },
    },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  await vi.waitFor(() =>
    expect(rendered.getByLabelText("Chief supervisor").textContent).toContain("Chief"),
  );
});

test("shows the role chip on managed threads and nothing on others", async () => {
  const worker = {
    threadId: "thr_worker", role: "worker" as const, projectId: "proj_1", chiefThreadId: "thr_chief",
    workerThreadId: null, title: "Fix totals", state: "idle" as const, status: "idle",
    result: null, blocker: null, recommendation: null, createdAt: 1, updatedAt: 1,
  };
  const render = (threadId: string) => {
    const rendered = renderSlot<
      { threadId: string; projectId: string; isCompactViewport: boolean },
      typeof rpcContract
    >(
      app.threadHeaderActions[0]!,
      { threadId, projectId: "proj_1", isCompactViewport: false },
      { rpc: { status: () => ({ sectionId: "sec_chief", threads: [worker] }) } },
    );
    unmounts.push(() => rendered.lifecycle.unmount());
    return rendered;
  };
  const managed = render(worker.threadId);
  await vi.waitFor(() => expect(managed.getByLabelText("Chief worker").textContent).toBe("Worker"));
  managed.lifecycle.unmount();
  const other = render("thr_other");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(other.queryByLabelText(/Chief/)).toBeNull();
});

test("picks a scanned model per role and clears back to the BB default", async () => {
  const section = app.settingsSections.find((candidate) => candidate.id === "models")!;
  const configuration = {
    hosts: [{
      hostId: "host_1",
      hostName: "Local",
      connected: true,
      error: null,
      fallback: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "medium" as const },
      selections: {
        chief: { providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "high" as const },
        planner: null,
        junior: null,
        senior: null,
        reviewer: null,
        advisor: null,
      },
      unusable: [],
    }],
  };
  const rendered = renderSlot<Record<string, never>, typeof rpcContract>(
    section,
    {},
    {
      rpc: {
        status: () => emptyStatus,
        start: () => ({ threadId: "thr_1", created: false }),
        create: () => ({ threadId: "thr_1", created: true }),
        modelConfiguration: () => configuration,
        setRoleModel: () => ({ ok: true as const }),
      },
    },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  await vi.waitFor(() => expect(rendered.getByText("Local")).toBeTruthy());
  expect(rendered.getAllByText("Not set · BB picks the model")).toHaveLength(5);

  fireEvent.click(rendered.getByRole("button", { name: "Use BB default" }));

  await vi.waitFor(() =>
    expect(rendered.rpcCalls).toContainEqual({
      method: "setRoleModel",
      input: { hostId: "host_1", role: "chief", selection: null },
    }),
  );
  expect(rendered.getAllByText("Not set · BB picks the model")).toHaveLength(6);
});

test("the thread panel's Chief to-do tab lists items as a checklist and refetches on the realtime signal", async () => {
  expect(app.threadPanelActions.map((action) => action.id)).toEqual(["pending"]);
  const items = [
    { id: "thr_w", label: "worker “Fix totals”", status: "ready", action: "Review thr_w now.", done: false },
    { id: "todo #1", label: "Ship docs", status: "done", action: null, done: true },
  ];
  const rendered = renderSlot<{ threadId: string; params: null }, typeof rpcContract>(
    app.threadPanelActions[0]!,
    { threadId: "thr_chief", params: null },
    {
      rpc: {
        status: () => emptyStatus,
        start: () => ({ threadId: "thr_1", created: false }),
        create: () => ({ threadId: "thr_1", created: true }),
        pending: ({ threadId }) => (threadId === "thr_chief" ? { chief: true, items, doneOmitted: 0 } : { chief: false, items: [], doneOmitted: 0 }),
      },
    },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  await vi.waitFor(() => expect(rendered.getByRole("checkbox", { name: "worker “Fix totals”" })).toBeTruthy());
  expect((rendered.getByRole("checkbox", { name: "worker “Fix totals”" }) as HTMLInputElement).checked).toBe(false);
  const done = rendered.container.querySelector("details input[type=checkbox]") as HTMLInputElement;
  expect(done.checked).toBe(true);
  expect(done.getAttribute("aria-label")).toBe("Ship docs");
  expect(rendered.container.querySelector("summary")?.textContent).toBe("Done (1)");
  fireEvent.click(rendered.getAllByRole("button", { name: "thr_w" })[0]!);
  expect(rendered.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_w" });
  rendered.emitRealtime("pending", null);
  await vi.waitFor(() =>
    expect(rendered.rpcCalls.filter((call) => call.method === "pending")).toHaveLength(2),
  );
});

test("the Chief pending tab refetches once after the realtime connection reconnects", async () => {
  let items: TodoItem[] = [];
  const rendered = renderSlot<{ threadId: string; params: null }, typeof rpcContract>(
    app.threadPanelActions[0]!,
    { threadId: "thr_chief", params: null },
    {
      realtimeConnectionState: "connected",
      rpc: {
        status: () => emptyStatus,
        start: () => ({ threadId: "thr_1", created: false }),
        create: () => ({ threadId: "thr_1", created: true }),
        pending: () => ({ chief: true, items, doneOmitted: 0 }),
      },
    },
  );
  unmounts.push(() => rendered.lifecycle.unmount());
  const calls = () => rendered.rpcCalls.filter((call) => call.method === "pending").length;

  const shown = () => rendered.container.textContent;

  await act(async () => {});
  await vi.waitFor(() => expect(shown()).toBe("Nothing tracked yet."));
  expect(calls()).toBe(1);
  items = [{ id: "todo #1", label: "Follow up", status: "open", action: null, done: false }];
  await act(async () => rendered.setRealtimeConnectionState("reconnecting"));
  expect(calls()).toBe(1);
  expect(shown()).toBe("Nothing tracked yet.");
  await act(async () => rendered.setRealtimeConnectionState("connected"));
  await vi.waitFor(() => expect(shown()).toContain("Follow up"));
  expect(calls()).toBe(2);
});
