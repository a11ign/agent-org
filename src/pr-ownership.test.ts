// no-token: gh -- every pull request list, claim comment and clock here is an injected value; nothing imported reaches `gh`, `git` or the wall clock
/**
 * #3445: A PULL REQUEST IS A CLAIM'S OWN BY ONE TEST, AND THE OPEN AND MERGED LOOKUPS SHARE IT.
 *
 * #3390's work was merged as `a11ign/agent-org`#134 on `agent/chairman-answered-3390` while the claim named `agent/a-needs-chairman-row-3390`. The open lookup took
 * a head ending `-<row>`, the merged one only the claimed branch, so the merge released nothing for 69 minutes and the holder was nudged as idle.
 *
 * THE POSITIVE CONTROL FOR EVERY NEGATIVE IS THE SAME PULL REQUEST WITH ONE FIELD CHANGED BACK: each "not owned" row below differs from an owned row in exactly
 * one field, so a negative cannot pass for a reason other than that field. Nothing is asserted against an empty population.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownsPr, RUNGS } from "./pr-ownership.mjs";
import { claimFactsFrom, readClaim } from "./claim-stall.mjs";
import { claimRecordComment } from "./row-claim.mjs";

const ROW = 3390;
const SESSION = "worker-3390";
const BRANCH = "agent/a-needs-chairman-row-3390";
const REPO = "/home/agent/repos/a11y-witness";
const TRACKER = "a11ign/a11ign";
const CLAIMED_AT = Date.parse("2026-10-04T10:37:38Z");
const MERGED_AT = "2026-10-04T11:19:39Z";
const NUDGE_TICK = Date.parse("2026-10-04T12:06:42Z");
const MIN = 60_000;

const CLAIMANT = { row: ROW, branch: BRANCH, session: SESSION, trackerRepo: TRACKER, soleHolder: true };
const IO = { git: () => ({ status: 1, out: "" }), exists: () => false, mtime: () => null };

type Pr = { number: number; headRefName?: string; title?: string; labels?: { name: string }[]; mergedAt?: string; repoKey?: string };

/** The real claim comment: written by `row-claim.mjs`'s own writer, so a change to its format breaks this. */
const claimComment = { body: claimRecordComment({ session: SESSION, branch: BRANCH, worktree: undefined }),
  createdAt: new Date(CLAIMED_AT).toISOString(), author: { login: "a11ign-ai-workers" } };

/** A pull request that matches NO rung: a head naming another row, another row's title, no label. Each cell changes exactly the field its rung reads. */
const stranger = (over: Partial<Pr> = {}): Pr => ({ number: 7, headRefName: "agent/something-else-9999", title: "Something else (a11ign/a11ign#9999)",
  labels: [], mergedAt: MERGED_AT, ...over });

/** One field changed to the shape that rung reads. */
const RUNG_FIELDS: Record<(typeof RUNGS)[number], Partial<Pr>> = {
  "branch": { headRefName: BRANCH },
  "row-suffix": { headRefName: `agent/chairman-answered-${ROW}` },
  "title": { title: `Teach the gate whose pull request it is (${TRACKER}#${ROW})` },
  "session-label": { labels: [{ name: `session:${SESSION}` }] },
};

type Lane = "open" | "merged";
/** What `claimFactsFrom` makes of one pull request in one lane of one repository: the pull request the claim counts as its own, or `null`. */
function countedAs(lane: Lane, pr: Pr, { elsewhere, sessionRows = 1 }: { elsewhere: boolean; sessionRows?: number }, comments = [claimComment]): number | null {
  const tagged = elsewhere ? { ...pr, repoKey: "agent-org" } : pr;
  const lists = { open: lane === "open" ? [tagged] : [], merged: lane === "merged" ? [tagged] : [] };
  const input = { row: ROW, session: SESSION, waiting: null, blockedBy: [], comments, repo: REPO, trackerRepo: TRACKER, sessionRows,
    ...(elsewhere ? { openPrs: [], mergedPrs: [], elsewhere: lists } : { openPrs: lists.open, mergedPrs: lists.merged }) };
  const facts = claimFactsFrom(input as Parameters<typeof claimFactsFrom>[0], IO) as { ownPrs: Pr[]; mergedPr: { number: number } | null };
  return lane === "open" ? facts.ownPrs[0]?.number ?? null : facts.mergedPr?.number ?? null;
}

