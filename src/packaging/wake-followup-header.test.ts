// no-token: clearContext -- every herdr call is the injected `run`; nothing here reaches gh
/**
 * #2538: THE FIRST-CONTACT PREAMBLE GOES ON A SESSION'S FIRST ORDER ONLY (chairman, relayed by `ceo`, 2026-09-25).
 * `worker-2443`'s second order arrived wrapped in the WHOLE preamble again -- "Before you start", "Work autonomously",
 * "ENDING YOUR TURN", ~1,640 chars -- into a context that already held it. Since #2483 a per-row instance is never
 * cleared, so every copy stays.
 *
 * DRIVEN THROUGH `deliver` AND `clearThenPrompt`, the two paths that type an order, because a phrase grep over
 * `addressed` alone would pass with `deliver` never asking for the header. THE FIVE FORMS are each one test below, and
 * the positive control (a cleared standing seat DOES get the preamble) sits in the same file: a header given to
 * everybody would pass the follow-up half by removing the preamble altogether.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver as settlingDeliver } from "../wake.mjs";
import { clearThenPrompt as settlingClearThenPrompt, deliveredText } from "../prompt-session.mjs";
import { sessionOf } from "../token-audit.mjs";

/** #2546: a test that is not ABOUT the clear's five-second settle does not wait it; `wake-clear-settle.test.ts` pins the delay. */
const noSettle = () => {};
/** #2688: an EMPTY transcript root, so a per-row label this file reuses (`worker-2443`, `worker-4`, `reviewer-2537`,
 * all real, reused org role names on a shared host) is never compacted by a coincidence of a live session's own
 * transcript -- this file is not about the compact check, only about the header that follows the clear-skip. */
const NO_TRANSCRIPTS = join(tmpdir(), "a11y-2538-no-transcripts");
/** #2771: a delivery to a `reviewer-<n>` re-points that reviewer's tree first, and the default seams are REAL git on the host's
 * `~/reviews` and the primary's refs. A test that is not about the checkout injects this instead: every git call answers one head. */
const FAKE_HEAD = "d".repeat(40);
const FAKE_CHECKOUT = { git: () => `${FAKE_HEAD}\n`, exists: () => true, link: () => null, root: "/fake-reviews", repoRoot: "/fake-primary" };
const deliver: typeof settlingDeliver = (orders, agents, roster, deps) =>
  settlingDeliver(orders, agents, roster, { contextRoot: NO_TRANSCRIPTS, checkout: FAKE_CHECKOUT, ...deps, sleep: noSettle });
const clearThenPrompt: typeof settlingClearThenPrompt = (run, label, text, options) =>
  settlingClearThenPrompt(run, label, text, { contextRoot: NO_TRANSCRIPTS, ...options, sleep: noSettle });

const PREAMBLE_PHRASES = ["Before you start", "Work autonomously", "ENDING YOUR TURN"];
const ROSTER = ["worker-capture", "worker-judge", "worker-tooling"];
const agents = (labels: string[]) => labels.map((label) => ({ label, status: "idle" }));
const count = (text: string, phrase: string) => text.split(phrase).length - 1;
const counts = (text: string) => PREAMBLE_PHRASES.map((p) => count(text, p));

/** A `run` that records every herdr call and answers a `workspace create` the way herdr does. */
function recorder() {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args.join(" ").includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  const prompts = () => calls.filter((c) => c[2] === "agent" && c[3] === "prompt");
  return { run, cleared: () => prompts().filter((c) => c[5] === "/clear").map((c) => c[4]),
    /** What was TYPED to `label` as the order -- the `/clear` is not the order. */
    ordered: (label: string) => prompts().filter((c) => c[4] === label && c[5] !== "/clear").map((c) => c[5]) };
}

const ORDER_TEXT = "#2537 at `b778b0cb` has FAILING checks and is blocked.";
const order = (session: string, extra: object = {}) => ({ session, cause: "pr-checks-failing",
  causeKey: `${session}/pr-checks-failing/pr-2537/b778b0cb`, prompt: ORDER_TEXT, ...extra });

// --- THE FIVE DELIVERY FORMS, through `deliver` ---

test("#2538 a STARTED target gets the FULL preamble, once", () => {
  const r = recorder();
  const got = deliver([{ session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131",
    prompt: "Ready row #2131 is unclaimed." }], agents([]), ROSTER, { run: r.run });
  assert.deepEqual(got.refused, []);
  const [typed] = r.ordered("worker-capture");
  assert.ok(typed, "the started process was given its order, so the counts below are not an empty run");
  assert.deepEqual(counts(typed).slice(1), [1, 1], "a process that started knowing nothing is told everything, once");
  assert.ok(typed.startsWith("You are `worker-capture`"));
});

