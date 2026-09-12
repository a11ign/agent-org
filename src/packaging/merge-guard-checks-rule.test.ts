/**
 * RULE: DID EVERY REQUIRED CONTEXT ACTUALLY RUN AND CONCLUDE? -- #148's other half, #455's split into
 * `scripts/merge-guard/checks-rule.mjs`. Four distinct states -- empty, missing, still running, failing --
 * each needing a different sentence and a different fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkReasons, newestPerName, SATISFIED } from "../../../../scripts/merge-guard/checks-rule.mjs";
import { reasonKind } from "../../../../scripts/merge-guard/reason-kind.mjs";

const REQUIRED = ["changed", "ts", "python", "ansible", "docs", "changeset"];
const pr = { headRefOid: "d5c2436601abcdef" };
const green = () => REQUIRED.map((name) => (
  { name, status: "completed", conclusion: name === "ts" ? "success" : "skipped" }));

test("THE #148 CASE: not one check run, ever -- distinct from a present-and-failing context", () => {
  const reasons = checkReasons(pr, REQUIRED, []);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /NO CHECK RUNS EXIST for head d5c2436601/);
  assert.match(reasons[0], /never ran is not a failing check/,
    "must name the distinction the field cannot express, or the reader mistakes this for a red gate");
});

test("every required context present and satisfied raises nothing", () => {
  assert.deepEqual(checkReasons(pr, REQUIRED, green()), []);
});

test("`skipped` and `neutral` are SATISFIED, not failures -- a path filter declining is not a defect", () => {
  assert.ok(SATISFIED.has("skipped"));
  assert.ok(SATISFIED.has("neutral"));
  assert.ok(SATISFIED.has("success"));
  assert.ok(!SATISFIED.has("failure"));
});

test("a required context that never ran is distinct from an empty list and from a failure", () => {
  const runs = green().filter((run) => run.name !== "changeset");
  const reasons = checkReasons(pr, REQUIRED, runs);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /REQUIRED CONTEXT NEVER RAN: changeset/);
  assert.match(reasons[0], /Present-and-failing and never-ran are different states/);
});

test("a failing context and a still-running one are separate sentences", () => {
  const failing = green().map((r) => (r.name === "ts" ? { ...r, conclusion: "failure" } : r));
  assert.match(checkReasons(pr, REQUIRED, failing).join("\n"), /FAILING: ts \(failure\)/);

  const running = green().map((r) => (r.name === "ts"
    ? { ...r, status: "in_progress", conclusion: null } : r));
  const reasons = checkReasons(pr, REQUIRED, running);
  assert.match(reasons.join("\n"), /STILL RUNNING: ts/);
  assert.match(reasons.join("\n"), /ask again/, "in-flight is not a defect and must not read as one");
});

test("MUTATION target: multiple independent faults are reported as multiple sentences, not merged into one", () => {
  const runs = green().filter((run) => run.name !== "changeset")
    .map((r) => (r.name === "ts" ? { ...r, conclusion: "failure" } : r));
  const reasons = checkReasons(pr, REQUIRED, runs);
  assert.equal(reasons.length, 2, "missing-context and failing must stay two sentences");
});

// --- #902: THE NEWEST RUN PER NAME. A superseded attempt must not speak for a name that has since -----
// concluded differently. Measured 2026-09-11: two sessions read PR #996 as red, twenty minutes apart,
// from a `gate` job belonging to a run cancelled 22 seconds after it started. Both readings were of a
// real check run with a real failure conclusion -- it was simply not the one that decided.

/** One name, twice: an older run and a newer one, in the order the API returns them (oldest first). */
const twice = (name: string, older: Record<string, unknown>, newer: Record<string, unknown>) => [
  { id: 100, name, status: "completed", conclusion: null, ...older },
  { id: 200, name, status: "completed", conclusion: null, ...newer },
];

