// no-token: gh
//
// #4229: A `Waiting-for:` THE GATE CANNOT READ IS REFUSED WHERE IT IS WRITTEN. #4090 was parked 2026-10-08T09:37Z on a sentence; the condition
// was true at 10:22Z and the row sat about ten hours, because `parseWaits` keeps such a line as `unreadable` and nothing acts on one.
//
// EVERY CASE GOES THROUGH `fileRefusalReason` (what `createIssue` calls) or `promoteRefusalReason` (what `--promote=` and `--board=` call through
// `promoteGate`), never the new predicate on its own, so a predicate that is right and not wired in is red here.
//
// POSITIVE CONTROLS, NAMED: case 2 is the non-empty population (every form the gate reads is ACCEPTED, so case 1's refusals cannot be
// "everything with a Waiting-for line is refused"); case 3 pairs a body with no line and one with the line inside a fence, both accepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileRefusalReason, promoteRefusalReason } from "../row-file.mjs";
import { WAIT_STATES, parseWaits } from "../wait-condition.mjs";

const COMPLETE_BODY = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n"
  + "## Acceptance\n\n```\nnpx tsx --test x\n```\n\n"
  + "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";
const withWait = (line: string) => `${COMPLETE_BODY}\n${line}\n`;

/** #4090's own line, from the row's body (it was parked 09:37Z on it). */
const STATE_4090 = "Waiting-for: ceo's dispatched run https://github.com/a11ign/zz-throwaway-nightly-4090/actions/runs/37757279386 ends and its three readings "
  + "(run id, wall-clock, the 'N captures, about X minutes' line) are posted on this row";

const READABLE = [
  "closed #4090", "merged #4090", "closed a11ign/agent-org#410", "labelled needs:chairman #3229", "unlabelled answer:ceo #3490",
  "published agent-org@latest", "published @a11ign/agent-org@next >= 1.2.3", "agent-org latest = next", "@a11ign/agent-org latest = next",
  "tagged v0.85.7", "manual",
];

test("1. THE FAILING CASE: #4090's own sentence is refused, with the forms and the answer:<session> remedy named", () => {
  for (const line of [STATE_4090, "Waiting-for: ceo's dispatched run ends", "Waiting-for: soon", "Waiting-for: closed the freeze row"]) {
    const reason = fileRefusalReason(withWait(line));
    assert.match(String(reason), /REFUSING to file/, line);
    for (const form of ["closed #n", "merged #n", "labelled|unlabelled <label> #n", "published <pkg>@<dist-tag>", "<pkg> latest = next", "tagged <tag>", "manual", "answer:<session>"]) {
      assert.ok(String(reason).includes(form), `the refusal names \`${form}\`: ${reason}`);
    }
    assert.ok(String(reason).includes(line.replace(/^Waiting-for:\s*/, "").slice(0, 40)), "and quotes the line it refused");
  }
  assert.match(String(promoteRefusalReason(withWait(STATE_4090), 4090)), /REFUSING to (promote|file)[\s\S]*answer:<session>/, "a row that already exists is refused the same way");
});

test("2. POSITIVE CONTROL: every form the gate reads, and `manual`, is accepted, as a plain line, a heading and among several", () => {
  assert.equal(fileRefusalReason(COMPLETE_BODY), null, "the control body is fileable on its own");
  for (const wait of READABLE) {
    assert.equal(fileRefusalReason(withWait(`Waiting-for: ${wait}`)), null, wait);
    assert.equal(fileRefusalReason(withWait(`## Waiting-for: ${wait}`)), null, `heading: ${wait}`);
    assert.equal(promoteRefusalReason(withWait(`Waiting-for: ${wait}`), 1), null, `promote: ${wait}`);
  }
  assert.equal(fileRefusalReason(withWait("Waiting-for: closed #1\nWaiting-for: manual")), null);
  assert.match(String(fileRefusalReason(withWait("Waiting-for: closed #1\nWaiting-for: soon"))), /soon/, "one unreadable line among readable ones is still refused");
  assert.deepEqual(READABLE.map((w) => parseWaits(`Waiting-for: ${w}`)[0].state).filter((s) => s === "unreadable"), [], "the list is the gate's own grammar");
  assert.ok(WAIT_STATES.length > 0);
});

test("3. a body with no Waiting-for line is accepted as today, and one inside a fence is not read as a line", () => {
  assert.equal(fileRefusalReason(COMPLETE_BODY), null);
  assert.equal(fileRefusalReason(`${COMPLETE_BODY}\nThe row once carried a Waiting-for: note in prose.\n`), null, "mid-sentence is not a line");
  assert.equal(fileRefusalReason(`${COMPLETE_BODY}\n\`\`\`\nWaiting-for: soon\n\`\`\`\n`), null, "a fenced example is not a wait");
  assert.equal(fileRefusalReason(`${COMPLETE_BODY}\n~~~\nWaiting-for: soon\n~~~\n`), null);
  assert.equal(fileRefusalReason(withWait("Waiting-for:")), null, "an empty value is no wait, as parseWaits reads it");
});
