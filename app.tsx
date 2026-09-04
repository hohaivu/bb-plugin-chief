import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

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
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = useCallback(async () => {
    if (!projectId || isLaunching) return;
    setError(null);
    setIsLaunching(true);
    try {
      const result = await rpc.call("create", { projectId });
      navigate.toThread(result.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setIsLaunching(false);
    }
  }, [isLaunching, navigate, projectId, rpc]);

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex items-center gap-3 px-6 py-3 text-sm text-muted-foreground">
        <div className="min-w-0 flex-1 space-y-1">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : (
            <p>Create an independent supervisor for this project. You can start more than one.</p>
          )}
        </div>
        <button
          type="button"
          disabled={!projectId || isLaunching}
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
  app.slots.experimental_threadHeaderAction({
    id: "chief-role",
    title: "Chief role",
    component: ChiefHeaderBadge,
  });
});
