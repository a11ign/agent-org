// no-token: gh
//
// Every GitHub fact in this file is a fixture in the fake code host's world (A11-160, step 5): the pass reads it, and its default `arm` runs the REAL `runArmPr` over the same code host, so `arm-pr`'s own
// reads and writes land in the fake too, the changed-file list of the authorship verdict among them (A11-160, step 9). The `run` the pass is handed must never run. True of the IMPORT and false of every CALL.
/**
 * agent-org#1622: AN OUTSIDE PASS REPORTS "armed" ONLY AFTER A READ-BACK SAYS SO, AND EVERY REFUSAL `arm-pr` MAKES IS NAMED, NOT PASSED.
 *
 * THE INSTANCE. a11ign/a11ign#1595 was ejected from the merge queue, the outside pass logged it "armed", and its GraphQL read said
 * `autoMergeRequest: null`. `arm-pr` exits DONE for a deliberate refusal as it does for an arm (its exit codes are not changed here),
 * so the pass read the exit as the answer. The answer is the read-back.
 *
 * ONE TEST PER REFUSAL, THROUGH THE PASS, with the real `runArmPr` under it. Each refusal asserts four things:
 *   - it is not in `result.armed`;
 *   - no auto-merge write was made;
 *   - it is named in `result.left` (with the line `arm-pr` wrote) or in `result.failed`;
 *   - no log line says "armed" in lowercase. The word belongs to the read-back line, and to nothing else.
 * The positive control beside them is an armable pull request, which IS in `result.armed` after its read-back says so.
 *
 * THE ORDER is `arm-pr`'s own (ejection first, because #3487 put it before any write for a pull request that nothing else has touched),
 * then the drift refusals (a fact the policy list did not show, read again by `arm-pr`), then the two that the pass's verdict refuses
 * before `arm-pr` is ever reached (a draft that is not approved, a fork). Those two assert that `arm-pr` was never called.
 *
 * THE TWO REFUSALS THAT READ GITHUB THROUGH A VERDICT THAT HAS NOT MOVED (the red cross-repo leg, #1622 (6), and the deliberate refusal, (7)) are in
 * `plugins/github/rows/outside-arm-verdicts.test.ts`, which runs them over the GitHub plugin's own rows: their reads (a check run, a failed log, a pull request's text) are GitHub's own
 * shape, and move into the code host's operations with their callers.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { outsideArmPass, type OutsideArmPr } from "../auto-arm-sweep.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow, type FakeRowPull } from "../plugins/fakes/code-host-rows.ts";
import type { Lane } from "../lane-ownership.ts";

const REPO = "a11ign/a11ign";
const LEADS = "a11ign-ai-leads";
const OUTSIDE = "an-outside-contributor";
const WORKFLOW = ".github/workflows/ci.yml";
const PIPELINE: Lane = { lane: "the pipeline", owner: "ceo", branchPrefixes: ["ceo/"], paths: [".github/workflows/"],
  why: "trunk health", except: [".github/workflows/consumer-gate.yml"], reviewOnly: true };
const NO_LANES = { lanes: [] as Lane[] };

const LIST: OutsideArmPr = { number: 7, state: "OPEN", isDraft: false, baseRefName: "main", isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED", labels: [{ name: "agent" }] };
const EJECTED_AT = "2026-10-04T14:48:06Z";

afterEach(() => forgetActivation());

type World = {
  list?: Partial<OutsideArmPr>;   // the policy list the pass reads: what the CALLER's list shows (drift: a fact the list did not show is the pull request's)
  pull?: Partial<FakeRowPull>;    // what the code host holds, and `arm-pr` reads: labels, body, author, state, an ejection
  blockedBy?: number[];           // the open rows that block row #1, which the pull request closes
  files?: string[];               // the files of the pull request, for the authorship read (the verdict that has not moved reads them through its `run`)
  merged?: boolean;               // the pull request merged between the pass's list and `arm-pr`'s read of it
};

/** The fake code host holding pull request #7, which closes row #1, with `arm-pr`'s reads of it counted in `world.calls`. */
function seeded(w: World) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = REPO;
  const pull: FakeRowPull = { number: 7, body: "Closes #1", headRefName: "agent/lane-7", labels: [], isDraft: w.list?.isDraft === true, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-23T10:00:00Z",
    comments: [], baseRefName: "main", isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED", author: OUTSIDE, headRefOid: "abc123",
    closes: [{ number: 1, repo: REPO, title: "a row", labels: [] }], ...(w.files === undefined ? {} : { files: w.files }), ...w.pull };
  world.pulls.set(7, pull);
  world.rows.set(1, fakeRow(world, 1, { blockedBy: w.blockedBy ?? [] }));
  for (const blocker of w.blockedBy ?? []) world.rows.set(blocker, fakeRow(world, blocker));
  const rows = host.rows!;
  const read = rows.readPullForArming;
  rows.readPullForArming = (request) => {
    world.calls.push(`readPullForArming #${request.number}`);
    return { ...read(request), ...(w.merged === true ? { state: "MERGED" } : {}) };
  };
  substituteCodeHost(host);
  return { world, pull };
}

