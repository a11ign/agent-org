/**
 * #2127: THE REVIEWER PARITY RULE, MADE OBSERVABLE -- and the proof that this reader could not be
 * satisfied by the account that posts the review.
 *
 * THE DEFECT THIS PINS. `.claude/rules/agent-practices.md` gives odd pull requests to `reviewer` and
 * even ones to `reviewer-2`, and `work-gate.mjs` routes on exactly that. On 2026-09-23 `reviewer-2`
 * reviewed #2105 -- an ODD number -- twice, including the APPROVED, and nothing could see it: all four
 * reviews on that pull request carry `user.login == "a11ign-bot"`, because the two sessions share one
 * GitHub account. The session's name lived only in the review's body prose. A rule nothing can observe
 * cannot be enforced, reported, or counted; a human reading four review bodies an hour later is what
 * found this one.
 *
 * THE POSITIVE CONTROL IS THE #2105 SHAPE ITSELF, and it is the test that must fail if this reader
 * stops working: an odd pull request with a `reviewer-2` attribution must read as a VIOLATION. The
 * `correct` cases below pass for a reader that answers "correct" to everything, so they are not the
 * control -- they are what stops the violation case being met by answering "violation" to everything.
 *
 * AND THE THIRD CASE IS THE WHOLE POINT: two reviews with the SAME `user.login` and different
 * reviewing sessions must come apart. A reader keyed on the login finds no disagreement anywhere in
 * this repository and looks like it works.
 *
 * FIELD NAMES ARE MEASURED, NOT GUESSED. The status fixtures below are the literal shapes GitHub
 * returned on 2026-09-23T12:40:51Z for a real status written by `a11ign-bot` (scopes `gist`,
 * `read:org`, `repo`; repository permission `push: true`) onto commit `74e4d1c5` of this row's own
 * branch: REST `commits/{sha}/statuses` spells `target_url`, GraphQL's `statusCheckRollup.contexts`
 * spells `targetUrl`, and a `StatusContext` node carries NO `name` -- which is why `newestPerName`
 * skips it and an attribution status cannot disturb the gate's read of the checks.
 */
// NO CAPABILITY DECLARATION, AND NONE IS NEEDED -- checked rather than assumed: `testFileRequirements`
// on this file returns `[]`, because nothing here spawns `gh`. The only `gh` in the fixture is a FAKE
// shell shim `fakeGh` writes into a temporary directory that goes first on `PATH`, so the door script
// under test reaches the shim and never the real client; and the module under test spawns nothing at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTRIBUTION_CONTEXT_PREFIX, PARITY, attributionContext, attributedSession, parityOfReview,
  parityOwner, parityViolationsOnCommit, reviewingSession,
} from "../review-attribution.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const DOOR = join(REPO_ROOT, "packages/agent-org/src/reviewer/pr-review-verdict.sh");

/** The review `reviewer-2` should never have posted: #2105 is odd, so the parity owner is `reviewer`. */
const REVIEW_2105_APPROVAL = {
  html_url: "https://github.com/a11ign/a11ign/pull/2105#pullrequestreview-5290312345",
  commit_id: "e1b8b7bc0000000000000000000000000000abcd",
  state: "APPROVED",
  user: { login: "a11ign-bot" },
};

/** The review `reviewer` posted on the same commit, one minute later. Same account, other session. */
const REVIEW_2105_REFUSAL = {
  html_url: "https://github.com/a11ign/a11ign/pull/2105#pullrequestreview-5290399999",
  commit_id: "e1b8b7bc0000000000000000000000000000abcd",
  state: "CHANGES_REQUESTED",
  user: { login: "a11ign-bot" },
};

/** REST `commits/{sha}/statuses`: `target_url`, measured. */
const restStatus = (session: string, targetUrl: string) =>
  ({ context: attributionContext(session), state: "success", target_url: targetUrl });

