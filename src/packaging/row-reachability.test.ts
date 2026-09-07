/**
 * A ROW'S LABELS DESCRIBE ITS CLASSIFICATION, NEVER ITS REACHABILITY (#177).
 *
 * Ready showed four unclaimed rows, none `fleet-gated`, so by every label the lane read fully pickable.
 * The honest pickable count was 3; on one earlier evening it was 1. **Every one of those rows was
 * correctly classified** — `ready`, not `fleet-gated`, nothing about the labels wrong. The classification
 * cannot express the fact, so the count is right about its labels and wrong about the work.
 *
 * THE CHECK IS "DOES THIS ROW'S SUBJECT EXIST ON `main` YET", not "is anyone else in these files", and
 * #186 is the case that forces the distinction: nobody is editing `board-summary-check.mjs`, and the row
 * is unstartable anyway because `dirOnOriginMain` — the function it is entirely about — exists on one
 * unmerged branch and nowhere else. A region check alone scores that CLEAR.
 *
 * Driven against the pure verdict: the states worth testing are combinations of lookup results, and
 * arranging them against real refs would mean creating branches at the moment the test runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { startability } from "../../../../scripts/row-reachability.mjs";

const examined = { paths: 3, symbols: 2 };
const clear = { row: 189, subjectsMissing: [], heldRegions: [], examined };

test("THE #186 CASE: the subject does not exist on main, and no region check would see it", () => {
  const v = startability({
    ...clear, row: 186,
    subjectsMissing: [{ name: "dirOnOriginMain", refs: ["origin/pm/reported-directory-159"] }],
    heldRegions: [],
  });
  assert.equal(v.code, 1, "a row about code that has not landed is not startable");
  const text = v.lines.join("\n");
  assert.match(text, /SUBJECT NOT ON main: `dirOnOriginMain`/);
  assert.match(text, /origin\/pm\/reported-directory-159/,
    "it must NAME the ref -- 'blocked' and 'blocked on X' are different instructions");
  assert.match(text, /editing somebody's open work/,
    "and say why building on that branch is not simply the workaround");
});

test("a held region is reported but does NOT block — it is a merge cost, not a blocker", () => {
  // The half that stops this being deleted: a check that reports every row blocked is one nobody reads.
  const v = startability({
    ...clear, heldRegions: [{ path: "scripts/row-claim.mjs", refs: ["origin/agent/x"] }],
  });
  assert.equal(v.code, 0, "contention is worth knowing and is not a reason to refuse the row");
  assert.match(v.lines.join("\n"), /REGION HELD/);
  assert.match(v.lines.join("\n"), /merge cost, not a blocker/);
});

test("a clear row is STARTABLE and says what it examined", () => {
  const v = startability(clear);
  assert.equal(v.code, 0);
  assert.match(v.lines.join("\n"), /STARTABLE/);
  assert.match(v.lines.join("\n"), /3 path\(s\), 2 symbol\(s\) examined/,
    "a count of what was looked at, or 'startable' is indistinguishable from 'nothing was checked'");
});

test("EXAMINED NOTHING is inconclusive, never startable — the sharpest case here", () => {
  // A row with no Region and no backticked identifier gives this nothing to work on. Reporting STARTABLE
  // would be a check reporting success having examined nothing, which is what the whole row is about.
  const v = startability({ ...clear, examined: { paths: 0, symbols: 0 } });
  assert.equal(v.code, 2);
  assert.match(v.lines.join("\n"), /names no source path and no symbol/);
});

test("a failed lookup is inconclusive, and must never read as startable", () => {
  for (const broken of [{ subjectsMissing: null }, { heldRegions: null }]) {
    const v = startability({ ...clear, ...broken });
    assert.equal(v.code, 2, "null is 'I could not ask', never 'there is nothing there'");
    assert.match(v.lines.join("\n"), /CANNOT SAY/);
  }
});

test("both faults at once are reported separately, and the blocker wins the exit code", () => {
  const v = startability({
    ...clear, row: 171,
    subjectsMissing: [{ name: "formInputs", refs: ["origin/agent/identify-input-purpose-79"] }],
    heldRegions: [{ path: "packages/judge/src/coverage.ts", refs: ["origin/agent/identify-input-purpose-79"] }],
  });
  assert.equal(v.code, 1);
  const text = v.lines.join("\n");
  assert.match(text, /SUBJECT NOT ON main/);
  assert.match(text, /REGION HELD/);
  assert.doesNotMatch(text, /is STARTABLE/,
    "a blocked row must not also print the startable sentence -- one verdict per run");
});

/**
 * THE FIFTH STATE: the blocking ref's PR is CLOSED, so nobody is coming (#177, found by `dispatcher`).
 *
 * Measured 2026-09-07. #171's subject lives on `agent/identify-input-purpose-79`, whose PR **#89 is
 * CLOSED** — the work moved and that branch will never merge. #186's lives on `pm/reported-directory-159`,
 * whose **PR #172 is OPEN**. Before this the two printed identically, and they are not the same
 * situation: *wait for it* and *nobody is building this* are different instructions, and a reader
 * following the first onto a closed PR learns nothing about what replaced it.
 *
 * The verdict deliberately does not DECIDE between them — a row blocked behind an abandoned branch is
 * arguably not blocked at all, and that is a call for a person. It reports the state and stops.
 */
