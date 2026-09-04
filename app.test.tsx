// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";

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
