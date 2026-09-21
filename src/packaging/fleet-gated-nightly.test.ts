// no-token: gh -- reached only through fleet-gated-nightly.mjs's own import closure (`defaultGhRun`), never
// called here: every `performFiring` test below injects its own `ghRun`/`herdrRun` stub, so this file never
// spawns a real `gh` or `herdr`.
/**
 * #1830: THE FIRING MUST NEVER REPORT "EXAMINED 0" AS "ALL ROWS COVERED" -- the row's own Mutation.
 * `examinedComment([], ...)` is the direct pin. `fleetGatedRows` throwing rather than returning `[]` on a
 * refused `gh` call is `work-gate.test.ts`'s own rule (`readPrs`/`readReadyRows` never coerce a refusal
 * to an empty queue) applied to this firing's one read.
 *
 * `performFiring` below is `main`'s own orchestration, injectable exactly as `work-gate.mjs`'s
 * `performActions` is (PR #1844, reviewer-2 at `c8f4499f`): before this, only the pure helpers
 * (`examinedComment`, `wakeText`, `fleetGatedRows`) were under test, and `main` itself was not -- proved
 * by swapping the real #914 comment for a print and showing the acceptance command still passed. This is
 * the CONSUMER half the file used to warn would carry these tokens on purpose: it reaches `gh`/`herdr` by
 * name, injected, never spawned for real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { fleetGatedRows, examinedComment, wakeText, performFiring, MILESTONE, STANDING_ROW, SESSION }
  from "../fleet-gated-nightly.mjs";

const FIRED_AT = "2026-09-22T01:00:03.412Z";

test("MUTATION target: an empty fleet-gated set reads `examined 0`, never `all rows covered`", () => {
  const comment = examinedComment([], FIRED_AT);
  assert.match(comment, /examined 0 row/);
  assert.doesNotMatch(comment, /all rows covered/i);
  assert.match(comment, /Nobody woken/);
});

test("a non-empty set names every row number, not just the count", () => {
  const comment = examinedComment([{ number: 1768 }, { number: 71 }, { number: 44 }], FIRED_AT);
  assert.match(comment, /examined 3 row/);
  assert.match(comment, /#1768/);
  assert.match(comment, /#71/);
  assert.match(comment, /#44/);
  assert.match(comment, new RegExp(MILESTONE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the comment states the milestone and the fired-at timestamp it was measured at", () => {
  const comment = examinedComment([{ number: 1 }], FIRED_AT);
  assert.match(comment, new RegExp(FIRED_AT.replace(/[.:]/g, "\\$&")));
});

test("wakeText hands the woken session the row list, so it does not wake to go and look", () => {
  const text = wakeText([{ number: 1768 }, { number: 44 }]);
  assert.match(text, /#1768/);
  assert.match(text, /#44/);
  assert.match(text, /by-row batch/);
  assert.match(text, /#914/);
});

test("wakeText on an empty list still reads as a sentence, not a template artefact", () => {
  const text = wakeText([]);
  assert.match(text, /0 row/);
  assert.doesNotMatch(text, /undefined/);
});

test("fleetGatedRows parses the query's own JSON shape straight through", () => {
  const run = (args: string[]) => {
    assert.deepEqual(args.slice(0, 2), ["issue", "list"]);
    assert.ok(args.includes("--milestone"));
    assert.ok(args.includes(MILESTONE));
    assert.ok(args.includes("fleet-gated"));
    return JSON.stringify([{ number: 5, comments: [] }]);
  };
  assert.deepEqual(fleetGatedRows(run), [{ number: 5, comments: [] }]);
});

test("MUTATION target: a refused read THROWS -- it must never be swallowed into `[]`, "
  + "which this firing's own comment would then report as `examined 0` for a read that never happened", () => {
  const run = () => { throw new Error("gh: authentication required"); };
  assert.throws(() => fleetGatedRows(run), /authentication required/);
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

test("performFiring posts the #914 comment AND wakes the session when rows are open", () => {
  const ghCalls: string[][] = [];
  const herdrCalls: string[][] = [];
  const ghRun = (args: string[]) => {
    ghCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([{ number: 1768, comments: [] }]);
    return "";
  };
  const result = performFiring({ ghRun, herdrRun: herdrStub("idle", herdrCalls), now: () => FIRED_AT });
  if (result.kind !== "woke") throw new Error(`expected "woke", got "${result.kind}"`);

  assert.match(result.comment, /examined 1 row/);
  assert.match(result.comment, /#1768/);

  const commentCall = ghCalls.find((c) => c[0] === "issue" && c[1] === "comment");
  assert.ok(commentCall, "the comment must actually be posted, not just computed");
  assert.deepEqual(commentCall?.slice(0, 2), ["issue", "comment"]);
  assert.ok(commentCall?.includes(STANDING_ROW), "posted to #914");
  const bodyIndex = commentCall?.indexOf("--body") ?? -1;
  assert.equal(commentCall?.[bodyIndex + 1], result.comment, "the exact comment text is what gets posted");

  const wakeCall = herdrCalls.find((c) => c.includes(wakeText([{ number: 1768 }])));
  assert.ok(wakeCall, "the wake must carry wakeText's exact text, not a paraphrase");
  assert.ok(herdrCalls.some((c) => c.includes(SESSION)), "the wake names the session it woke");
});

test("performFiring on an empty row list posts the comment and wakes nobody", () => {
  const ghCalls: string[][] = [];
  const herdrCalls: string[][] = [];
  const ghRun = (args: string[]) => {
    ghCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([]);
    return "";
  };
  const result = performFiring({ ghRun, herdrRun: herdrStub("idle", herdrCalls), now: () => FIRED_AT });
  if (result.kind !== "quiet") throw new Error(`expected "quiet", got "${result.kind}"`);

  assert.match(result.comment, /examined 0 row/);
  assert.ok(ghCalls.some((c) => c[0] === "issue" && c[1] === "comment"), "the comment still posts");
  assert.deepEqual(herdrCalls, [], "no fleet-gated row means nothing is woken -- herdr is never touched");
});

test("performFiring on a refused row-list read posts nothing and wakes nobody", () => {
  const ghCalls: string[][] = [];
  const herdrCalls: string[][] = [];
  const ghRun = (args: string[]) => {
    ghCalls.push(args);
    throw new Error("gh: authentication required");
  };
  const result = performFiring({ ghRun, herdrRun: herdrStub("idle", herdrCalls), now: () => FIRED_AT });
  if (result.kind !== "cannot-ask") throw new Error(`expected "cannot-ask", got "${result.kind}"`);

  assert.match(result.message, /could not list fleet-gated rows/);
  assert.equal(ghCalls.length, 1, "only the failed read is attempted -- never a comment on top of it");
  assert.deepEqual(herdrCalls, [], "a read that could not be asked wakes nobody");
});

test("performFiring on a refused #914 comment post also wakes nobody", () => {
  const herdrCalls: string[][] = [];
  const ghRun = (args: string[]) => {
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([{ number: 1768, comments: [] }]);
    if (args[0] === "issue" && args[1] === "comment") throw new Error("gh: 403 rate limited");
    return "";
  };
  const result = performFiring({ ghRun, herdrRun: herdrStub("idle", herdrCalls), now: () => FIRED_AT });
  if (result.kind !== "cannot-ask") throw new Error(`expected "cannot-ask", got "${result.kind}"`);

  assert.match(result.message, /could not post the examined-count comment/);
  assert.deepEqual(herdrCalls, [], "a comment that never landed must never be followed by a wake");
});

test("performFiring reports not-woken, without retracting the comment already posted, "
  + "when the session cannot be prompted", () => {
  const ghCalls: string[][] = [];
  const herdrCalls: string[][] = [];
  const ghRun = (args: string[]) => {
    ghCalls.push(args);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([{ number: 1768, comments: [] }]);
    return "";
  };
  // "working": promptable refuses before clearThenPrompt would ever run.
  const result = performFiring({ ghRun, herdrRun: herdrStub("working", herdrCalls), now: () => FIRED_AT });
  if (result.kind !== "not-woken") throw new Error(`expected "not-woken", got "${result.kind}"`);

  assert.match(result.why, /is working/);
  assert.ok(ghCalls.some((c) => c[0] === "issue" && c[1] === "comment"), "the comment already landed");
  assert.ok(!herdrCalls.some((c) => c.includes("/clear") || c.includes("prompt")),
    "a session that cannot be prompted is never sent a clear or a prompt");
});
