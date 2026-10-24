// no-token: none -- every read is the fake code host's rows (A11-160, step 9); `git` is an injected seam, and the clock is a constant; nothing imported reaches the network or a worktree
/**
 * #3821: THE GATE READS THE NEWEST COMMENTS OF A CLAIMED ROW, WHATEVER THE ROW'S COMMENT COUNT.
 *
 * `gh issue list --json comments` returns a row's FIRST 100 comments, oldest first, and says nothing about the rest. #3566 had 112: the claim record the gate
 * read was an OLD one, a pull request merged since it read as "merged after the claim", and two live claims were released within two minutes each.
 *
 * THE FAKE IS THE CODE HOST (A11-160, step 9; it was a stub `gh` that answered the by-label connection and the batched GraphQL read). The world holds the claimed rows with their comments; its by-label read cuts a
 * row's comments at the first 100 as a connection that selects `comments(first:100)` does, and its end-of-row read answers the last 100. What the two reads SEND, and how the plugin reads their answers (a refused
 * call, `errors` beside `data`, a row the answer leaves out), are the plugin's: `plugins/github/rows/{board-snapshot-rows,gate-reads}.test.ts`.
 *
 * THE FIXTURE IS THAT SHAPE: an older claim record at the 10th comment, a pull request merged after the 50th and before the 108th, the live claim at the 108th.
 * THE CONTROLS: the same row with 99 comments is HELD before and after the fix (the cap itself), and the same 112 comments with the claim record AT the cap
 * is released by BOTH readings (so "held" is not what a row with a merged pull request always gets).
 *
 * The RED run is the fixture against the page the old `readClaimedRowComments` returned (`oldPage`, the first 100 and nothing else).
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { claimRecordComment } from "../row-claim.ts";
import { CLAIM_LABEL } from "../claim-labels.ts";
import { claimFactsFrom, readClaim } from "../claim-stall/stall-causes-and-claim-readings.ts";
import { claimStalledOrders } from "../claim-stall.ts";
import { readClaimedRowComments, ISSUE_LIST_COMMENT_CAP } from "../work-gate/reads.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

const ROW = 3566;
const SESSION = "worker-3566";
const BRANCH = "agent/the-anchor-3566";
const T0 = Date.parse("2026-10-06T07:00:00Z");
const MINUTE = 60_000;
const NOW = T0 + 200 * MINUTE;
const REPO = "/home/agent/repos/a11y-witness";

afterEach(() => forgetActivation());

const at = (n: number) => new Date(T0 + (n - 1) * MINUTE).toISOString();
const record = (n: number) => ({ id: `c${n}`, body: claimRecordComment({ session: SESSION, branch: BRANCH, worktree: "../wt-3566" }), createdAt: at(n), author: { login: "a11ign-ai-workers" } });
const chatter = (n: number) => ({ id: `c${n}`, body: `comment ${n}`, createdAt: at(n), author: { login: "a11ign-ai-leads" } });

/** `total` comments, oldest first, with a claim record at each position named in `claimsAt`. */
const commentsOf = (total: number, claimsAt: number[]) => Array.from({ length: total }, (_, i) => (claimsAt.includes(i + 1) ? record(i + 1) : chatter(i + 1)));

/** agent-org#302's stand-in: merged after the 50th comment and before the 108th, owned by the claimant by its branch. */
const MERGED = [{ number: 302, headRefName: BRANCH, mergedAt: at(60), title: "the work", labels: [] }];

/** What `readClaimedRowComments` is handed in place of `gh`: the fake code host acts on its own state, so a read that reached it would be a read that went around the code host. */
const noGh = (): string => { throw new Error("the fake code host acts on its own state: no gh is run"); };

/** How the end-of-row read (`newestCommentsOf`) is answered: from the world, refused, or with an answer that carries no row (a refusal that is a value, not a throw). */
type EndRead = "answer" | "throws" | "null" | "carries no row";

/**
 * The fake code host holding `rows` as CLAIMED rows (`in-progress`, open), each with the comments given in the page's shape (id, body, createdAt, author{login}); its by-label read answers the FIRST 100
 * comments of a row, oldest first, as a connection that selects `comments(first:100)` does (the cap is the fake's: `withSelectedCommentsPage`), and its end-of-row read answers the LAST 100. `asked(op)`
 * are the requests the code host was given, in order. `end` makes the end-of-row read fail the way GitHub fails it.
 */
