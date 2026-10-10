// no-token: gh
//
// #4640 (class `row-not-finishable`; the chairman, 2026-10-09: READY MEANS FINISHABLE): a Done-when item naming a future time, a seat's or the chairman's act,
// or another row's outcome is a row no engineer can finish from claim to merge, so `row-file` refuses it unless that part is its own row, and offers the split.
//
// NO NETWORK AND NO CORPUS: the bodies, the labels, the blocked-by list and the clock are fixtures. The wiring case drives `createIssue` with a `spawnGh` that
// counts creates and a `run` that answers nothing, so a refusal asserts ZERO creates and a stray read would show.
//
// POSITIVE CONTROLS, NAMED (an emptiness assertion points at where its population is): every refusal class is paired with `ALREADY_DATA` (the same item, the wait
// carried as data, NOT refused) and with `CITED` (the same names, no wait on them, NOT refused). Case 1 is the non-empty population for the refusals; case 4 is
// the row's OWN Done-when, which must pass; case 6 breaks the wiring by reading a body the classifier refuses and requires `createIssue` to say so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIssue } from "./row-file.ts";
import { doneWhenItems, liveCheckItems, unfinishableItems, unsplitDoneWhenRefusal } from "./unsplit-done-when.ts";

const NOW = new Date("2026-10-09T20:40:00Z");
const HEAD = "## Region\n\npackages/lab/src/packaging/foo.ts\n\n## Acceptance\n\n```\nnpx tsx --test src/foo.test.ts\n```\n\n## Open-check\n\n```\ngit grep -n foo origin/main | wc -l\n0\n```\n\n";
const bodyWith = (doneWhen: string, extra = "") => `${HEAD}## Done-when\n\n${doneWhen}\n\n${extra}`;
const kindsOf = (body: string, declared = {}) => unfinishableItems(body, { now: NOW, declared }).map((item) => item.kind);

const FUTURE = ["1. The reading is taken on day 3 and posted.", "1. The count is read after 2026-10-12 and posted.", "1. The window closes 2026-10-11T19:00:00Z.",
  "1. Re-read the count in three days.", "1. The worker-count reading is due tomorrow.", "1. Read it two weeks after the freeze."];
const SEAT = ["1. ceo approves the wording.", "1. The ruling is confirmed by the chairman.", "1. product-manager's sign-off is posted.", "1. orchestrator then reads the lab and posts the number.",
  "1. The chairman must confirm the brief."];
const ROW = ["1. Once #4438 merges, the reading is re-run.", "1. After #4441 closes the label is removed.", "1. The row waits on #4437.", "1. When a11ign/agent-org#541 lands, rebase.",
  "1. #4438's merge is confirmed."];

test("1. THE FAILING CASE: each of the three classes is refused, and the refusal OFFERS THE SPLIT (the second row's Done-when and the data it carries)", () => {
  const cases: [string[], string, RegExp][] = [
    [FUTURE, "future-time", /Not-before: /], [SEAT, "seat-act", /answer:<session>.*needs:chairman|needs:chairman/s], [ROW, "row-outcome", /--blocked-by \d+/],
  ];
  for (const [lines, kind, carries] of cases) {
    for (const line of lines) {
      assert.deepEqual(kindsOf(bodyWith(line)), [kind], line);
      const refusal = String(unsplitDoneWhenRefusal(bodyWith(line), { now: NOW }));
      assert.match(refusal, /REFUSING to file/, line);
      assert.ok(refusal.includes(`SECOND ROW's Done-when: "${line.replace(/^1\. /, "")}"`), `the refusal gives the second row's Done-when: ${refusal}`);
      assert.match(refusal, carries, `${kind} names the data the second row carries: ${line}`);
      assert.match(refusal, /Nothing was filed/);
    }
  }
  assert.match(String(unsplitDoneWhenRefusal(bodyWith("1. Read it after 2026-10-12."), { now: NOW })), /Not-before: 2026-10-12T00:00:00Z/, "an absolute date is carried over as the exact Not-before");
  assert.match(String(unsplitDoneWhenRefusal(bodyWith("1. Once #4438 merges, go."), { now: NOW })), /--blocked-by 4438/, "the exact row is named");
});

