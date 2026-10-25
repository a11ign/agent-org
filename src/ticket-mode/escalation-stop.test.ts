// no-token: gh -- the hook decides on text, and the board's reading of an outcome is a pure function; nothing is spawned
//
// A11-257: only an item of the escalation list reaches a person. A planner or a worker that stops on any other question is refused by the Stop hook, told to settle it in the plan or the pull request, and held only
// for the bound every refusal has. A stop that names an item is allowed, and the board's card starts with the item's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { MAX_STOP_REFUSALS, stopVerdict, toolVerdict } from "./hook.ts";
import { ESCALATION_RULE, OFF_LIST_PREFIX } from "./escalation.ts";
import { parseOutcome } from "./pool-outcome.ts";
import { FINDINGS_GIVEN_FILE, FINDINGS_RETRIED_FILE, PUBLISH_FILE, QUESTION_FILE, TALK_FILE, WRITER_FILE } from "./worker-files.ts";

const write = (dir: string, outcome: object): void => writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));

/** A planning run's ticket dir: its outcome, the list its brief gave, and the ticket A11-257's plan folder holding `files` (file name to text). */
function planningRun(outcome: object, files: Record<string, string>) {
  const dir = tmpDir("ticket-hook-escalation-");
  write(dir, outcome);
  const planDir = join(dir, "plan", "A11-257");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(dir, FINDINGS_GIVEN_FILE), JSON.stringify([{ key: "A11-257", planDir, urls: [] }]));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(planDir, name), text);
  return { dir, planDir };
}

/** The agent writing its outcome again after a refusal: a file newer than the one refused. */
function writeAgain(dir: string, outcome: object): void {
  const later = Date.now() / 1000 + 5;
  write(dir, outcome);
  utimesSync(join(dir, "outcome.json"), later, later);
}

test("A11-257: a planner question off the list is refused and settled in the plan", () => {
  const asked = planningRun({ kind: "planned" }, { [QUESTION_FILE]: "The behaviour grill is needed. I would recommend the shorter wording.\n" });
  const refused = stopVerdict(asked.dir);
  assert.equal(refused.code, 2, "a QUESTION.md that names no item of the list is refused");
  const said = refused.say.join("\n");
  assert.ok(said.includes("A11-257:") && said.includes(QUESTION_FILE), "it names the ticket and the file");
  assert.ok(said.includes(ESCALATION_RULE), "it quotes the list");
  assert.match(said, /Decide it yourself now: where you would recommend an option, take it, record it under "Decisions made without a person"/);
  const unknown = planningRun({ kind: "planned" }, { [QUESTION_FILE]: "**Escalation:** silly\n\nWhich wording?\n" });
  assert.equal(stopVerdict(unknown.dir).code, 2, "an id that is not on the list is refused too");
});

test("A11-257: a planner that settles the question in its plan, and removes the QUESTION.md, may stop", () => {
  const asked = planningRun({ kind: "planned" }, { [QUESTION_FILE]: "Which wording?\n" });
  assert.equal(stopVerdict(asked.dir).code, 2);
  rmSync(join(asked.planDir, QUESTION_FILE));
  writeFileSync(join(asked.planDir, "A11-257-0001-plan.md"), "# Plan\n\n## Decisions made without a person\n\n- Product: the shorter wording. Reason: the board's other lists use it.\n");
  writeAgain(asked.dir, { kind: "planned" });
  assert.equal(stopVerdict(asked.dir).code, 0);
});

test("A11-257: a needs-human outcome that names no item, or one that is not on the list, is refused, and is held only for the bound every refusal has", () => {
  const dir = tmpDir("ticket-hook-escalation-");
  write(dir, { kind: "needs-human", reason: "which colour?" });
  const refused = stopVerdict(dir);
  assert.equal(refused.code, 2);
  assert.match(refused.say.join("\n"), /is a needs-human outcome that names no item of the escalation list, so this stop is refused/);
  write(dir, { kind: "needs-human", reason: "which colour?", escalation: "silly" });
  assert.match(stopVerdict(dir).say.join("\n"), /names "silly", which is not an item of the escalation list/);
  const bound = tmpDir("ticket-hook-escalation-");
  write(bound, { kind: "needs-human", reason: "the check never started" });
  assert.deepEqual(Array.from({ length: MAX_STOP_REFUSALS + 1 }, () => stopVerdict(bound).code), [2, 2, 0], "an agent is never held for ever: the board marks the stop that gets through");
});

