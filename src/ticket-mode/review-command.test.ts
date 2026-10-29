// no-token: gh -- the reviewer port and the pull request's state are injected; nothing starts and nothing reaches GitHub or herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewerToStart, reviewOnDemand } from "./review-command.ts";
import { resolveProviders } from "./providers.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import type { ReviewerPort, ReviewState } from "./reviewer-port.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

const URL = "https://github.com/a11ign/control/pull/119";
const PLUGIN = "https://github.com/a11ign/plugin/pull/7";
const HEAD = "3aeaba9bd".padEnd(40, "0");

/** The code host the reviewer port reads the plugin's pull request through: open at `HEAD`, its author the org's own, and its checks settled green. */
function pluginPull() {
  const host = createFakeCodeHost();
  host.seedPull("a11ign/plugin", 7, { head: HEAD, trust: "inside", settled: true });
  return host;
}

/** A port that records what it was asked, and answers as told. */
const port = (answer: Awaited<ReturnType<ReviewerPort["start"]>>, live = false) => {
  const calls: string[] = [];
  const p: ReviewerPort = {
    live: async ({ pr, head }) => { calls.push(`live ${pr}@${head}`); return live; },
    start: async ({ pr, head }) => { calls.push(`start ${pr}@${head}`); return answer; },
    close: async () => ({ state: "gone" }), retire: async () => ({ retired: true, report: null }), listedPulls: async () => [],
    settled: async () => "working", verdictFileOf: () => null, repostVerdict: async () => ({ posted: true }), reprompt: async () => ({ prompted: true }),
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

test("starts the reviewer at the pull request's current head, names the seat it started, and records it for the pool", async () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  const recorded: string[][] = [];
  const r = await reviewOnDemand({ url: URL, port: p, readState: () => stateAt(HEAD), started: new Set(), record: (label, key, head) => { recorded.push([label, key, head]); } });
  assert.equal(r.code, 0);
  assert.match(r.out, /started reviewer-control-119 for .*pull\/119 at 3aeaba9b/);
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`, `start ${URL}@${HEAD}`]);
  assert.deepEqual(recorded, [["reviewer-control-119", `${URL}@${HEAD}`, HEAD]], "the start is recorded for the pool, with its seat and head");
});

test("A11-235: a start is recorded with its look: the time of the start and the pull request body it saw, so the pool can tell when the body changes", async () => {
  const { p } = port({ label: "reviewer-control-119" });
  const looks: unknown[] = [];
  const withBody = { ...stateAt(HEAD), view: { body: "Closes A11-1\n" } } as unknown as ReviewState;
  await reviewOnDemand({ url: URL, port: p, readState: () => withBody, started: new Set(), now: () => 1234, record: (_label, _key, _head, _unclaimed, look) => { looks.push(look); } });
  assert.deepEqual(looks, [{ at: 1234, body: "Closes A11-1\n" }]);
  const bare: unknown[] = [];
  await reviewOnDemand({ url: URL, port: p, readState: () => stateAt(HEAD), started: new Set(), now: () => 5, record: (_label, _key, _head, _unclaimed, look) => { bare.push(look); } });
  assert.deepEqual(bare, [{ at: 5, body: "" }], "a host that gives no body has an empty one; a start with no brief has no decisions on its look, so none are compared (A11-250)");
});

test("a --head given is the head reviewed, and its posted review is what is checked at that head", async () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  const r = await reviewOnDemand({ url: URL, head: "abc1234", port: p, readState: () => stateAt(HEAD, [reviewOn("APPROVED", "abc1234")]), started: new Set(), record: () => {} });
  assert.equal(r.code, 0);
  assert.match(r.out, /already reviewed at abc1234/);
  assert.deepEqual(calls, [], "a head with a posted review starts nothing");
});

test("a head given that has no review is started at that head", async () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  await reviewOnDemand(asked(stateAt(HEAD), { port: p, head: "abc1234" }));
  assert.deepEqual(calls, [`live ${URL}@abc1234`, `start ${URL}@abc1234`]);
});

test("a reviewer already live for that head is not started twice", async () => {
  const { p, calls } = port({ label: "never" }, true);
  const r = await reviewOnDemand(asked(stateAt(HEAD), { port: p }));
  assert.equal(r.code, 0);
  assert.match(r.out, /already working/);
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`]);
});

