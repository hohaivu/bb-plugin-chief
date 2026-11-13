import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSentry, parseDsn, secretsOf, type SentryEvent } from "./src/observe/sentry";

const DSN = "https://publickey123@o9.ingest.sentry.io/4242";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const event = (over: Partial<SentryEvent> = {}): SentryEvent => ({ eventId: "e".repeat(32), level: "error", kind: "tool_error", message: "chief_report: failed", tags: { role: "worker" }, ...over });

describe("sentry", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T08:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const make = (over: { dsn?: string | undefined; secrets?: string[]; warn?: (message: string) => void } = {}) =>
    createSentry({ dsn: () => ("dsn" in over ? over.dsn : DSN), secrets: () => over.secrets ?? [], release: "1.2.3", warn: over.warn ?? (() => {}) });
  const envelope = (call = 0) => (fetchMock.mock.calls[call]![1].body as string).split("\n").map((line) => JSON.parse(line));

  test("parses a DSN and lists the values no outbound text may hold", () => {
    expect(parseDsn(DSN)).toEqual({ publicKey: "publickey123", host: "o9.ingest.sentry.io", protocol: "https", projectId: "4242" });
    expect(parseDsn("not a dsn")).toBeNull();
    expect(parseDsn("https://o9.ingest.sentry.io/4242")).toBeNull();
    expect(secretsOf({ sentryDsn: DSN, sentryAuthToken: "tok-1" })).toEqual([DSN, "tok-1", "publickey123"]);
    expect(secretsOf({})).toEqual([]);
  });

  test("sends nothing without a DSN", () => {
    make({ dsn: undefined }).send(event());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an invalid DSN sends nothing and says so through warn", () => {
    const warn = vi.fn();
    make({ dsn: "garbage", warn }).send(event());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  test("posts one envelope to the DSN's envelope endpoint", async () => {
    make().send(event());
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://o9.ingest.sentry.io/api/4242/envelope/");
    expect(init.method).toBe("POST");
  });

  test("the whole serialized envelope holds no secret, the fingerprint included", async () => {
    make({ secrets: [DSN, "tok-super-secret", "publickey123"] }).send(event({
      message: "call failed: Bearer example-secret-value, password=hunter2, dsn tok-super-secret via publickey123",
      tags: { thread_id: "thr_abc", note: "Bearer example-secret-value tok-super-secret" },
    }));
    await flush();
    const body = fetchMock.mock.calls[0]![1].body as string;
    for (const secret of ["example-secret-value", "hunter2", "tok-super-secret", "publickey123"]) expect(body).not.toContain(secret);
    const [, , item] = envelope();
    expect(JSON.stringify(item.fingerprint)).not.toContain("example-secret-value");
  });

  test("carries exactly the allowlisted keys and nothing else", async () => {
    make().send(event({ tags: { role: "worker", thread_id: "thr_abc" } }));
    await flush();
    const [header, itemHeader, item] = envelope();
    expect(Object.keys(header).sort()).toEqual(["event_id", "sent_at"]);
    expect(Object.keys(itemHeader)).toEqual(["type"]);
    expect(Object.keys(item).sort()).toEqual(["event_id", "fingerprint", "level", "logger", "message", "platform", "release", "tags", "timestamp"]);
    expect(Object.keys(item.message)).toEqual(["formatted"]);
    expect(item.release).toBe("bb-plugin-chief@1.2.3");
    expect(item.fingerprint).toEqual(["tool_error", "chief_report: failed"]);
  });

  test("throttles one fingerprint to once per 10 minutes; ids and numbers do not make a new one", async () => {
    const sentry = make();
    sentry.send(event({ message: "thread thr_aaa failed 3 times" }));
    sentry.send(event({ message: "thread thr_bbb failed 9 times" }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sentry.send(event({ kind: "stall", message: "thread thr_aaa failed 3 times" }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-11-13T08:09:59Z"));
    sentry.send(event({ message: "thread thr_ccc failed 1 times" }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-11-13T08:10:01Z"));
    sentry.send(event({ message: "thread thr_ddd failed 1 times" }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("a failed send never throws and reports once through the given warn, scrubbed", async () => {
    const warn = vi.fn();
    fetchMock.mockRejectedValue(new Error("connect failed for publickey123"));
    const sentry = make({ secrets: ["publickey123"], warn });
    expect(() => sentry.send(event({ message: "first" }))).not.toThrow();
    expect(() => sentry.send(event({ message: "second" }))).not.toThrow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).not.toContain("publickey123");
  });

  test("a fetch that throws synchronously, a non-ok answer and a warn that throws never reach the caller", async () => {
    fetchMock.mockImplementationOnce(() => { throw new Error("sync boom"); });
    expect(() => make().send(event({ message: "sync" }))).not.toThrow();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const warn = vi.fn(() => { throw new Error("warn boom"); });
    expect(() => make({ warn }).send(event({ message: "http" }))).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledOnce();
  });
});
