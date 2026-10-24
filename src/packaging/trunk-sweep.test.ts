/**
 * #417: THE INTERIM COVER WHILE THE TRUNK IS UNGUARDED AFTER EVERY PIPELINE MERGE.
 *
 * `needsGateSweep` is the whole gate-side decision, as one pure function. The row-closing half reuses
 * `close-rows-sweep.ts`'s own `mergedPrsInWindow`/`closurePlan` wiring (already tested in that file) --
 * this file does not repeat those. How the project's `nightly.yml`/`trunk.yml` schedule and trigger the
 * two halves is the project's to assert, and left this file with #3233.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { needsGateSweep, sweepTrunk, EXIT } from "../trunk-sweep.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

afterEach(() => forgetActivation());

// The tool's own script, `src` up one.
const SCRIPT = fileURLToPath(new URL("../trunk-sweep.ts", import.meta.url));

// --- needsGateSweep: the pure decision ---

test("needsGateSweep: zero check runs needs a sweep", () => {
  assert.equal(needsGateSweep(0), true);
});

test("needsGateSweep: MUTATION TARGET -- any check run at all means no sweep is needed", () => {
  assert.equal(needsGateSweep(1), false);
  assert.equal(needsGateSweep(9), false);
});

// --- the CLI, guarded like every other argv-reading script here ---

test("trunk-sweep.ts refuses an unknown flag rather than silently ignoring it", () => {
  let threw = false;
  try {
    execFileSync("node", [SCRIPT, "--bogus"], { encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /unknown flag --bogus/);
  }
  assert.ok(threw);
});

test("trunk-sweep.ts refuses to run without GITHUB_REPOSITORY -- CANNOT ASK, never a guessed repo", () => {
  let threw = false;
  try {
    const env = { ...process.env };
    delete env.GITHUB_REPOSITORY;
    execFileSync("node", [SCRIPT], { encoding: "utf8", stdio: "pipe", env });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, EXIT.CANNOT_ASK);
    assert.match(String(err.stderr), /GITHUB_REPOSITORY is unset/);
  }
  assert.ok(threw);
});

// --- the sweep over the fake code host's world (A11-160, step 9): what it reads, what it dispatches, and what each refusal ends in ---

/** One sweep of `o/r` over a world whose tip of main is `abc1234` and carries `checkRuns` check runs; `edit` shapes the world further. */
function sweepOf(checkRuns: number, edit: (queue: ReturnType<typeof createFakeCodeHost>["rowsWorld"]["tail"]["queue"]) => void = () => {}) {
  const host = createFakeCodeHost();
  const { queue } = host.rowsWorld.tail;
  queue.mainSha = "abc1234";
  queue.checkRunTotals.set("abc1234", checkRuns);
  edit(queue);
  substituteCodeHost(host);
  const out: string[] = [];
  const err: string[] = [];
  const code = sweepTrunk("o/r", { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err, queue };
}

test("a tip with ZERO check runs dispatches trunk.yml, once, and says so", () => {
  const { code, out, err, queue } = sweepOf(0);
  assert.equal(code, EXIT.DONE);
  assert.deepEqual(queue.dispatched, ["trunk.yml"]);
  assert.deepEqual(out, ["TRUNK-SWEEP: main's tip (abc1234) carries ZERO check runs -- triggering trunk.yml.", "TRUNK-SWEEP: triggered."]);
  assert.deepEqual(err, []);
});

test("CONTROL: a tip with a check run dispatches nothing, and says how many it carries", () => {
  const { code, out, queue } = sweepOf(2);
  assert.equal(code, EXIT.DONE);
  assert.deepEqual(queue.dispatched, [], "the positive control above is the same world with none");
  assert.deepEqual(out, ["TRUNK-SWEEP: main's tip (abc1234) already carries 2 check run(s) -- nothing to do."]);
});

test("a lookup that fails is CANNOT ASK, never fine: neither a refused tip nor a refused count dispatches anything", () => {
  for (const [what, edit] of [
    ["the tip", (queue: { mainSha: unknown }) => { queue.mainSha = new Error("HTTP 502"); }],
    ["the count", (queue: { checkRunTotals: Map<string, number | Error> }) => { queue.checkRunTotals.set("abc1234", new Error("HTTP 502")); }],
  ] as const) {
    const { code, err, queue } = sweepOf(0, edit as never);
    assert.equal(code, EXIT.CANNOT_ASK, what);
    assert.match(err.join("\n"), /CANNOT ASK: reading main's tip or its check runs failed -- HTTP 502/, what);
    assert.deepEqual(queue.dispatched, [], what);
  }
});

test("a count that is not a number is not zero: it is read as it is and nothing is dispatched for it", () => {
  const { code, out, queue } = sweepOf(Number.NaN);
  assert.equal(code, EXIT.DONE);
  assert.deepEqual(queue.dispatched, []);
  assert.match(out.join("\n"), /already carries NaN check run\(s\)/, "as the script always did: NaN is not zero, so it is not swept");
});

test("a dispatch that is refused is exit 1 and says why, and the tip is still reported as having no check runs", () => {
  const { code, out, err, queue } = sweepOf(0, (queue) => { queue.dispatchRefusal = "HTTP 422: workflow does not have workflow_dispatch"; });
  assert.equal(code, EXIT.COULD_NOT_TRIGGER);
  assert.deepEqual(queue.dispatched, []);
  assert.match(err.join("\n"), /TRUNK-SWEEP: could not trigger trunk\.yml -- HTTP 422/);
  assert.match(out.join("\n"), /carries ZERO check runs -- triggering trunk\.yml/);
  assert.doesNotMatch(out.join("\n"), /triggered\.$/);
});