test("#3390 as it happened: a merge on a branch the claimant did not claim RELEASES the claim as merged, not the idle nudge", () => {
  const merged134 = { number: 134, headRefName: "agent/chairman-answered-3390", mergedAt: MERGED_AT, repoKey: "agent-org",
    title: "Hand a chairman-answered row back to its holder (a11ign/a11ign#3390)", labels: [] };
  const facts = claimFactsFrom({ row: ROW, session: SESSION, waiting: null, blockedBy: [], comments: [claimComment], openPrs: [], mergedPrs: [],
    elsewhere: { open: [], merged: [merged134] }, repo: REPO, trackerRepo: TRACKER, sessionRows: 1 }, IO) as Parameters<typeof readClaim>[0];
  const agents = [{ label: "ceo", status: "idle" }, { label: "orchestrator", status: "idle" }, { label: SESSION, status: "idle" }];
  const reading = readClaim(facts, { now: NUDGE_TICK, restartAt: null, nudge: null, agents, idleSince: NUDGE_TICK - 46 * MIN });
  assert.equal(reading.kind, "release");
  assert.deepEqual({ why: (reading as { why: string }).why, mergedPr: (reading as { mergedPr: number }).mergedPr }, { why: "merged", mergedPr: 134 });
  assert.notEqual(reading.kind, "nudge");
});

for (const lane of ["open", "merged"] as Lane[]) {
  test(`the table, ${lane} column: every rung owns a pull request in both repositories, and names itself`, () => {
    let owned = 0;
    for (const rung of RUNGS) {
      for (const elsewhere of [false, true]) {
        const pr = stranger({ number: 40, ...RUNG_FIELDS[rung] });
        assert.equal(ownsPr(CLAIMANT, pr), rung, `${rung}: the one rung that says so`);
        assert.equal(countedAs(lane, pr, { elsewhere }), 40, `${rung} / ${elsewhere ? "another repository" : "this repository"}`);
        owned += 1;
      }
    }
    assert.equal(owned, RUNGS.length * 2, "the controls the negatives are read against: every cell was owned");
  });
}

test("the control for every negative: the stranger alone is nobody's, in every lane and repository", () => {
  assert.equal(ownsPr(CLAIMANT, stranger()), null);
  for (const lane of ["open", "merged"] as Lane[]) {
    for (const elsewhere of [false, true]) assert.equal(countedAs(lane, stranger(), { elsewhere }), null, `${lane} / ${elsewhere}`);
  }
});

/** Each differs from an OWNED row of the table in exactly one field. */
const NEGATIVES: { name: string; pr: Pr }[] = [
  { name: "a head ending -1<row> (agent/x-13390), not -<row>", pr: stranger({ headRefName: `agent/x-1${ROW}` }) },
  { name: "a title naming the NEXT row", pr: stranger({ title: `Next (${TRACKER}#${ROW + 1})` }) },
  { name: "a title naming this row's NUMBER in another repository", pr: stranger({ title: `Elsewhere (a11ign/agent-org#${ROW})` }) },
  { name: "a title whose reference is a longer repository path ending the same way", pr: stranger({ title: `Nested (x/${TRACKER}#${ROW})` }) },
  { name: "a title naming a longer row number (#13390)", pr: stranger({ title: `Longer (${TRACKER}#1${ROW})` }) },
  { name: "a session: label of a different session", pr: stranger({ labels: [{ name: "session:worker-3391" }] }) },
  { name: "the row named in the body's prose only (no field)", pr: { ...stranger(), body: `Closes: none -- built for ${TRACKER}#${ROW}` } as Pr },
];

