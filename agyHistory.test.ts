import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { decodeFields, failedStatus, readAgySteps } from "./src/observe/agyHistory";

// A hand-encoded protobuf: varint tags, length-delimited fields only.
const varint = (value: number) => { const out: number[] = []; let rest = value; while (rest > 0x7f) { out.push((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128); } out.push(rest); return out; };
const field = (number: number, payload: Uint8Array | string) => {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  return Uint8Array.from([...varint(number * 8 + 2), ...varint(bytes.length), ...bytes]);
};
const message = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));

describe("agy decodeFields", () => {
  test("decodes the tool name and its JSON arguments out of a nested message", () => {
    const buf = message(field(1, message(field(2, "view_file"), field(3, '{"AbsolutePath":"/x"}'))));
    const texts = decodeFields(buf).map((entry) => entry.text);
    expect(texts).toEqual(["view_file", '{"AbsolutePath":"/x"}']);
    expect(decodeFields(buf).map((entry) => entry.path)).toEqual([".1.2", ".1.3"]);
  });

  test("a malformed buffer gives an empty list and never throws", () => {
    expect(decodeFields(Uint8Array.from([0x0a, 0xff, 0x01, 0x41]))).toEqual([]); // declared length overruns the buffer
    expect(decodeFields(Uint8Array.from([0x80]))).toEqual([]); // unterminated varint
    expect(decodeFields(new Uint8Array())).toEqual([]);
  });

  test("leaves short, binary and uuid-only leaves out", () => {
    const buf = message(field(1, "ab"), field(2, Uint8Array.from([1, 2, 3, 4, 5])), field(3, "123e4567-e89b-12d3-a456-426614174000"), field(4, "kept text"));
    expect(decodeFields(buf).map((entry) => entry.text)).toEqual(["kept text"]);
  });

  test("statuses 6 and 7 are the failures", () => {
    expect([5, 6, 7, 8].map(failedStatus)).toEqual([false, true, true, false]);
  });
});

describe("agy readAgySteps (temp conversation db)", () => {
  let dir: string;
  const hasCli = (() => { try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "agy-")); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  function build(name: string, steps: { idx: number; type: number; status: number; payload?: Uint8Array; error?: Uint8Array }[]) {
    const path = join(dir, name);
    const db = new Database(path);
    db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB)");
    const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?)");
    for (const step of steps) insert.run(step.idx, step.type, step.status, step.payload ? Buffer.from(step.payload) : null, step.error ? Buffer.from(step.error) : null);
    db.close();
    return path;
  }

  test.skipIf(!hasCli)("reads steps in order with decoded payloads and the error of a failed step", async () => {
    const path = build("a.db", [
      { idx: 1, type: 5, status: 3, payload: message(field(1, message(field(2, "view_file"), field(3, '{"AbsolutePath":"/x"}')))) },
      { idx: 2, type: 5, status: 6, error: message(field(1, "permission denied")) },
      { idx: 3, type: 5, status: 7, error: message(field(1, "tool crashed")) },
    ]);
    const read = await readAgySteps(path, 10);
    if (read.status !== "ok") throw new Error(`unexpected ${read.status}`);
    expect(read.steps.map((step) => step.idx)).toEqual([1, 2, 3]);
    expect(read.steps[0]!.texts.map((entry) => entry.text)).toEqual(["view_file", '{"AbsolutePath":"/x"}']);
    expect(read.steps[0]!.error).toBeUndefined();
    expect(read.steps[1]!.error).toContain("permission denied");
    expect(read.steps[2]!.error).toContain("tool crashed");
  });

  test.skipIf(!hasCli)("newest returns the last N steps, still oldest first", async () => {
    const path = build("b.db", [1, 2, 3, 4].map((idx) => ({ idx, type: 5, status: 3 })));
    const read = await readAgySteps(path, 2, true);
    expect(read.status === "ok" && read.steps.map((step) => step.idx)).toEqual([3, 4]);
  });

  test.skipIf(!hasCli)("an empty history beside a -wal file is unavailable, never ok", async () => {
    const path = build("c.db", []);
    expect(await readAgySteps(path, 10)).toMatchObject({ status: "ok", steps: [] });
    await writeFile(`${path}-wal`, "");
    expect(await readAgySteps(path, 10)).toMatchObject({ status: "unavailable", steps: [] });
  });

  test("a db that is not on this machine is missing", async () => {
    expect(await readAgySteps(join(dir, "none.db"), 10)).toMatchObject({ status: "missing", steps: [] });
  });
});