function claimedHost(rows: Record<number, object[]>, { end = "answer" }: { end?: EndRead } = {}) {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  for (const [number, comments] of Object.entries(rows)) {
    world.rows.set(Number(number), fakeRow(world, Number(number), { labels: [CLAIM_LABEL],
      comments: (comments as ReturnType<typeof chatter>[]).map((c, index) => ({ id: index + 1, body: c.body, createdAt: c.createdAt, author: c.author.login })) }));
  }
  if (end === "throws") world.failures.set("newestCommentsOf", new Error("HTTP 502"));
  const watched = watchedRows(host);
  if (end === "null") watched.host.rows!.newestCommentsOf = () => null;
  if (end === "carries no row") watched.host.rows!.newestCommentsOf = () => new Map();
  substituteCodeHost(watched.host);
  return { world, asked: (op: string) => watched.calls.filter((call) => call.op === op).map((call) => call.request) };
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
  claimedHost(ROW_112);
  const page = readClaimedRowComments(noGh)!;
  assert.equal(page[0].comments.length, ISSUE_LIST_COMMENT_CAP);
  assert.equal(page[0].comments.at(-1).body, "comment 112", "the NEWEST comment is in the page, oldest first as `issue list` gives them");
  assert.equal(verdictOn(page).verdict, "held");
});

test("#3821 the same fixture with 99 comments is HELD before and after (the control for the cap itself), and makes no second call", () => {
  const rows = { [ROW]: commentsOf(99, [10, 98]) };
  const { asked } = claimedHost(rows);
  assert.equal(verdictOn(oldPage(rows)).verdict, "held");
  assert.equal(verdictOn(readClaimedRowComments(noGh)!).verdict, "held");
  assert.equal(asked("readRowsByLabel").length, 1, "#5050: the one by-label read is the list");
  assert.deepEqual([asked("readRowsByLabel")[0].label, asked("readRowsByLabel")[0].state], [CLAIM_LABEL, "OPEN"], "of the OPEN claimed rows");
  assert.match(asked("readRowsByLabel")[0].select, new RegExp(`comments\\(first:${ISSUE_LIST_COMMENT_CAP}\\)`), "asking each row's first 100 comments, which is what the cap is");
  assert.equal(asked("newestCommentsOf").length, 0, "a row under the cap is read whole, so a healthy tick pays nothing beyond the one list read");
});

test("#3821 a live claim that PRECEDES the merge is released by BOTH readings (the control that 'held' is not what every row with a merged pull request gets)", () => {
  const rows = { [ROW]: commentsOf(112, [10, 40]) };
  claimedHost(rows);
  assert.equal(verdictOn(oldPage(rows)).verdict, "released");
  assert.equal(verdictOn(readClaimedRowComments(noGh)!).verdict, "released", "the claim at the 40th is in the newest 100, and the merge at the 60th is after it");
});

// --- Done-when 2: a row whose end cannot be read is never released --------------------------------------------------------------------------

test("#3821 a refused or erroring end-of-row read leaves the capped row OUT of the page, and the claim-stall pass SKIPS it, never releases it", () => {
  for (const end of ["throws", "null", "carries no row"] as const) {
    claimedHost({ ...ROW_112, 77: commentsOf(3, [1]) }, { end });
    const page = readClaimedRowComments(noGh)!;
    assert.deepEqual(page.map((r) => r.number), [77], `${end}: the capped row is dropped and the short row is kept`);
    assert.equal(verdictOn(page).verdict, "skip", `${end}: a row the page does not carry is not evaluated`);
  }
});

test("#3821 a refused list read (#5050: the by-label connection) is still `null`, never `[]` (#1286)", () => {
  const { world } = claimedHost(ROW_112);
  world.failures.set("readRowsByLabel", new Error("HTTP 403"));
  assert.equal(readClaimedRowComments(noGh), null);
});

// --- Done-when 1: the cost is one call for every capped row, never one per row ---------------------------------------------------------

test("#3821 two capped rows cost ONE end-of-row read, and it asks for those rows only", () => {
  const { asked } = claimedHost({ ...ROW_112, 3600: commentsOf(150, [140]), 77: commentsOf(3, [1]) });
  const page = readClaimedRowComments(noGh)!;
  assert.equal(asked("newestCommentsOf").length, 1);
  assert.deepEqual(asked("newestCommentsOf")[0].numbers.toSorted((a: number, b: number) => a - b), [3566, 3600], "the 3-comment row is not asked about");
  assert.equal(asked("newestCommentsOf")[0].last, ISSUE_LIST_COMMENT_CAP, "each row's last 100");
  assert.deepEqual(page.map((r) => r.number).sort((a, b) => a - b), [77, 3566, 3600]);
  assert.equal(page.find((r) => r.number === 3600)!.comments.at(-1).body, "comment 150");
});
