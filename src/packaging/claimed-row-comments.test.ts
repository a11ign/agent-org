// no-token: gh -- every `gh` and `git` call here is an injected seam, and the clock is a constant; nothing imported reaches the network or a worktree
/**
 * #3821: THE GATE READS THE NEWEST COMMENTS OF A CLAIMED ROW, WHATEVER THE ROW'S COMMENT COUNT.
 *
 * `gh issue list --json comments` returns a row's FIRST 100 comments, oldest first, and says nothing about the rest. #3566 had 112: the claim record the gate
 * read was an OLD one, a pull request merged since it read as "merged after the claim", and two live claims were released within two minutes each.
 *
 * THE FIXTURE IS THAT SHAPE: an older claim record at the 10th comment, a pull request merged after the 50th and before the 108th, the live claim at the 108th.
 * THE CONTROLS: the same row with 99 comments is HELD before and after the fix (the cap itself), and the same 112 comments with the claim record AT the cap
 * is released by BOTH readings (so "held" is not what a row with a merged pull request always gets).
 *
 * The RED run is the fixture against the page the old `readClaimedRowComments` returned (`oldPage`, the first 100 and nothing else).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimRecordComment } from "../row-claim.mjs";
import { claimFactsFrom, readClaim, claimStalledOrders } from "../claim-stall.mjs";
import { readClaimedRowComments, ISSUE_LIST_COMMENT_CAP } from "../work-gate.mjs";

const ROW = 3566;
const SESSION = "worker-3566";
const BRANCH = "agent/the-anchor-3566";
const T0 = Date.parse("2026-10-06T07:00:00Z");
const MINUTE = 60_000;
const NOW = T0 + 200 * MINUTE;
const REPO = "/home/agent/repos/a11y-witness";

const at = (n: number) => new Date(T0 + (n - 1) * MINUTE).toISOString();
const record = (n: number) => ({ id: `c${n}`, body: claimRecordComment({ session: SESSION, branch: BRANCH, worktree: "../wt-3566" }), createdAt: at(n), author: { login: "a11ign-ai-workers" } });
const chatter = (n: number) => ({ id: `c${n}`, body: `comment ${n}`, createdAt: at(n), author: { login: "a11ign-ai-leads" } });

/** `total` comments, oldest first, with a claim record at each position named in `claimsAt`. */
const commentsOf = (total: number, claimsAt: number[]) => Array.from({ length: total }, (_, i) => (claimsAt.includes(i + 1) ? record(i + 1) : chatter(i + 1)));

/** agent-org#302's stand-in: merged after the 50th comment and before the 108th, owned by the claimant by its branch. */
const MERGED = [{ number: 302, headRefName: BRANCH, mergedAt: at(60), title: "the work", labels: [] }];

/** A `gh` that answers like the real one: `issue list` the FIRST 100 comments of each row, GraphQL the LAST 100 of the rows it is asked about. */
function gh(rows: Record<number, object[]>, { graphql = "answer" }: { graphql?: "answer" | "refuse" | "errors" } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "issue") return JSON.stringify(Object.entries(rows).map(([number, comments]) => ({ number: Number(number), comments: comments.slice(0, ISSUE_LIST_COMMENT_CAP) })));
    if (graphql === "refuse") throw new Error("HTTP 502");
    if (graphql === "errors") return JSON.stringify({ errors: [{ message: "rate limited" }], data: null });
    const query = String(args.find((a) => a.startsWith("query=")));
    const repository = Object.fromEntries([...query.matchAll(/(r\d+): issue\(number: (\d+)\)/g)].map(([, alias, number]) =>
      [alias, { number: Number(number), comments: { nodes: (rows[Number(number)] ?? []).slice(-ISSUE_LIST_COMMENT_CAP) } }]));
    return JSON.stringify({ data: { repository } });
  };
  return { run, calls, graphqlCalls: () => calls.filter((a) => a[0] === "api") };
}

const io = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };

/** What the claim-stall pass makes of a page for the row: `skip`, a release order, or neither (HELD). */
function verdictOn(page: { number: number; comments: object[] }[]) {
  const comments = page.find((r) => r.number === ROW)?.comments ?? [];
  const facts = claimFactsFrom({ row: ROW, session: SESSION, waiting: null, blockedBy: [], comments, openPrs: [], mergedPrs: MERGED, repo: REPO, trackerRepo: "a11ign/a11ign", sessionRows: 1 }, io);
  if ("skip" in facts) return { verdict: "skip", why: facts.skip };
  const reading = readClaim(facts, { now: NOW, restartAt: null, agents: null, nudge: null, goneSince: null, idleSince: null });
  const [order] = claimStalledOrders([{ facts, reading }], NOW);
  return { verdict: order?.release === undefined ? "held" : "released", why: reading.kind };
}