test("#902: a SUPERSEDED failure does not speak -- the newest run of that name concluded success", () => {
  const runs = [...green().filter((r) => r.name !== "ts"), ...twice("ts", { conclusion: "failure" }, { conclusion: "success" })];
  assert.deepEqual(checkReasons(pr, REQUIRED, runs), [],
    "an older failing run of a name whose newest run succeeded is the exact reading that made a green PR red");
});

test("#902: and the other direction -- an older SUCCESS does not hide the newest run's failure", () => {
  const runs = [...green().filter((r) => r.name !== "ts"), ...twice("ts", { conclusion: "success" }, { conclusion: "failure" })];
  assert.deepEqual(checkReasons(pr, REQUIRED, runs), ["FAILING: ts (failure)."],
    "taking the newest must not become taking the friendliest");
});

test("#902: a cancelled older run beside a running newer one reports STILL RUNNING, not a failure", () => {
  // `cancelled` is not in SATISFIED, so before this the pair reported BOTH sentences: a failure that had
  // been superseded, and the wait that is the real state.
  const runs = [...green().filter((r) => r.name !== "ts"),
    ...twice("ts", { conclusion: "cancelled" }, { status: "in_progress", conclusion: null })];
  const reasons = checkReasons(pr, REQUIRED, runs);
  assert.equal(reasons.length, 1, `expected the wait alone, got:\n${reasons.join("\n")}`);
  assert.match(reasons[0], /^STILL RUNNING: ts\./);
});

test("#902: ordering is by ID, never by array order -- the API does not promise oldest first", () => {
  const newestFirst = [
    { id: 200, name: "ts", status: "completed", conclusion: "success" },
    { id: 100, name: "ts", status: "completed", conclusion: "failure" },
  ];
  assert.deepEqual(newestPerName(newestFirst).map((r) => r.id), [200]);
  assert.deepEqual(checkReasons(pr, ["ts"], newestFirst), []);
});

test("#902: a run carrying NO id keeps the previous behaviour -- last in array order wins", () => {
  // A caller that has not been taught to fetch ids must not silently lose its runs; it gets exactly what
  // it got before. `lookupCheckRuns` does carry them, and `lookups.mjs` says why.
  const noIds = [
    { name: "ts", status: "completed", conclusion: "failure" },
    { name: "ts", status: "completed", conclusion: "success" },
  ];
  assert.deepEqual(newestPerName(noIds).map((r) => r.conclusion), ["success"]);
});

test("#902 MUTATION TARGET: the fix is in the RULE, and `lookupCheckRuns` must carry the id it needs", () => {
  // The ordering key has to arrive. `checkReasons` grouping by newest is inert if its caller drops `id`,
  // which is what this file's own subject did until #902 -- a rule that cannot apply, not a rule that is
  // wrong. Asserted against the source, because no unit test of `checkReasons` can see its caller.
  const source = readFileSync(new URL("../../../../scripts/merge-guard/lookups.mjs", import.meta.url), "utf8");
  const mapper = /check-runs[\s\S]*?\.map\(([\s\S]*?)\)\);/.exec(source)?.[1] ?? "";
  assert.match(mapper, /\bid: run\.id\b/,
    "lookupCheckRuns no longer carries `id`, so newest-per-name has no ordering key and silently reverts");
});

/**
 * #1007: A CANCELLED RUN REACHED NO VERDICT, SO IT IS A WAIT — NOT A FAILURE, AND NOT SATISFIED EITHER.
 *
 * Measured on #1005 at 2026-09-11T23:14Z and it cost two claims in one hour. `gh pr ready` triggers CI,
 * `cancel-in-progress` kills the run already going, and that run's `gate` job leaves a check-run whose
 * conclusion is `cancelled`. It was the NEWEST `gate` on the head — the replacement run's had not reported
 * yet — so #902's newest-per-name rule was working exactly as designed and could not help. `row-claim`
 * turned it into "RED (a required check is failing)" and refused the author's next claim.
 *
 * THE SHAPE OF THE FIXTURE IS THE LIVE ONE, not a minimal pair: newest `gate` cancelled, `ts / run` still
 * in flight, everything else success or skipped. A minimal pair would have proved the classification and
 * missed what made this expensive — that the two halves arrive together, and the sentence a reader acts on
 * is the one naming what to do about both.
 */
