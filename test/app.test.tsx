// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../src/rpcContract";

const hostPicker = vi.hoisted(() => ({ normalizes: false, emits: 0 }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  const { createElement, useEffect } = await import("react");
  // Like bb's picker: every render it re-reports its own state, here with a service tier Chief does not store.
  // Capped so a looping app fails the assertions instead of hanging the run.
  function HostLikePicker(props: any) {
    useEffect(() => {
      if (hostPicker.normalizes && props.value.serviceTier === undefined && hostPicker.emits++ < 50) props.onChange({ ...props.value, serviceTier: "default" });
    });
    // Resolved lazily: the harness installs the runtime inside loadPluginApp.
    const Picker = (globalThis as any).__bbPluginRuntime.pluginSdkApp.experimental_ProviderModelPicker;
    return createElement(Picker, props);
  }
  return { ...actual, experimental_ProviderModelPicker: HostLikePicker };
});

const app = await loadPluginApp(() => import("../app"));
const unmounts: Array<() => void> = [];
const emptyStatus = { sectionId: null, threads: [] };

afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  hostPicker.normalizes = false;
  hostPicker.emits = 0;
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

  fireEvent.click(rendered.getByRole("button", { name: "Start Chief" }));

  await vi.waitFor(() =>
    expect(rendered.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_proj_2_new",
    }),
  );
  expect(rendered.rpcCalls).toEqual([
    { method: "create", input: { projectId: "proj_2" } },
  ]);
  expect(rendered.queryByRole("combobox")).toBeNull();
});

const project = (id: string, isPersonal = false) => ({
  id,
  name: `Project ${id}`,
  isPersonal,
  href: `/p/${id}`,
  settingsHref: `/p/${id}/settings`,
});
const createRpc = {
  status: () => emptyStatus,
  start: () => ({ threadId: "thr_existing", created: false }),
  create: ({ projectId }: { projectId: string }) => ({ threadId: `thr_${projectId}_new`, created: true }),
};

