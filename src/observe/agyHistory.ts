import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { clip } from "../core/text";
import { execFileAsync } from "../runtime/exec";

export interface DecodedText { path: string; text: string }
export interface AgyStep { idx: number; stepType: number; status: number; texts: DecodedText[]; error?: string }
export type AgyRead =
  | { status: "ok"; steps: AgyStep[] }
  | { status: "skipped" | "unavailable" | "missing"; note: string; steps: [] };

const MAX_DEPTH = 8;
const MIN_TEXT = 4;
const MAX_PAYLOAD_BYTES = 262_144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function varint(buf: Uint8Array, at: number): [number, number] | null {
  let value = 0;
  for (let shift = 0; shift < 10; shift += 1) {
    const byte = buf[at + shift];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * 2 ** (7 * shift);
    if (!(byte & 0x80)) return [value, at + shift + 1];
  }
  return null;
}

/** The printable UTF-8 text of a leaf, or null when it is binary, too short, or only the conversation uuid. */
function textOf(buf: Uint8Array): string | null {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return null; }
  const trimmed = text.trim();
  return trimmed.length >= MIN_TEXT && !CONTROL.test(text) && !UUID.test(trimmed) ? text : null;
}

/** One level of the wire walk. False when the bytes are not a valid message, so a caller keeps them as text instead. */
function walk(buf: Uint8Array, prefix: string, depth: number, out: DecodedText[]): boolean {
  let at = 0;
  while (at < buf.length) {
    const tag = varint(buf, at);
    if (!tag) return false;
    at = tag[1];
    const field = Math.floor(tag[0] / 8);
    if (field === 0) return false;
    const wire = tag[0] % 8;
    if (wire === 0) {
      const value = varint(buf, at);
      if (!value) return false;
      at = value[1];
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
      if (at > buf.length) return false;
    } else if (wire === 2) {
      const length = varint(buf, at);
      if (!length || length[1] + length[0] > buf.length) return false;
      const sub = buf.subarray(length[1], length[1] + length[0]);
      at = length[1] + length[0];
      const path = `${prefix}.${field}`;
      const nested: DecodedText[] = [];
      if (depth > 0 && sub.length && walk(sub, path, depth - 1, nested) && nested.length) out.push(...nested);
      else {
        const text = textOf(sub);
        if (text !== null) out.push({ path, text });
      }
    } else return false; // groups and the unused wire types: not protobuf
  }
  return true;
}

/** shortcut: schema-less decode, field meanings unknown beyond tool name/args and text; add the .proto if one is published.
 * Every printable UTF-8 leaf of 4+ characters, with its field path; a malformed buffer gives [] and never throws. */
export function decodeFields(buf: Uint8Array, depth = MAX_DEPTH): DecodedText[] {
  try {
    const out: DecodedText[] = [];
    return walk(buf, "", Math.min(depth, MAX_DEPTH), out) ? out : [];
  } catch {
    return [];
  }
}

/** The steps of one agy conversation db, oldest first (or the newest `limit` steps, still in order, when `newest`). Strictly read-only: the
 * sqlite3 CLI with -readonly and mode=ro. Never throws: every failure is a status that says why, and an empty history behind an
 * uncheckpointed WAL is "unavailable", never "ok". */
export async function readAgySteps(dbPath: string, limit: number, newest = false): Promise<AgyRead> {
  try { await access(dbPath); } catch { return { status: "missing", note: "not on this machine", steps: [] }; }
  const n = Math.max(1, Math.floor(limit));
  // Payloads over 256 KiB (system instructions, file dumps) are left out rather than half-decoded.
  const hex = (column: string) => `case when length(${column}) <= ${MAX_PAYLOAD_BYTES} then hex(${column}) end`;
  const sql = `select idx, step_type, status, ${hex("step_payload")} p, ${hex("error_details")} e from steps order by idx ${newest ? "desc" : ""} limit ${n}`;
  let rows: { idx: number; step_type: number; status: number; p: string | null; e: string | null }[];
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", `${pathToFileURL(dbPath).href}?mode=ro`, sql], { timeout: 15_000, maxBuffer: 256 * 1024 * 1024 });
    rows = stdout.trim() ? JSON.parse(stdout) : []; // sqlite3 -json prints nothing for zero rows
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return { status: "skipped", note: "the sqlite3 CLI is not installed on the plugin server", steps: [] };
    return { status: "unavailable", note: clip(String((error as Error)?.message ?? error).replace(/\s+/g, " "), 200), steps: [] };
  }
  if (!rows.length) {
    const wal = await access(`${dbPath}-wal`).then(() => true, () => false);
    return wal ? { status: "unavailable", note: "uncheckpointed WAL: the history is not readable read-only", steps: [] } : { status: "ok", steps: [] };
  }
  if (newest) rows.reverse();
  const steps = rows.map((row): AgyStep => {
    const step: AgyStep = { idx: row.idx, stepType: row.step_type, status: row.status, texts: row.p ? decodeFields(Buffer.from(row.p, "hex")) : [] };
    if (row.status === 6 || row.status === 7) {
      const raw = row.e ? Buffer.from(row.e, "hex") : null;
      const error = raw && (decodeFields(raw).map((field) => field.text).join(" | ") || textOf(raw));
      if (error) step.error = clip(error, 300);
    }
    return step;
  });
  return { status: "ok", steps };
}