const LIVE_1005 = [
  { id: 103452318218, name: "gate", status: "completed", conclusion: "cancelled" },
  { id: 103452318300, name: "ts / run", status: "in_progress", conclusion: null },
  { id: 103452318301, name: "changed", status: "completed", conclusion: "success" },
  { id: 103452318302, name: "docs", status: "completed", conclusion: "skipped" },
];

test("#1007: a required context whose newest run is CANCELLED is a WAIT, naming it, never FAILING", () => {
  const reasons = checkReasons(pr, ["gate"], LIVE_1005);
  assert.equal(reasons.length, 1, `expected one sentence, got: ${JSON.stringify(reasons)}`);
  assert.match(reasons[0], /^STILL RUNNING:/,
    "a cancelled context sends the reader where a still-running one does -- the replacement run is already "
    + "going -- so it must carry that sentence, which is the one `own-pr-health-rule` reads as a wait");
  assert.match(reasons[0], /gate \(cancelled: superseded, so it reached no verdict\)/,
    "and it must say WHICH and WHY, or a reader looks for a job that is still in flight and finds none");
  assert.ok(!reasons.some((reason) => reason.startsWith("FAILING")),
    `a cancelled run is not a failure a claimant can go fix: ${JSON.stringify(reasons)}`);
});

test("#1007: but it still REFUSES -- cancelled is not satisfied, or a merge proceeds on a context that never decided", () => {
  // THE MUTATION TARGET, and the reason the fix is not `SATISFIED.add("cancelled")`. That version is
  // strictly worse than the bug: the gate would read green on a required context that reached no verdict.
  assert.ok(!SATISFIED.has("cancelled"),
    "`cancelled` must never join SATISFIED -- it means no verdict, not a verdict of success");
  const onlyCancelled = [{ id: 1, name: "gate", status: "completed", conclusion: "cancelled" }];
  assert.notDeepEqual(checkReasons(pr, ["gate"], onlyCancelled), [],
    "a required context with nothing but a cancelled conclusion must still refuse the merge");
});

test("#1007: a GENUINE failure is still FAILING, and reads as red -- the distinction the fix rests on", () => {
  const failed = [{ id: 1, name: "gate", status: "completed", conclusion: "failure" }];
  const reasons = checkReasons(pr, ["gate"], failed);
  assert.deepEqual(reasons, ["FAILING: gate (failure)."]);
  const timedOut = [{ id: 1, name: "gate", status: "completed", conclusion: "timed_out" }];
  assert.match(checkReasons(pr, ["gate"], timedOut)[0], /^FAILING: gate \(timed_out\)/,
    "only `cancelled` moves: every other unsatisfied conclusion is still a failure somebody must go fix");
});

test("#1007: an OLDER cancelled run beside a newer conclusion is still #902's case, and does not speak", () => {
  // The two rows are neighbours and it matters which one is which: #902 is about ORDER (an old cancelled
  // attempt speaking for a name that has since concluded), #1007 about CLASSIFICATION (the newest IS the
  // cancelled one). This asserts #902's half still holds, so a fix to one cannot quietly undo the other.
  const superseded = [
    { id: 100, name: "gate", status: "completed", conclusion: "cancelled" },
    { id: 200, name: "gate", status: "completed", conclusion: "success" },
  ];
  assert.deepEqual(checkReasons(pr, ["gate"], superseded), []);
});

