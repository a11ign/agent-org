// no-token: none -- pure functions; nothing is spawned
//
// A11-241: herdr 0.9.3 refuses an agent name that is not `^[a-z][a-z0-9_-]{0,31}$`, and `reviewer-announcement-emulator-11` is 33 characters. `herdrAgentName` is the one function every
// `herdr agent <verb> <name>` call passes its label through; these hold it to herdr's rule for every kind of name the board makes, with inputs longer than any today's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HERDR_AGENT_NAME, agentStartArgs, herdrAgentName } from "./herdr-agents.ts";
import { reviewerInstance, reviewerSeat, seatName } from "./review-attribution.ts";
import { herdrName } from "./ticket-mode/pool-herdr.ts";

const LONG_KEY = "announcement-emulator-with-a-very-long-repository-name";

/** One name of every kind the board gives a herdr agent, built from inputs longer than any in use. */
function longNames(): Record<string, string> {
  return {
    reviewerSeat: reviewerSeat({ repoKey: LONG_KEY, number: 123456 }),
    reviewerSeatShortKey: reviewerSeat({ repoKey: "a", number: 7 }),
    reviewerPrimary: reviewerSeat({ repoKey: "", number: 7 }),
    worker: seatName("worker", LONG_KEY, 4096),
    ticketRun: herdrName("NBF-1270-AND-A-VERY-LONG-TRACKER-KEY-12345678"),
    batchPlanner: herdrName("b1761379186000-12345678901234567890"),
    writer: herdrName(`writer-w${"z".repeat(40)}`),
    publish: herdrName(`publish-p${"z".repeat(40)}`),
    notALetterFirst: "123-" + "x".repeat(40),
    upperAndSymbols: "Reviewer.Some Repo/With Symbols-" + "9".repeat(40),
    empty: "",
  };
}

test("A11-241: every kind of herdr agent name, from long inputs, is within 32 characters and matches herdr's pattern", () => {
  for (const [kind, full] of Object.entries(longNames())) {
    const name = herdrAgentName(full);
    assert.match(name, HERDR_AGENT_NAME, `${kind}: ${name}`);
    assert.ok(name.length <= 32, `${kind}: ${name} is ${name.length} characters`);
  }
  // The names the board makes itself are already within the rule, whatever their inputs.
  for (const name of [longNames().ticketRun, longNames().batchPlanner, longNames().writer, longNames().publish]) assert.match(name, HERDR_AGENT_NAME);
});

test("A11-241: a name herdr already accepts comes back unchanged, so no running agent changes name", () => {
  for (const name of ["reviewer-announcement-emulator-9", "t-nbf-1270", "worker-3", "reviewer-7", "ceo", "orchestrator", "a", "a".repeat(32), "a_b-c9"]) {
    assert.equal(herdrAgentName(name), name);
  }
  assert.equal(herdrName("NBF-1270"), "t-nbf-1270", "a ticket's key is lowercased, as it was");
});

test("A11-241: a name that is not valid is made valid, and the same each time", () => {
  assert.equal(herdrAgentName("SMOKE-1"), "smoke-1");
  assert.equal(herdrAgentName("a.b c"), "a-b-c");
  assert.equal(herdrAgentName("9lives"), "x-9lives");
  assert.equal(herdrAgentName(""), "x-");
  assert.match(herdrAgentName(""), HERDR_AGENT_NAME);
});

test("A11-241: reviewer-announcement-emulator-11 keeps its prefix and its number, and is exactly 32 characters", () => {
  const name = herdrAgentName("reviewer-announcement-emulator-11");
  assert.equal(name.length, 32);
  assert.match(name, /^reviewer-announcemen-11-[0-9a-f]{8}$/);
  assert.equal(herdrAgentName("reviewer-announcement-emulator-11"), name, "the same each time");
  assert.equal(herdrAgentName("reviewer-announcement-emulator-9"), "reviewer-announcement-emulator-9", "the 32-character label that worked is not renamed");
});

test("A11-241: 1,000 synthetic targets get 1,000 distinct names, stable across calls", () => {
  const fulls: string[] = [];
  for (let n = 1; n <= 1000; n += 1) fulls.push(reviewerSeat({ repoKey: LONG_KEY, number: n }));
  // Long keys that share a 25-character prefix, and the same number.
  for (let k = 0; k < 100; k += 1) fulls.push(reviewerSeat({ repoKey: `announcement-emulator-${String(k).padStart(3, "0")}-tail`, number: 11 }));
  const first = fulls.map(herdrAgentName);
  assert.equal(new Set(fulls).size, fulls.length);
  assert.equal(new Set(first).size, fulls.length, "no two targets share an agent name");
  assert.deepEqual(fulls.map(herdrAgentName), first, "the same names on a second call");
  for (const name of first) assert.match(name, HERDR_AGENT_NAME);
});

test("A11-241: the number the hash replaces the rest of is kept readable, and a number too long to keep is left to the hash", () => {
  assert.match(herdrAgentName(`reviewer-${LONG_KEY}-123456`), /^reviewer-.*-123456-[0-9a-f]{8}$/);
  const huge = herdrAgentName(`reviewer-${LONG_KEY}-${"9".repeat(30)}`);
  assert.match(huge, /^reviewer-[a-z-]*-[0-9a-f]{8}$/);
  assert.ok(huge.length <= 32);
});

test("A11-241: the seat label stays parseable by its own reader, and the agent start names the shortened agent", () => {
  const label = reviewerSeat({ repoKey: "announcement-emulator", number: 11 });
  assert.deepEqual(reviewerInstance(label), { key: "announcement-emulator", number: 11 });
  const args = agentStartArgs(label, "codex", "w1:p1", ["--flag"], { session: "tickets" });
  assert.deepEqual(args, ["--session", "tickets", "agent", "start", herdrAgentName(label), "--kind", "codex", "--pane", "w1:p1", "--", "--flag"]);
  assert.ok(args[4].length <= 32);
});