/** GraphQL `statusCheckRollup.contexts.nodes`: `targetUrl`, no `name`, measured. */
const rollupStatus = (session: string, targetUrl: string) =>
  ({ __typename: "StatusContext", context: attributionContext(session), state: "SUCCESS",
     targetUrl, createdAt: "2026-09-23T12:40:51Z" });

// --- the parity rule itself -------------------------------------------------------------------

test("#2127: the parity rule is ODD -> reviewer, EVEN -> reviewer-2, and #2105 is reviewer's", () => {
  assert.equal(parityOwner(2105), "reviewer");
  assert.equal(parityOwner(2126), "reviewer-2");
  assert.equal(parityOwner("2127"), "reviewer");
});

// --- the three the row asks for ---------------------------------------------------------------

test("#2127 (1): a review by the PARITY-CORRECT reviewer reads as correct", () => {
  const statuses = [restStatus("reviewer", REVIEW_2105_REFUSAL.html_url)];
  assert.equal(reviewingSession(REVIEW_2105_REFUSAL, statuses), "reviewer");
  assert.equal(parityOfReview({ prNumber: 2105, review: REVIEW_2105_REFUSAL, statuses }), PARITY.correct);
});

test("#2127 (2) POSITIVE CONTROL, the #2105 shape: an ODD pull request with a `reviewer-2` review "
  + "reads as a VIOLATION", () => {
  const statuses = [restStatus("reviewer-2", REVIEW_2105_APPROVAL.html_url)];
  assert.equal(reviewingSession(REVIEW_2105_APPROVAL, statuses), "reviewer-2");
  assert.equal(parityOfReview({ prNumber: 2105, review: REVIEW_2105_APPROVAL, statuses }), PARITY.violation);
  // And the commit-level question a counter asks, with its own positive control one test down.
  assert.deepEqual(parityViolationsOnCommit({ prNumber: 2105, statuses }), ["reviewer-2"]);
});

test("#2127 (3): two reviews with the SAME `user.login` and different sessions come apart -- which is "
  + "what a reader keyed on the account cannot do", () => {
  const statuses = [
    rollupStatus("reviewer-2", REVIEW_2105_APPROVAL.html_url),
    rollupStatus("reviewer", REVIEW_2105_REFUSAL.html_url),
  ];
  assert.equal(REVIEW_2105_APPROVAL.user.login, REVIEW_2105_REFUSAL.user.login,
    "the fixture only means something while both reviews carry the identical account");
  assert.equal(reviewingSession(REVIEW_2105_APPROVAL, statuses), "reviewer-2");
  assert.equal(reviewingSession(REVIEW_2105_REFUSAL, statuses), "reviewer");
  assert.equal(parityOfReview({ prNumber: 2105, review: REVIEW_2105_APPROVAL, statuses }), PARITY.violation);
  assert.equal(parityOfReview({ prNumber: 2105, review: REVIEW_2105_REFUSAL, statuses }), PARITY.correct);
});

// --- what the reader refuses to guess ---------------------------------------------------------

test("#2127: a commit with only the PARITY OWNER's attributions reports no violation -- the empty "
  + "answer whose positive control is the test above", () => {
  const statuses = [rollupStatus("reviewer", REVIEW_2105_REFUSAL.html_url)];
  assert.deepEqual(parityViolationsOnCommit({ prNumber: 2105, statuses }), []);
});

test("#2127: today's state -- four reviews, one account, NO attribution statuses -- reads as "
  + "`unobservable`, never as correct", () => {
  for (const review of [REVIEW_2105_APPROVAL, REVIEW_2105_REFUSAL]) {
    assert.equal(reviewingSession(review, []), null);
    assert.equal(parityOfReview({ prNumber: 2105, review, statuses: [] }), PARITY.unobservable);
  }
  assert.deepEqual(parityViolationsOnCommit({ prNumber: 2105, statuses: [] }), []);
});