for (const lane of ["open", "merged"] as Lane[]) {
  test(`the negatives, ${lane} column: not owned in either repository, each against its owned twin in the table`, () => {
    for (const { name, pr } of NEGATIVES) {
      assert.equal(ownsPr(CLAIMANT, pr), null, name);
      for (const elsewhere of [false, true]) assert.equal(countedAs(lane, { ...pr, number: 41 }, { elsewhere }), null, `${name} / ${elsewhere}`);
    }
    assert.ok(NEGATIVES.length > 0 && RUNGS.length === 4);
  });
}

test("a title reference is read against the HOME repository the caller names: without one that rung cannot match, and no rung is guessed", () => {
  const pr = stranger({ ...RUNG_FIELDS.title });
  assert.equal(ownsPr(CLAIMANT, pr), "title");
  assert.equal(ownsPr({ ...CLAIMANT, trackerRepo: undefined }, pr), null);
  assert.equal(ownsPr({ ...CLAIMANT, trackerRepo: "a11ign/agent-org" }, pr), null, "another home repository is another reference");
  assert.equal(ownsPr(CLAIMANT, { ...pr, title: `(${TRACKER}#${ROW})` }), "title", "bare reference in parentheses, nothing before it");
  assert.equal(ownsPr(CLAIMANT, { ...pr, title: `Fix ${TRACKER}#${ROW}` }), "title", "bare reference, no parentheses");
});

test("a claim with no recorded branch owns by the other three rungs, and the branch rung cannot match an undefined head against a null branch", () => {
  const noBranch = { ...CLAIMANT, branch: null };
  assert.equal(ownsPr(noBranch, { ...stranger(), headRefName: undefined }), null);
  assert.equal(ownsPr(noBranch, stranger({ headRefName: "agent/a-needs-chairman" })), null, "a head that merely resembles the branch");
  assert.equal(ownsPr(noBranch, stranger(RUNG_FIELDS["row-suffix"])), "row-suffix");
  assert.equal(ownsPr(noBranch, stranger(RUNG_FIELDS.title)), "title");
  assert.equal(ownsPr(noBranch, stranger(RUNG_FIELDS["session-label"])), "session-label");
});

test("a merge dated BEFORE the claim is another instance's work: owned by every rung, and still not the claim's", () => {
  const before = new Date(CLAIMED_AT - MIN).toISOString();
  for (const rung of RUNGS) {
    const owned = stranger({ number: 50, ...RUNG_FIELDS[rung] });
    assert.equal(countedAs("merged", owned, { elsewhere: true }), 50, `${rung}: the control, the same pull request merged after the claim`);
    assert.equal(countedAs("merged", { ...owned, mergedAt: before }, { elsewhere: true }), null, `${rung}: merged before the claim`);
  }
});

for (const lane of ["open", "merged"] as Lane[]) {
  test(`a session: label names a SESSION, not a row: for a session holding two rows it owns nothing (${lane} column), and the same pull request is owned by a sole holder`, () => {
    const labelled = stranger({ number: 60, ...RUNG_FIELDS["session-label"] });
    assert.equal(countedAs(lane, labelled, { elsewhere: false, sessionRows: 1 }), 60, "the control: the same pull request, a session holding one row");
    assert.equal(countedAs(lane, labelled, { elsewhere: false, sessionRows: 2 }), null, "a standing seat's label says nothing about which row");
    assert.equal(ownsPr({ ...CLAIMANT, soleHolder: false }, labelled), null);
    assert.equal(ownsPr({ ...CLAIMANT, soleHolder: undefined }, labelled), null, "unknown is not sole");
    const byHead = stranger({ number: 61, ...RUNG_FIELDS["row-suffix"] });
    assert.equal(countedAs(lane, byHead, { elsewhere: false, sessionRows: 2 }), 61, "the other rungs do not depend on how many rows the session holds");
  });
}
