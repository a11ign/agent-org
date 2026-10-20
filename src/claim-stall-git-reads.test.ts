// no-token: gh -- every `git` call here is an injected, counting seam and the clock is a constant; nothing imported reaches a worktree or the network
/**
 * agent-org#1083: A CLAIMED ROW'S GIT READS ARE PAID FOR ON DEMAND, AND ONCE.
 *
 * `claimFactsFrom` ran `rev-parse` and `log` for the branch AND for `origin/<branch>` while it built every held row's facts, so a row the reading never asks
 * about (an open pull request, a merge, a blocker) still paid four subprocesses, and `facts.work()` / `facts.file()` re-ran `rev-list` / `status` for each
 * reading that asked. The facts' own doc said "the costly facts are THUNKS" and two of the four were not.
 *
 * EVERY "NO SUCH READ" ASSERTION HAS A TWIN THAT DOES ASK, so a count of zero is a reading and not a fake that answers nothing (the quiet row's `nudge`,
 * the merged row's `rev-list`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimRecordComment } from "./row-claim.ts";
import { claimFactsFrom, readClaim, type ClaimFacts, type HostReads } from "./claim-stall/stall-causes-and-claim-readings.ts";
import { claimStallTick } from "./work-gate/claim-stall-tick.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-12T08:00:00Z");
const REPO = "/home/agent/repos/a11y-witness";
const SESSION = "worker-4001";
const BRANCH = "agent/the-row-4001";
const WT = "/home/agent/repos/wt-4001";
const CTX = { now: NOW, restartAt: null, agents: null, nudge: null, goneSince: null, idleSince: null };

const record = { id: "r0", body: claimRecordComment({ session: SESSION, branch: BRANCH, worktree: "../wt-4001" }),
  createdAt: new Date(NOW - 600 * MIN).toISOString(), author: { login: "a11ign-ai-workers" } };
const MERGED = [{ number: 77, headRefName: BRANCH, mergedAt: new Date(NOW - 100 * MIN).toISOString(), title: "the row's work", labels: [] }];

/** A counting host: `calls` is every git argv's subcommand, in order; `world` shapes what the few answers are. */
function host({ dirty = [] as string[], broken = null as string | null } = {}) {
  const calls: string[] = [];
  const git: HostReads["git"] = (_dir, args) => {
    calls.push(args[0]);
    if (broken !== null && args[0] === broken) return { status: null, out: "" };
    if (args[0] === "status") return { status: 0, out: dirty.map((d) => ` M ${d}\0`).join("") };
    if (args[0] === "rev-list") return { status: 0, out: "0\n" };
    if (args[0] === "worktree") return { status: 0, out: "" };
    return { status: 0, out: "" };
  };
  const io: HostReads = { git, exists: (p) => p === WT, mtime: () => NOW - MIN, cloneOf: (key) => ({ clone: `/home/agent/repos/${key}` }) };
  return { calls, io, count: (sub: string) => calls.filter((c) => c === sub).length };
}

function factsOf(io: HostReads, over: { openPrs?: object[]; mergedPrs?: object[] } = {}): ClaimFacts {
  const built = claimFactsFrom({ row: 4001, session: SESSION, waiting: null, blockedBy: [], comments: [record], openPrs: (over.openPrs ?? []) as never,
    mergedPrs: (over.mergedPrs ?? []) as never, repo: REPO, trackerRepo: "a11ign/agent-org", sessionRows: 1 }, io);
  if ("skip" in built) throw new Error(`skipped: ${built.skip}`);
  return built;
}

test("building a row's facts runs no git: every costly fact is read on demand", () => {
  const h = host();
  factsOf(h.io);
  assert.deepEqual(h.calls, []);
});

test("a row an open pull request owns issues no git at all, and the same row with none does (the twin)", () => {
  const owned = host();
  assert.equal(readClaim(factsOf(owned.io, { openPrs: [{ number: 9, headRefName: BRANCH }] }), CTX).kind, "pr-owned");
  assert.deepEqual(owned.calls, [], "pr-owned asks for no commit, no push, no file and no work");

  const quiet = host();
  assert.equal(readClaim(factsOf(quiet.io), CTX).kind, "nudge");
  assert.deepEqual([...new Set(quiet.calls)].sort(), ["log", "rev-parse", "status"], "the quiet row reads its own commits and its worktree, and no `rev-list`");
});

test("a row whose work() is never called issues no `rev-list`; the merged row's single call issues one", () => {
  const quiet = host();
  readClaim(factsOf(quiet.io), CTX);
  assert.equal(quiet.count("rev-list"), 0);

  const merged = host();
  assert.equal(readClaim(factsOf(merged.io, { mergedPrs: MERGED }), CTX).kind, "release");
  assert.equal(merged.count("rev-list"), 1);
});

test("work() asked again is answered from the first read: one `rev-list` and one `status` per holder worktree", () => {
  const h = host();
  const facts = factsOf(h.io, { mergedPrs: MERGED });
  readClaim(facts, CTX);
  const first = facts.work();
  assert.equal(facts.work(), first, "the same reading object, not a second one that happens to be equal");
  assert.equal(h.count("rev-list"), 1);
  assert.equal(h.count("status"), 1);
});

test("commit(), push() and file() are each read once however many readings ask", () => {
  const h = host();
  const facts = factsOf(h.io);
  for (let i = 0; i < 3; i++) { facts.commit(); facts.push(); facts.file(); }
  assert.equal(h.count("log"), 2, "one `log` for the branch and one for `origin/<branch>`");
  assert.equal(h.count("rev-parse"), 2);
  assert.equal(h.count("status"), 1);
});

test("a remembered nudge's second reading does not re-run the `git status` the clock just ran", () => {
  const h = host({ dirty: ["a.mjs"] });
  const nudge = { nudgedAt: NOW - 10 * MIN, deliveredAt: NOW - 9 * MIN };
  const reading = readClaim(factsOf(h.io), { ...CTX, nudge });
  assert.equal(reading.kind, "moving", "the file moved a minute ago, so the held nudge is answered");
  assert.equal(h.count("status"), 1);
});

test("a commit read that git will not answer HOLDS the row: it is neither nudged nor released", () => {
  const h = host({ broken: "rev-parse" });
  const reading = readClaim(factsOf(h.io), CTX);
  assert.equal(reading.kind, "holding");
  assert.match((reading as { why: string }).why, /git rev-parse .* exited null/);
});

test("the tick's moves leave out a row whose commit could not be read, and say why in `skipped` (as the build-time read did)", () => {
  const h = host({ broken: "rev-parse" });
  const seen: { moves: Map<number, unknown>; skipped: Map<number, string> }[] = [];
  const row = { number: 4001, title: "row", labels: [{ name: "in-progress" }, { name: `session:${SESSION}` }], body: "", blockedBy: { nodes: [] } };
  const orders = claimStallTick({ rows: [row], claimedComments: [{ number: 4001, comments: [record] }], openPrs: [], mergedPrs: [], io: h.io, repo: REPO,
    now: NOW, restartAt: null, agents: null, stateDir: "/state", ledger: () => "", log: () => {}, read: () => ({}), write: () => {},
    onFacts: (facts) => { if (facts !== null) seen.push(facts); } });
  assert.deepEqual(orders, [], "an unreadable git is never a nudge or a release");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].moves.has(4001), false);
  assert.match(seen[0].skipped.get(4001) ?? "", /^#4001: git rev-parse .* exited null/);
});
