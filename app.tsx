import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { ModelConfiguration, ModelSelection, rpcContract, TodoItem } from "./server";

const ROLES = [
  { role: "chief", label: "Chief", hint: "Supervises and decides." },
  { role: "planner", label: "Planner", hint: "Plans work before it starts." },
  { role: "worker", label: "Worker", hint: "Implements the work Chief delegates." },
  { role: "reviewer", label: "Reviewer", hint: "Reviews finished work." },
  { role: "advisor", label: "Advisor", hint: "Diagnoses work that keeps failing review." },
] as const;

function Crown() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14">
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
      setError(cause instanceof Error ? cause.message : String(cause));
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
      setError(cause instanceof Error ? cause.message : String(cause));
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
        setError(cause instanceof Error ? cause.message : String(cause));
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
          Chief, its planners, workers, reviewers, and advisors can each run on their own model. A role
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
            const value = selection ?? host.fallback;
            return (
              <div key={role} className="mt-3 flex flex-wrap items-center gap-3">
                <div className="w-24 shrink-0">
                  <div className="text-sm text-foreground">{label}</div>
                  <div className="text-xs text-muted-foreground">{hint}</div>
                </div>
                {value ? (
                  <ProviderModelPicker
                    value={value}
                    routing={{ kind: "host", hostId: host.hostId }}
                    disabled={!host.connected}
                    onChange={(next) => save(host.hostId, role, {
                      providerId: next.providerId,
                      model: next.model,
                      reasoningLevel: next.reasoningLevel,
                    })}
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
                      Use BB default
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">Not set · BB picks the model</span>
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

function ChiefHeaderBadge({
  threadId,
  isCompactViewport,
}: {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void rpc.call("status", null).then((result) => {
      if (current) {
        setRole(result.threads.find((thread) => thread.threadId === threadId)?.role ?? null);
      }
    }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [rpc, threadId]);

  if (!role) return null;
  const isChief = role === "chief";
  const label = isChief ? "Chief supervisor" : `Chief ${role}`;
  return (
    <span
      aria-label={label}
      title={label}
      style={{
        alignItems: "center",
        background: "color-mix(in srgb, var(--primary) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--primary) 20%, transparent)",
        borderRadius: 999,
        color: "var(--primary)",
        display: "inline-flex",
        fontSize: 12,
        fontWeight: 500,
        gap: 5,
        height: 26,
        padding: isCompactViewport ? "0 6px" : "0 9px",
      }}
    >
      {isChief ? <Crown /> : null}
      {isChief ? (isCompactViewport ? null : "Chief") : role.charAt(0).toUpperCase() + role.slice(1)}
    </span>
  );
}

/** Text with every thread id turned into a navigate button. */
function Linked({ text }: { text: string }) {
  const navigate = useBbNavigate();
  return (
    <>
      {text.split(/(thr_[a-z0-9]+)/).map((piece, index) =>
        index % 2 ? (
          <button key={index} type="button" onClick={() => navigate.toThread(piece)} className="cursor-pointer underline underline-offset-2 hover:text-primary">
            {piece}
          </button>
        ) : piece,
      )}
    </>
  );
}

function TodoEntry({ item }: { item: TodoItem }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <input type="checkbox" checked={item.done} readOnly disabled aria-label={item.label} className="mt-0.5" />
      <div className={item.done ? "line-through text-muted-foreground" : "text-foreground"}>
        <Linked text={item.label} /> <span className="text-muted-foreground">(<Linked text={item.id} />, {item.status})</span>
        {item.action ? <div className="text-xs text-muted-foreground"><Linked text={item.action} /></div> : null}
      </div>
    </li>
  );
}

/** This Chief's to-do checklist: every managed thread and project todo, done items collapsed. */
function ChiefPendingPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState<{ chief: boolean; items: TodoItem[]; doneOmitted: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setPending(await rpc.call("pending", { threadId }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("pending", () => void load());
  // Signals published while the socket was down are lost, so refetch on reconnect.
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected") void load();
    previousConnection.current = connection;
  }, [connection, load]);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button
          type="button"
          disabled={isLoading}
          onClick={() => void load()}
          className="h-7 shrink-0 cursor-pointer rounded-md border border-input px-3 text-xs font-medium disabled:opacity-50"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {pending && !pending.chief ? <p className="text-sm text-muted-foreground">Not a Chief thread.</p> : null}
      {pending?.chief && !pending.items.length ? <p className="text-sm text-muted-foreground">Nothing tracked yet.</p> : null}
      {pending?.chief && pending.items.some((item) => !item.done) ? (
        <ul className="space-y-1">{pending.items.filter((item) => !item.done).map((item) => <TodoEntry key={item.id} item={item} />)}</ul>
      ) : null}
      {pending?.chief && pending.items.some((item) => item.done) ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Done ({pending.items.filter((item) => item.done).length}{pending.doneOmitted ? `, ${pending.doneOmitted} older not shown` : ""})
          </summary>
          <ul className="mt-1 space-y-1">{pending.items.filter((item) => item.done).map((item) => <TodoEntry key={item.id} item={item} />)}</ul>
        </details>
      ) : null}
    </div>
  );
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
  app.slots.experimental_threadHeaderAction({
    id: "chief-role",
    title: "Chief role",
    component: ChiefHeaderBadge,
  });
  app.slots.threadPanelAction({
    id: "pending",
    title: "Chief to-do",
    icon: "Crown",
    component: ChiefPendingPanel,
  });
});
