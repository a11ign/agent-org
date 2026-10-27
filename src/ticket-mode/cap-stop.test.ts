// no-token: gh -- the hook decides on files; nothing is spawned
// module: the Stop hook on the planner's round at the board's round cap (A11-343) -- it must decide before it ends `reviewed`, and it may stop on an item of the escalation list instead
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { stopVerdict } from "./hook.ts";
import { CAP_DECISION_FILE, CAP_PLANNER_FILE } from "./cap-files.ts";
import { parseCapDecision } from "./cap-decision.ts";

const write = (dir: string, outcome: object): void => writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));

/** The agent writing its outcome again after a refusal: a file newer than the one refused, and the count of refusals in a row started again. */
function writeAgain(dir: string, outcome: object): void {
  rmSync(join(dir, "stop-refusals"), { force: true });
  const later = Date.now() / 1000 + 5;
  write(dir, outcome);
  utimesSync(join(dir, "outcome.json"), later, later);
}

/** The planner's round at the cap: the board left its mark. */
function capRound(outcome: object = { kind: "reviewed" }) {
  const dir = tmpDir("ticket-hook-cap-");
  write(dir, outcome);
  writeFileSync(join(dir, CAP_PLANNER_FILE), "\n");
  return dir;
}

test("A11-343: the planner's round at the cap is refused until it has written a decision, and says which two it may write and how to escalate", () => {
  const dir = capRound();
  const refused = stopVerdict(dir);
  assert.equal(refused.code, 2);
  const said = refused.say.join("\n");
  assert.match(said, /cap-decision\.json is not there/);
  assert.match(said, /"decision": "round"/);
  assert.match(said, /"decision": "waiting", "ticket": "<KEY>"/);
  assert.match(said, /needs-human/);
});

/** The planner's round whose decision file says `decision`, ending `reviewed` again after the refusal before it: what the hook then says. */
const saysOf = (dir: string, decision: object): string => {
  writeFileSync(join(dir, CAP_DECISION_FILE), JSON.stringify(decision));
  writeAgain(dir, { kind: "reviewed" });
  return stopVerdict(dir).say.join("\n");
};

test("A11-343: a `round` decision needs its reason, and a `waiting` one needs the key of a ticket", () => {
  const dir = capRound();
  assert.match(saysOf(dir, { decision: "round", reason: "  " }), /needs a reason/);
  assert.match(saysOf(dir, { decision: "waiting", reason: "needs the Auth0 fix" }), /needs ticket: the key of the ticket to wait on/);
  assert.match(saysOf(dir, { decision: "waiting", ticket: "the auth ticket", reason: "needs the Auth0 fix" }), /needs ticket/);
  assert.match(saysOf(dir, { decision: "upheld", reason: "that is the stand-off's word" }), /needs decision: "round" or "waiting"/);
});

test("A11-343: either decision lets the round end, and an escalation needs no decision file", () => {
  const round = capRound();
  writeFileSync(join(round, CAP_DECISION_FILE), JSON.stringify({ decision: "round", reason: "answer the comment, and say the red check is A11-61's" }));
  assert.equal(stopVerdict(round).code, 0);
  const waiting = capRound();
  writeFileSync(join(waiting, CAP_DECISION_FILE), JSON.stringify({ decision: "waiting", ticket: "A11-341", reason: "capture stays red until A11-341 merges" }));
  assert.equal(stopVerdict(waiting).code, 0);
  const escalated = capRound({ kind: "needs-human", reason: "the feedback asks for a new colour", escalation: "reserved" });
  assert.equal(stopVerdict(escalated).code, 0);
});

test("A11-343: an escalation that names no item of the list is refused, as it is in every other round", () => {
  const dir = capRound({ kind: "needs-human", reason: "the pull request keeps getting feedback" });
  assert.equal(stopVerdict(dir).code, 2);
});

test("A11-343: a decision is read as the board reads it: a ticket key, with its team prefix and number", () => {
  assert.deepEqual(parseCapDecision(JSON.stringify({ decision: "waiting", ticket: " A11-341 ", reason: " why " }), "f"), { decision: "waiting", ticket: "A11-341", reason: "why" });
  assert.equal(typeof parseCapDecision(JSON.stringify({ decision: "waiting", ticket: "341", reason: "why" }), "f"), "string");
  assert.equal(typeof parseCapDecision("{", "f"), "string");
});
