/**
 * #429: `reported.json`'s `gates` list holds different KINDS of thing, and picking the newest by `at`
 * regardless of kind lets a promotion run recorded an hour after a conformance run silently replace the
 * conformance verdict on the page the board reads. Demonstrated on the issue itself: adding one newer
 * `promote` entry flipped the appendix's headline from a real FAIL to a real PASS with nothing wrong in
 * either entry — the SELECTION was wrong, not the rendering of either result.
 *
 * These assert on `latestVerdictGate` — the SELECTION — never on rendered prose. A test that only checked
 * the appendix string could pass while the selection still picked by `at` alone, because a fixture happens
 * to order its entries favourably (this row's own acceptance names that trap explicitly).
 *
 * WHAT THIS FIX DECIDES A GATE IS, stated here rather than left a comment: the appendix's one verdict slot
 * means "the latest CONFORMANCE result" specifically, never "the latest result of any kind that happens
 * to carry a verdict" — the issue's own distinction. An entry counts only when BOTH: (1) it is a
 * `-e job=rules-real-pages` run (the one recorded kind whose PASS/FAIL is a claim about the product's own
 * accessibility conformance, named directly rather than inferred), and (2) it actually carries a verdict
 * a reader can be told about (`worstVerdict(entry.output)` returns non-null). `-e job=promote` (a decision
 * about which trained model ships, not conformance), a throughput measurement (`capture-only` +
 * `fleet-hours`, numbers and no PASS/FAIL/BLOCKED/INCONCLUSIVE line), and an ad-hoc operational
 * diagnostic (a fleet postmortem, a PDF-refusal report) therefore never compete for the slot — the first
 * two are excluded even though one of them (`promote`) DOES carry a verdict, which is exactly the case
 * the issue demonstrates and a verdict-only filter would still get wrong.
 *
 * THE `gates` LIST ITSELF IS UNCHANGED, and that is a decision too. The row asked whether a verdict-less
 * measurement belongs in it at all. It does: section five reads every entry, the throughput measurement
 * included, and that is where a measurement is useful. Only the ONE verdict slot filters by kind.
 *
 * Adopted from `dispatcher`'s uncommitted work in the row's worktree (`ceo`'s ruling: a worktree travels
 * with its row), read line by line, and committed under `worker-judge`.
 *
 * Imports the PURE `board-gates.mjs`, never `board-data.mjs`, which spawns `gh`: that keeps this file
 * runnable by CI's acceptance job. The one test that needs the tracked record is
 * `board-appendix-gate-record.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { latestVerdictGate } from "../../../../scripts/board-gates.mjs";

/** The row's own demonstrated population, reproduced verbatim (dates/commands as given on #429). */
const CONFORMANCE_MAIN = {
  command: "npm run lab:job -- -e job=rules-real-pages -e ref=main",
  at: "2026-09-07T12:26:00Z",
  output: "86 conformant real page(s) scored against the baseline.\n\n"
    + "FAIL — 2 problem(s) across 84 of 85 from conformant real pages scored against the baseline",
};
const CONFORMANCE_BRANCH = {
  command: "npm run lab:job -- -e job=rules-real-pages -e ref=lead/real-page-outcome-is-stated",
  at: "2026-09-06T23:40:00Z",
  output: "FAIL — 4 problem(s) across 85 of 85 from conformant real pages scored against the baseline",
};
const THROUGHPUT_MEASUREMENT = {
  command: "npm run lab:job -- -e job=capture-only ...\nnpm run lab:job -- -e job=fleet-hours ...",
  at: "2026-09-06T22:00:00Z",
  output: "arm-ten   {\"capturesBilled\": 98, \"medianSeconds\": 46.5}\nCapture complete: 49 captured, 0 failed",
};
const PROMOTION_MAIN = {
  command: "npm run lab:job -- -e job=promote -e ref=main",
  at: "2026-09-06T19:30:00Z",
  output: "PASS — all 1652 case(s) discriminate, and the corpus is complete.\nPromoted candidate.",
};

const FOUR_ENTRIES = [CONFORMANCE_MAIN, CONFORMANCE_BRANCH, THROUGHPUT_MEASUREMENT, PROMOTION_MAIN];

test("#429 VACUITY: the row's own four-entry population is exactly four, not fewer by a typo above", () => {
  assert.equal(FOUR_ENTRIES.length, 4);
});

test("#429: with the row's own four entries, the conformance FAIL is selected, not the throughput "
  + "measurement or the promotion PASS, whichever of the three is textually newest", () => {
  const selected = latestVerdictGate(FOUR_ENTRIES);
  assert.equal(selected, CONFORMANCE_MAIN,
    "the newest entry that actually carries a verdict is CONFORMANCE_MAIN — the other two either carry "
    + "no verdict (measurement) or are older (the branch conformance run)");
});

