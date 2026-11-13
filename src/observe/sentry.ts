import { clip } from "../core/text";
import { normalize, scrub } from "./scrub";

const WINDOW_MS = 10 * 60_000;

export interface SentryEvent {
  eventId: string;
  level: "error" | "warning";
  kind: string;
  message: string;
  tags: Record<string, string>;
}

export function parseDsn(dsn: string) {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.split("/").filter(Boolean).pop();
    if (!/^https?:$/.test(url.protocol) || !url.username || !projectId) return null;
    return { publicKey: url.username, host: url.host, protocol: url.protocol.slice(0, -1), projectId };
  } catch {
    return null;
  }
}

/** A direct envelope POST, no SDK. `warn` must be the original bb.log.warn: a failed send reports through it, never through the observed one. */
export function createSentry(options: { dsn: () => string | undefined; secrets: () => string[]; release: string; warn: (message: string) => void }) {
  const { dsn, secrets, release, warn } = options;
  // shortcut: per-process, a reload resets it
  const lastSent = new Map<string, number>();
  let lastWarnAt = 0;
  let parsed: { dsn: string; value: ReturnType<typeof parseDsn> } | null = null;

  function warnOnce(message: string) {
    const now = Date.now();
    if (now - lastWarnAt < WINDOW_MS) return;
    lastWarnAt = now;
    try { warn(message); } catch { /* a warn that throws must not fail a send */ }
  }

  function target() {
    const raw = dsn();
    if (!raw) return null;
    if (parsed?.dsn !== raw) {
      parsed = { dsn: raw, value: parseDsn(raw) };
      if (!parsed.value) warn("Sentry DSN is invalid; nothing is sent to Sentry.");
    }
    return parsed.value;
  }

  /** Fire and forget; never throws. Every outbound field comes from the scrubbed message or scrubbed tag values. */
  function send(event: SentryEvent) {
    try {
      const to = target();
      if (!to) return;
      const clean = scrub(event.message, secrets());
      const fingerprint = [event.kind, normalize(clean)];
      const key = fingerprint.join("\u0000");
      const now = Date.now();
      if (now - (lastSent.get(key) ?? 0) < WINDOW_MS) return;
      lastSent.set(key, now);
      if (lastSent.size > 500) for (const [other, at] of lastSent) if (now - at >= WINDOW_MS) lastSent.delete(other);
      const tags = Object.fromEntries(Object.entries(event.tags).map(([name, value]) => [name, clip(scrub(value, secrets()), 200)]));
      const body = [
        { event_id: event.eventId, sent_at: new Date(now).toISOString() },
        { type: "event" },
        { event_id: event.eventId, timestamp: now / 1000, level: event.level, platform: "node", logger: "chief", release: `bb-plugin-chief@${release}`, message: { formatted: clip(clean, 300) }, tags, fingerprint },
      ].map((part) => JSON.stringify(part)).join("\n");
      const failed = (why: string) => warnOnce(`Could not send an event to Sentry: ${why}`);
      fetch(`${to.protocol}://${to.host}/api/${to.projectId}/envelope/`, {
        method: "POST",
        headers: { "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${to.publicKey}, sentry_client=bb-plugin-chief/${release}`, "Content-Type": "application/x-sentry-envelope" },
        body,
        signal: AbortSignal.timeout(10_000),
      }).then((response) => { if (!response.ok) failed(`HTTP ${response.status}`); }, (error) => failed(scrub(String(error), secrets())));
    } catch { /* telemetry never throws into its caller */ }
  }
  return { send };
}
