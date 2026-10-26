// no-token: gh -- the hook decides on files and on a `pull` stub that answers what `gh pr view` would; nothing is spawned
// module: the Stop hook on the two rounds of a stand-off (A11-290) -- a second reply with no change at the same head is refused, and the planner's round must decide
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { MAX_STOP_REFUSALS, stopVerdict } from "./hook.ts";
import { escalationList } from "./escalation.ts";
import { bodyHash } from "./standoff-body-hash.ts";
import { STANDOFF_DECISION_FILE, STANDOFF_PLANNER_FILE, STANDOFF_ROUND_FILE } from "./standoff-files.ts";

const URL = "https://github.com/a11ign/agent-org/pull/1933";
const DESCRIPTION = "Closes A11-270\n\nThe bundle is 340 KB.\n";

const write = (dir: string, outcome: object): void => writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));

/** The agent writing its outcome again after a refusal: a file newer than the one refused. */
function writeAgain(dir: string, outcome: object): void {
  // The count of refusals in a row starts again for a new kind of mistake, as the test reads one refusal at a time.
  rmSync(join(dir, "stop-refusals"), { force: true });
  const later = Date.now() / 1000 + 5;
  write(dir, outcome);
  utimesSync(join(dir, "outcome.json"), later, later);
}

/** The worker's round for a stand-off: the board left `standoff-round.json` with the head and the description's hash the pull request had when the round began. */
function workerRound(outcome: object = { kind: "reviewed" }) {
  const dir = tmpDir("ticket-hook-standoff-");
  write(dir, outcome);
  writeFileSync(join(dir, STANDOFF_ROUND_FILE), JSON.stringify({ [URL]: { head: "h1", body: bodyHash(DESCRIPTION) } }));
  return dir;
}

test("A11-290: a stand-off round that says reviewed with the head and the description as they were is refused, naming the escalation list", () => {
  const dir = workerRound();
  const refused = stopVerdict(dir, { pull: () => ({ head: "h1", body: DESCRIPTION }) });
  assert.equal(refused.code, 2);
  const said = refused.say.join("\n");
  assert.match(said, /second reply with no change/);
  assert.ok(said.includes(URL));
  assert.ok(said.includes(escalationList()), "the only other way out is an item of the list");
});

test("A11-290: a push, or a changed measurement in the description, lets the round end reviewed", () => {
  const pushed = workerRound();
  assert.equal(stopVerdict(pushed, { pull: () => ({ head: "h2", body: DESCRIPTION }) }).code, 0, "the head moved");
  const measured = workerRound();
  assert.equal(stopVerdict(measured, { pull: () => ({ head: "h1", body: DESCRIPTION.replace("340 KB", "180 KB, measured with the production build") }) }).code, 0, "the description's evidence changed");
});

test("A11-290: a stand-off round may stop on an item of the escalation list, and a pull request gh cannot read allows the stop out loud", () => {
  const dir = workerRound({ kind: "needs-human", reason: "the fix needs a new dependency licence", escalation: "legal" });
  assert.equal(stopVerdict(dir, { pull: () => ({ head: "h1", body: DESCRIPTION }) }).code, 0);
  const unread = workerRound();
  const allowed = stopVerdict(unread, { pull: () => null });
  assert.equal(allowed.code, 0);
  assert.match(allowed.say.join("\n"), /could not be read, so the stand-off round's change was not checked and the stop is ALLOWED/);
});

test("A11-290: the refusal is counted and bounded like every other, so a worker is never held for ever", () => {
  const dir = workerRound();
  const pull = () => ({ head: "h1", body: DESCRIPTION });
  for (let refusal = 0; refusal < MAX_STOP_REFUSALS; refusal += 1) assert.equal(stopVerdict(dir, { pull }).code, 2);
  assert.equal(stopVerdict(dir, { pull }).code, 0);
});

test("A11-290: a run that is no stand-off round is judged as before", () => {
  const dir = tmpDir("ticket-hook-standoff-");
  write(dir, { kind: "reviewed" });
  assert.equal(stopVerdict(dir, { pull: () => { throw new Error("asked about a pull request of a run with no stand-off"); } }).code, 0);
});

/** The planner's round for a stand-off: the board left its mark. */
function plannerRound() {
  const dir = tmpDir("ticket-hook-standoff-");
  write(dir, { kind: "reviewed" });
  writeFileSync(join(dir, STANDOFF_PLANNER_FILE), "\n");
  return dir;
}

test("A11-290: the planner's round is refused until it has decided, and an amended decision needs the amended plan", () => {
  const dir = plannerRound();
  assert.match(stopVerdict(dir).say.join("\n"), /standoff-decision\.json is not there/);
  writeFileSync(join(dir, STANDOFF_DECISION_FILE), JSON.stringify({ decision: "maybe", reason: "x" }));
  writeAgain(dir, { kind: "reviewed" });
  assert.match(stopVerdict(dir).say.join("\n"), /needs decision: "amended" or "upheld"/);
  writeFileSync(join(dir, STANDOFF_DECISION_FILE), JSON.stringify({ decision: "amended", reason: "the 200 KB limit cannot be met" }));
  writeAgain(dir, { kind: "reviewed" });
  assert.match(stopVerdict(dir).say.join("\n"), /holds no amended plan file/);
  mkdirSync(join(dir, "plan"), { recursive: true });
  writeFileSync(join(dir, "plan", "A11-270-plan-1.md"), "# Plan\n");
  writeAgain(dir, { kind: "reviewed" });
  assert.equal(stopVerdict(dir).code, 0);
});

test("A11-290: an upheld decision needs no plan file, only its reason", () => {
  const dir = plannerRound();
  writeFileSync(join(dir, STANDOFF_DECISION_FILE), JSON.stringify({ decision: "upheld", reason: "the entry point can be split" }));
  assert.equal(stopVerdict(dir).code, 0);
  writeFileSync(join(dir, STANDOFF_DECISION_FILE), JSON.stringify({ decision: "upheld", reason: "  " }));
  writeAgain(dir, { kind: "reviewed" });
  assert.match(stopVerdict(dir).say.join("\n"), /needs a reason/);
});