test("#429 ACCEPTANCE, MUTATION TARGET, COMPOSED EXACTLY AS THE ISSUE DEMONSTRATES IT: a promotion PASS "
  + "recorded an HOUR AFTER the conformance FAIL must NOT displace it -- both carry a verdict, so this is "
  + "the case a bare 'does it have a verdict' filter still gets wrong", () => {
  // The issue's own repro, verbatim: "adding one newer entry of a different kind... BEFORE latest:
  // rules-real-pages FAIL. AFTER latest: promote PASS." Before this fix, sorting all four by `at` alone
  // -- or even filtering only to "carries a verdict" -- picks this PASS, because it genuinely IS newer
  // and genuinely DOES carry one.
  const promotionRecordedAfter = { ...PROMOTION_MAIN, at: "2026-09-07T13:26:00Z" }; // one hour after CONFORMANCE_MAIN
  const selected = latestVerdictGate([...FOUR_ENTRIES, promotionRecordedAfter]);
  assert.equal(selected, CONFORMANCE_MAIN,
    "a promote run, however new and however PASS, is not a conformance result and must never win the "
    + "appendix's conformance-verdict slot");
});

test("#429 ACCEPTANCE, MUTATION TARGET: a throughput measurement with NO verdict line never wins the "
  + "slot, however new its timestamp", () => {
  const measurementRecordedLatest = { ...THROUGHPUT_MEASUREMENT, at: "2026-09-09T23:00:00Z" };
  const selected = latestVerdictGate([...FOUR_ENTRIES, measurementRecordedLatest]);
  assert.equal(selected, CONFORMANCE_MAIN,
    "a measurement with no PASS/FAIL/BLOCKED/INCONCLUSIVE line must never be chosen, regardless of how "
    + "recent its `at` is -- it is not a gate in the sense this slot means");
});

test("#429: an operational diagnostic with prose that happens to contain the word 'success' in lower "
  + "case, or inside a longer sentence, is not mistaken for a verdict", () => {
  const diagnostic = {
    command: "gh workflow run board-report.yml --ref main",
    at: "2026-09-09T23:00:00Z",
    output: "a11y-worker-2 | SUCCESS => ping: pong\nnewest 'gate' conclusion per head: success 7  failure 3",
  };
  const selected = latestVerdictGate([...FOUR_ENTRIES, diagnostic]);
  assert.equal(selected, CONFORMANCE_MAIN,
    "lower-case 'success'/'failure' inside a diagnostic's own quoted output must not read as this "
    + "project's PASS/FAIL/BLOCKED/INCONCLUSIVE vocabulary");
});

test("#429 ACCEPTANCE, MUTATION TARGET: a `rules-real-pages` run that printed NO verdict line at all -- "
  + "the real INCONCLUSIVE shape, a run cut short with a census the gate does not trust -- never wins the "
  + "slot even though it is the right KIND and the newest by far", () => {
  const inconclusiveRun = {
    command: "npm run lab:job -- -e job=rules-real-pages -e ref=main",
    at: "2026-09-09T09:00:00Z", // newer than every entry in FOUR_ENTRIES
    output: "1 capture(s) have a census this run does not trust: a real second CDP target existed and "
      + "none was confirmed to be the page navigated to.\nNothing to report either way.",
  };
  const selected = latestVerdictGate([...FOUR_ENTRIES, inconclusiveRun]);
  assert.equal(selected, CONFORMANCE_MAIN,
    "right kind, wrong on the second test: no PASS/FAIL/BLOCKED/INCONCLUSIVE line means no verdict a "
    + "reader can be told, so the older but genuinely verdict-bearing conformance FAIL must still win");
});

test("#429: no entry carries a verdict at all -- the slot is genuinely empty, not defaulted to the "
  + "newest entry regardless", () => {
  assert.equal(latestVerdictGate([THROUGHPUT_MEASUREMENT]), null);
  assert.equal(latestVerdictGate([]), null);
});

test("#429: two verdict-carrying entries at the identical timestamp is decided by array order, not "
  + "silently dropped -- an unreadable tie is a different failure than none of this row's concern, but "
  + "the function must still return SOMETHING rather than throwing on real, if unusual, data", () => {
  const tied = { ...CONFORMANCE_BRANCH, at: CONFORMANCE_MAIN.at };
  const selected = latestVerdictGate([CONFORMANCE_MAIN, tied]);
  assert.ok(selected === CONFORMANCE_MAIN || selected === tied);
});
