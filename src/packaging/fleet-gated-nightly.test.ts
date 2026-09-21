// no-token: REPO -- reached only through this file's own import closure, never called here
// no-token: STANDING_ROW -- same
// no-token: SESSION -- same
//
// `examinedComment` and `wakeText` are pure and every input (`issues`, `firedAtIso`) is a fixture this
// file constructs -- neither reaches `REPO`, `STANDING_ROW` or `SESSION` through anything called here,
// only through the module's own import closure. A consumer test that exercises `main`'s `gh`/`herdr`
// calls would carry those tokens on purpose; this file is the pure half.
/**
 * #1830: THE FIRING MUST NEVER REPORT "EXAMINED 0" AS "ALL ROWS COVERED" -- the row's own Mutation.
 * `examinedComment([], ...)` is the direct pin. `fleetGatedRows` throwing rather than returning `[]` on a
 * refused `gh` call is `work-gate.test.ts`'s own rule (`readPrs`/`readReadyRows` never coerce a refusal
 * to an empty queue) applied to this firing's one read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { fleetGatedRows, examinedComment, wakeText, MILESTONE }
  from "../fleet-gated-nightly.mjs";

const FIRED_AT = "2026-09-22T01:00:03.412Z";

test("MUTATION target: an empty fleet-gated set reads `examined 0`, never `all rows covered`", () => {
  const comment = examinedComment([], FIRED_AT);
  assert.match(comment, /examined 0 row/);
  assert.doesNotMatch(comment, /all rows covered/i);
  assert.match(comment, /Nobody woken/);
});

test("a non-empty set names every row number, not just the count", () => {
  const comment = examinedComment([{ number: 1768 }, { number: 71 }, { number: 44 }], FIRED_AT);
  assert.match(comment, /examined 3 row/);
  assert.match(comment, /#1768/);
  assert.match(comment, /#71/);
  assert.match(comment, /#44/);
  assert.match(comment, new RegExp(MILESTONE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the comment states the milestone and the fired-at timestamp it was measured at", () => {
  const comment = examinedComment([{ number: 1 }], FIRED_AT);
  assert.match(comment, new RegExp(FIRED_AT.replace(/[.:]/g, "\\$&")));
});

test("wakeText hands the woken session the row list, so it does not wake to go and look", () => {
  const text = wakeText([{ number: 1768 }, { number: 44 }]);
  assert.match(text, /#1768/);
  assert.match(text, /#44/);
  assert.match(text, /by-row batch/);
  assert.match(text, /#914/);
});

test("wakeText on an empty list still reads as a sentence, not a template artefact", () => {
  const text = wakeText([]);
  assert.match(text, /0 row/);
  assert.doesNotMatch(text, /undefined/);
});

test("fleetGatedRows parses the query's own JSON shape straight through", () => {
  const run = (args: string[]) => {
    assert.deepEqual(args.slice(0, 2), ["issue", "list"]);
    assert.ok(args.includes("--milestone"));
    assert.ok(args.includes(MILESTONE));
    assert.ok(args.includes("fleet-gated"));
    return JSON.stringify([{ number: 5, comments: [] }]);
  };
  assert.deepEqual(fleetGatedRows(run), [{ number: 5, comments: [] }]);
});

test("MUTATION target: a refused read THROWS -- it must never be swallowed into `[]`, "
  + "which this firing's own comment would then report as `examined 0` for a read that never happened", () => {
  const run = () => { throw new Error("gh: authentication required"); };
  assert.throws(() => fleetGatedRows(run), /authentication required/);
});