test("A11-275: a worker that stops needs-human on an ask only the person's session can do is refused, and told to declare a `session` wait", () => {
  const dir = tmpDir("ticket-hook-escalation-");
  write(dir, { kind: "needs-human", reason: "run `agent-org update` on the Mac and quote its last line" });
  const refused = stopVerdict(dir);
  assert.equal(refused.code, 2, "an ask for the session names no item of the list, so it is no stop");
  const said = refused.say.join("\n");
  assert.ok(said.includes("\"waitingOn\": [ { \"session\": \"<the exact command, where it runs, and what a pass looks like>\" } ]"), "the refusal carries the shape of the wait it should declare");
  assert.ok(said.includes("`POST /api/session-asks/<KEY>/answer`"));
  write(dir, { kind: "working", reason: "needs the Mac", waitingOn: [{ session: "run `agent-org update` on the Mac and quote its last line" }], until: "2099-01-01T00:00:00Z" });
  assert.equal(stopVerdict(dir).code, 0, "the declared wait is the stop it is allowed");
});

test("A11-257: an on-list question still stops", () => {
  for (const id of ["outward", "access", "discard", "frozen", "legal", "reserved", "contradicts"]) {
    const dir = tmpDir("ticket-hook-escalation-");
    write(dir, { kind: "needs-human", reason: "post the release note to the forum?", escalation: id });
    assert.equal(stopVerdict(dir).code, 0, `needs-human naming ${id}`);
  }
  const asked = planningRun({ kind: "planned" }, { [QUESTION_FILE]: "**Escalation:** outward\n\nMay I post the release note to the forum?\n" });
  assert.equal(stopVerdict(asked.dir).code, 0, "a QUESTION.md that names an item stops the planner as it did");
});

test("A11-257: the board marks an on-list stop with its item's words, and one that names none as off the list", () => {
  const onList = parseOutcome(JSON.stringify({ kind: "needs-human", reason: "post the release note to the forum?", escalation: "outward" }));
  assert.deepEqual(onList, { kind: "needs-human", reason: "outward-facing — post the release note to the forum?", escalation: "outward" });
  const offList = parseOutcome(JSON.stringify({ kind: "needs-human", reason: "which colour?" }));
  assert.deepEqual(offList, { kind: "needs-human", reason: `${OFF_LIST_PREFIX} which colour?` });
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "needs-human", reason: "x", escalation: "silly" })), { kind: "needs-human", reason: `${OFF_LIST_PREFIX} x`, escalation: "silly" }, "an id that is not on the list is off the list");
  assert.deepEqual(parseOutcome(JSON.stringify({ kind: "needs-human", reason: "waiting for the person in the terminal" }), { talk: true }), { kind: "needs-human", reason: "waiting for the person in the terminal" }, "a talk session only says it waits");
});

test("A11-257: a talk session, a new-ticket run and a publish run may stop on a needs-human that names no item: a person is in the first, and the others report a failure", () => {
  for (const mark of [TALK_FILE, WRITER_FILE, PUBLISH_FILE]) {
    const dir = tmpDir("ticket-hook-escalation-");
    writeFileSync(join(dir, mark), "{}\n");
    write(dir, { kind: "needs-human", reason: "waiting for the person in the terminal" });
    assert.equal(stopVerdict(dir).code, 0, mark);
  }
  const plain = tmpDir("ticket-hook-escalation-");
  write(plain, { kind: "needs-human", reason: "waiting for the person in the terminal" });
  assert.equal(stopVerdict(plain).code, 2, "POSITIVE CONTROL: the same outcome in a run with no such mark is refused");
});

test("A11-257: a worker may not write the talk mark that exempts its run", () => {
  assert.equal(toolVerdict("Bash", { command: `echo > ${TALK_FILE}` }).code, 2);
});

test("A11-257: a list of plan folders the hook cannot read is not 'no question': the stop is allowed out loud, and a readable list is still checked", () => {
  const asked = planningRun({ kind: "planned" }, { [QUESTION_FILE]: "Which wording?\n" });
  assert.equal(stopVerdict(asked.dir).code, 2, "POSITIVE CONTROL: the same question with a readable list is refused");
  for (const broken of ["{not json", JSON.stringify({ key: "A11-257" }), JSON.stringify([{ key: "A11-257" }])]) {
    const run = planningRun({ kind: "planned" }, { [QUESTION_FILE]: "Which wording?\n" });
    writeFileSync(join(run.dir, FINDINGS_GIVEN_FILE), broken);
    writeFileSync(join(run.dir, FINDINGS_RETRIED_FILE), "{}\n"); // the blocker-findings retry is spent, so only this check speaks
    const verdict = stopVerdict(run.dir);
    assert.equal(verdict.code, 0, broken);
    assert.match(verdict.say.join("\n"), /so the plan's QUESTION\.md files were not checked against the escalation list and the stop is ALLOWED/, `${broken}: the skip is said out loud, not silent`);
  }
});
