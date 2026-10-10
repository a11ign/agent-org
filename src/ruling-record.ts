#!/usr/bin/env node
// @ts-check
// #2997: `ruling:record` AND THE TICK'S HALF THAT TOUCHES A FILE. A ruling that changes standing state is recorded WITH ITS CHECK, and the check is the completion:
//   pnpm run ruling:record --session=ceo --on=<issue> --check="<predicate>" [--check="<predicate>" ...] [--grace=<minutes>] [--at=<ISO time>]
// The predicate is from the closed vocabulary `ruling-check.ts` states. A ruling with no check is REFUSED, and so is a predicate outside it. The record is
// `rulings.jsonl` in the host's state directory, beside `org-retro-readings.jsonl`: APPEND-ONLY, one line per fact -- the ruling, then (at most) an `offered` line when
// the tick first posted on its issue, then (once) a `took-effect` line -- so nothing is ever rewritten and a half-written line costs one line.
// The record is idempotent: the same ruling (same issue, recorder and time) is recorded once.
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stateEntryPath } from "./host-config.ts";
import { refuseUnknownFlags } from "@a11ign/toolchain/lib/cli-flags";
import { DEFAULT_GRACE_MINUTES, parseCheck, settleRulings, rulingOrder } from "./ruling-check.ts";

export const RULINGS_FILE = "rulings.jsonl";
const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 };

/**
 * THE RULINGS, folded from the file's lines. `unreadable` is a file that exists and cannot be read as lines: the tick says so and reads nothing, never treats it as
 * "no rulings" (an unreadable record that read as empty would drop every ruling it held).
 * @param {string} stateDir
 * @returns {{ status: "none" | "read" | "unreadable", rulings: import("./ruling-check.ts").Ruling[] }}
 */
export function readRulings(stateDir: string): { status: "none" | "read" | "unreadable"; rulings: import("./ruling-check.ts").Ruling[]; } {
  let text;
  try {
    text = readFileSync(join(stateDir, RULINGS_FILE), "utf8");
  } catch (cause) {
    return { status: (cause as any)?.code === "ENOENT" ? "none" : "unreadable", rulings: [] };
  }
  const byId: Map<string, import("./ruling-check.ts").Ruling> = new Map();
  for (const line of text.split("\n").filter(Boolean)) {
    const entry = parseLine(line);
    if (entry === null) return { status: "unreadable", rulings: [] };
    foldInto(byId, entry);
  }
  return { status: "read", rulings: [...byId.values()] };
}

/** @param {string} line @returns {any | null} */
function parseLine(line: string): any | null {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === "object" && typeof entry.id === "string" ? entry : null;
  } catch {
    return null;
  }
}

/** @param {Map<string, any>} byId @param {any} entry */
function foldInto(byId: Map<string, any>, entry: any) {
  if (entry.event === undefined) {
    if (!byId.has(entry.id)) byId.set(entry.id, { id: entry.id, on: entry.on, by: entry.by, at: Date.parse(entry.at), checks: entry.check, grace: entry.grace,
      resolved: false, offeredAt: null });
    return;
  }
  const ruling = byId.get(entry.id);
  if (!ruling) return;
  if (entry.event === "took-effect") ruling.resolved = true;
  if (entry.event === "offered") ruling.offeredAt = Date.parse(entry.at);
}

/** @param {string} stateDir @returns {string} what the tick says when it cannot read the record: ONE sentence, for the gate and for `rulingTick` */
export const unreadableLine = (stateDir: string): string => `rulings: ${join(stateDir, RULINGS_FILE)} could not be read, so no ruling was checked this tick`;

/** @param {string} stateDir @param {object} line */
function append(stateDir: string, line: object) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, RULINGS_FILE), `${JSON.stringify(line)}\n`);
}

/**
 * RECORD A RULING, or refuse it by name: no check, a predicate outside the vocabulary, no recorder, a grace that is not a number of minutes.
 * @param {{ stateDir: string, by: string | undefined, on: number, checks: string[], at: string, grace?: number }} input
 * @returns {{ ok: true, id: string, fresh: boolean } | { ok: false, why: string }}
 */
