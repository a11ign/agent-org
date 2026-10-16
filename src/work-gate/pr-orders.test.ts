// no-token: gh -- nothing here runs `gh`; the pull requests are literal objects and the chairman's write is a fake `run`.
/**
 * a11ign#5528, agent-org#1538: A CHECK WHOSE REMEDY IS A REVIEW IS NOT A CODE FAILURE.
 *
 * A check that says `Cleared-by: review` in its output summary is red until a reviewer's verdict clears it. The gate reads that line for the
 * head the checks were read at, and routes such a pull request to its reviewer: `awaiting-review`, a reviewer ordered at the head, and NO
 * `pr-checks-failing` at the author. A check with no marker, or a pull request with one unmarked failing check among the marked, is red as before.
 *
 * THE CONTROLS: (a) is the new routing and must FAIL on `main`, where no marker is read. (b)-(c) are the unchanged routing and must PASS on both.
 * (d) is the human marker, (e) a head that moved since the review.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stallReasonOf, perPullRequestOrders, fileReviewGatedHuman, reviewGateOf, reviewGatedHumanBrief } from "./pr-orders.ts";
import { clearedByOf, checkMarkersOf } from "./review-gate.ts";
import { subjectRef } from "../review-attribution.ts";
import { reviewGatedUnaskedReading, REVIEW_GATED_MINUTES } from "../org-health.ts";
import { reviewGatedFacts } from "./org-health.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const MOVED = "fedcba9876543210fedcba9876543210fedcba98";
const REQUIRED = null;

const red = (name: string) => ({ name, status: "COMPLETED", conclusion: "FAILURE", completedAt: new Date(NOW - 3 * HOUR).toISOString() });
const green = (name: string) => ({ name, status: "COMPLETED", conclusion: "SUCCESS", completedAt: new Date(NOW - 3 * HOUR).toISOString() });

/** a ready pull request whose `changeset` and `gate` checks are red, with the given markers read at `checkMarkersHead` */
function pullRequest({ rollup = [red("changeset"), red("gate")], markers = { changeset: "review", gate: "review" }, markersHead = HEAD, head = HEAD, isDraft = false }:
  { rollup?: any[]; markers?: Record<string, string>; markersHead?: string; head?: string; isDraft?: boolean } = {}) {
  return { number: 5528, repo: "a11ign/a11ign", repoKey: "a11ign/a11ign", isDraft, headRefOid: head,
    statusCheckRollup: rollup, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", labels: [],
    author: { login: "a11ign-bot" }, comments: [], files: [{ path: "src/a.ts", additions: 3, deletions: 1 }], changedFiles: 1,
    checkMarkers: markers, checkMarkersHead: markersHead };
}

const reviewerOrderFor = (pr: any, orders: any[]) => orders.some((o) => o.cause === "draft-awaiting-verdict" && o.subject === `pr-${subjectRef(pr.repoKey, pr.number)}`);
const checksFailingOrderFor = (orders: any[]) => orders.some((o) => o.cause === "pr-checks-failing");

test("(a) a failing check whose remedy is a review is awaiting-review, with a reviewer ordered at the head and no pr-checks-failing", () => {
  const pr = pullRequest();
  assert.equal(stallReasonOf(pr, REQUIRED, NOW), "awaiting-review");
  const orders = perPullRequestOrders([pr], REQUIRED, null, NOW);
  assert.equal(reviewerOrderFor(pr, orders), true);
  assert.equal(checksFailingOrderFor(orders), false);
  assert.ok(orders.some((o) => o.causeKey?.includes(HEAD.slice(0, 8))), "the reviewer's order is keyed on the head");
});

test("(b) a red check with no marker is red and pr-checks-failing, as before", () => {
  const pr = pullRequest({ markers: {} });
  assert.equal(stallReasonOf(pr, REQUIRED, NOW), "red");
  assert.equal(checksFailingOrderFor(perPullRequestOrders([pr], REQUIRED, null, NOW)), true);
});

test("(c) one failing marked review and one failing unmarked check is red and pr-checks-failing", () => {
  const pr = pullRequest({ rollup: [red("changeset"), red("ts / run")], markers: { changeset: "review" } });
  assert.equal(reviewGateOf(pr, REQUIRED), null);
  assert.equal(stallReasonOf(pr, REQUIRED, NOW), "red");
  assert.equal(checksFailingOrderFor(perPullRequestOrders([pr], REQUIRED, null, NOW)), true);
});