test("a blocking ref carries its PR state, so 'wait' and 'nobody is coming' are distinguishable", () => {
  const abandoned = startability({
    ...clear, row: 171,
    subjectsMissing: [{ name: "formInputs",
      refs: ["origin/agent/identify-input-purpose-79 (PR #89 CLOSED)"] }],
    heldRegions: [],
  });
  assert.match(abandoned.lines.join("\n"), /PR #89 CLOSED/,
    "a reader following an abandoned branch needs to know it is abandoned before they wait on it");

  const waiting = startability({
    ...clear, row: 186,
    subjectsMissing: [{ name: "dirOnOriginMain", refs: ["origin/pm/reported-directory-159 (PR #172 OPEN)"] }],
    heldRegions: [],
  });
  assert.match(waiting.lines.join("\n"), /PR #172 OPEN/);

  assert.equal(abandoned.code, waiting.code,
    "the VERDICT is the same in both -- the subject is not on main either way. Only the reader can decide "
    + "whether an abandoned blocker is a blocker, and this tool must not decide it for them");
});

/**
 * THE SIXTH STATE: a row blocked by another ROW, which neither regions nor symbols can express.
 *
 * `dispatcher` ran the merged tool across the backlog and found #77 reported STARTABLE while its own
 * title reads *"blocked behind #35's schema migration"* and #35 is open. The tool was correct about what
 * it examined — the region is clear and the symbols are on `main` — and a reader takes STARTABLE as
 * *nothing blocks this*. That is #187's fourth shape, in the tool built to compute reachability.
 *
 * IT READS THE LABEL, NOT THE PROSE. Parsing a title for a blocker is the coarse inference this tool
 * refuses everywhere else; the `blocked` label is the same authoritative record `row-claim` already
 * trusts for `in-progress`, so reading it is not a guess. And the STARTABLE sentence now states its own
 * limit, because a verdict that cannot say what it did not check is the defect the census catalogues.
 */
test("the `blocked` label is read, and STARTABLE says what it did not check", () => {
  const blocked = startability({ ...clear, row: 77, blockedLabel: true });
  assert.equal(blocked.code, 1, "a row somebody has recorded as blocked must not read as startable");
  assert.match(blocked.lines.join("\n"), /CARRIES THE `blocked` LABEL/);

  const startable = startability(clear);
  assert.equal(startable.code, 0);
  assert.match(startable.lines.join("\n"), /never "nothing blocks this"/,
    "STARTABLE must name its own limit, or it is read as a wider claim than it makes");
});

/**
 * A CLOSED ROW GETS NO VERDICT AT ALL — not a verdict with a caveat (#218).
 *
 * Measured 2026-09-07: #83 read `STARTABLE: no unmerged branch is in its region`, and **both sentences
 * were true** — nothing held the region and every symbol was on `main`, BECAUSE the work was done and
 * merged twenty-five minutes earlier. `dispatcher` briefed a worker on that reading; it cost nothing only
 * because that worker checked GitHub themselves before starting.
 *
 * This is #208's limit reached one field earlier than the limit it states. STARTABLE was documented as
 * *"nothing I can see"* — and what it could not see here was not a subtle dependency. **It was the
 * issue's own `state`, already in the query being made for the labels.**
 *
 * IT RETURNS EARLY RATHER THAN APPENDING A NOTE, because a green light with a caveat beside it is still
 * a green light, and the role file's target for units dispatched at closed rows is zero.
 */
test("a CLOSED row is refused outright, and the region check is not even consulted", () => {
  const v = startability({
    ...clear, row: 83, state: "CLOSED", closedAt: "2026-09-07T03:17:43Z",
    subjectsMissing: [], heldRegions: [],
  });
  assert.equal(v.code, 1);
  const text = v.lines.join("\n");
  assert.match(text, /#83 IS CLOSED \(2026-09-07T03:17:43Z\)/, "it names the state and when");
  assert.doesNotMatch(text, /STARTABLE/,
    "a closed row must not print a startable verdict at all -- a caveat beside one is still a green light");
  assert.match(text, /BECAUSE the work landed/,
    "and it must say WHY the region being clear is not evidence here, or the next reader re-derives it");
});

test("an OPEN row's output is unchanged — refusing more is not automatically better", () => {
  // This check is consulted before every dispatch. A version that refuses more things gets distrusted,
  // and then it is not consulted at all.
  const open = startability({ ...clear, state: "OPEN" });
  const stateless = startability(clear);
  assert.equal(open.code, 0);
  assert.deepEqual(open.lines, stateless.lines,
    "adding the state check must not change what an open row prints");
});

/**
 * THE REGION HALF SAYS AS MUCH ABOUT A BRANCH AS THE SUBJECT HALF DOES.
 *
 * #208 taught the SUBJECT half to report a blocking ref's PR state — `(PR #89 CLOSED)` means nobody is
 * coming, `(PR #172 OPEN)` means wait. **The region half never got it**, so one tool said two different
 * amounts about the same branch, and an undecorated `REGION HELD` reads as *"wait for that to land"*
 * even when the branch is dead. Found by `dispatcher` using the tool four minutes after #221 merged:
 * `REGION HELD … origin/agent/identify-input-purpose-79`, whose PR #89 is closed and whose work moved
 * wholesale to another row.
 *
 * `(no PR)` is a THIRD message and deliberately not folded into the other two: a branch nobody has
 * proposed is not abandoned, it is plausibly somebody's live work, and it is the one case where "wait"
 * may genuinely be right.
 */
test("a held region names each branch's PR state, and `no PR` stays its own answer", () => {
  const v = startability({
    ...clear,
    heldRegions: [{ path: "packages/evidence/src/verify.ts", refs: [
      "origin/agent/identify-input-purpose-79 (PR #89 CLOSED)",
      "origin/agent/same-document-resolved-url (no PR)",
    ] }],
  });
  const text = v.lines.join("\n");
  assert.match(text, /PR #89 CLOSED/, "nobody is coming");
  assert.match(text, /\(no PR\)/, "unproposed is not abandoned, and must not read as either of the others");
  assert.equal(v.code, 0, "contention is still a merge cost, not a blocker -- decorating it changes nothing");
});

/**
 * "NAMED NOTHING" AND "NAMED PROSE" ARE TWO DIFFERENT SENTENCES (#228).
 *
 * The `.md` filter is correct: there is no symbol to verify in a README, and pretending to check one
 * would be worse than saying nothing. But dropping prose paths SILENTLY made the verdict tell a docs row
 * it *"names no source path"* — when it named one, `packages/cli/README.md`, in a Region field that was
 * filled in correctly. That sends its author to fix something that is not broken.
 *
 * This is the third time tonight this tool's WALK was right and its SENTENCE was wider: #218 said
 * STARTABLE for a closed row, #227 said a branch held a region without saying whether it would ever land,
 * and this. All three are the census's own fourth shape, in the tool its author wrote.
 */
test("a row whose Region is PROSE is told so, and NOT told to add a Region it already has", () => {
  const v = startability({ ...clear, examined: { paths: 0, symbols: 0, prose: 1 } });
  assert.equal(v.code, 2, "still inconclusive -- this checks code and cannot judge a document");
  const text = v.lines.join("\n");
  assert.match(text, /names 1 document\(s\)/);
  assert.match(text, /NOT a missing Region: do not add one/,
    "the whole point: its author filled the field in correctly and must not be sent back to it");
  assert.doesNotMatch(text, /names no source path/,
    "that is the OTHER sentence, for a row that named nothing at all");
});

test("a row that named nothing at all still gets the original sentence", () => {
  const v = startability({ ...clear, examined: { paths: 0, symbols: 0, prose: 0 } });
  assert.equal(v.code, 2);
  assert.match(v.lines.join("\n"), /names no source path and no symbol/);
  assert.doesNotMatch(v.lines.join("\n"), /document\(s\)/,
    "collapsing the two is what made the docs message wrong; keep them apart in both directions");
});