test("#2127: a status pointing at ANOTHER review on the same commit attributes nothing here", () => {
  const statuses = [restStatus("reviewer-2", REVIEW_2105_APPROVAL.html_url)];
  assert.equal(reviewingSession(REVIEW_2105_REFUSAL, statuses), null);
  assert.equal(parityOfReview({ prNumber: 2105, review: REVIEW_2105_REFUSAL, statuses }), PARITY.unobservable);
});

test("#2127: two sessions claiming ONE review is a contradiction, not a tie to break", () => {
  const statuses = [
    restStatus("reviewer", REVIEW_2105_APPROVAL.html_url),
    restStatus("reviewer-2", REVIEW_2105_APPROVAL.html_url),
  ];
  assert.equal(reviewingSession(REVIEW_2105_APPROVAL, statuses), null);
});

test("#2127: a status that is not an attribution is not read as one", () => {
  assert.equal(attributedSession({ context: "ts / run", state: "success" }), null);
  assert.equal(attributedSession({ context: ATTRIBUTION_CONTEXT_PREFIX, state: "success" }), null,
    "a bare `review/` names no session and must not read as one");
  assert.equal(attributedSession({ context: "reviewer", state: "success" }), null);
  assert.equal(attributedSession({ context: "review/worker-judge" }), "worker-judge",
    "an unrostered name is still a fact about who reviewed");
});

// --- the door: the one place the identity still exists ------------------------------------------

/**
 * A `gh` on `PATH` that records its argv and answers the one read the door makes. `reviewsJson` is what
 * `gh api .../reviews --jq ...` prints -- the door asks for a tab-separated `[html_url, commit_id, body]`.
 */