/**
 * #1007: THE CONSUMER ASSERTION IS DELIBERATELY ABSENT, and worker-judge's review of #1008 is why.
 *
 * An earlier version drove `ownPrHealthReason` (`scripts/row-claim/own-pr-health-rule.mjs`) to prove that
 * `row-claim`'s own colour reads the sentence above as a wait rather than RED -- the exact verdict that
 * refused a claim. **#989 dissolves that relationship**: B2 stops reading check state at all, so
 * `colourFor` and its prefix-matching go with it. The assertion pinned a path about to stop existing, and
 * both pull requests were green alone while whichever merged second would have broken.
 *
 * It was also the only reason this file needed a `// no-token: gh` declaration: importing that module
 * pulls `lookups.mjs` into the closure, which spawns `gh`, and the acceptance job has no token. One
 * deletion removes the collision, the declaration and the proof burden.
 *
 * NOTHING THIS MODULE OWNS IS LOST. The `STILL RUNNING:` prefix is still asserted above against this
 * module's own output, which is the property `checks-rule.mjs` is responsible for. The other two consumers
 * (`merge-guard.mjs`, `armed-race-rule.mjs`) read `reasons.length` and never the prefixes -- checked, not
 * assumed -- so after #989 no caller parses these sentences and there is no cross-module contract left to
 * pin from here.
 */

// ---------------------------------------------------------------------------------------------------
// #1009: the two never-rans. "That job was deleted" and "that job has not started" were one sentence.
//
// `gate` on this repository `needs: [changed, ts, python, ansible, changeset, rulesFitness]`, so it
// produces no check-run at all until its needs finish — it is the LAST job to report on every single
// pull request. **For most of every run, the healthy state and the broken state read identically**, and
// the remedies differ: *ask again* versus *go and find out why that job never fired*.
//
// Sibling of #1007, same function, the other branch: that one is a `cancelled` conclusion, this is no
// conclusion at all.
// ---------------------------------------------------------------------------------------------------

/**
 * #1008's head at 23:3xZ, the shape that produced the report — `ts / run` in flight, no `gate` at all.
 *
 * EXPORTED, because the consumer assertions this row also requires live in `merge-guard.test.ts` and
 * `workflow-run-liveness.test.ts` -- see the note at the foot of this file for why they are not here --
 * and a second copy of the fixture is the fact-stated-twice shape on the population the whole row is
 * about.
 *
 * `completedAt` is carried because the CONSUMERS read it: `stalenessReason` compares it to `main`'s tip,
 * and a population of nulls would make it speak and hand those assertions a refusal for a reason that has
 * nothing to do with this row. Dated AFTER the `mainTipIso` they pass, so the only sentence in play is
 * the one under test.
 */
export const LIVE_SHAPE = [
  { id: 1, name: "changed", status: "completed", conclusion: "success", completedAt: "2026-09-12T01:00:00Z" },
  { id: 2, name: "ts / run", status: "in_progress", conclusion: null, completedAt: null },
  { id: 3, name: "acceptance", status: "completed", conclusion: "success", completedAt: "2026-09-12T01:00:00Z" },
  { id: 4, name: "deliberateRefusals", status: "completed", conclusion: "success", completedAt: "2026-09-12T01:00:00Z" },
  { id: 5, name: "python", status: "completed", conclusion: "skipped", completedAt: "2026-09-12T01:00:00Z" },
];

test("#1009 ACCEPTANCE: a required context with no run, while something else is UNFINISHED, is a WAIT", () => {
  const reasons = checkReasons(pr, ["gate"], LIVE_SHAPE);
  const joined = reasons.join("\n");
  assert.match(joined, /STILL RUNNING:.*\bgate\b/,
    `the waiting context must be named in the WAIT: got ${JSON.stringify(reasons)}`);
  assert.match(joined, /no run has reported it yet/,
    "and annotated, so nobody mistakes it for a job that is actually executing");
  assert.doesNotMatch(joined, /NEVER RAN/,
    "this is the whole row: a healthy mid-run pull request must not be reported as an absence. `gate` "
    + "needs six other jobs, so this is the NORMAL state for most of every run");
  assert.match(joined, /ask again/, "and the remedy must be the waiting one, not the investigating one");
});