/** The page the code BEFORE #3821 returned: the first 100 comments, the only call it made. */
const oldPage = (rows: Record<number, object[]>) => Object.entries(rows).map(([number, comments]) => ({ number: Number(number), comments: comments.slice(0, ISSUE_LIST_COMMENT_CAP) }));

// --- the fixture: 112 comments, an old claim at the 10th, the live one at the 108th -------------------------------------------------------------

const ROW_112 = { [ROW]: commentsOf(112, [10, 108]) };

test("#3821 RED: the first 100 comments of the 112-comment row release a claim made at the 108th (the page the old reader returned)", () => {
  assert.equal(verdictOn(oldPage(ROW_112)).verdict, "released", "the control for the fix: this page DOES release, so 'held' below is the fix and not the fixture");
});

test("#3821 the 112-comment row: the claim made at the 108th is HELD, because the gate now reads the newest 100", () => {
  const { run } = gh(ROW_112);
  const page = readClaimedRowComments(run)!;
  assert.equal(page[0].comments.length, ISSUE_LIST_COMMENT_CAP);
  assert.equal(page[0].comments.at(-1).body, "comment 112", "the NEWEST comment is in the page, oldest first as `issue list` gives them");
  assert.equal(verdictOn(page).verdict, "held");
});

test("#3821 the same fixture with 99 comments is HELD before and after (the control for the cap itself), and makes no second call", () => {
  const rows = { [ROW]: commentsOf(99, [10, 98]) };
  const { run, graphqlCalls } = gh(rows);
  assert.equal(verdictOn(oldPage(rows)).verdict, "held");
  assert.equal(verdictOn(readClaimedRowComments(run)!).verdict, "held");
  assert.equal(graphqlCalls().length, 0, "a row under the cap is read whole, so a healthy tick pays nothing beyond the one `issue list`");
});

test("#3821 a live claim that PRECEDES the merge is released by BOTH readings (the control that 'held' is not what every row with a merged pull request gets)", () => {
  const rows = { [ROW]: commentsOf(112, [10, 40]) };
  assert.equal(verdictOn(oldPage(rows)).verdict, "released");
  assert.equal(verdictOn(readClaimedRowComments(gh(rows).run)!).verdict, "released", "the claim at the 40th is in the newest 100, and the merge at the 60th is after it");
});

// --- Done-when 2: a row whose end cannot be read is never released --------------------------------------------------------------------------

test("#3821 a refused or erroring GraphQL read leaves the capped row OUT of the page, and the claim-stall pass SKIPS it, never releases it", () => {
  for (const graphql of ["refuse", "errors"] as const) {
    const page = readClaimedRowComments(gh({ ...ROW_112, 77: commentsOf(3, [1]) }, { graphql }).run)!;
    assert.deepEqual(page.map((r) => r.number), [77], `${graphql}: the capped row is dropped and the short row is kept`);
    assert.equal(verdictOn(page).verdict, "skip", `${graphql}: a row the page does not carry is not evaluated`);
  }
});

test("#3821 a refused `issue list` is still `null`, never `[]` (#1286)", () => {
  assert.equal(readClaimedRowComments(() => { throw new Error("HTTP 403"); }), null);
});

// --- Done-when 1: the cost is one call for every capped row, never one per row ---------------------------------------------------------

test("#3821 two capped rows cost ONE GraphQL call, and it asks for those rows only", () => {
  const { run, graphqlCalls } = gh({ ...ROW_112, 3600: commentsOf(150, [140]), 77: commentsOf(3, [1]) });
  const page = readClaimedRowComments(run)!;
  assert.equal(graphqlCalls().length, 1);
  const query = String(graphqlCalls()[0].find((a) => a.startsWith("query=")));
  assert.deepEqual([...query.matchAll(/issue\(number: (\d+)\)/g)].map((m) => Number(m[1])), [3566, 3600], "the 3-comment row is not asked about");
  assert.deepEqual(page.map((r) => r.number).sort((a, b) => a - b), [77, 3566, 3600]);
  assert.equal(page.find((r) => r.number === 3600)!.comments.at(-1).body, "comment 150");
});
