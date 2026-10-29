// no-token: gh -- herdr is an injected stand-in that refuses; nothing is spawned
// A11-282: the tick lists herdr without holding the board thread's loop. The synchronous `herdrRun` left herdr's own refusal in the journal on every pass; the asynchronous listing must not stop the watch in silence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";

/** What the process wrote to stderr while `run` ran. */
async function stderrDuring(run: () => Promise<void>): Promise<string> {
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((line: string) => { said.push(String(line)); return true; }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
  return said.join("");
}

/** An `execFile` failure as the asynchronous herdr rejects it: the command on the first line of its message, then what herdr printed on stderr. */
const refusal = (printed: string): Error => new Error(`Command failed: herdr --session tickets workspace list\n${printed}\n`);

test("A11-282: a herdr that refuses the tick's listing leaves its refusal on stderr, as the synchronous listing did, and the pass goes on", async () => {
  let printed = "the herdr server is not running";
  const fixture = poolFixture({ keys: ["NBF-1"] });
  const pool = fixture.restart({ herdr: () => { throw refusal(printed); } });
  const said = await stderrDuring(() => pool.tick());
  assert.match(said, /the herdr server is not running/);
  printed = "agent_not_found: no such agent";
  assert.equal(await stderrDuring(() => pool.tick()), "", "an answer that says a seat is gone is not journalled on every pass");
});