export function recordRuling({ stateDir, by, on, checks, at, grace = DEFAULT_GRACE_MINUTES }: { stateDir: string; by: string | undefined; on: number; checks: string[]; at: string; grace?: number; }): { ok: true; id: string; fresh: boolean; } | { ok: false; why: string; } {
  if (!by) return { ok: false, why: "--session=<name> is required: the tick offers a ruling that has not taken effect to the session that recorded it" };
  if (!Number.isInteger(on) || on <= 0) return { ok: false, why: "--on=<issue number> is required: the ruling's own issue, where the tick posts" };
  if (checks.length === 0) return { ok: false, why: "a ruling is a claim about state; name the state: --check=\"<predicate>\" is required" };
  for (const text of checks) {
    const parsed = parseCheck(text);
    if (!parsed.ok) return { ok: false, why: parsed.why };
  }
  if (!Number.isFinite(Date.parse(at))) return { ok: false, why: `--at=${at} is not a time` };
  if (!Number.isFinite(grace) || grace < 0) return { ok: false, why: `--grace=${grace} is not a number of minutes` };
  const id = `r${on}-${Date.parse(at)}`;
  if (readRulings(stateDir).rulings.some((r) => r.id === id)) return { ok: true, id, fresh: false };
  append(stateDir, { id, on, by, at, check: checks, grace });
  return { ok: true, id, fresh: true };
}

/**
 * THE TICK'S RULING HALF, over a world it has already read: mark each passing ruling `took-effect`, post ONE line on the issue of each ruling that has just failed
 * past its grace (the first time only), and return the orders for the ones still failing. A refused record or an unread world is logged, never read as "no rulings".
 * `comment` throwing leaves the ruling un-marked, so the next tick tries again; the order is returned either way.
 * @param {{ stateDir: string, world: import("./ruling-check.ts").World, now: number, comment: (issue: number, line: string) => void, log?: (line: string) => void }} tick
 */
export function rulingTick({ stateDir, world, now, comment, log = () => {} }: { stateDir: string; world: import("./ruling-check.ts").World; now: number; comment: (issue: number, line: string) => void; log?: (line: string) => void; }) {
  const record = readRulings(stateDir);
  if (record.status === "unreadable") {
    log(unreadableLine(stateDir));
    return [];
  }
  return settleRulings(record.rulings, world, now).flatMap(({ ruling, action, reading }) => {
    if (action === "took-effect") append(stateDir, { id: ruling.id, event: "took-effect", at: new Date(now).toISOString() });
    if (action !== "offer") return [];
    if (ruling.offeredAt === null) postFirstLine({ stateDir, ruling, reading, now, comment, log });
    return [rulingOrder(ruling, reading, now)];
  });
}

/** @param {{ stateDir: string, ruling: import("./ruling-check.ts").Ruling, reading: import("./ruling-check.ts").Reading, now: number, comment: (issue: number, line: string) => void, log: (line: string) => void }} input */
function postFirstLine({ stateDir, ruling, reading, now, comment, log }: { stateDir: string; ruling: import("./ruling-check.ts").Ruling; reading: import("./ruling-check.ts").Reading; now: number; comment: (issue: number, line: string) => void; log: (line: string) => void; }) {
  try {
    comment(ruling.on, `Ruling ${ruling.id} has not taken effect: its check still fails at ${reading.failing.length} item(s) (${reading.failing.slice(0, 5).join(", ")}${reading.failing.length > 5 ? ", ..." : ""}). `
      + `\`${ruling.by}\` has been offered it; this is posted once.`);
    append(stateDir, { id: ruling.id, event: "offered", at: new Date(now).toISOString() });
  } catch (cause) {
    log(`rulings: could not post on #${ruling.on} (${(cause as Error).message.split("\n")[0]}); the next tick tries again`);
  }
}

/** @param {string[]} argv @param {string} name @returns {string[]} every value of `--name=v` or `--name v`, in order */
function valuesOf(argv: string[], name: string): string[] {
  return argv.flatMap((arg, index) => (arg.startsWith(`--${name}=`) ? [arg.slice(name.length + 3)] : arg === `--${name}` && argv[index + 1] !== undefined ? [argv[index + 1]] : []));
}

/** @param {string[]} argv */
export function main(argv: string[] = process.argv.slice(2), { stateDir = stateEntryPath(""), now = () => new Date().toISOString() } = {}) {
  const [on] = valuesOf(argv, "on");
  const [grace] = valuesOf(argv, "grace");
  const [at = now()] = valuesOf(argv, "at");
  const result = recordRuling({ stateDir, by: valuesOf(argv, "session")[0], on: Number(on), checks: valuesOf(argv, "check"), at, ...(grace !== undefined && { grace: Number(grace) }) });
  if (!result.ok) {
    process.stderr.write(`ruling:record: REFUSED -- ${result.why}. Nothing was recorded.\n`);
    return EXIT.REFUSED;
  }
  process.stdout.write(`${result.fresh ? "RECORDED" : "ALREADY RECORDED"} ${result.id} in ${join(stateDir, RULINGS_FILE)}\n`);
  return EXIT.OK;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  refuseUnknownFlags(["--session=", "--session", "--on=", "--on", "--check=", "--check", "--grace=", "--grace", "--at=", "--at"],
    { entry: import.meta.url, command: "node src/ruling-record.ts" });
  process.exitCode = main();
}
