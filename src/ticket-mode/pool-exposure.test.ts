// no-token: gh -- herdr, the tracker, the clock and the serve check are injected; the pool is driven over fakes and nothing is spawned or served
// A11-279: the instance checks the board's and the terminal's serves at its first pass and as it runs, says each change once, and keeps the last result; a pool made without the check checks nothing
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { EXPOSURE_EVERY_MS } from "./pool-exposure.ts";
import type { ServeCheck } from "../install/service.ts";

const T0 = Date.UTC(2026, 9, 25, 16, 0, 0);

/** The lines the board's log gets while `body` runs. */
async function logged(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk).trimEnd()); return true; }) as typeof process.stderr.write;
  try {
    await body();
  } finally {
    process.stderr.write = write;
  }
  return lines.filter((line) => line.startsWith("ticket:serve: "));
}

/** A pool whose serve check answers what `answer` holds now, and counts the checks. */
function checked(initial: readonly ServeCheck[]) {
  let clock = T0;
  const made = poolFixture({ keys: [], now: () => clock });
  const held = { answer: initial, asked: 0, failure: null as Error | null };
  const pool = made.restart({ serveCheck: async () => { held.asked += 1; if (held.failure !== null) throw held.failure; return held.answer; } });
  return { made, held, pool, advance: async (ms: number) => { clock += ms; await pool.tick(); } };
}

const UI_BACK: ServeCheck = { service: "ui", state: "reapplied", port: 9443 };
const TERMINAL_BACK: ServeCheck = { service: "terminal", state: "reapplied", port: 9444 };

test("A11-279: the serves are checked in the instance's first pass, and a serve that was gone is said to be put back", async () => {
  const run = checked([UI_BACK, TERMINAL_BACK]);
  const lines = await logged(() => run.pool.tick());
  assert.equal(run.held.asked, 1, "checked at the first pass, with nothing else started");
  assert.deepEqual(lines, ["ticket:serve: the ui (port 9443) serve was gone, and the board put it back", "ticket:serve: the terminal (port 9444) serve was gone, and the board put it back"]);
});

test("A11-279: the serves are checked again every EXPOSURE_EVERY_MS and not on each tick, so a serve lost while the instance runs is put back", async () => {
  const run = checked([{ service: "ui", state: "present", port: 9443 }]);
  await run.pool.tick();
  await run.advance(EXPOSURE_EVERY_MS - 1);
  assert.equal(run.held.asked, 1, "a wake just after a check does not spawn tailscale again");
  run.held.answer = [UI_BACK];
  const lines = await logged(() => run.advance(1));
  assert.equal(run.held.asked, 2);
  assert.deepEqual(lines, ["ticket:serve: the ui (port 9443) serve was gone, and the board put it back"]);
});

test("A11-279: a port another entry holds and a serve that could not be made are said once each, with the reason, and the instance goes on", async () => {
  const foreign: ServeCheck = { service: "ui", state: "foreign", port: 9443, why: "port 9443 already serves http://127.0.0.1:9999 on the tailnet" };
  const refused: ServeCheck = { service: "terminal", state: "refused", port: 9444, why: "Tailscale is Stopped, not Running" };
  const run = checked([foreign, refused]);
  const first = await logged(() => run.pool.tick());
  assert.deepEqual(first, [
    "ticket:serve: the ui (port 9443) serve is held by another entry, which the board leaves alone: port 9443 already serves http://127.0.0.1:9999 on the tailnet",
    "ticket:serve: the terminal (port 9444) serve is not in place and the board could not put it back: Tailscale is Stopped, not Running",
  ]);
  assert.deepEqual(await logged(() => run.advance(EXPOSURE_EVERY_MS * 5)), [], "the same finding is not said again");
  run.held.answer = [{ service: "ui", state: "present", port: 9443 }, { service: "terminal", state: "present", port: 9444 }];
  await run.advance(EXPOSURE_EVERY_MS * 5);
  run.held.answer = [refused];
  assert.equal((await logged(() => run.advance(EXPOSURE_EVERY_MS))).length, 1, "a loss after the serve was back is said again");
});

test("A11-279: the last result is kept for the board, and a check that throws is said and tried again", async () => {
  const run = checked([UI_BACK]);
  run.held.failure = new Error("tailscale is not on PATH\nsecond line");
  const lines = await logged(() => run.pool.tick());
  assert.deepEqual(lines, ["ticket:serve: the serves could not be checked: tailscale is not on PATH"]);
  run.held.failure = null;
  await run.advance(EXPOSURE_EVERY_MS);
  assert.equal(run.held.asked, 2, "tried again at the next check");
});

test("A11-279: a pool made without a serve check checks nothing", async () => {
  const made = poolFixture({ keys: [] });
  assert.deepEqual(await logged(() => made.pool.tick()), []);
});

test("A11-279: after a check that could not read or serve a port, the next is five intervals later, so a tailscaled that does not answer is not waited for each time", async () => {
  const refused: ServeCheck = { service: "ui", state: "refused", port: 9443, why: "tailscale did not answer" };
  const run = checked([refused]);
  await run.pool.tick();
  await run.advance(EXPOSURE_EVERY_MS * 5 - 1);
  assert.equal(run.held.asked, 1, "not asked again before five intervals");
  await run.advance(1);
  assert.equal(run.held.asked, 2);
});