test("2. CONTROL: a wait that is ALREADY DATA on the row is not refused, per class, and only the data that matches the class counts", () => {
  assert.deepEqual(kindsOf(bodyWith("1. Read it on day 3.", "Not-before: 2026-10-12T19:00:00Z\n")), []);
  assert.deepEqual(kindsOf(bodyWith("1. Read it on day 3.", "Waiting-for: closed #4437\n")), []);
  assert.deepEqual(kindsOf(bodyWith("1. ceo approves the wording."), { labels: ["answer:ceo"] }), []);
  assert.deepEqual(kindsOf(bodyWith("1. The chairman must confirm the brief."), { labels: ["needs:chairman"] }), []);
  assert.deepEqual(kindsOf(bodyWith("1. ceo approves.", "Waiting-for: unlabelled answer:ceo #3490\n")), []);
  assert.deepEqual(kindsOf(bodyWith("1. Once #4438 merges, go."), { blockedBy: [4438] }), []);
  assert.deepEqual(kindsOf(bodyWith("1. Once #4438 merges, go.", "Waits-on-done-when: 4438.1\n")), []);
  assert.deepEqual(kindsOf(bodyWith("1. Once #4438 merges, go.", "Waiting-for: merged #4438\n")), []);
  // the data must be about THIS item: an edge onto another row does not excuse #4438, and a Not-before does not excuse a seat's act
  assert.deepEqual(kindsOf(bodyWith("1. Once #4438 merges, go."), { blockedBy: [9] }), ["row-outcome"]);
  assert.deepEqual(kindsOf(bodyWith("1. ceo approves.", "Not-before: 2026-10-12\n")), ["seat-act"]);
  assert.deepEqual(kindsOf(bodyWith("1. Read it on day 3.", "Waiting-for: soon\n")), ["future-time"], "an UNREADABLE Waiting-for is not data");
});

test("3. CONTROL: a row, a seat or a date that is only CITED is not refused, and neither is a past or bounding date", () => {
  const CITED = ["1. The refusal names `ceo` as the owner label.", "1. The shape matches #4437 and #4438.", "1. The comment cites ceo's comments 6088554995 and 6088564270.",
    "1. The report is posted to the orchestrator on the row.", "1. The work is done before 2026-10-20.", "1. The count is read by 2026-10-20.", "1. The reading from 2026-10-08 is quoted.",
    "1. The pull request is merged.", "1. Closes #4437 in the body.", "1. Route the finding to ceo and file it ready."];
  for (const line of CITED) assert.deepEqual(kindsOf(bodyWith(line)), [], line);
  assert.deepEqual(kindsOf(bodyWith("1. The reading from 2026-10-09 is quoted.")), [], "today's own date is midnight, already past, not a future time");
});

test("4. the row's OWN Done-when (#4640) passes: its three items name the PR merging, row-file run for real, and an order of `none`", () => {
  const own = "1. The Acceptance passes and the pull request is merged.\n2. Run `row-file` for real on one fixture body per class (three refusals) and on the split version "
    + "(files, filed as `backlog` with `out-of-release` and closed straight after as `not planned`; say so on the pull request). Paste the three refusal texts.\n"
    + "3. Order, as data: none (independent of `a`, `b` and `c`).";
  assert.equal(doneWhenItems(bodyWith(own)).length, 3);
  assert.equal(unsplitDoneWhenRefusal(bodyWith(own), { now: NOW }), null);
});

test("5. the section is read as the section: only under `## Done-when`, outside a fence, a wrapped item is one item, no section is no finding", () => {
  assert.deepEqual(kindsOf(`${HEAD}## What it is\n\nOnce #4438 merges, and ceo approves, on day 3.\n`), [], "prose outside Done-when is not an item");
  assert.deepEqual(kindsOf(bodyWith("```\n1. Once #4438 merges\n```")), [], "a fenced example is not an item");
  assert.deepEqual(kindsOf(bodyWith("1. The reading is posted once\n   #4438 merges and read.")), ["row-outcome"], "a wrapped item is read whole");
  assert.deepEqual(doneWhenItems(bodyWith("1. a\n2. b\n- c")), ["a", "b", "c"]);
  assert.deepEqual(kindsOf(HEAD), [], "no Done-when section is not a finding");
  assert.deepEqual(kindsOf(bodyWith("1. Read it on day 3.\n2. ceo approves.\n3. Once #4438 merges, go.")), ["future-time", "seat-act", "row-outcome"], "every item is judged");
});