/** One pass over the pull request #7 with the real `arm-pr` under it. The lanes are empty unless a case brings its own. */
function drive(w: World = {}, lanes: { lanes: Lane[] } = NO_LANES) {
  const { world, pull } = seeded(w);
  const lines: string[] = [];
  const prs: OutsideArmPr[] = [{ ...LIST, ...w.list }];
  const run = (args: string[]): string => {
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const result = outsideArmPass({ repo: REPO, switchesPath: "", on: true, prs, run, log: (line) => lines.push(line), lanes });
  return { result, lines, world, pull };
}

const arms = (out: ReturnType<typeof drive>) => out.world.calls.filter((call) => call.startsWith("armPullAuto"));
const armPrWasReached = (out: ReturnType<typeof drive>) => out.world.calls.some((call) => call.startsWith("readPullForArming"));

/** The four things every refusal must hold, and the reason it is named by. */
function assertRefused(name: string, out: ReturnType<typeof drive>, why: RegExp) {
  assert.deepEqual(out.result.armed, [], `${name}: must not be armed`);
  assert.deepEqual(arms(out), [], `${name}: no arm write`);
  const left = out.result.left.find((entry) => entry.number === 7);
  assert.ok(left !== undefined || out.result.failed.includes(7), `${name}: named in result.left or result.failed`);
  assert.match(left ? left.why : out.lines.join("\n"), why, `${name}: the reason`);
  for (const line of out.lines) assert.doesNotMatch(line, /\barmed\b/, `${name}: no log line says armed: ${line}`);
}

// --- the refusals, in arm-pr's own order, ejection first ----------------------------------------------------------------------------------

test("#1622 (1) ejected without a push: the merge queue's ejection is named as the ejection, and nothing is armed", () => {
  const out = drive({ pull: { ejectedAt: EJECTED_AT } });
  assertRefused("ejected", out, /without a push/);
  assert.ok(out.result.left.some((entry) => entry.why.includes(EJECTED_AT)), "the ejection time is in the reason");
});

test("#1622 (2) hold: a `hold:` label `arm-pr` reads, although the list the pass read showed none, is named as the hold", () => {
  const out = drive({ pull: { labels: ["hold:ceo"] } });
  assertRefused("hold", out, /hold/i);
});

test("#1622 (3) settled: a pull request `arm-pr` reads as merged, although the list showed it open, is named as settled", () => {
  const out = drive({ merged: true });
  assertRefused("settled", out, /MERGED|merged/);
});

test("#1622 (4) authorship: a leads-login pull request that touches the pipeline is named as the lane refusal", () => {
  const out = drive({ pull: { author: LEADS }, files: [WORKFLOW] }, { lanes: [PIPELINE] });
  assertRefused("authorship", out, /lane|pipeline/i);
});

test("#1622 (5) open blocker: a closing row that an OPEN row blocks is named as the block, and `arm-pr` announces it", () => {
  const out = drive({ blockedBy: [9] });
  assertRefused("open blocker", out, /blocked by open #9/);
  assert.ok(out.pull.comments.some((body) => body.includes("<!-- arm-refused: open-blocker 9 -->")), "the refusal is said once, on the pull request");
});

// --- the two the pass's verdict refuses before `arm-pr` is reached ------------------------------------------------------------------------

test("#1622 (8) draft not approved: the pass leaves it, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { isDraft: true, reviewDecision: "REVIEW_REQUIRED" } });
  assertRefused("draft", out, /draft that is not approved/);
  assert.equal(armPrWasReached(out), false, "no arm-pr read");
});

test("#1622 (9) fork: the pass leaves it, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { isCrossRepository: true } });
  assertRefused("fork", out, /fork/);
  assert.equal(armPrWasReached(out), false, "no arm-pr read");
});

