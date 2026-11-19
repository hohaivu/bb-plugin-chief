import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbNavigate,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./src/rpcContract";
import type { ModelConfiguration, ModelSelection } from "./src/types";

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const ROLES = [
  { role: "chief", label: "Chief", hint: "Supervises and decides." },
  { role: "planner", label: "Planner", hint: "Plans work before it starts." },
  { role: "worker", label: "Worker", hint: "Implements the work Chief delegates." },
  { role: "designer", label: "Designer", hint: "Decides or implements how UI looks (design tools, design-to-code)." },
  { role: "spec-writer", label: "Spec Writer", hint: "Keeps docs/specs, docs/INDEX.md and docs/decisions current." },
  { role: "reviewer", label: "Reviewer", hint: "Reviews finished work." },
  { role: "advisor", label: "Advisor", hint: "Diagnoses work that keeps failing review." },
  { role: "researcher", label: "Researcher", hint: "Answers Chief's read-only research questions." },
] as const;

function Crown({ plus = false }: { plus?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14">
      {plus ? <path d="M20 1v6m-3-3h6" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" /> : null}
      <path
        d="m4 8 4 3 4-6 4 6 4-3-2 10H6L4 8Zm3 13h10"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function StartChief({ projectId }: { projectId: string | null }) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { projects: allProjects } = experimental_useSidebarThreads();
  // ponytail: personal project hidden; it has no repo for workers to branch from
  const projects = allProjects.filter((project) => !project.isPersonal);
  const [picked, setPicked] = useState<string | null>(null);

  // The slot only carries a project on a project route. On the root New thread
  // screen the user picks one, preselected to the default Chief project, or the
  // first project when that default is unset or gone. A pick that has left the
  // list is ignored the same way.
  const configured = typeof values?.chiefProject === "string" ? values.chiefProject : null;
  const fallback = projects.find((p) => p.id === configured)?.id ?? projects[0]?.id ?? null;
  const listedPick = projects.some((p) => p.id === picked) ? picked : null;
  const target = projectId ?? listedPick ?? fallback;

  const launch = useCallback(async () => {
    if (!target || isLaunching) return;
    setError(null);
    setIsLaunching(true);
    try {
      const result = await rpc.call("create", { projectId: target });
      navigate.toThread(result.threadId);
    } catch (cause) {
      setError(errorMessage(cause));
      setIsLaunching(false);
    }
  }, [isLaunching, navigate, target, rpc]);

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex items-center gap-3 px-6 py-3 text-sm text-muted-foreground">
        <div className="min-w-0 flex-1 space-y-1">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : projectId ? (
            <p>Create an independent supervisor for this project. You can start more than one.</p>
          ) : projects.length ? (
            <p>Pick the project this Chief supervises. You can start more than one.</p>
          ) : (
            <p>Create a project to start a Chief from here.</p>
          )}
        </div>
        {!projectId && projects.length ? (
          <select
            aria-label="Chief project"
            value={target ?? ""}
            onChange={(event) => setPicked(event.target.value)}
            className="h-7 shrink-0 cursor-pointer rounded-md border border-input bg-transparent px-2 text-xs font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          disabled={!target || isLaunching}
          onClick={() => void launch()}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-transparent px-3 text-xs font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {isLaunching ? "Starting…" : "Start Chief"}
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3">
            <path
              d="m9 18 6-6-6-6"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

function ChiefModelSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [configuration, setConfiguration] = useState<ModelConfiguration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setConfiguration(await rpc.call("modelConfiguration", null));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    (hostId: string, role: (typeof ROLES)[number]["role"], selection: ModelSelection | null) => {
      setError(null);
      setConfiguration((current) => current && {
        hosts: current.hosts.map((host) =>
          host.hostId === hostId
            ? {
                ...host,
                selections: { ...host.selections, [role]: selection },
                // The picker only offers models this machine serves, so a fresh
                // pick clears the stale "cannot serve that model" warning.
                unusable: host.unusable.filter((stale) => stale !== role),
              }
            : host,
        ),
      });
      void rpc.call("setRoleModel", { hostId, role, selection }).catch((cause) => {
        setError(errorMessage(cause));
        void load();
      });
    },
    [load, rpc],
  );

  if (!configuration && isLoading) {
    return <p className="text-sm text-muted-foreground">Scanning machines for providers and models…</p>;
  }

  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Chief, its planners, workers, designers, reviewers, advisors, and researchers can each run on their own model. A role
          without a selection uses BB&apos;s own default for the project.
        </p>
        <button
          type="button"
          disabled={isLoading}
          onClick={() => void load()}
          className="h-7 shrink-0 cursor-pointer rounded-md border border-input px-3 text-xs font-medium disabled:opacity-50"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {configuration?.hosts.map((host) => (
        <div key={host.hostId} className="rounded-lg border border-border p-3">
          <div className="text-sm font-medium text-foreground">
            {host.hostName}
            {host.connected ? null : " · disconnected"}
          </div>
          {host.error ? <p className="mt-1 text-xs text-muted-foreground">{host.error}</p> : null}
          {ROLES.map(({ role, label, hint }) => {
            const selection = host.selections[role];
            const inheritsWorker = role === "designer" || role === "spec-writer";
            const value = selection ?? (inheritsWorker ? host.selections.worker : null) ?? host.fallback;
            return (
              <div key={role} className="mt-3 flex flex-wrap items-center gap-3">
                <div className="w-24 shrink-0">
                  <div className="text-sm text-foreground">{label}</div>
                  <div className="text-xs text-muted-foreground">{hint}</div>
                </div>
                {value ? (
                  <HostModelPicker
                    hostId={host.hostId}
                    value={value}
                    disabled={!host.connected}
                    onPick={(selection) => save(host.hostId, role, selection)}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">No model catalog to choose from.</span>
                )}
                {selection ? (
                  <>
                    {host.unusable.includes(role) ? (
                      <span className="text-xs text-destructive">
                        This machine cannot serve that model; spawning on BB&apos;s default.
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => save(host.hostId, role, null)}
                      className="h-7 cursor-pointer rounded-md border border-input px-3 text-xs font-medium"
                    >
                      {inheritsWorker ? "Use Worker model" : "Use BB default"}
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {inheritsWorker ? "Not set · uses the Worker model" : "Not set · BB picks the model"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {configuration?.hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No machines are enrolled yet.</p>
      ) : null}
    </div>
  );
}

/** bb's picker re-reports its own normalized state (e.g. a service tier Chief does not store) through
 * onChange on every render; only a changed triple is a pick, or saving it re-renders into a loop. */
function HostModelPicker({ hostId, value, disabled, onPick }: {
  hostId: string;
  value: ModelSelection;
  disabled: boolean;
  onPick: (selection: ModelSelection) => void;
}) {
  return (
    <ProviderModelPicker
      value={value}
      routing={{ kind: "host", hostId }}
      disabled={disabled}
      onChange={(next) => {
        const selection = { providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel };
        if (selection.providerId !== value.providerId || selection.model !== value.model
          || selection.reasoningLevel !== value.reasoningLevel) onPick(selection);
      }}
    />
  );
}

function useHeaderRoles({ threadIds }: { threadIds: readonly string[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [roles, setRoles] = useState<ReadonlyMap<string, string | null>>(new Map());
  // One token per visible lifetime: re-entering the visible set refetches, and stale completions are dropped.
  const lifetimes = useRef(new Map<string, object>());

  useEffect(() => {
    const visible = new Set(threadIds);
    const left = [...lifetimes.current.keys()].filter((threadId) => !visible.has(threadId));
    for (const threadId of left) lifetimes.current.delete(threadId);
    if (left.length > 0) setRoles((previous) => {
      const next = new Map(previous);
      for (const threadId of left) next.delete(threadId);
      return next;
    });
    for (const threadId of visible) {
      if (lifetimes.current.has(threadId)) continue;
      const token = {};
      lifetimes.current.set(threadId, token);
      void rpc.call("role", { threadId }).then((result) => {
        if (lifetimes.current.get(threadId) === token) setRoles((previous) => new Map(previous).set(threadId, result.role));
      }).catch(() => {
        if (lifetimes.current.get(threadId) === token) lifetimes.current.delete(threadId);
      });
    }
  }, [rpc, threadIds]);

  return roles;
}

function useCreateChief() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [launching, setLaunching] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const { projects } = experimental_useSidebarThreads();

  // Offer it only once the project is known to be non-personal (a personal project has no repo for workers to branch from).
  const canLaunch = (projectId: string) => projects.some((candidate) => candidate.id === projectId && !candidate.isPersonal);

  const launch = async (threadId: string, projectId: string) => {
    if (inFlight.current.has(threadId)) return;
    inFlight.current.add(threadId);
    setLaunching(new Set(inFlight.current));
    try {
      const result = await rpc.call("create", { projectId });
      navigate.toThread(result.threadId);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      inFlight.current.delete(threadId);
      setLaunching(new Set(inFlight.current));
    }
  };

  return { canLaunch, launching, launch };
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "start-chief",
    title: "Chief",
    component: StartChief,
  });
  app.slots.settingsSection({
    id: "models",
    title: "Chief models by machine",
    description: "Live provider and model choices scanned from each enrolled machine.",
    component: ChiefModelSettings,
  });
  app.experimental_icons.register({ name: "chief/crown", component: () => <Crown /> });
  app.experimental_icons.register({ name: "chief/crown-plus", component: () => <Crown plus /> });
  app.slots.experimental_threadAction({
    id: "chief-role",
    title: "Chief role",
    icon: "chief/crown",
    group: "chief",
    order: 0,
    placement: "header",
    useData: useHeaderRoles,
    item: ({ thread, data }) => {
      const role = data.get(thread.id);
      if (!role) return null;
      const name = ROLES.find((entry) => entry.role === role)?.label ?? role.charAt(0).toUpperCase() + role.slice(1);
      return {
        label: role === "chief" ? "Chief supervisor" : `Chief ${name}`,
        icon: "chief/crown",
        disabled: true,
        run: () => undefined,
      };
    },
  });
  app.slots.experimental_threadAction({
    id: "new-chief",
    title: "New Chief",
    icon: "chief/crown-plus",
    group: "chief",
    order: 1,
    placement: "header",
    useData: () => useCreateChief(),
    item: ({ thread, data }) => data.canLaunch(thread.projectId)
      ? { label: "New Chief", icon: "chief/crown-plus", disabled: data.launching.has(thread.id), run: () => data.launch(thread.id, thread.projectId) }
      : null,
  });

});