test("#2538 a CLEARED standing singleton gets the FULL preamble -- the positive control", () => {
  const r = recorder();
  const got = deliver([order("worker-tooling")], agents(["worker-tooling"]), ROSTER, { run: r.run });
  assert.deepEqual(got.refused, []);
  assert.deepEqual(r.cleared(), ["worker-tooling"], "it was cleared first, so its window holds nothing");
  const [typed] = r.ordered("worker-tooling");
  assert.deepEqual(counts(typed).slice(1), [1, 1], "and it gets the autonomy paragraphs it just lost");
  assert.ok(typed.includes(ORDER_TEXT));
});

test("#2538 an UNCLEARED instance's order is one header line and the order, and carries none of the three phrases", () => {
  for (const label of ["worker-2443", "worker-4", "reviewer-2537"]) {
    const r = recorder();
    const got = deliver([order(label)], agents([label]), ROSTER, { run: r.run });
    assert.deepEqual(got.refused, [], label);
    assert.deepEqual(r.cleared(), [], `${label}: not cleared (#2483)`);
    const [typed] = r.ordered(label);
    assert.ok(typed, `${label}: the order WAS typed`);
    assert.deepEqual(counts(typed), [0, 0, 0], `${label}: the preamble is already in its window`);
    // A reviewer's order also says its tree was re-pointed (#2771); nothing else rides along for anyone.
    const repointed = label.startsWith("reviewer-")
      ? `\n\nYour checkout of #2537, \`/fake-reviews/${label}\`, has just been re-pointed to the pull request's current head \`${FAKE_HEAD.slice(0, 8)}\`.` : "";
    assert.equal(typed, `You are \`${label}\` -- a follow-up order to your session: your first order and its brief still stand.\n\n${ORDER_TEXT}${repointed}`,
      `${label}: exactly the header, a blank line and the order, pinned whole`);
    assert.ok(typed.length < ORDER_TEXT.length + repointed.length + 150, `${label}: nothing else rode along (${typed.length} chars)`);
  }
});

test("#2538 a RESUMED standing seat keeps its context (#2470), so it gets the header form and no clear", () => {
  const r = recorder();
  const got = deliver([order("worker-tooling", { resume: true })], agents(["worker-tooling"]), ROSTER, { run: r.run });
  assert.deepEqual(got.refused, []);
  assert.deepEqual(r.cleared(), [], "a resume is never preceded by a clear");
  const [typed] = r.ordered("worker-tooling");
  assert.deepEqual(counts(typed), [0, 0, 0]);
  assert.ok(typed.startsWith("You are `worker-tooling` -- a follow-up"));
});

test("#2538 a process this tick STARTED for a resume is NEW, and is briefed in full", () => {
  const r = recorder();
  deliver([{ session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131",
    prompt: "Ready row #2131 is unclaimed.", resume: true }], agents([]), ROSTER, { run: r.run });
  const [typed] = r.ordered("worker-capture");
  assert.deepEqual(counts(typed).slice(1), [1, 1], "`resume` says nothing about a process that has no context to keep");
});

// --- THE ATTRIBUTION SURVIVES (done-when 3) ---

test("#2538 token-audit still attributes a transcript that opens on a follow-up to its session", () => {
  const header = deliveredText("worker-2443", ORDER_TEXT, null, { followUp: true });
  const full = deliveredText("worker-2443", ORDER_TEXT, null);
  assert.equal(sessionOf(header), "worker-2443", "the header names the session in the words `sessionOf` reads");
  assert.equal(sessionOf(full), "worker-2443", "and the full form is unchanged");
  assert.equal(sessionOf(ORDER_TEXT), null, "CONTROL: an order with no name is NOT attributed, so the two above prove the header");
});

// --- `prompt:session`, in both directions ---

test("#2538 clearThenPrompt: an instance gets the header; a standing seat, cleared, gets the whole preamble", () => {
  const instance = recorder();
  assert.equal(clearThenPrompt(instance.run, "worker-2443", "Rebase on main.", { sender: "ceo" }), null);
  const [typedToInstance] = instance.ordered("worker-2443");
  assert.deepEqual(counts(typedToInstance), [0, 0, 0]);
  assert.ok(typedToInstance.startsWith("You are `worker-2443` -- a follow-up"));
  assert.ok(typedToInstance.includes("Sent to you by `ceo`"), "the asker still travels");

  const standing = recorder();
  assert.equal(clearThenPrompt(standing.run, "worker-tooling", "Rebase on main.", { sender: "ceo" }), null);
  assert.deepEqual(standing.cleared(), ["worker-tooling"]);
  const [typedToSeat] = standing.ordered("worker-tooling");
  assert.deepEqual(counts(typedToSeat).slice(1), [1, 1], "POSITIVE CONTROL: the cleared seat is told everything");
});

test("#2538 deliveredText defaults to the FULL form: a caller that says nothing about the window briefs in full", () => {
  assert.deepEqual(counts(deliveredText("worker-tooling", "hello", null)).slice(1), [1, 1]);
  assert.deepEqual(counts(deliveredText("worker-2443", "hello", null, { followUp: true })), [0, 0, 0]);
});