test("a head the pool already started a reviewer for is not started again, even when no reviewer is listed now", async () => {
  const { p, calls } = port({ label: "never" });
  const r = await reviewOnDemand(asked(stateAt(HEAD), { port: p, started: new Set([`${URL}@${HEAD}`]) }));
  assert.equal(r.code, 0);
  assert.match(r.out, /already started for .* at 3aeaba9b, so none is started again/);
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`], "the start is not asked for");
});

test("a head with a posted approval or requested changes says which, and starts nothing", async () => {
  for (const [state, word] of [["APPROVED", "approved"], ["CHANGES_REQUESTED", "changes requested"]]) {
    const { p, calls } = port({ label: "never" });
    const r = await reviewOnDemand(asked(stateAt(HEAD, [reviewOn(state, HEAD)]), { port: p }));
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`already reviewed at 3aeaba9b: ${word}`));
    assert.deepEqual(calls, []);
  }
});

test("a head that changed after requested changes is not reviewed yet, so it is started", async () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  await reviewOnDemand(asked(stateAt(HEAD, [reviewOn("CHANGES_REQUESTED", "68bd2e8d00000000000000000000000000000000")]), { port: p }));
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`, `start ${URL}@${HEAD}`], "the new head is started");
});

test("the port's refusal is passed on with a non-zero code, and nothing is recorded: an outside author, checks not settled, a moved head", async () => {
  const { p } = port({ refusal: "no reviewer for x: its checks at y have not settled green" });
  const r = await reviewOnDemand({ url: URL, port: p, readState: () => stateAt(HEAD), started: new Set(), record: () => { throw new Error("nothing is recorded"); } });
  assert.equal(r.code, 1);
  assert.match(r.out, /have not settled green/);
});

test("an address that is not a pull request is refused before anything is asked, and an unreadable one has no head", async () => {
  const { p, calls } = port({ label: "never" });
  assert.equal((await reviewOnDemand(asked(stateAt(HEAD), { port: p, url: "a11ign/control#119" }))).code, 2);
  assert.equal((await reviewOnDemand(asked(null, { port: p }))).code, 1);
  assert.deepEqual(calls, []);
});

// A11-161: `ticket:review` starts the reviewer the machine has enabled, and nothing when it has none.
const providersOf = (reviewer: Record<string, unknown> | undefined) => resolveProviders({ tickets: reviewer === undefined ? {} : { providers: { reviewer } } });

test("A11-161: ticket:review with no reviewer plugin enabled starts nothing and refuses by name: install for none, enable for one that is switched off", async () => {
  const none = await reviewerToStart({ reviewer: () => null }, providersOf(undefined), defaultCatalog());
  assert.deepEqual(none, { refusal: "ticket:review: this machine has no reviewer, so none is started: run `agent-org plugin install atomic`" });
  const disabled = await reviewerToStart({ reviewer: () => null }, providersOf({ provider: "atomic", enabled: false }), defaultCatalog());
  assert.deepEqual(disabled, { refusal: "ticket:review: this machine has no reviewer, so none is started: run `agent-org plugin enable atomic`" });
});

test("A11-161: ticket:review loads the enabled reviewer and starts it, and a reviewer that cannot start on this host is refused with the reason it gives", async () => {
  const fake = createFakeReviewer();
  const chosen = await reviewerToStart({ reviewer: () => fake }, providersOf({ provider: "atomic" }), defaultCatalog());
  assert.ok("reviewer" in chosen && chosen.reviewer === fake);
  assert.equal(fake.refusal(), null, "it was loaded: refusal() answers only after load()");
  const refusing = createFakeReviewer("/.agent-org/project.json: the declaration cannot be read");
  assert.deepEqual(await reviewerToStart({ reviewer: () => refusing }, providersOf({ provider: "atomic" }), defaultCatalog()),
    { refusal: "ticket:review: the reviewer does not load on this host: /.agent-org/project.json: the declaration cannot be read" });
  assert.deepEqual(refusing.started, [], "nothing is started");
});

test("A11-175: ticket:review starts a reviewer past a red unrequired check: the state names it, and nothing is refused for it", async () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  const state = { ...stateAt(HEAD), unrequiredRed: ["checks (cross-repo)"] } as ReviewState;
  const r = await reviewOnDemand(asked(state, { port: p }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /started reviewer-control-119 for .*pull\/119 at 3aeaba9b/);
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`, `start ${URL}@${HEAD}`]);
});
