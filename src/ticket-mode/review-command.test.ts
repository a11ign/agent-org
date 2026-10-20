// no-token: gh -- the reviewer port and the pull request's state are injected; nothing starts and nothing reaches GitHub or herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewOnDemand } from "./review-command.ts";
import { atomicReviewerPort, loadReviewerGate, type ReviewerPort, type ReviewState } from "./reviewer-port.ts";

const URL = "https://github.com/a11ign/control/pull/119";
const HEAD = "3aeaba9bd".padEnd(40, "0");

/** A port that records what it was asked, and answers as told. */
const port = (answer: ReturnType<ReviewerPort["start"]>, live = false) => {
  const calls: string[] = [];
  const p: ReviewerPort = {
    live: ({ pr, head }) => { calls.push(`live ${pr}@${head}`); return live; },
    start: ({ pr, head }) => { calls.push(`start ${pr}@${head}`); return answer; },
    close: () => ({ state: "gone" }), retire: () => ({ retired: true, report: null }), listedPulls: () => [],
    settled: () => "working", verdictFileOf: () => null, repostVerdict: () => ({ posted: true }), reprompt: () => ({ prompted: true }),
  };
  return { p, calls };
};

/** The pull request as `readState` reads it at `head`, with `reviews` on it. */
const stateAt = (head: string, reviews: ReviewState["reviews"] = []) => ({ head, reviews, settled: true, trust: "INSIDE", view: {} }) as unknown as ReviewState;

/** The reviewer's review on `head`, as GitHub lists it. */
const reviewOn = (state: string, commit: string) => ({ author: "a11ign-reviewer", state, commit, at: 1 });

/** The arguments `reviewOnDemand` takes with nothing remembered and nothing recorded, reading `state`. */
const asked = (state: ReviewState | null, extra: Partial<Parameters<typeof reviewOnDemand>[0]> = {}) => ({ url: URL, port: port({ label: "reviewer-control-119" }).p,
  readState: () => state, started: new Set<string>(), record: () => {}, ...extra });

test("starts the reviewer at the pull request's current head, names the seat it started, and records it for the pool", () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  const recorded: string[][] = [];
  const r = reviewOnDemand({ url: URL, port: p, readState: () => stateAt(HEAD), started: new Set(), record: (label, key, head) => { recorded.push([label, key, head]); } });
  assert.equal(r.code, 0);
  assert.match(r.out, /started reviewer-control-119 for .*pull\/119 at 3aeaba9b/);
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`, `start ${URL}@${HEAD}`]);
  assert.deepEqual(recorded, [["reviewer-control-119", `${URL}@${HEAD}`, HEAD]], "the start is recorded for the pool, with its seat and head");
});

test("a --head given is the head reviewed, and its posted review is what is checked at that head", () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  const r = reviewOnDemand({ url: URL, head: "abc1234", port: p, readState: () => stateAt(HEAD, [reviewOn("APPROVED", "abc1234")]), started: new Set(), record: () => {} });
  assert.equal(r.code, 0);
  assert.match(r.out, /already reviewed at abc1234/);
  assert.deepEqual(calls, [], "a head with a posted review starts nothing");
});

test("a head given that has no review is started at that head", () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  reviewOnDemand(asked(stateAt(HEAD), { port: p, head: "abc1234" }));
  assert.deepEqual(calls, [`live ${URL}@abc1234`, `start ${URL}@abc1234`]);
});

test("a reviewer already live for that head is not started twice", () => {
  const { p, calls } = port({ label: "never" }, true);
  const r = reviewOnDemand(asked(stateAt(HEAD), { port: p }));
  assert.equal(r.code, 0);
  assert.match(r.out, /already working/);
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`]);
});

test("a head the pool already started a reviewer for is not started again, even when no reviewer is listed now", () => {
  const { p, calls } = port({ label: "never" });
  const r = reviewOnDemand(asked(stateAt(HEAD), { port: p, started: new Set([`${URL}@${HEAD}`]) }));
  assert.equal(r.code, 0);
  assert.match(r.out, /already started for .* at 3aeaba9b, so none is started again/);
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`], "the start is not asked for");
});

test("a head with a posted approval or requested changes says which, and starts nothing", () => {
  for (const [state, word] of [["APPROVED", "approved"], ["CHANGES_REQUESTED", "changes requested"]]) {
    const { p, calls } = port({ label: "never" });
    const r = reviewOnDemand(asked(stateAt(HEAD, [reviewOn(state, HEAD)]), { port: p }));
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`already reviewed at 3aeaba9b: ${word}`));
    assert.deepEqual(calls, []);
  }
});

test("a head that changed after requested changes is not reviewed yet, so it is started", () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  reviewOnDemand(asked(stateAt(HEAD, [reviewOn("CHANGES_REQUESTED", "68bd2e8d00000000000000000000000000000000")]), { port: p }));
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`, `start ${URL}@${HEAD}`], "the new head is started");
});

test("the port's refusal is passed on with a non-zero code, and nothing is recorded: an outside author, checks not settled, a moved head", () => {
  const { p } = port({ refusal: "no reviewer for x: its checks at y have not settled green" });
  const r = reviewOnDemand({ url: URL, port: p, readState: () => stateAt(HEAD), started: new Set(), record: () => { throw new Error("nothing is recorded"); } });
  assert.equal(r.code, 1);
  assert.match(r.out, /have not settled green/);
});

test("an address that is not a pull request is refused before anything is asked, and an unreadable one has no head", () => {
  const { p, calls } = port({ label: "never" });
  assert.equal(reviewOnDemand(asked(stateAt(HEAD), { port: p, url: "a11ign/control#119" })).code, 2);
  assert.equal(reviewOnDemand(asked(null, { port: p })).code, 1);
  assert.deepEqual(calls, []);
});

test("ticket:review starts the reviewer for a repository the host clones and the project does not declare, with no entry in project.json", async () => {
  await loadReviewerGate();
  const gh = () => JSON.stringify({ state: "OPEN", headRefOid: HEAD, reviews: [], author: { login: "worker-bot" }, isCrossRepository: false, isDraft: false,
    statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] });
  const port = atomicReviewerPort({ session: "tickets", run: () => JSON.stringify({ result: { agents: [], workspaces: [] } }), gh, declared: { exact: ["worker-bot"], pattern: [] },
    clones: { plugin: "/repos/plugin" }, checkout: () => ({ path: "/work/pr-7", head: HEAD }), spawn: (order) => ({ label: order.session, workspace: "w7", profile: { kind: "codex", model: "m", effort: "e" } }) });
  const r = reviewOnDemand({ url: "https://github.com/a11ign/plugin/pull/7", port, readState: () => stateAt(HEAD), started: new Set(), record: () => {} });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /started reviewer-plugin-7 for .*a11ign\/plugin\/pull\/7 at 3aeaba9b/);
});
