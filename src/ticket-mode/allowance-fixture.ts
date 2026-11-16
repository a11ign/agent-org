// no-token: gh -- herdr, the tracker, the clock and the transcripts are fakes in a temporary folder; the pool is driven over them and nothing is spawned
// module: the runs the allowance tests drive (A11-434): live ticket runs on a clock the test moves, each with a Claude transcript the test writes to
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";

export const MIN = 60_000;
/** 13:00 UTC: the board's clock when the worker is refused. */
export const T0 = Date.UTC(2026, 10, 13, 13, 0, 0);
/** 14:00 UTC, the reset the message names. */
export const RESET = Date.UTC(2026, 10, 13, 14, 0, 0);
export const SAID = "You've hit your session limit · resets 2pm (UTC)";
/** The limit menu as Claude Code 2.1.299 drew it on the host (captured 2026-10-13), with this test's reset. */
export const MENU = [
  `  ⎿  ${SAID}`, "", "   What do you want to do?", "", "   ❯ 1. Stop and wait for limit to reset", "     2. Wait here, then continue automatically shortly",
  "     3. Switch to usage credits", "", "   Enter to confirm · Esc to cancel",
].join("\n");

/** One transcript line as Claude Code writes it: a reply of `role` saying `text` at `at`. */
const line = (role: "user" | "assistant", text: string, at: number): string =>
  JSON.stringify({ type: role, isSidechain: false, timestamp: new Date(at).toISOString(), message: { role, content: [{ type: "text", text }] } });

type Role = "user" | "assistant";

/**
 * The runs of `keys`, as many started as `max` allows and each started one seen working, on a clock the test moves, from half an hour before {@link T0}. Each started run has a transcript the test writes to with
 * `say(key, …)`; `advance` moves the clock and makes the board's next pass.
 */
export async function liveRuns(keys: readonly string[], max: number) {
  let clock = T0 - 30 * MIN;
  const made = poolFixture({ keys, max, now: () => clock });
  await made.pool.tick();
  const started = keys.filter((key) => made.entry(key).phase === "running");
  for (const key of started) made.status.set(herdrName(key), "working");
  await made.pool.tick();
  const dir = join(made.root, "transcripts", "-ticket-folder");
  mkdirSync(dir, { recursive: true });
  const lines = new Map<string, string[]>();
  const fileOf = (key: string) => join(dir, `session-${herdrName(key)}.jsonl`);
  const write = (key: string, text: string) => {
    writeFileSync(fileOf(key), text);
    utimesSync(fileOf(key), new Date(clock), new Date(clock));
  };
  const say = (key: string, role: Role, text: string, at = clock) => {
    const said = [...(lines.get(key) ?? []), line(role, text, at)];
    lines.set(key, said);
    writeFileSync(fileOf(key), `${said.join("\n")}\n`);
    utimesSync(fileOf(key), new Date(at), new Date(at));
  };
  for (const key of started) {
    say(key, "user", "Read the brief and follow it.");
    say(key, "assistant", "Reading the brief.");
  }
  const advance = async (ms: number) => { clock += ms; await made.pool.tick(); await new Promise<void>((resolve) => { setImmediate(resolve); }); };
  /** The prompts and keys the board sent to the agents, in order. */
  const prompts = () => made.herdr.calls.filter((args) => args[3] === "prompt" || args[3] === "send-keys");
  const status = (key: string, value: string) => made.status.set(herdrName(key), value);
  return { ...made, say, write, status, advance, prompts, now: () => clock, set: (at: number) => { clock = at; } };
}

/** NBF-1 started and seen working, alone on a board of one slot. */
export async function liveRun() {
  const runs = await liveRuns(["NBF-1"], 1);
  return {
    ...runs,
    name: herdrName("NBF-1"),
    say: (role: Role, text: string, at?: number) => runs.say("NBF-1", role, text, at),
    status: (value: string) => runs.status("NBF-1", value),
    /** The transcript's tail as nothing can read it: a line cut or half-written, with no whole entry after the last one the board read. */
    garble: (text: string) => runs.write("NBF-1", text),
  };
}

/** NBF-1 refused at 13:00 with the reset at 14:00 as its last reply, its agent idle, and the board's next pass made. */
export async function refusedIdle() {
  const run = await liveRun();
  run.set(T0);
  run.say("assistant", SAID);
  run.status("idle");
  await run.advance(MIN);
  return run;
}