test("#1622 (10) unread labels: a list that did not carry the labels is left, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { labels: undefined } });
  assertRefused("unread labels", out, /labels were not read/);
  assert.equal(armPrWasReached(out), false, "no arm-pr read");
});

test("#1622 (11) hold in the list: the pass leaves a pull request its own list shows held, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { labels: [{ name: "hold:ceo" }] } });
  assertRefused("verdict hold", out, /hold:ceo/);
  assert.equal(armPrWasReached(out), false, "no arm-pr read");
});

test("#1622 (12) closed in the list: the pass leaves it, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { state: "CLOSED" } });
  assertRefused("verdict state", out, /the pull request is CLOSED/);
  assert.equal(armPrWasReached(out), false, "no arm-pr read");
});

test("#1622 (13) base not main in the list: the pass leaves it, and `arm-pr` is never called for it", () => {
  const out = drive({ list: { baseRefName: "dev" } });
  assertRefused("verdict base", out, /its base is dev, not main/);
  assert.equal(armPrWasReached(out), false, "no arm-pr read");
});

// --- agent-org#1628: an approved draft is readied before `arm-pr` can refuse it ---------------------------------------------------------

test("#1628 an approved draft that `arm-pr` refuses (a hold only it reads) is not left ready: it is put back to a draft", () => {
  const out = drive({ list: { isDraft: true, reviewDecision: "APPROVED" }, pull: { labels: ["hold:ceo"] } });
  assertRefused("approved draft", out, /hold/i);
  const ready = out.world.calls.filter((call) => call.startsWith("readyPullRequest"));
  assert.deepEqual(ready, ["readyPullRequest #7", "readyPullRequest #7 undo"], "readied, then put back, in that order");
  assert.equal(out.pull.isDraft, true, "and it is a draft again");
  assert.deepEqual(out.result.readied, [], "not counted as readied");
});

test("#1628 CONTROL: an approved draft that `arm-pr` arms stays ready and is not put back", () => {
  const out = drive({ list: { isDraft: true, reviewDecision: "APPROVED" } });
  assert.deepEqual(out.result.armed, [7], out.lines.join("\n"));
  assert.deepEqual(out.result.readied, [7]);
  assert.equal(out.world.calls.some((call) => call.endsWith("undo")), false, "no put-back");
  assert.equal(out.pull.isDraft, false, "it is ready");
});

// --- the positive control -------------------------------------------------------------------------------------------------------------------

test("#1622 CONTROL: an armable pull request IS armed, and only after its read-back says so", () => {
  const out = drive({});
  assert.deepEqual(out.result.armed, [7], out.lines.join("\n"));
  assert.equal(arms(out).length, 1, "the arm write happened");
  assert.equal(out.pull.armed, true);
  assert.ok(out.lines.some((line) => /OUTSIDE-ARM: #7 armed -- read back: /.test(line)), out.lines.join("\n"));
});
