// A11-437: random event sequences fed to the settle of a run by its pull requests -- every wait names the pull requests it waits on, the ticket completes only when every one merged or closed with one merged, and merged, closed and needs-a-person are reachable
import { test } from "node:test";
import assert from "node:assert/strict";
import { settleStep, type SettleStep } from "./pr-state-machine.ts";
import { reviewAtHead } from "./pool-settle.ts";
import type { ViewEntry } from "./board-view/view-types-and-filters.ts";
import type { PullState } from "./source.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";

const SEQUENCES = 400;
const EVENTS_PER_SEQUENCE = 40;

/** A seeded generator (mulberry32): a failing sequence is found again from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** What can happen to one of the run's pull requests between two reads of the tracker: the check and queue events leave its state open, `unread` is a read the tracker could not make. */
const EVENTS = ["red", "cancelled", "rerun", "ejected", "push", "approval", "unread", "read", "merged", "closed"] as const;
type Event = (typeof EVENTS)[number];

/** The run, the state the tracker reads of each of its pull requests (absent: unread), and the ends the settle reached. */
type World = { entry: ViewEntry; states: Record<string, PullState>; ends: Set<"merged" | "closed" | "needs-a-person"> };

/** The number of the pull request a run opened while it ran, which no outcome lists (A11-358). */
const OPENED = 99;
/** How many seeds each start state is run from, so the six start states run as many sequences together as one property of the other files. */
const SEEDS_PER_START = SEQUENCES / 4;

const urlOf = (n: number): string => `https://github.com/a11ign/agent-org/pull/${n}`;

/** A finished review round with `count` pull requests it answers, and one it opened while it ran when `opened` says so (A11-358), all open. */
function start(count: number, opened: boolean, states: Record<string, PullState> = {}): World {
  const review = Array.from({ length: count }, (_, n) => ({ repo: "a11ign/agent-org", url: urlOf(n + 1) }));
  const entry = { ticket: { key: "A11-1" }, phase: "finished", review, ...(opened ? { opened: [{ repo: "a11ign/agent-org", url: urlOf(OPENED) }] } : {}) } as unknown as ViewEntry;
  const all = [...review, ...(opened ? [{ url: urlOf(OPENED) }] : [])];
  return { entry, states: { ...Object.fromEntries(all.map(({ url }) => [url, "open" as PullState])), ...states }, ends: new Set() };
}

const pullsOfWorld = (world: World): string[] => [...(world.entry.review ?? []), ...(world.entry.opened ?? [])].map(({ url }) => url);

/** One event, on one of the run's pull requests chosen at random. A merged or closed pull request stays so: GitHub reopens none the board answers. */
function happen(world: World, event: Event, url: string): void {
  const state = world.states[url];
  if (state === "merged" || state === "closed") return;
  if (event === "unread") delete world.states[url];
  else if (event === "read") world.states[url] = "open";
  else if (event === "merged" || event === "closed") world.states[url] = event;
}

/** What the settle should be, from the states alone: the model the machine is held to. */
function expected(world: World): SettleStep["do"] {
  const states = pullsOfWorld(world).map((url) => world.states[url]);
  if (!states.every((state) => state === "merged" || state === "closed")) return "wait";
  return states.includes("merged") ? "complete" : "ask";
}

/** One read of the tracker, settled by the machine: checked against the model, a wait or an ask shows its reason, and a wait names each pull request it waits on. */
function settleOnce(world: World, where: string): void {
  const step = settleStep(world.entry, { ...world.states });
  assert.equal(step.do, expected(world), `${where}: settled ${step.do} on ${JSON.stringify(world.states)}`);
  if (step.do !== "complete") assert.ok(step.reason !== "", `${where}: the run ${step.do}s with no reason shown`);
  if (step.do === "wait") for (const url of pullsOfWorld(world).filter((each) => world.states[each] !== "merged" && world.states[each] !== "closed")) assert.ok(step.reason.includes(url), `${where}: the wait does not name ${url}`);
  if (step.do === "complete") world.ends.add("merged");
  if (step.do === "ask") world.ends.add("needs-a-person");
  if (pullsOfWorld(world).every((url) => world.states[url] === "closed")) world.ends.add("closed");
}

