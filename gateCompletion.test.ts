import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { CLOSE_OUT, disposeAll } from "./test/harness";
import { gateWorld } from "./test/gateWorld";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

describe("smoke", () => {
  test("approve and green tests pass the gate and complete the worker", async () => {
    const world = await gateWorld();
    const { worker } = await world.passed();
    await world.complete(worker.threadId);
    expect(world.row(worker.threadId).state).toBe("complete");
  });
});