test("#1009: a required context with no run while every other run has CONCLUDED is still an ABSENCE", () => {
  // Unchanged, and this is the assertion that makes the split a split rather than a rename. If the
  // waiting mutation below leaves this passing AND the one above passing, the two cases were never
  // separated.
  const reasons = checkReasons(pr, ["gate"], [
    { id: 1, name: "changed", status: "completed", conclusion: "success" },
    { id: 2, name: "ts / run", status: "completed", conclusion: "success" },
  ]);
  const joined = reasons.join("\n");
  assert.match(joined, /REQUIRED CONTEXT NEVER RAN: gate/, "a genuine absence keeps its sentence");
  assert.match(joined, /removed, renamed, or/,
    "and now says WHY it is not 'not yet' -- every other run concluded, so waiting is not the remedy");
  assert.doesNotMatch(joined, /STILL RUNNING/, "with nothing running, there is nothing to wait for");
});

test("#1009: the #148 case is untouched — no runs at all is neither of the two never-rans", () => {
  const reasons = checkReasons(pr, ["gate"], []);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /NO CHECK RUNS EXIST/);
  assert.doesNotMatch(reasons[0], /STILL RUNNING|NEVER RAN/,
    "nothing has tested this code at all, which is a third thing and already has its own sentence");
});

test("#1009: a SUPERSEDED run counts as unfinished — the replacement has not reported either", () => {
  // #1007's ruling applied here rather than restated: a cancelled context means a replacement run is
  // already going, the same world as one in flight. Taking only `in_progress` would report an absence on
  // exactly the head whose replacement has not yet produced its check-runs.
  const joined = checkReasons(pr, ["gate"], [
    { id: 1, name: "ts / run", status: "completed", conclusion: "cancelled" },
  ]).join("\n");
  assert.match(joined, /STILL RUNNING:.*\bgate\b/, "the missing required context waits on the replacement");
  assert.doesNotMatch(joined, /NEVER RAN/, "a cancelled sibling is not 'everything concluded'");
});

test("#1009: the waiting sentence CLASSIFIES as STILL_RUNNING, not UNCLASSIFIED", () => {
  // WHY THE WAIT JOINS THE EXISTING SENTENCE INSTEAD OF GETTING A NEW PREFIX. `reason-kind.mjs` maps a
  // reason to a kind by PREFIX and returns `UNCLASSIFIED` for anything it does not recognise -- silently.
  // A new prefix would be a second copy of the sentence, in another file, with nothing comparing them,
  // and #188's reconciliation log would file every waiting refusal under `UNCLASSIFIED` while every test
  // here passed. That file's own header names this shape.
  const waiting = checkReasons(pr, ["gate"], LIVE_SHAPE)[0];
  assert.equal(reasonKind(waiting), "STILL_RUNNING",
    `the waiting reason classified as ${reasonKind(waiting)}; a new prefix needs a new REASON_KINDS entry `
    + "and the miss is silent");
  const absence = checkReasons(pr, ["gate"], [
    { id: 1, name: "ts", status: "completed", conclusion: "success" }]).join("\n");
  assert.equal(reasonKind(absence), "MISSING_REQUIRED_CONTEXT",
    "and the genuine absence keeps its own kind, or the two are indistinguishable in the log too");
});


// WHY THE CONSUMER ASSERTIONS ARE NOT IN THIS FILE.
//
// The row requires them ("asserted at the consumer and not only at `checkReasons`, because the two
// sentences are separate strings with nothing tying them"), and they were here first. Importing
// `mergeReadiness` puts `gh` in this file's IMPORT CLOSURE -- the test never calls it, every input is
// injected -- and `pr-open`'s acceptance check refused on exactly that:
//
//     REFUSED npx tsx --test …/merge-guard-checks-rule.test.ts -> needs `token`, which this job does
//     not have -- merge-guard-checks-rule.test.ts requires token via mergeReadiness -> gh -> lookups.mjs:26
//
// **Satisfying the row would have disqualified this file from the job that runs acceptance commands.**
// So they live in `merge-guard.test.ts` and `workflow-run-liveness.test.ts`, which already import those
// modules and already carry that constraint, and they share `LIVE_SHAPE` from here rather than retyping
// the population.
