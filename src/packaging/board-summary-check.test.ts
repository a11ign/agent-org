// no-token: gh
// This file imports board-summary-check.mjs and board-document.mjs, whose closures spawn `gh`; every test here drives a
// pure function or injects the instant and stubs the exit, and nothing here calls or spawns it.
/**
 * #1345: A SUMMARY'S AGE IS THE MINUTES THAT PASSED, NOT ITS DISTANCE FROM NOW WITHIN ONE DAY.
 *
 * `statedWritingTime` compared "HH:MM" with "HH:MM", so a summary written at 23:50 and rendered at 00:30 read as
 * 1,400 minutes stale and `requireSummaryIsFresh` refused it. It fails CLOSED -- nothing wrong is published --
 * but the number in the refusal is false, and the only renders in that hour are the post-midnight republish
 * #1302 fixed the date for. No test imported `board-summary-check.mjs` before this file (#1345's Region note).
 *
 * THE INSTANTS ARE UTC AND THE ASSERTIONS ARE LONDON'S. September is BST (UTC+1), December is GMT, so each case
 * says which London wall clock its instant is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statedWritingTime } from "../../../../scripts/board-summary-check.mjs";
import { requireSummaryIsFresh } from "../../../../scripts/board-document.mjs";

test("#1345 ACCEPTANCE: written at 23:50 on 13 September and read at 00:30 London on the 14th is 40 minutes old", () => {
  // 2026-09-13T23:30Z is 00:30 BST on 14 September.
  assert.deepEqual(statedWritingTime("Written at 23:50 on 13 September.", new Date("2026-09-13T23:30:00Z")),
    { stated: "23:50", driftMinutes: 40 });
});

test("#1345 POSITIVE CONTROL: a same-day summary keeps its same-day age -- 07:20 read at 08:13 London is 53", () => {
  // The real opener of docs/board/summaries/2026-09-13.md. 07:13Z is 08:13 BST, the scheduled render's hour.
  assert.deepEqual(statedWritingTime("Written at 07:20 on 13 September.", new Date("2026-09-13T07:13:00Z")),
    { stated: "07:20", driftMinutes: 53 });
});

test("#1345: a time stated LATER today is its distance ahead, never wrapped into yesterday", () => {
  // 00:30 London on the 14th, a summary claiming 09:30 on the 14th: 540 minutes ahead. Wrapped into yesterday it
  // would read 900, and a later-than-now claim must stay the claim it is.
  assert.equal(statedWritingTime("Written at 09:30 on 14 September.", new Date("2026-09-13T23:30:00Z"))?.driftMinutes, 540);
});

test("#1345: the row's own after-midnight case, and a year boundary in GMT", () => {
  assert.equal(statedWritingTime("Written at 00:10 on 14 September.", new Date("2026-09-13T23:30:00Z"))?.driftMinutes, 20);
  // 00:30 on 1 January 2027 is 00:30 GMT: a summary from 23:50 on 31 December is last year's, 40 minutes ago.
  assert.equal(statedWritingTime("Written at 23:50 on 31 December.", new Date("2027-01-01T00:30:00Z"))?.driftMinutes, 40);
});

test("#1345: with no day stated, or an \"HH:MM\" now, the age is within one day, as before -- stated, not fixed", () => {
  // No day to place the time on, so it cannot be moved across midnight. The late-edition path passes "HH:MM" and
  // reads only `.stated`, which is why that spelling still works.
  assert.equal(statedWritingTime("Written at 23:50.", new Date("2026-09-13T23:30:00Z"))?.driftMinutes, 1400);
  assert.deepEqual(statedWritingTime("Written at 23:50 on 13 September.", "00:30"), { stated: "23:50", driftMinutes: 1400 });
  assert.equal(statedWritingTime("We are on the date.", new Date("2026-09-13T07:13:00Z")), null);
});

test("#1345 CALLER: requireSummaryIsFresh ages a summary from its ONE injected instant -- 23:50 rendered at 00:30 London "
  + "publishes, and 22:00 at the same instant still refuses", () => {
  const exits: (string | number | null | undefined)[] = [];
  const errors: string[] = [];
  const realExit = process.exit;
  const realError = console.error;
  process.exit = ((code?: string | number | null) => { exits.push(code); throw new Error(`exit ${code}`); }) as typeof process.exit;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try {
    const at = new Date("2026-09-13T23:30:00Z");
    requireSummaryIsFresh(true, { text: "Written at 23:50 on 13 September." }, "2026-09-14", at);
    assert.deepEqual(exits, [], `a 40-minute-old summary must render; it was refused with: ${errors.join(" | ")}`);
    // POSITIVE CONTROL: the same instant, a summary from 22:00 on the 13th, is 150 minutes old and must refuse -- a
    // caller that stopped refusing at all would pass the assertion above.
    assert.throws(() => requireSummaryIsFresh(true, { text: "Written at 22:00 on 13 September." }, "2026-09-14", at), /exit 5/);
    assert.match(errors.join("\n"), /written at 22:00 and London now reads 00:30 -- 150 minutes later/);
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
});
