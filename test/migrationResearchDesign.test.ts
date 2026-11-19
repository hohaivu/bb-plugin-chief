import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "../src/db/migrations";
import { createThreadStore } from "../src/db/threadStore";
import type { ManagedRow } from "../src/types";
import { disposals, disposeAll } from "./harness";

afterEach(disposeAll);

// The design fields' storage (docs/specs/research.md Data). The three columns are appended to MIGRATIONS (16bbc52 ended at 161 statements), so an upgraded database keeps every old row and old rows read as light.
describe("research_design, research_thread_id and waiting_on_user storage", () => {
  const BASE_COUNT = 161;
  const BASE_HASH = "e80886b9f6402b52630af5e53cb895ced22c6e9632d26a61a44bbdd8fe5b6eed";

  function database(id: string) {
    const { bb, harness } = createFakePluginHost({ pluginId: `chief-design-${id}` });
    disposals.push(() => harness.lifecycle.dispose());
    return { bb, db: bb.storage.database() };
  }
  const newRow = (threadId: string, extra: Record<string, unknown> = {}) => ({ threadId, role: "researcher" as const, projectId: "proj_1", chiefThreadId: "thr_chief", title: "Design · x", ...extra });

  // Contract (research.md Data): MIGRATIONS is append-only, so a database that ran the 161 statements of 16bbc52 upgrades in place. Regression: an edited or reordered earlier statement.
  test("the first 161 statements are the ones 16bbc52 shipped, and the design columns come after them", () => {
    expect(createHash("sha256").update(JSON.stringify(MIGRATIONS.slice(0, BASE_COUNT))).digest("hex")).toBe(BASE_HASH);
    const added = MIGRATIONS.slice(BASE_COUNT).join("\n");
    for (const column of ["research_design", "research_thread_id", "waiting_on_user"]) expect(added).toContain(column);
    for (const column of ["research_design", "research_thread_id", "waiting_on_user"]) expect(MIGRATIONS.slice(0, BASE_COUNT).join("\n")).not.toContain(column);
  });

  // Contract: an upgraded database keeps its rows, and a row written before the columns reads NULL, NULL and 0. Regression: a column added NOT NULL without a default, or a backfill that marks old researchers as design.
  test("upgrading keeps old rows and they read research_design NULL, research_thread_id NULL and waiting_on_user 0", () => {
    const { bb, db } = database("upgrade");
    bb.storage.migrate(db, MIGRATIONS.slice(0, BASE_COUNT));
    db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at)
      VALUES ('thr_old', 'researcher', 'proj_1', 'thr_chief', 'Research · old', 'ready', 1, 2)`).run();
    bb.storage.migrate(db, MIGRATIONS);
    expect(db.prepare(`SELECT title, state, research_design, research_thread_id, waiting_on_user FROM managed_threads WHERE thread_id='thr_old'`).get())
      .toEqual({ title: "Research · old", state: "ready", research_design: null, research_thread_id: null, waiting_on_user: 0 });
    expect(() => bb.storage.migrate(db, MIGRATIONS)).not.toThrow();
  });

  describe("the thread store", () => {
    function store(id: string) {
      const { bb, db } = database(id);
      bb.storage.migrate(db, MIGRATIONS);
      const threads = createThreadStore<ManagedRow>(db, { onReload() {} });
      return { threads, flag: (threadId: string) => (db.prepare(`SELECT research_design AS flag FROM managed_threads WHERE thread_id=?`).get(threadId) as { flag: number | null }).flag };
    }

    // Contract: research_design is 1 for a design launch and 0 for a light launch; a row with no value reads as light (NULL). Regression: the flag dropped or inverted on insert.
    test("a design insert stores 1, a light insert stores 0 and an insert without the field stores NULL", () => {
      const { threads, flag } = store("insert");
      threads.insert(newRow("thr_design", { researchDesign: true }));
      threads.insert(newRow("thr_light", { researchDesign: false }));
      threads.insert(newRow("thr_plain"));
      expect([flag("thr_design"), flag("thr_light"), flag("thr_plain")]).toEqual([1, 0, null]);
    });

    // Contract: a recovery row seeded before the launch insert keeps the launch's value, and an upsert without researchDesign keeps the stored one. Regression: the second write resetting the flag to NULL.
    test("a recovery row followed by the launch insert has 1, and a later upsert without the field keeps it", () => {
      const { threads, flag } = store("recovery");
      threads.insert(newRow("thr_r", { state: "active" }));
      expect(flag("thr_r")).toBeNull();
      threads.insert(newRow("thr_r", { researchDesign: true }));
      expect(flag("thr_r")).toBe(1);
      threads.insert(newRow("thr_r"));
      expect(flag("thr_r")).toBe(1);
    });

    // Contract: an explicit false stores 0, replacing a stored 1 or NULL. Regression: COALESCE treating false as absent.
    test("an explicit false stores 0 over a stored 1", () => {
      const { threads, flag } = store("false");
      threads.insert(newRow("thr_f", { researchDesign: true }));
      threads.insert(newRow("thr_f", { researchDesign: false }));
      expect(flag("thr_f")).toBe(0);
    });
  });
});
