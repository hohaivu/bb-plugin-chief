import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { start, type setup } from "./harness";

type State = Awaited<ReturnType<typeof setup>>;
const saved: Record<string, string | undefined> = {};

/** Points HOME and CLAUDE_CONFIG_DIR at a temp dir, so no adapter can read the real ~/.claude or ~/.gemini. Call `restoreEnv` in afterEach. */
export async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), "chief-home-"));
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR"]) saved[key] ??= process.env[key];
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  return home;
}
export function restoreEnv() {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; delete saved[key]; }
}

export const putFile = async (path: string, text: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
export const jsonl = (...lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
export const localDay = (at = Date.now()) => new Date(at).toLocaleDateString("en-CA");

/** The primary host, a temp HOME, and thread events answered per thread and per requested type (the fake host ignores `types`). */
export async function dailyWorld(state: State) {
  const home = await tempHome();
  const events = new Map<string, any[]>();
  state.harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
  state.harness.sdk.stub("threads.events.list", async ({ threadId, types }: { threadId: string; types?: string[] }) => (events.get(threadId) ?? []).filter((event) => !types || types.includes(event.type)));
  await state.harness.behavior.setSettings({ chiefProject: "proj_1" });
  const chief = (await start(state)).threadId;
  return {
    home, chief, dataDir: state.storageRoot,
    identify: (threadId: string, providerThreadId: string) => events.set(threadId, [{ type: "thread/identity", seq: 1, createdAt: Date.now(), data: { providerThreadId } }, ...(events.get(threadId) ?? [])]),
    run: async () => {
      await state.harness.behavior.runSchedule("daily-report");
      const alerts = state.db.prepare(`SELECT dedupe_key, message FROM alert_outbox WHERE dedupe_key LIKE '%:daily:%'`).all() as { dedupe_key: string; message: string }[];
      return { alerts, path: /^Daily Chief report: (.+)$/m.exec(alerts[0]?.message ?? "")?.[1] };
    },
  };
}