test("projectless screen preselects the default Chief project and starts in the picked one", async () => {
  const rendered = renderSlot<{ projectId: string | null }, typeof rpcContract>(
    app.homepageSections[0]!,
    { projectId: null },
    {
      settings: { chiefProject: "proj_default" },
      sidebarThreads: {
        projects: [project("proj_a"), project("proj_default"), project("proj_me", true)],
      },
      rpc: createRpc,
    },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  const select = rendered.getByRole("combobox", { name: "Chief project" }) as HTMLSelectElement;
  expect(select.value).toBe("proj_default");
  expect(rendered.queryByRole("option", { name: "Project proj_me" })).toBeNull();

  fireEvent.change(select, { target: { value: "proj_a" } });
  fireEvent.click(rendered.getByRole("button", { name: "Start Chief" }));

  await vi.waitFor(() =>
    expect(rendered.rpcCalls).toEqual([{ method: "create", input: { projectId: "proj_a" } }]),
  );
});

test("projectless screen preselects the first project when no default is set", async () => {
  const rendered = renderSlot<{ projectId: string | null }, typeof rpcContract>(
    app.homepageSections[0]!,
    { projectId: null },
    { sidebarThreads: { projects: [project("proj_a"), project("proj_b")] }, rpc: createRpc },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  fireEvent.click(rendered.getByRole("button", { name: "Start Chief" }));

  await vi.waitFor(() =>
    expect(rendered.rpcCalls).toEqual([{ method: "create", input: { projectId: "proj_a" } }]),
  );
});

test("a picked project that leaves the sidebar list is never the create target", async () => {
  // The harness reads this array on every render, so mutating it and
  // rerendering stands in for a live sidebar update.
  const projects = [project("proj_a"), project("proj_b")];
  const StartChief = app.homepageSections[0]!.component;
  const rendered = renderSlot<{ projectId: string | null }, typeof rpcContract>(
    app.homepageSections[0]!,
    { projectId: null },
    { sidebarThreads: { projects }, rpc: createRpc },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  fireEvent.change(rendered.getByRole("combobox", { name: "Chief project" }), {
    target: { value: "proj_a" },
  });

  projects.splice(0, 1);
  rendered.lifecycle.rerender(<StartChief projectId={null} />);
  const select = rendered.getByRole("combobox", { name: "Chief project" }) as HTMLSelectElement;
  expect(select.value).toBe("proj_b");
  fireEvent.click(rendered.getByRole("button", { name: "Start Chief" }));
  await vi.waitFor(() =>
    expect(rendered.rpcCalls).toEqual([{ method: "create", input: { projectId: "proj_b" } }]),
  );

  projects.splice(0);
  rendered.lifecycle.rerender(<StartChief projectId={null} />);
  expect(rendered.queryByRole("combobox")).toBeNull();
  expect(rendered.getByText(/Create a project/)).toBeTruthy();
});

test("button disabled when there are no projects to pick", async () => {
  const rendered = renderSlot<{ projectId: string | null }, typeof rpcContract>(
    app.homepageSections[0]!,
    { projectId: null },
    { rpc: createRpc },
  );
  unmounts.push(() => rendered.lifecycle.unmount());

  expect(rendered.getByRole("button", { name: "Start Chief" })).toHaveProperty("disabled", true);
  expect(rendered.getByText(/Create a project/)).toBeTruthy();
});

function renderHeaderAction(
  id: string,
  threads: Array<{ id: string; projectId: string }>,
  options: NonNullable<Parameters<typeof renderSlot<object, typeof rpcContract>>[2]>,
) {
  const registration = app.threadActions.find((action) => action.id === id && action.placement === "header");
  expect(registration, "Missing SDK header action: " + id).toBeDefined();
  const action = registration!;
  // The SDK collector exposes registrations, not the host header renderer.
  function HeaderActionProbe() {
    const data = action.useData?.({ threadIds: threads.map((thread) => thread.id) });
    return threads.map((target) => {
      const item = action.item({
        data,
        thread: {
          ...target, parentThreadId: null, parentNotifications: "auto", archivedAt: null,
          pinnedAt: null, sectionId: null, isUnread: false, status: "idle", environment: null,
        },
      } as Parameters<typeof action.item>[0]);
      return <div key={target.id} data-testid={target.id}>
        {item && <button disabled={item.disabled} onClick={() => void item.run({
          requestRename: () => { throw new Error("Unexpected rename"); },
        })}>{item.label}</button>}
      </div>;
    });
  }
  const rendered = renderSlot<object, typeof rpcContract>({ component: HeaderActionProbe }, {}, options);
  unmounts.push(() => rendered.lifecycle.unmount());
  return rendered;
}

describe("SDK header actions", () => {
  test("labels each visible managed thread by role and leaves unmanaged threads unbadged", async () => {
    const cases = [
      ["chief", "Chief supervisor"], ["planner", "Chief Planner"], ["worker", "Chief Worker"],
      ["designer", "Chief Designer"], ["spec-writer", "Chief Spec Writer"],
      ["reviewer", "Chief Reviewer"], ["advisor", "Chief Advisor"], ["researcher", "Chief Researcher"],
      [null, null],
    ] as const;
    const threads = cases.map(([role]) => ({ id: role ?? "unmanaged", projectId: "proj_1" }));
    const roles = new Map<string, (typeof cases)[number][0]>(cases.map(([role]) => [role ?? "unmanaged", role]));
    const rendered = renderHeaderAction("chief-role", threads, {
      rpc: { role: ({ threadId }) => {
        if (!roles.has(threadId)) throw new Error("Unexpected role lookup");
        return { role: roles.get(threadId)! };
      } },
    });

    await vi.waitFor(() => {
      for (const [role, label] of cases) {
        const header = within(rendered.getByTestId(role ?? "unmanaged"));
        if (label) expect((header.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
        else expect(header.queryByRole("button")).toBeNull();
      }
    });
    expect(rendered.rpcCalls).toEqual(threads.map(({ id }) => ({ method: "role", input: { threadId: id } })));
  });

  test("New Chief launches in the header's project, not a personal or unknown project", async () => {
    const rendered = renderHeaderAction("new-chief", [
      { id: "repo", projectId: "proj_repo" },
      { id: "personal", projectId: "proj_me" },
      { id: "unknown", projectId: "proj_missing" },
    ], {
      sidebarThreads: { projects: [project("proj_other"), project("proj_me", true), project("proj_repo")] },
      rpc: { create: createRpc.create },
    });
    expect(within(rendered.getByTestId("personal")).queryByRole("button")).toBeNull();
    expect(within(rendered.getByTestId("unknown")).queryByRole("button")).toBeNull();
    fireEvent.click(within(rendered.getByTestId("repo")).getByRole("button", { name: "New Chief" }));
    await vi.waitFor(() => expect(rendered.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_proj_repo_new" },
    ]));
    expect(rendered.rpcCalls).toEqual([{ method: "create", input: { projectId: "proj_repo" } }]);
  });
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
        worker: null,
        reviewer: null,
        advisor: null,
        researcher: null,
        "research-helper": null,
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

// Contract (Settings > Models, Spec Writer row): the row sits after Designer, an unset Spec Writer is described as using the
// Worker model, a stored pick offers "Use Worker model" (not "Use BB default"), and clearing it saves role "spec-writer" with
// a null selection. Regression: dropping spec-writer from the inherit-Worker roles shows "BB picks the model" and the wrong
// button; a wrong role string in the row clears another role's pick.
test("the Spec Writer row follows Designer, inherits the Worker model, and clears its own pick", async () => {
  const section = app.settingsSections.find((candidate) => candidate.id === "models")!;
  const pick = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" as const };
  const configuration = {
    hosts: [{
      hostId: "host_1", hostName: "Local", connected: true, error: null,
      fallback: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "medium" as const },
      selections: { chief: null, planner: null, worker: null, designer: null, "spec-writer": pick, reviewer: null, advisor: null, researcher: null, "research-helper": null },
      unusable: [],
    }],
  };
  const rendered = renderSlot<Record<string, never>, typeof rpcContract>(section, {}, {
    rpc: { modelConfiguration: () => configuration, setRoleModel: () => ({ ok: true as const }) } as never,
  });
  unmounts.push(() => rendered.lifecycle.unmount());
  await vi.waitFor(() => expect(rendered.getByText("Local")).toBeTruthy());

  const labels = ["Chief", "Planner", "Worker", "Designer", "Spec Writer", "Reviewer", "Advisor"];
  const rows = labels.map((label) => rendered.getByText(label, { selector: "div" }).closest("div.mt-3") as HTMLElement);
  expect(rows.every(Boolean)).toBe(true);
  expect(new Set(rows).size).toBe(labels.length);
  expect(rows.every((row, i) => i === 0 || rows[i - 1]!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

  const specRow = within(rows[4]!);
  expect(specRow.queryByText("Not set · uses the Worker model")).toBeNull();
  expect(specRow.queryByRole("button", { name: "Use BB default" })).toBeNull();

  fireEvent.click(specRow.getByRole("button", { name: "Use Worker model" }));

  await vi.waitFor(() =>
    expect(rendered.rpcCalls).toContainEqual({ method: "setRoleModel", input: { hostId: "host_1", role: "spec-writer", selection: null } }),
  );
  expect(rendered.rpcCalls.filter((call) => call.method === "setRoleModel")).toHaveLength(1);
  await vi.waitFor(() => expect(specRow.getByText("Not set · uses the Worker model")).toBeTruthy());
});

test("a picker re-reporting a service tier saves no role model", async () => {
  hostPicker.normalizes = true;
  const section = app.settingsSections.find((candidate) => candidate.id === "models")!;
  const configuration = {
    hosts: [{
      hostId: "host_1", hostName: "Local", connected: true, error: null,
      fallback: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "medium" as const },
      selections: { chief: null, planner: null, worker: null, designer: null, "spec-writer": null, reviewer: null, advisor: null, researcher: null, "research-helper": null },
      unusable: [],
    }],
  };
  const rendered = renderSlot<Record<string, never>, typeof rpcContract>(section, {}, {
    rpc: { modelConfiguration: () => configuration, setRoleModel: () => ({ ok: true as const }) } as never,
  });
  unmounts.push(() => rendered.lifecycle.unmount());
  await vi.waitFor(() => expect(rendered.getByText("Local")).toBeTruthy());
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(rendered.rpcCalls.filter((call) => call.method === "setRoleModel")).toHaveLength(0);
  expect(rendered.getAllByText("Not set · BB picks the model")).toHaveLength(6);
});

// Contract (Settings > Models, Researcher row): Chief models by machine has a Researcher row after Advisor that behaves like
// the Worker row: an unset pick says BB picks the model, a stored pick offers "Use BB default", and clearing saves role
// "researcher" with a null selection. Regression: a wrong role string clears another role's pick; inheriting the Worker model
// shows the wrong text and button.
test("the Researcher row follows Advisor, uses the BB default, and clears its own pick", async () => {
  const section = app.settingsSections.find((candidate) => candidate.id === "models")!;
  const pick = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" as const };
  const configuration = {
    hosts: [{
      hostId: "host_1", hostName: "Local", connected: true, error: null,
      fallback: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "medium" as const },
      selections: { chief: null, planner: null, worker: null, designer: null, "spec-writer": null, reviewer: null, advisor: null, researcher: pick, "research-helper": null },
      unusable: [],
    }],
  };
  const rendered = renderSlot<Record<string, never>, typeof rpcContract>(section, {}, {
    rpc: { modelConfiguration: () => configuration, setRoleModel: () => ({ ok: true as const }) } as never,
  });
  unmounts.push(() => rendered.lifecycle.unmount());
  await vi.waitFor(() => expect(rendered.getByText("Local")).toBeTruthy());

  const advisor = rendered.getByText("Advisor", { selector: "div" }).closest("div.mt-3") as HTMLElement;
  const row = rendered.getByText("Researcher", { selector: "div" }).closest("div.mt-3") as HTMLElement;
  expect(advisor.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const researcher = within(row);
  expect(researcher.queryByText(/^Not set/)).toBeNull();
  expect(researcher.queryByRole("button", { name: "Use Worker model" })).toBeNull();

  fireEvent.click(researcher.getByRole("button", { name: "Use BB default" }));
  await vi.waitFor(() =>
    expect(rendered.rpcCalls).toContainEqual({ method: "setRoleModel", input: { hostId: "host_1", role: "researcher", selection: null } }),
  );
  expect(rendered.rpcCalls.filter((call) => call.method === "setRoleModel")).toHaveLength(1);
  await vi.waitFor(() => expect(researcher.getByText("Not set · BB picks the model")).toBeTruthy());
});

test("registers no thread panel action: the Chief to-do panel is removed", () => {
  // Contract (work-list spec, Removed): the roster's Pending block is the one work list; no `pending` thread panel action remains.
  expect(app.threadPanelActions.map((action) => action.id)).not.toContain("pending");
});

// Contract (Settings): the Researcher on/off switch is a plugin setting beside the other Chief switches; the app registers
// only the Chief models section (no "Chief researcher" section, no Refresh button).
test("registers only the Chief models settings section", () => {
  expect(app.settingsSections.map((section) => section.id)).toEqual(["models"]);
});