function runSequence(seed: number, from: World): World["ends"] {
  const random = generator(seed);
  const world: World = { ...from, states: { ...from.states }, ends: new Set() };
  const pulls = pullsOfWorld(world);
  for (let n = 0; n < EVENTS_PER_SEQUENCE; n += 1) {
    const event = EVENTS[Math.floor(random() * EVENTS.length)];
    happen(world, event, pulls[Math.floor(random() * pulls.length)]);
    settleOnce(world, `seed ${seed}, event ${n} (${event})`);
  }
  return world.ends;
}

/** The start states of a run's settle the property enumerates: how many pull requests it has, whether one is only in what it opened, and any already merged, closed or unread. */
const START_STATES: Readonly<Record<string, () => World>> = {
  "one pull request, open": () => start(1, false),
  "two pull requests, open": () => start(2, false),
  "three pull requests, one merged": () => start(3, false, { [urlOf(1)]: "merged" }),
  "two pull requests, one closed": () => start(2, false, { [urlOf(2)]: "closed" }),
  "one answered and one it opened (A11-358)": () => start(1, true),
  "two pull requests, one unread": () => { const world = start(2, false); delete world.states[urlOf(1)]; return world; },
};

test("A11-437: in any random sequence of red, cancelled, rerun, ejected, push, approval, merge and close events, the run settles as its pull requests say, and every wait names what it waits on", () => {
  for (const make of Object.values(START_STATES)) for (let seed = 1; seed <= SEEDS_PER_START; seed += 1) runSequence(seed, make());
});

/** The ends a start state can reach: a run one of whose pull requests merged already can only complete; every other can complete, or have every pull request closed and ask a person. */
const reachable = (world: World): readonly string[] => (Object.values(world.states).includes("merged") ? ["merged"] : ["closed", "merged", "needs-a-person"]);

test("A11-437: from every start state of the settle, merged, closed and needs-a-person are each reachable", () => {
  for (const [name, make] of Object.entries(START_STATES)) {
    const want = reachable(make());
    const reached = new Set<string>();
    for (let seed = 1; seed <= SEQUENCES && reached.size < want.length; seed += 1) for (const end of runSequence(seed, make())) reached.add(end);
    assert.deepEqual([...reached].sort(), [...want], `from ${name}`);
  }
});

/** Review rounds of two pull requests, by what the tracker read of them, and how each settles. */
const SETTLES: readonly (readonly [string, Record<string, PullState>, SettleStep])[] = [
  ["one merged, one closed", { [urlOf(1)]: "merged", [urlOf(2)]: "closed" }, { do: "complete" }],
  ["both closed", { [urlOf(1)]: "closed", [urlOf(2)]: "closed" }, { do: "ask", reason: "its pull requests were closed without merging" }],
  ["one merged, one open", { [urlOf(1)]: "merged", [urlOf(2)]: "open" }, { do: "wait", reason: `${urlOf(2)} not merged or closed yet: the ticket completes when they merge` }],
];

for (const [name, states, step] of SETTLES) {
  test(`A11-437: a review round's done with ${name} settles as ${step.do}`, () => {
    assert.deepEqual(settleStep(start(2, false).entry, states), step);
  });
}

test("A11-437: a run with no pull request waits, and says why", () => {
  assert.deepEqual(settleStep(start(0, false).entry, {}), { do: "wait", reason: "it has no pull request to settle it" });
});

/** A head's verdict and GitHub's review decision, and the readiness `reviewAtHead` reads from them, as before its move. */
const REVIEWS: readonly (readonly [PullFeedback["verdictAtHead"], PullFeedback["reviewDecision"], ReturnType<typeof reviewAtHead>])[] = [
  [undefined, "approved", undefined],
  ["approved", undefined, undefined],
  [null, "changes-requested", "none"],
  ["approved", "approved", "approved"],
  ["approved", null, "approved"],
  ["approved", "changes-requested", "changes-requested"],
  ["changes-requested", "approved", "changes-requested"],
  ["approved", "review-required", "none"],
];

for (const [verdictAtHead, reviewDecision, readiness] of REVIEWS) {
  test(`A11-437: from pool-settle, a head whose verdict is ${String(verdictAtHead)} with GitHub's decision ${String(reviewDecision)} reads ${String(readiness)}`, () => {
    assert.equal(reviewAtHead({ verdictAtHead, reviewDecision } as PullFeedback), readiness);
  });
}