test("(d) a failing check that says Cleared-by: human files the chairman's brief, and orders no reviewer", () => {
  const pr = pullRequest({ markers: { changeset: "review", gate: "human" } });
  assert.equal(reviewGateOf(pr, REQUIRED), "human");
  const orders = perPullRequestOrders([pr], REQUIRED, null, NOW);
  assert.equal(reviewerOrderFor(pr, orders), false);
  assert.equal(checksFailingOrderFor(orders), false);

  const calls: string[][] = [];
  const logged: string[] = [];
  const filed = fileReviewGatedHuman([pr], { required: REQUIRED, run: (args: string[]) => { calls.push(args); return ""; }, log: (line: string) => logged.push(line) });
  assert.equal(filed, 1);
  assert.deepEqual(calls[0].slice(0, 4), ["pr", "edit", "5528", "--repo"]);
  assert.ok(calls[0].includes("needs:chairman"), "the brief carries the chairman's label");
  const comment = calls[1];
  assert.deepEqual(comment.slice(0, 3), ["pr", "comment", "5528"]);
  const body = comment[comment.indexOf("--body") + 1];
  assert.ok(body.includes("`src/a.ts` (+3 -1)"), "the brief names the diff");
  assert.ok(body.includes("`gate`"), "the brief names the check that asks for the human");
  assert.deepEqual(logged, []);

  // The same brief is not filed twice: its marker is on a comment already.
  const again = fileReviewGatedHuman([{ ...pr, comments: [{ body: reviewGatedHumanBrief(pr).marker }] }], { required: REQUIRED, run: () => "", log: () => {} });
  assert.equal(again, 0);
});

test("(e) a head that moved since the review is unmarked at the new head, so it is red again", () => {
  const pr = pullRequest({ head: MOVED, markersHead: HEAD });
  assert.equal(reviewGateOf(pr, REQUIRED), null);
  assert.equal(stallReasonOf(pr, REQUIRED, NOW), "red");
  assert.equal(checksFailingOrderFor(perPullRequestOrders([pr], REQUIRED, null, NOW)), true);
});

test("a marker naming an act the gate does not know (`edit`) is no marker", () => {
  assert.equal(clearedByOf("Cleared-by: edit"), null);
  assert.equal(clearedByOf("Please wait.\nCleared-by: review"), "review");
  assert.equal(clearedByOf("A line that quotes Cleared-by: review inside a sentence"), null);
  assert.equal(clearedByOf(null), null);
});

test("the marker is read from each check's newest run only", () => {
  const markers = checkMarkersOf([
    { id: 10, name: "gate", summary: "Cleared-by: review" },
    { id: 11, name: "gate", summary: "re-run without the marker" },
    { id: 12, name: "changeset", summary: "Cleared-by: human" },
  ]);
  assert.deepEqual(markers, { changeset: "human" });
});

test("review-gated-unasked: a red review-gated pull request with no reviewer ordered for two hours is reported, one hour is not", () => {
  const pr = pullRequest();
  const facts = reviewGatedFacts([pr], [], REQUIRED);
  assert.deepEqual(facts.map((f) => f.number), [5528]);
  assert.equal(facts[0].reviewerOrdered, false);
  const subject = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  const orderAt = (head: string) => ({ cause: "draft-awaiting-verdict", subject, causeKey: `agent-x/draft-awaiting-verdict/${subject}/${head.slice(0, 8)}` });
  assert.equal(reviewGatedFacts([pr], [orderAt(HEAD)], REQUIRED)[0].reviewerOrdered, true);

  // A head that moved since the reviewer was ordered: the order at the old head is not an order at the new one, so the detector trips.
  const moved = pullRequest({ head: MOVED, markersHead: MOVED });
  assert.equal(reviewGatedFacts([moved], [orderAt(HEAD)], REQUIRED)[0].reviewerOrdered, false, "an order at the old head is not counted at the new one");
  assert.equal(reviewGatedFacts([moved], [orderAt(MOVED)], REQUIRED)[0].reviewerOrdered, true, "an order at the new head is counted");
  const movedFacts = reviewGatedFacts([moved], [orderAt(HEAD)], REQUIRED);
  assert.equal(reviewGatedUnaskedReading({ now: NOW, prs: movedFacts.map((f) => ({ ...f, redSince: NOW - 3 * HOUR })) }).status, "tripped");
  assert.equal(REVIEW_GATED_MINUTES, 120);

  const twoHoursAgo = NOW - 2 * HOUR - 1000;
  const oneHourAgo = NOW - HOUR;
  const tripped = reviewGatedUnaskedReading({ now: NOW, prs: [{ number: 5528, redSince: twoHoursAgo, reviewerOrdered: false }] });
  assert.equal(tripped.status, "tripped");
  const quiet = reviewGatedUnaskedReading({ now: NOW, prs: [{ number: 5528, redSince: oneHourAgo, reviewerOrdered: false }] });
  assert.equal(quiet.status, "clear");
});
