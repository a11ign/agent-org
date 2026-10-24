// no-token: gh -- reached only through fleet-gated-nightly.ts's own import closure (the board's `gh` runner), never
// called here: the rows are the fake code host's (A11-160, step 9) and every `performFiring` test below injects its
// own `herdrRun` stub, so this file never spawns a real `gh` or `herdr`.
/**
 * #1830: THE FIRING MUST NEVER REPORT "EXAMINED 0" AS "ALL ROWS COVERED" -- the row's own Mutation.
 * `examinedComment([], ...)` is the direct pin. `fleetGatedRows` throwing rather than returning `[]` on a
 * refused `gh` call is `work-gate.test.ts`'s own rule (`readPrs`/`readReadyRows` never coerce a refusal
 * to an empty queue) applied to this firing's one read.
 *
 * `performFiring` below is `main`'s own orchestration, injectable exactly as `work-gate.ts`'s
 * `performActions` is (PR #1844, reviewer-2 at `c8f4499f`): before this, only the pure helpers
 * (`examinedComment`, `wakeText`, `fleetGatedRows`) were under test, and `main` itself was not -- proved
 * by swapping the real #914 comment for a print and showing the acceptance command still passed. This is
 * the CONSUMER half the file used to warn would carry these tokens on purpose: it reaches the code host's rows
 * and `herdr` by name, injected, never spawned for real. The argument list of the listing and its answer's shape are
 * the plugin's (`plugins/github/rows/class-row-reads.test.ts`); here the world is seeded with rows.
 */
import { afterEach, test } from "node:test";
import { testEach } from "../lib/test-each.ts";
import assert from "node:assert/strict";

import { fleetGatedRows, examinedComment, wakeText, performFiring as settlingPerformFiring, STANDING_ROW, SESSION }
  from "../fleet-gated-nightly.ts";
import { FLEET_GATED_SELECTOR } from "../work-gate/causes/rows-fleet-batch.ts";
import { PROMPT_REFUSED_PREFIX } from "../prompt-session.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

/** The fake code host in place with the standing row #914 and one open row per number in `gated` carrying the fleet-gated label. */
function worldWith(gated: number[]) {
  const host = createFakeCodeHost();
  substituteCodeHost(host);
  const { rowsWorld: world } = host;
  world.rows.set(Number(STANDING_ROW), fakeRow(world, Number(STANDING_ROW), { title: "the standing record" }));
  for (const number of gated) world.rows.set(number, fakeRow(world, number, { labels: [FLEET_GATED_SELECTOR.label] }));
  return world;
}
const standingComments = (world: ReturnType<typeof worldWith>) => world.rows.get(Number(STANDING_ROW))!.comments;
/** #2546: a test that is not ABOUT the clear's five-second settle does not wait it; `wake-clear-settle.test.ts` pins the delay. */
const noSettle = () => {};
const performFiring: typeof settlingPerformFiring = (deps) => settlingPerformFiring({ ...deps, sleep: noSettle });


const FIRED_AT = "2026-09-22T01:00:03.412Z";

test("MUTATION target: an empty fleet-gated set reads `examined 0`, never `all rows covered`", () => {
  const comment = examinedComment([], FIRED_AT);
  assert.match(comment, /examined 0 row/);
  assert.doesNotMatch(comment, /all rows covered/i);
  assert.match(comment, /Nobody woken/);
});

