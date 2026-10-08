// no-token: clearContext -- every herdr call is the injected `run`; the clock, the transcripts and the roster are injected too, so nothing here reaches gh
/**
 * #3440: A STANDING LEAD IS KEPT, OR COMPACTED, NOT CLEARED, WHEN ITS PREVIOUS ORDER WAS RECENT (chairman's order of 2026-10-04, lever 1, #928).
 *
 * `ceo`'s ruling: previous order at or under N (30 minutes) and a window at or under the fill threshold (50% of 200k) is KEPT and typed in the
 * follow-up shape; recent and over it is `/compact`ed; otherwise, and whenever either fact cannot be read, it is `/clear`ed and typed whole.
 * `wake-no-clear-for-instances.test.ts` still pins `worker-<n>` and `reviewer-<n>`, unedited.
 *
 * THE CONTROLS ARE THE TWO NON-EMPTY CASES, (1) kept and (2) cleared: every "sent no /clear" assertion below is read against a run in which
 * the order WAS typed and a run in which a /clear WAS sent, because "nothing was cleared" is also what a decision that clears nothing reports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deliver, deliverHandoffs, clearBeforeOrder, prepareContext, orderClockIn, keepsContext, CONTEXT_ACTION,
  KEEP_WITHIN_MS, KEEP_FILL_TOKENS, COMPACT_THRESHOLD_TOKENS } from "../wake.mjs";
import { clearThenPrompt, promptWithContext, promptOrQueue, queueOrLose } from "../prompt-session.mjs";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

const noSettle = () => {};
const MINUTE = 60_000;
const NOW = 20 * 60 * 60 * 1000;
const scratch = tmpDirForFile("keep-3440-");

/** A transcript root holding no transcript at all: "cannot tell". */
const NO_TRANSCRIPTS = join(scratch, "no-transcripts");
let rootCount = 0;
/** A transcript root whose newest turn for `label` read `cacheRead` tokens (the shape `instanceCacheRead` reads). */
function transcriptRootFor(label: string, cacheRead: number): string {
  const dir = join(scratch, `t-${rootCount++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "t.jsonl"), `${[
    JSON.stringify({ type: "user", message: { role: "user", content: `You are \`${label}\`, an org session in this repository.` } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5",
      usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 12 } } }),
  ].join("\n")}\n`);
  return dir;
}

/** A `run` recording every herdr call; `typed()` is what each session was sent, in order. */
function recorder(refuse: string[] = []) {
  const calls: string[][] = [];
  return { calls,
    run: (args: string[]) => {
      calls.push(args);
      if (args[3] === "prompt" && refuse.some((r) => String(args[5]).includes(r))) throw new Error(`refused ${args[5]}`);
      return "{}";
    },
    typed: () => calls.filter((c) => c[2] === "agent" && c[3] === "prompt").map((c) => `${c[4]}: ${c[5]}`),
    commands: () => calls.filter((c) => c[2] === "agent" && c[3] === "prompt" && String(c[5]).startsWith("/")).map((c) => String(c[5])) };
}

/** A clock at {@link NOW} whose record says `label`'s previous order landed `agoMs` earlier (`null`: none on record). */
function clockWith(label: string, agoMs: number | null) {
  const recorded: string[] = [];
  return { recorded,
    now: () => NOW,
    lastOrderAt: (who: string) => (who === label && agoMs !== null ? NOW - agoMs : null),
    recordOrder: (who: string) => { recorded.push(who); } };
}

const LEAD = "ceo";
const ROSTER = ["ceo", "product-manager", "orchestrator", "worker-capture", "worker-judge", "worker-tooling"];
const agents = (labels: string[]) => labels.map((label) => ({ label, status: "idle" }));
const order = (session: string) => ({ session, cause: "changes-requested", causeKey: `${session}/changes-requested/pr-3440/k`,
  prompt: "Your PR has a refusal to answer." });
const FIRST_CONTACT = /an org session in this repository/;
const FOLLOW_UP = /\[(?:order:\S+ )?session:[a-z0-9-]+ cause:\S+\]/;

/** One scenario, run through BOTH callers: what the window was done to, what was typed. */
type Scenario = { name: string; ago: number | null; tokens: number | null; action: string };
const SCENARIOS: Scenario[] = [
  { name: "(1) 10 minutes ago, small window", ago: 10 * MINUTE, tokens: 80_000, action: CONTEXT_ACTION.KEPT },
  { name: "(2) 31 minutes ago, small window", ago: 31 * MINUTE, tokens: 80_000, action: CONTEXT_ACTION.CLEARED },
  { name: "(3) 10 minutes ago, over the fill threshold", ago: 10 * MINUTE, tokens: KEEP_FILL_TOKENS + 1, action: CONTEXT_ACTION.COMPACTED },
  { name: "(4a) no previous order on record", ago: null, tokens: 80_000, action: CONTEXT_ACTION.CLEARED },
  { name: "(4b) a recent order and an unreadable transcript", ago: 10 * MINUTE, tokens: null, action: CONTEXT_ACTION.CLEARED },
  { name: "N's boundary: exactly N ago is kept", ago: KEEP_WITHIN_MS, tokens: 80_000, action: CONTEXT_ACTION.KEPT },
  { name: "N's boundary: one millisecond past N is cleared", ago: KEEP_WITHIN_MS + 1, tokens: 80_000, action: CONTEXT_ACTION.CLEARED },
  { name: "fill boundary: exactly the threshold is kept", ago: 10 * MINUTE, tokens: KEEP_FILL_TOKENS, action: CONTEXT_ACTION.KEPT },
  { name: "fill boundary: one token past it is compacted", ago: 10 * MINUTE, tokens: KEEP_FILL_TOKENS + 1, action: CONTEXT_ACTION.COMPACTED },
  { name: "a record from the future cannot be an age", ago: -MINUTE, tokens: 80_000, action: CONTEXT_ACTION.CLEARED },
];
const rootFor = (s: Scenario) => (s.tokens === null ? NO_TRANSCRIPTS : transcriptRootFor(LEAD, s.tokens));
/** The commands a window was sent before the order, as the scenario's expected outcome says they should be. */
const COMMANDS: Record<string, string[]> = {
  [CONTEXT_ACTION.KEPT]: [], [CONTEXT_ACTION.COMPACTED]: ["/compact"], [CONTEXT_ACTION.CLEARED]: ["/clear"] };

function viaDeliver(s: Scenario) {
  const r = recorder();
  const clock = clockWith(LEAD, s.ago);
  const got = deliver([order(LEAD)], agents([LEAD]), ROSTER, { run: r.run, sleep: noSettle, contextRoot: rootFor(s), clock });
  return { r, clock, got, typedOrder: r.typed().at(-1) ?? "" };
}
function viaClearThenPrompt(s: Scenario) {
  const r = recorder();
  const clock = clockWith(LEAD, s.ago);
  const report = clearThenPrompt(r.run, LEAD, "Your PR has a refusal to answer.", { sleep: noSettle, contextRoot: rootFor(s), clock });
  return { r, clock, report, typedOrder: r.typed().at(-1) ?? "" };
}

for (const s of SCENARIOS) {
  test(`#3440 deliver ${s.name}: ${s.action}, and the order is typed in the matching shape`, () => {
    const { r, clock, got, typedOrder } = viaDeliver(s);
    assert.deepEqual(got.refused, []);
    assert.deepEqual(r.commands(), COMMANDS[s.action], `the window commands sent before the order: ${JSON.stringify(r.typed())}`);
    assert.equal(r.typed().length, COMMANDS[s.action].length + 1, "and the order WAS typed, so a short list is not an empty run");
    // THE PROPERTY (done-when 5): never a first-contact order into a kept window, never a follow-up into a cleared one.
    assert.match(typedOrder, s.action === CONTEXT_ACTION.CLEARED ? FIRST_CONTACT : FOLLOW_UP);
    assert.doesNotMatch(typedOrder, s.action === CONTEXT_ACTION.CLEARED ? FOLLOW_UP : FIRST_CONTACT);
    assert.deepEqual(clock.recorded, [LEAD], "the order's time is recorded once it landed");
  });

  test(`#3440 (5) clearThenPrompt takes the same decision as deliver: ${s.name}`, () => {
    const d = viaDeliver(s);
    const c = viaClearThenPrompt(s);
    assert.equal(c.report, null);
    assert.deepEqual(c.r.commands(), d.r.commands(), "the same commands before the order, from either caller");
    assert.equal(c.r.typed().length, d.r.typed().length);
    assert.equal(FOLLOW_UP.test(c.typedOrder), FOLLOW_UP.test(d.typedOrder), "and the same shape");
    assert.equal(promptWithContext(recorder().run, LEAD, "x", { sleep: noSettle, contextRoot: rootFor(s), clock: clockWith(LEAD, s.ago) }).action,
      s.action, "and prepareContext's own word for it");
  });
}

