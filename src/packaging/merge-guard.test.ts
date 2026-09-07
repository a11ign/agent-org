/**
 * A PR THAT HAS NEVER RUN A CHECK READS AS `CLEAN`, AND A STALE RUN READS AS A CURRENT ONE (#161).
 *
 * Measured 2026-09-07. PR #148's base was another open PR's branch rather than `main`; `ci.yml` triggers
 * on `pull_request: branches: [main]`, so no workflow ever ran and the branch protection covering `main`
 * applied to nothing:
 *
 *     #148  CLEAN/MERGEABLE   check-runs: []   182 insertions into check-real-page-findings.ts
 *
 * `CLEAN/MERGEABLE` is the CORRECT answer to the question GitHub was asked, which is what makes it
 * dangerous — a required context that never ran is not a failing check, it is NO check, and the field
 * cannot express the difference. It was caught by a human noticing the list was EMPTY rather than green.
 *
 * TWO SHAPES, NEEDING OPPOSITE FIXES, and conflating them is how the first draft of the finding went
 * wrong: an empty check-run list means nothing has ever tested this, while runs WITH conclusions against
 * a base that has since moved are real results that look like evidence. The tests below drive both, plus
 * the third state this repo cares about most — "I could not ask", which must never read as either.
 *
 * DRIVEN AGAINST THE PURE VERDICT. The staleness case is the one no fixture gives for free, and the
 * lookup-failure cases cannot be produced on demand against a live API at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mergeReadiness } from "../../../../scripts/merge-guard.mjs";

const REQUIRED = ["changed", "ts", "python", "ansible", "docs", "changeset"];
const MAIN_TIP = "2026-09-07T00:41:07Z";
const AFTER = "2026-09-07T00:45:35Z";
const BEFORE = "2026-09-07T00:08:02Z";

const pr = (over: object = {}) => ({
  number: 148, state: "OPEN", baseRefName: "main", headRefOid: "d5c2436601abcdef", ...over,
});
const green = (at = AFTER) => REQUIRED.map((name) => ({
  name, status: "completed", conclusion: name === "ts" ? "success" : "skipped", completedAt: at,
}));

test("THE #148 CASE: a base that is not main, and not one check run — both named", () => {
  const v = mergeReadiness({
    pr: pr({ baseRefName: "lead/real-page-outcome-is-stated" }),
    required: REQUIRED, runs: [], mainTipIso: MAIN_TIP,
  });
  assert.equal(v.code, 1);
  assert.equal(v.reasons.length, 2, "two independent causes, two sentences -- they need different fixes");
  assert.match(v.reasons[0], /BASE IS NOT main/);
  assert.match(v.reasons[0], /branches: \[main\]/, "it must say WHY a non-main base runs nothing");
  assert.match(v.reasons[1], /NO CHECK RUNS EXIST/);
  assert.match(v.reasons[1], /never ran is not a failing check/,
    "the message must name the distinction the field cannot express");
});

test("A GENUINELY GREEN PR AGAINST main IS ACCEPTED — so this is not simply always-red", () => {
  // The half that stops a guard being deleted in a week. `skipped` is a path filter declining to run a
  // job, which is how this repo's own required contexts report on most PRs -- treating it as a failure
  // would refuse every correct PR in the tree.
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
  assert.deepEqual(v.reasons, []);
});

test("THE STALE SHAPE: real runs, real conclusions, against a base that has moved", () => {
  // The dangerous one, because the runs look like evidence. Measured on #135: newest run 00:08:02Z
  // against a main tipped 00:41:07Z.
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(BEFORE), mainTipIso: MAIN_TIP });
  assert.equal(v.code, 1);
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0], /EVERY RUN PREDATES THE CURRENT main/);
  assert.match(v.reasons[0], new RegExp(`${BEFORE}.*${MAIN_TIP}`, "s"),
    "both timestamps, or the reader cannot tell how stale");
  assert.doesNotMatch(v.reasons[0], /NO CHECK RUNS/,
    "this is the OTHER cause; reporting the empty-list sentence here would send somebody to the wrong fix");
});

test("A REQUIRED CONTEXT THAT NEVER RAN is distinct from an empty list and from a failure", () => {
  const runs = green().filter((run) => run.name !== "changeset");
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs, mainTipIso: MAIN_TIP });
  assert.equal(v.code, 1);
  assert.match(v.reasons[0], /REQUIRED CONTEXT NEVER RAN: changeset/);
  assert.match(v.reasons[0], /Present-and-failing and never-ran are different states/);
});

test("a failing context and a still-running one are separate sentences", () => {
  const failing = green().map((r) => (r.name === "ts" ? { ...r, conclusion: "failure" } : r));
  assert.match(mergeReadiness({ pr: pr(), required: REQUIRED, runs: failing, mainTipIso: MAIN_TIP })
    .reasons.join("\n"), /FAILING: ts \(failure\)/);

  const running = green().map((r) => (r.name === "ts"
    ? { ...r, status: "in_progress", conclusion: null, completedAt: null } : r));
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: running, mainTipIso: MAIN_TIP });
  assert.equal(v.code, 1);
  assert.match(v.reasons.join("\n"), /STILL RUNNING: ts/);
  assert.match(v.reasons.join("\n"), /ask again/, "in-flight is not a defect and must not read as one");
});

test("`[]` AND `null` ARE DIFFERENT ANSWERS, and this is the sharpest case in the file", () => {
  // "nothing ran" and "I could not ask" demand opposite responses. A lookup that fell through to an empty
  // array would report the safest-looking verdict for the least examined PR -- this repo's oldest defect.
  const nothingRan = mergeReadiness({ pr: pr(), required: REQUIRED, runs: [], mainTipIso: MAIN_TIP });
  assert.equal(nothingRan.code, 1, "an empty list is a FINDING");

  const couldNotAsk = mergeReadiness({ pr: pr(), required: REQUIRED, runs: null, mainTipIso: MAIN_TIP });
  assert.equal(couldNotAsk.code, 2, "a failed lookup is INCONCLUSIVE, and must never be either 0 or 1");
  assert.match(couldNotAsk.reasons[0], /CANNOT SAY/);
  assert.match(couldNotAsk.reasons[0], /check runs for head d5c2436601/, "it names WHICH lookup failed");
});

test("every failed lookup is inconclusive, and all of them are named at once", () => {
  const v = mergeReadiness({ pr: pr(), required: null, runs: null, mainTipIso: null });
  assert.equal(v.code, 2);
  for (const expected of [/branch protection/, /check runs/, /tip of `main`/]) {
    assert.match(v.reasons[0], expected, "one round trip should tell you everything that is missing");
  }
});

test("a PR that is not open is annotated rather than silently judged as if it were", () => {
  const v = mergeReadiness({ pr: pr({ state: "MERGED" }), required: REQUIRED, runs: green(),
    mainTipIso: MAIN_TIP });
  assert.match(v.notes.join("\n"), /MERGED, so this is a post-mortem/);
});

/**
 * AND THE ONE THAT MATTERS MOST: the guard must not consult the field it exists to distrust.
 *
 * `mergeStateStatus` is what reported #148 as the greenest PR on the board. A guard that read it would
 * share a failure mode with the thing it is checking, and this repo already has the rule — verify
 * `/health` over HTTP, not through the deploy channel that just failed. Asserted against the source
 * because no behavioural test can see a field being consulted "just to cross-check".
 */
test("the guard never reads mergeStateStatus, not even to cross-check", () => {
  const src = readFileSync(new URL("../../../../scripts/merge-guard.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  // TARGETS THE READ, NOT THE WORD -- and the first version of this assertion did the latter, then fired
  // on the script's own usage text explaining why the field is not to be trusted. A guard that forbids
  // NAMING the hazard makes the hazard harder to document, which is the opposite of the point. The two
  // patterns below are the only ways this script could actually consult it: ask GitHub for the field, or
  // read it off an object.
  assert.doesNotMatch(code, /--json[^\n]*mergeStateStatus/,
    "requesting the field at all invites the next reader to use it");
  assert.doesNotMatch(code, /\.mergeStateStatus\b/,
    "reading it -- even alongside the real check -- reintroduces the failure mode this tool exists to "
    + "avoid: a verification sharing a failure mode with the action verifies nothing");
  assert.match(code, /commits\/\$\{pr\.headRefOid\}\/check-runs/,
    "the authoritative source is the check runs FOR THE HEAD SHA. A `gh run list --limit N | grep` is "
    + "what turned a stale-run PR into a runless one in this finding's own first draft.");
});
