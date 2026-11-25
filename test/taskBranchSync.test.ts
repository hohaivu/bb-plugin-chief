import { afterEach, describe, expect, test, vi } from "vitest";
import { createCheckout } from "../src/runtime/checkout";

function setup(projects: { get: () => Promise<unknown> }, primaryHostId = "h1") {
  const warn = vi.fn();
  const ctx = { bb: { log: { warn }, sdk: { projects, system: { config: async () => ({ primaryHostId }) } } }, store: {} } as never;
  return { warn, sync: () => createCheckout(ctx).syncTaskBranch("proj", "feat") };
}

afterEach(() => vi.useRealTimers());

describe("syncTaskBranch lookups", () => {
  test("a rejected project lookup gives one warning and resolves", async () => {
    const { warn, sync } = setup({ get: async () => { throw new Error("boom"); } });
    await sync();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a stalled project lookup times out into one warning and resolves", async () => {
    vi.useFakeTimers();
    const { warn, sync } = setup({ get: () => new Promise(() => undefined) });
    const done = sync();
    await vi.advanceTimersByTimeAsync(31_000);
    await done;
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["an empty error", new Error("")],
    ["a multi-line error", new Error("first\nsecond\r\n  third")],
    ["a very long error", new Error("x".repeat(5_000))],
  ])("%s gives one bounded single-line warning", async (_name, error) => {
    const { warn, sync } = setup({ get: async () => { throw error; } });
    await sync();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.length).toBeLessThan(400);
  });

  test.each([
    ["a source on a remote host", { sources: [{ isDefault: true, hostId: "h2", path: "/x" }] }],
    ["a source with no path", { sources: [{ isDefault: true, hostId: "h1" }] }],
    ["no source", { sources: [] }],
  ])("%s gives one warning and no git", async (_name, project) => {
    const { warn, sync } = setup({ get: async () => project });
    await sync();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
