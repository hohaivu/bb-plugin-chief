import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbNavigate,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { ModelConfiguration, ModelSelection, rpcContract } from "./server";

const ROLES = [
  { role: "chief", label: "Chief", hint: "Supervises and decides." },
  { role: "planner", label: "Planner", hint: "Plans work before it starts." },
  { role: "junior", label: "Junior worker", hint: "Trivial, mechanical, already-specified bounded work." },
  { role: "senior", label: "Senior worker", hint: "Everything else Chief delegates." },
  { role: "reviewer", label: "Reviewer", hint: "Reviews finished work." },
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

  // The slot only carries a project on a project route; the root New thread
  // screen has none, so fall back to the configured default Chief project.
  const configured = values?.chiefProject;
  const target = projectId ?? (typeof configured === "string" && configured ? configured : null);

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
          ) : target ? (
            <p>No project is in view here, so this starts a Chief in your default Chief project.</p>
          ) : (
            <p>Open a project, or set a default Chief project in Settings, to start one from here.</p>
          )}
        </div>
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
          Chief, its planners, workers, and reviewers can each run on their own model. A role
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
  const [isChief, setIsChief] = useState(false);

  useEffect(() => {
    let current = true;
    void rpc.call("status", null).then((result) => {
      if (current) {
        setIsChief(
          result.threads.some(
            (thread) => thread.threadId === threadId && thread.role === "chief",
          ),
        );
      }
    }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [rpc, threadId]);

  if (!isChief) return null;
  return (
    <span
      aria-label="Chief supervisor"
      title="Chief supervisor"
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
      <Crown />
      {isCompactViewport ? null : "Chief"}
    </span>
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
});