test("6. WIRED IN: `createIssue` refuses an unsplit body before anything is filed, and does not refuse the same body split", () => {
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let creates = 0;
  const attempt = (doneWhen: string) => {
    written.length = 0;
    const status = createIssue(["--title", "t", "--session=product-manager", "--body", bodyWith(doneWhen)], { spawnGh: () => { creates += 1; return ""; }, run: () => "" });
    return { status, said: written.join("") };
  };
  try {
    const unsplit = attempt("1. The pull request is merged.\n2. Once #4438 merges, re-read the count.");
    assert.equal(unsplit.status, 1);
    assert.match(unsplit.said, /READY MEANS FINISHABLE/);
    assert.equal(creates, 0, "nothing was filed");
    const split = attempt("1. The pull request is merged.");
    assert.doesNotMatch(split.said, /READY MEANS FINISHABLE/, "the split version is not refused for it");
  } finally {
    process.stderr.write = write;
  }
});

// --- a11ign/agent-org#719: the FOURTH kind. A live check is a reading, filed as the verify row, and is NEVER a refusal at `row-file`. ---

const LIVE_CHECK = ["1. One record per use is quoted on #4627.", "1. The `trunk` log line names the verify row after the merge.", "1. The switch reads on in the field.",
  "1. Use 1 is live in a11ign.", "1. The published version carries the fix.", "1. Version 1.4.2 is published.", "1. The count is correct in production."];
const NOT_A_LIVE_CHECK = ["1. The tests pass.", "1. The README names the flag.", "1. The acceptance command's output is quoted in the pull request.",
  "1. The live gh call is mocked in the test.", "1. The flag is documented.", "1. The verify row is its own row, filed beside this one."];

test("11. `liveCheckItems` names a quoted record on a row, a switch read on, a log line after the merge, a published version; and it is NOT a refusal", () => {
  for (const item of LIVE_CHECK) {
    const found = liveCheckItems(bodyWith(item), { now: NOW });
    assert.equal(found.length, 1, item);
    assert.equal(found[0].kind, "live-check", item);
    assert.deepEqual(kindsOf(bodyWith(item)), [], `${item}: row-file's classifier does not return it, so the row is still filed`);
    assert.equal(unsplitDoneWhenRefusal(bodyWith(item), { now: NOW }), null, item);
  }
  for (const item of NOT_A_LIVE_CHECK) assert.deepEqual(liveCheckItems(bodyWith(item), { now: NOW }), [], item);
});

test("12. a seat's act and another row's outcome are NOT live checks, even when they name a reading (the refusals are kept)", () => {
  for (const item of [...SEAT, ...ROW, "1. ceo reads the switch on and quotes it on #4627.", "1. Once #4438 merges the log line shows after the merge."]) {
    assert.deepEqual(liveCheckItems(bodyWith(item), { now: NOW }), [], item);
  }
  assert.deepEqual(kindsOf(bodyWith("1. ceo reads the switch on and quotes it on #4627.")), ["seat-act"], "and it is still refused by row-file");
});

test("13. a record quoted on the build's OWN row, or a quotation in code, is not a live check", () => {
  assert.equal(liveCheckItems(bodyWith("1. The command's output is quoted on #719."), { now: NOW, self: 719 }).length, 0, "the engineer's own completion comment");
  assert.equal(liveCheckItems(bodyWith("1. The command's output is quoted on #719."), { now: NOW, self: 4630 }).length, 1, "the same words on another row's number are a reading");
  assert.equal(liveCheckItems(bodyWith('1. A test closes a row whose Done-when 2 reads "one record per use is quoted on #4627" and asserts a verify row.'), { now: NOW }).length, 0,
    "a quoted fixture is what the test is about, not what the row asks for");
  assert.equal(liveCheckItems(bodyWith("1. A test reads `quoted on #4627` from the fixture."), { now: NOW }).length, 0);
});

test("14. a `future-time` item is not returned twice: the live-check reader leaves it to `unfinishableItems`", () => {
  assert.deepEqual(liveCheckItems(bodyWith(FUTURE[0]), { now: NOW }), []);
  assert.deepEqual(kindsOf(bodyWith(FUTURE[0])), ["future-time"]);
});