testEach("a non-empty set names every row number, not just the count", [
  { name: "the count", pattern: /examined 3 row/ },
  { name: "row #1768", pattern: /#1768/ },
  { name: "row #71", pattern: /#71/ },
  { name: "row #44", pattern: /#44/ },
  { name: "the fleet-gated command", pattern: /`fleet-gated`/ },
], (c) => {
  const comment = examinedComment([{ number: 1768 }, { number: 71 }, { number: 44 }], FIRED_AT);
  assert.match(comment, c.pattern);
});

test("the comment states the fired-at timestamp it was measured at", () => {
  const comment = examinedComment([{ number: 1 }], FIRED_AT);
  assert.match(comment, new RegExp(FIRED_AT.replace(/[.:]/g, "\\$&")));
});

testEach("wakeText hands the woken session the row list, so it does not wake to go and look", [
  { name: "row #1768", pattern: /#1768/ },
  { name: "row #44", pattern: /#44/ },
  { name: "the by-row batch wording", pattern: /by-row batch/ },
  { name: "row #914", pattern: /#914/ },
], (c) => {
  const text = wakeText([{ number: 1768 }, { number: 44 }]);
  assert.match(text, c.pattern);
});

test("wakeText on an empty list still reads as a sentence, not a template artefact", () => {
  const text = wakeText([]);
  assert.match(text, /0 row/);
  assert.doesNotMatch(text, /undefined/);
});

test("fleetGatedRows lists the open rows that carry the fleet-gated label, on any milestone and whatever else they carry", () => {
  const world = worldWith([5]);
  world.rows.set(6, fakeRow(world, 6, { labels: ["backlog"] }));
  world.rows.set(7, fakeRow(world, 7, { labels: [FLEET_GATED_SELECTOR.label], state: "CLOSED" }));
  world.rows.set(8, fakeRow(world, 8, { labels: [FLEET_GATED_SELECTOR.label, "backlog"], milestone: { number: 3, title: "off the path", description: null, dueOn: null } }));
  assert.deepEqual(fleetGatedRows().map((row) => row.number), [8, 5], "#2443: an off-path row must be named too; an unlabelled row and a closed one are not");
});

test("MUTATION target: a refused read THROWS -- it must never be swallowed into `[]`, "
  + "which this firing's own comment would then report as `examined 0` for a read that never happened", () => {
  worldWith([5]).failures.set("openRowsCarryingLabel", new Error("gh: authentication required"));
  assert.throws(() => fleetGatedRows(), /authentication required/);
});

/** The bound the listing was asked with, discovered from the call it made rather than restated here. */
function limitAsked(world: ReturnType<typeof worldWith>): number {
  fleetGatedRows();
  return Number(/limit=(\d+)$/.exec(world.calls.at(-1)!)![1]);
}

test("fleetGatedRows asks for more than the code host's own default page", () => {
  const DEFAULT_PAGE_SIZE = 30;
  assert.ok(limitAsked(worldWith([])) > DEFAULT_PAGE_SIZE, "the explicit limit must exceed the default page size");
});

test("MUTATION target: a listing that SATURATES the limit THROWS -- it may be truncated, and reading it "
  + "as the whole set would silently under-report what this firing examined", () => {
  const world = worldWith([]);
  const limit = limitAsked(world);
  for (let number = 1; number <= limit; number++) world.rows.set(number, fakeRow(world, number, { labels: [FLEET_GATED_SELECTOR.label] }));
  assert.throws(() => fleetGatedRows(), /may be truncated/i);
});

test("a listing one row under the limit is trusted as complete, at the boundary", () => {
  const world = worldWith([]);
  const limit = limitAsked(world);
  for (let number = 1; number < limit; number++) world.rows.set(number, fakeRow(world, number, { labels: [FLEET_GATED_SELECTOR.label] }));
  assert.equal(fleetGatedRows().length, limit - 1);
});

/** A `herdrRun` stub that reports `SESSION` at `status` to `readAgents`, and records every call it sees. */
function herdrStub(status: string, calls: string[][]) {
  return (args: string[]) => {
    calls.push(args);
    if (args.join(" ") === "--session org workspace list") {
      return JSON.stringify({ result: { workspaces: [{ label: SESSION, agent_status: status }] } });
    }
    return "";
  };
}

/** One firing with the open row #1768 in the fake code host's world, and the session in `status`; returns the world and what the `herdr` stub recorded. */
function firingWithOpenRow(status: string) {
  const world = worldWith([1768]);
  const herdrCalls: string[][] = [];
  const result = performFiring({ herdrRun: herdrStub(status, herdrCalls), now: () => FIRED_AT });
  return { world, herdrCalls, result };
}

test("performFiring posts the #914 comment AND wakes the session when rows are open", () => {
  const { world, herdrCalls, result } = firingWithOpenRow("idle");
  if (result.kind !== "woke") throw new Error(`expected "woke", got "${result.kind}"`);

  assert.match(result.comment, /examined 1 row/);
  assert.match(result.comment, /#1768/);

  assert.deepEqual(standingComments(world).map((comment) => comment.body), [result.comment], "the comment must actually be posted, not just computed, to #914, with the exact text");
  assert.deepEqual(world.rows.get(1768)!.comments, [], "the firing comments on the standing row and on no other");

  const wakeCall = herdrCalls.find((c) => c.some((a) => a.includes(wakeText([{ number: 1768 }]))));
  assert.ok(wakeCall, "the wake must carry wakeText's exact text (inside the addressed brief, #2344), not a paraphrase");
  assert.ok(herdrCalls.some((c) => c.includes(SESSION)), "the wake names the session it woke");
});

test("performFiring on an empty row list posts the comment and wakes nobody", () => {
  const world = worldWith([]);
  const herdrCalls: string[][] = [];
  const result = performFiring({ herdrRun: herdrStub("idle", herdrCalls), now: () => FIRED_AT });
  if (result.kind !== "quiet") throw new Error(`expected "quiet", got "${result.kind}"`);

  assert.match(result.comment, /examined 0 row/);
  assert.deepEqual(standingComments(world).map((comment) => comment.body), [result.comment], "the comment still posts");
  assert.deepEqual(herdrCalls, [], "no fleet-gated row means nothing is woken -- herdr is never touched");
});

/** One firing over one open row #1768 where the code host refuses `operation` with `error`: the world, what `herdr` was sent, and what the firing came to. */
function firingRefusing(operation: "openRowsCarryingLabel" | "commentOnIssue", error: string) {
  const world = worldWith([1768]);
  world.failures.set(operation, new Error(error));
  const herdrCalls: string[][] = [];
  const result = performFiring({ herdrRun: herdrStub("idle", herdrCalls), now: () => FIRED_AT });
  if (result.kind !== "cannot-ask") throw new Error(`expected "cannot-ask", got "${result.kind}"`);
  return { world, herdrCalls, message: result.message };
}

test("performFiring on a refused row-list read posts nothing and wakes nobody", () => {
  const { world, herdrCalls, message } = firingRefusing("openRowsCarryingLabel", "gh: authentication required");
  assert.match(message, /could not list fleet-gated rows/);
  assert.deepEqual(standingComments(world), [], "only the failed read is attempted -- never a comment on top of it");
  assert.deepEqual(herdrCalls, [], "a read that could not be asked wakes nobody");
});

test("performFiring on a refused #914 comment post also wakes nobody", () => {
  const { herdrCalls, message } = firingRefusing("commentOnIssue", "gh: 403 rate limited");
  assert.match(message, /could not post the examined-count comment/);
  assert.deepEqual(herdrCalls, [], "a comment that never landed must never be followed by a wake");
});

test("performFiring reports not-woken, without retracting the comment already posted, "
  + "when the session cannot be prompted", () => {
  // "working": promptable refuses before clearThenPrompt would ever run.
  const { world, herdrCalls, result } = firingWithOpenRow("working");
  if (result.kind !== "not-woken") throw new Error(`expected "not-woken", got "${result.kind}"`);

  assert.match(result.why, /is working/);
  assert.equal(standingComments(world).length, 1, "the comment already landed");
  assert.ok(!herdrCalls.some((c) => c.includes("/clear") || c.includes("prompt")),
    "a session that cannot be prompted is never sent a clear or a prompt");
});

test("MUTATION target: performFiring reports not-woken, not woke, when the context clears but the order "
  + "itself is refused -- before this fix a `journalctl` read of `main` could show `WOKE orchestrator` "
  + "for a wake that never landed (reviewer-2 on PR #1844)", () => {
  const world = worldWith([1768]);
  const herdrRun = (args: string[]) => {
    if (args.join(" ") === "--session org workspace list") {
      return JSON.stringify({ result: { workspaces: [{ label: SESSION, agent_status: "idle" }] } });
    }
    // The clear (`/clear`, then `agent wait`) lands fine -- only the real order is refused below.
    if (args.includes("/clear") || args.includes("wait")) return "";
    if (args.includes("prompt")) throw new Error("herdr: agent unreachable");
    return "";
  };
  const result = performFiring({ herdrRun, now: () => FIRED_AT });
  if (result.kind !== "not-woken") throw new Error(`expected "not-woken", got "${result.kind}"`);

  assert.match(result.why, new RegExp(PROMPT_REFUSED_PREFIX));
  assert.equal(standingComments(world).length, 1, "the comment already landed");
});
