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