test("#3440 a kept lead's follow-up says its earlier readings are stale; a cleared one's first-contact order is not given the clause", () => {
  const kept = viaDeliver(SCENARIOS[0]).typedOrder;
  const cleared = viaDeliver(SCENARIOS[1]).typedOrder;
  assert.match(kept, /re-read the row, the PR and the API before acting/);
  assert.doesNotMatch(cleared, /Your window was NOT cleared/);
});

test("#3440 (3) a refused /compact is reported and the order still goes (mirrors #2483 and #2688)", () => {
  const s = SCENARIOS[2];
  const r = recorder(["/compact"]);
  const got = deliver([order(LEAD)], agents([LEAD]), ROSTER,
    { run: r.run, sleep: noSettle, contextRoot: rootFor(s), clock: clockWith(LEAD, s.ago) });
  assert.deepEqual(got.refused, [], "one order, one status: delivered, so not also UNDELIVERED (#3546)");
  assert.equal(got.sent.length, 1, `reported on the delivered line: ${JSON.stringify(got)}`);
  assert.match(got.sent[0], /\[.*\/compact refused/);
  assert.equal(r.typed().at(-1)?.startsWith(`${LEAD}: [order:wake:${LEAD}:`), true, "and the order was typed after the refused /compact");
  const c = recorder(["/compact"]);
  const report = clearThenPrompt(c.run, LEAD, "x", { sleep: noSettle, contextRoot: rootFor(s), clock: clockWith(LEAD, s.ago) });
  assert.match(String(report), /compact/);
  assert.equal(c.typed().length, 2, "clearThenPrompt too: /compact was attempted and the order went");
});

test("#3440 a prompt that was refused records no time: the next order cannot be kept on an order that never landed", () => {
  const r = recorder(["Your PR has a refusal to answer."]);
  const clock = clockWith(LEAD, 10 * MINUTE);
  const report = clearThenPrompt(r.run, LEAD, "Your PR has a refusal to answer.", { sleep: noSettle, contextRoot: transcriptRootFor(LEAD, 1), clock });
  assert.match(String(report), /^prompt refused/);
  assert.deepEqual(clock.recorded, []);
});

test("#3440 (7) the batched-wake header states what THIS delivery did, and the sentence true only of a clear is gone", () => {
  const handoff = [{ id: `handoff/${LEAD}/0001`, session: LEAD, prompt: "the check failed", queuedAt: NOW - 60_000 },
    { id: `handoff/${LEAD}/0002`, session: LEAD, prompt: "and another", queuedAt: NOW - 30_000 }];
  const header = (s: Scenario) => {
    const r = recorder();
    deliverHandoffs(handoff, agents([LEAD]), ROSTER,
      { run: r.run, now: NOW, sleep: noSettle, contextRoot: rootFor(s), clock: clockWith(LEAD, s.ago) });
    return r.typed().at(-1) ?? "";
  };
  assert.match(header(SCENARIOS[0]), /THIS DELIVERY KEPT YOUR CONTEXT/);
  assert.match(header(SCENARIOS[2]), /THIS DELIVERY COMPACTED YOUR CONTEXT/);
  assert.match(header(SCENARIOS[1]), /THIS DELIVERY CLEARED YOUR CONTEXT/);
  for (const s of SCENARIOS) {
    const text = header(s);
    assert.doesNotMatch(text, /each delivery clears your context/, `${s.name}: the sentence that was true only of a clear`);
    assert.match(text, /2 ORDERS WERE QUEUED FOR YOU/, `${s.name}: it is the batched header, so the absence above is not an absent header`);
    assert.doesNotMatch(text, /@@CONTEXT@@/, `${s.name}: the placeholder was filled`);
  }
});

/** What `queueOrLose` writes to stderr and `promptOrQueue` to stdout, captured. */
function captured(fn: () => unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as never;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as never;
  try { fn(); } finally { process.stdout.write = o; process.stderr.write = e; }
  return { out: out.join(""), err: err.join("") };
}

test("#3440 (7) prompt:session tells its sender what THIS delivery did: kept, compacted or cleared", () => {
  const say = (s: Scenario) => {
    const dir = tmpDir("ps-", scratch);
    return captured(() => promptOrQueue({ run: recorder().run, label: LEAD, text: "x", agents: agents([LEAD]), path: join(dir, "queue"),
      stance: "decision" as never, sender: "worker-1", sleep: noSettle, contextRoot: rootFor(s), clock: clockWith(LEAD, s.ago) })).out;
  };
  assert.equal(say(SCENARIOS[0]), "PROMPTED ceo, context kept (not cleared)\n");
  assert.match(say(SCENARIOS[2]), /^PROMPTED ceo, context compacted \(not cleared/);
  assert.equal(say(SCENARIOS[1]), "PROMPTED ceo, on a cleared context\n", "the control: 31 minutes on, the old sentence, because it is true again");
});

test("#3440 (7) the queued-order refusal no longer says a standing seat is always cleared first", () => {
  const dir = tmpDir("q-", scratch);
  const { err } = captured(() => queueOrLose({ label: LEAD, text: "x", why: "it is busy", agents: [{ label: LEAD, status: "working" }],
    path: join(dir, "queue"), stance: "undeclared" as never }));
  assert.match(err, /QUEUED/, "it queued, so the text under test was printed");
  assert.doesNotMatch(err, /for a standing seat, which is cleared first, it also wipes/);
  assert.match(err, /under 30 minutes ago is kept or compacted, not cleared/);
});

test("#3440 (8) a per-row instance never reaches the clock: it is kept whatever the record says, and a throwing clock proves it", () => {
  const throwing = { now: () => { throw new Error("clock read"); }, lastOrderAt: () => { throw new Error("record read"); },
    recordOrder: () => {} };
  for (const label of ["worker-4", "reviewer-2456"]) {
    const r = recorder();
    assert.deepEqual(clearBeforeOrder(r.run, label, noSettle, NO_TRANSCRIPTS, undefined, throwing), { sent: false, refusal: null });
    assert.deepEqual(r.calls, [], `${label}: nothing sent`);
  }
  // the positive control: the SAME throwing clock does reach a standing lead, so the clock is the thing being avoided.
  assert.throws(() => clearBeforeOrder(recorder().run, LEAD, noSettle, NO_TRANSCRIPTS, undefined, throwing), /record read/);
});

test("#3440 a persistent seat never reaches the clock either: the fact is read first, the clock second", () => {
  const sessions = join(scratch, "sessions.json");
  writeFileSync(sessions, JSON.stringify({ live: [{ name: "liaison", role: "liaison", persistent: true }, { name: "ceo", role: "ceo" }] }));
  const throwing = { now: () => { throw new Error("clock read"); }, lastOrderAt: () => { throw new Error("record read"); }, recordOrder: () => {} };
  assert.equal(keepsContext("liaison", sessions), true);
  const r = recorder();
  assert.deepEqual(prepareContext(r.run, "liaison", { sleep: noSettle, contextRoot: NO_TRANSCRIPTS, sessions, clock: throwing }),
    { action: CONTEXT_ACTION.KEPT, refusal: null });
  assert.deepEqual(r.calls, []);
  const big = recorder();
  assert.equal(prepareContext(big.run, "liaison", { sleep: noSettle, sessions, clock: throwing,
    contextRoot: transcriptRootFor("liaison", COMPACT_THRESHOLD_TOKENS + 1) }).action, CONTEXT_ACTION.COMPACTED, "and it still compacts over #2688's threshold");
});

test("#3440 without a clock nothing is known, so every standing seat is cleared exactly as before", () => {
  const r = recorder();
  assert.deepEqual(clearBeforeOrder(r.run, LEAD, noSettle, transcriptRootFor(LEAD, 1)), { sent: true, refusal: null });
  assert.deepEqual(r.commands(), ["/clear"]);
});

test("#3440 orderClockIn: the record round-trips, and absent or garbage is cannot-tell, never recent", () => {
  const dir = join(scratch, "records");
  let at = 5_000_000;
  const clock = orderClockIn(dir, () => at);
  assert.equal(clock.lastOrderAt(LEAD), null, "no record");
  clock.recordOrder(LEAD);
  assert.equal(clock.lastOrderAt(LEAD), 5_000_000);
  assert.equal(clock.lastOrderAt("product-manager"), null, "a record is per seat");
  at = 6_000_000;
  clock.recordOrder(LEAD);
  assert.equal(clock.lastOrderAt(LEAD), 6_000_000, "the newest wins");
  const file = readdirSync(dir).find((f) => f.includes(LEAD)) ?? "";
  assert.ok(existsSync(join(dir, file)), "and it is a file in the directory the caller named");
  writeFileSync(join(dir, file), "not a number\n");
  assert.equal(clock.lastOrderAt(LEAD), null, "garbage reads as cannot tell");
});