function fakeGh(bin: string, tsvLine: string, { failStatus = false } = {}) {
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  // THE ANSWER GOES IN A FILE AND THE SHIM `cat`s IT. A verdict line carries backticks, and a backtick
  // inside a double-quoted shell literal is command substitution -- the first draft of this fixture
  // silently handed the door a MANGLED body, which it then correctly refused to attribute. A fixture
  // that makes the subject take its own refusal path proves nothing about the path being tested.
  const answer = join(bin, "reviews.tsv");
  writeFileSync(answer, `${tsvLine}\n`);
  writeFileSync(join(bin, "gh"), [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    `if [[ "$1" == "api" && "$2" == --method ]]; then exit ${failStatus ? 1 : 0}; fi`,
    `if [[ "$1" == "api" ]]; then cat ${JSON.stringify(answer)}; fi`,
    "exit 0",
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);
  return log;
}

function runDoor(session: string | null, tsvLine: string, options: { failStatus?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-verdict-"));
  const bin = join(dir, "bin");
  const log = fakeGh(bin, tsvLine, options);
  const file = join(dir, "verdict.md");
  const body = "**Review of #2105 at `e1b8b7bc`, by reviewer: not convinced — the blocker.**";
  writeFileSync(file, `${body}\n\nAcceptance: npm test — 3/0\n`);
  const env: Record<string, string> = { ...process.env as Record<string, string>,
    PATH: `${bin}:${process.env.PATH}` };
  delete env.A11Y_REVIEWER_SESSION;
  if (session !== null) env.A11Y_REVIEWER_SESSION = session;
  const result = spawnSync("bash", [DOOR, "2105", "not-convinced", file], { env, encoding: "utf8" });
  return { result, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [], body };
}

const TSV = "https://github.com/a11ign/a11ign/pull/2105#pullrequestreview-5290399999\t"
  + "e1b8b7bc0000000000000000000000000000abcd\t"
  + "**Review of #2105 at `e1b8b7bc`, by reviewer: not convinced — the blocker.**";

test("#2127: the door posts the review AND a `review/<session>` status pointing at that review", () => {
  const { result, calls } = runDoor("reviewer", TSV);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.some((c) => c.startsWith("pr review 2105 ")), `no review posted: ${calls.join(" | ")}`);
  const status = calls.find((c) => c.includes("statuses/"));
  assert.ok(status, `no attribution status written: ${calls.join(" | ")}`);
  assert.match(status!, /statuses\/e1b8b7bc0000000000000000000000000000abcd/);
  assert.ok(status!.includes(`context=${attributionContext("reviewer")}`), status!);
  assert.ok(status!.includes("target_url=https://github.com/a11ign/a11ign/pull/2105#pullrequestreview-5290399999"),
    status!);
  assert.ok(status!.includes("state=success"),
    "ALWAYS success: this records who reviewed, never whether the review passed");
});

test("#2127: the door writes `reviewer-2`'s own name, not a constant -- the mutation that would make "
  + "every review read as `reviewer` and hide the #2105 violation", () => {
  const { calls } = runDoor("reviewer-2", TSV);
  const status = calls.find((c) => c.includes("statuses/"));
  assert.ok(status!.includes(`context=${attributionContext("reviewer-2")}`), status!);
});

test("#2127: with no session declared the review STILL POSTS, and the door says it is unattributed", () => {
  const { result, calls } = runDoor(null, TSV);
  assert.equal(result.status, 0, "an attribution that cannot be made must never cost a verdict");
  assert.ok(calls.some((c) => c.startsWith("pr review 2105 ")), "the review is the thing that must happen");
  assert.ok(!calls.some((c) => c.includes("statuses/")), "nothing to attribute it to");
  assert.match(result.stderr, /UNATTRIBUTED/);
  assert.match(result.stderr, /A11Y_REVIEWER_SESSION/);
});

test("#2127: a review that is not the newest one back from GitHub is NOT attributed -- the door never "
  + "labels a review it cannot prove it just posted", () => {
  const otherBody = "**Review of #2105 at `e1b8b7bc`, by reviewer-2: convinced.**";
  const tsv = `https://github.com/a11ign/a11ign/pull/2105#pullrequestreview-1\tdeadbeef\t${otherBody}`;
  const { result, calls } = runDoor("reviewer", tsv);
  assert.equal(result.status, 0);
  assert.ok(!calls.some((c) => c.includes("statuses/")), "it would have attributed somebody else's review");
  assert.match(result.stderr, /not the one just posted/);
});

test("#2127: the read-back takes the LAST review, not the first -- a pull request with a page of "
  + "earlier reviews still attributes the one just posted", () => {
  const earlier = "https://github.com/a11ign/a11ign/pull/2105#pullrequestreview-1\tdeadbeef\t"
    + "**Review of #2105 at `aaaaaaaa`, by reviewer-2: convinced.**";
  const { result, calls } = runDoor("reviewer", `${earlier}\n${TSV}`);
  assert.equal(result.status, 0, result.stderr);
  const status = calls.find((c) => c.includes("statuses/"));
  assert.ok(status, `no attribution status written: ${calls.join(" | ")}`);
  assert.match(status!, /statuses\/e1b8b7bc0000000000000000000000000000abcd/);
  assert.ok(!status!.includes("deadbeef"), "it attributed the older review's commit");
});

test("#2127: a failed status write is reported and still does not fail the verdict", () => {
  const { result } = runDoor("reviewer", TSV, { failStatus: true });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /could not record the attribution status/);
});

// --- one spelling, across a language boundary ---------------------------------------------------

test("#2127: the door's context prefix IS `attributionContext`'s -- the writer is shell and the reader "
  + "is JavaScript, so nothing but this comparison can keep them in step", () => {
  const script = readFileSync(DOOR, "utf8");
  const declared = /^ATTRIBUTION_CONTEXT_PREFIX=(\S+)$/m.exec(script);
  assert.ok(declared, "the door must declare the prefix on one readable line");
  assert.equal(declared![1], ATTRIBUTION_CONTEXT_PREFIX);
  assert.ok(script.includes('-f "context=${ATTRIBUTION_CONTEXT_PREFIX}${session}"'),
    "the posted context must be built from that constant and the session, not spelled again");
  assert.equal(attributionContext("reviewer-2"), "review/reviewer-2");
});
