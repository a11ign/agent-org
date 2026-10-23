// no-token: none -- the rows `escalateStuck` reads and writes are the fake code host's (A11-160, step 7), and the repository declaration is injected as `repoOf`; nothing imported reaches `gh`
/**
 * #622: A STUCK-CAUSE ROW THE TICK FILED IS CLOSED WHEN ITS `answer:ceo` IS REMOVED, NOT LEFT `parked` WITH NO WAIT.
 *
 * `fileRepositoryRow` files the row `answer:ceo` + `parked` + `out-of-release` (#4727) and removing `answer:ceo` is the answer, but the
 * only reader of the removal (`reaskCleared`) is for a LABEL row, so a filed row stayed open `parked` with no `Not-before:`, `Waiting-for:`,
 * `blockedBy` edge or `answer:<session>`: the shape `board-truth-audit`'s `parkedWithoutConditions` names to `product-manager`.
 *
 * THE CLAIMS, each with its control in the same fixture: the answered row is closed with a comment naming the cause key; a row still
 * carrying `answer:ceo` is not touched; a label row (the primary's own) is not closed by it; and a row that was moved on, or re-routed to
 * `answer:<session>`, is left. Make `closeAnsweredRow` never close and the first goes red; make it close whatever it finds and the
 * second, fourth and fifth do.
 */
import { afterEach, test } from "node:test";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import assert from "node:assert/strict";
import { escalateStuck, ESCALATION_LABEL } from "./wake/merge-queue-wait.ts";
import { MAX_DELIVERIES } from "./wake/fyi-delivery-and-limits.ts";

const SHA = "0123abcd";
const MERGED = `worker-3075/trunk-red/pr-agent-org#56/${SHA}`;
const PRIMARY = `worker-3075/trunk-red/pr-56/${SHA}`;
afterEach(() => forgetActivation());
/** The `run` the tick is handed: the rows are the fake's, so nothing may reach it. */
const noRun = (args: string[]): string => { throw new Error(`the fake code host answers every read; nothing may run ${args.join(" ")}`); };
const declared = (key: string): string | null => (key === "agent-org" ? "a11ign/agent-org" : null);

type Row = { number: number; title: string; labels: { name: string }[] };

/** A fake code host holding `open` as open rows, the next filed row being #9000. */
function hostHolding(open: Row[]) {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.nextNumber = 9000;
  for (const r of open) world.rows.set(r.number, fakeRow(world, r.number, { title: r.title, labels: r.labels.map((l) => l.name) }));
  substituteCodeHost(host);
  return world;
}

/** The title the tick files for `MERGED`, read off a first escalation so the fixture does not restate its wording. */
const filedTitle = (() => {
  const world = hostHolding([]);
  escalateStuck([`${MERGED}: x`], noRun, () => {}, { repoOf: declared });
  forgetActivation();
  return [...world.rows.values()][0].title;
})();

const row = (labels: string[], title = filedTitle, number = 3101): Row => ({ number, title, labels: labels.map((name) => ({ name })) });

/** What a world holds, to say what a tick wrote: every row's state, labels, body and comments. */
const snapshot = (world: ReturnType<typeof hostHolding>) => JSON.stringify([...world.rows.values()]);

/** One tick over a key already escalated; `open` is every open row the fake holds, filtered by the label the tick asks for. */
function tick(key: string, open: Row[]) {
  const world = hostHolding(open);
  const before = snapshot(world);
  const log: string[] = [];
  escalateStuck([`${key}: delivered ${MAX_DELIVERIES} times`], noRun, (l: string) => log.push(l), { repoOf: declared, escalated: new Set([key]) });
  const closes = [...world.rows.values()].filter((r) => r.state === "CLOSED");
  return { world, log: log.join(""), closes, written: snapshot(world) !== before };
}

test("an open filed stuck-cause row whose answer:ceo is gone is closed with a comment naming the cause key", () => {
  const { closes, log } = tick(MERGED, [row(["parked", "out-of-release"])]);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].number, 3101);
  const comment = closes[0].comments.at(-1)!.body;
  assert.ok(comment.includes(MERGED), "the comment names the cause key");
  assert.match(comment, /answer:ceo/);
  assert.match(log, /ANSWERED #3101 \(.*\) -- answer:ceo was removed/);
});

test("a row still carrying answer:ceo is not touched", () => {
  assert.equal(tick(MERGED, [row([ESCALATION_LABEL, "parked", "out-of-release"])]).written, false);
  // CONTROL: the same row, label gone, is the one closed.
  assert.equal(tick(MERGED, [row(["parked", "out-of-release"])]).closes.length, 1);
});

test("a row filed for something else is not closed, and a cause with no row open writes nothing", () => {
  assert.equal(tick(MERGED, [row(["parked"], "Stuck trunk-red: another -- a different cause")]).written, false);
  assert.equal(tick(MERGED, []).written, false, "the row already closed: nothing to do, and no error");
});

test("a row re-routed to another session, or no longer parked, is left", () => {
  assert.equal(tick(MERGED, [row(["parked", "answer:product-manager"])]).written, false, "answer:<session> is a wait, not an answer");
  assert.equal(tick(MERGED, [row(["ready", "out-of-release"])]).written, false, "moved out of parked: closing it would discard the work");
});

test("a label row of the primary is not closed: its answer is read by the re-ask, not here", () => {
  const world = hostHolding([row(["parked"], "Some row of the primary", 56)]);
  world.failures.set("readRowsByLabel", new Error("HTTP 502"));
  const log: string[] = [];
  escalateStuck([`${PRIMARY}: delivered ${MAX_DELIVERIES} times`], noRun, (l: string) => log.push(l), { repoOf: declared, escalated: new Set([PRIMARY]) });
  assert.deepEqual([...world.rows.values()].filter((r) => r.state === "CLOSED"), []);
  assert.doesNotMatch(log.join(""), /COULD NOT CLOSE/, "and no list of rows is read for it: a refused read would have been said");
});

test("a refused read is reported, not thrown, and closes nothing", () => {
  const world = hostHolding([row(["parked", "out-of-release"])]);
  world.failures.set("readRowsByLabel", new Error("HTTP 502"));
  const log: string[] = [];
  escalateStuck([`${MERGED}: x`], noRun, (l: string) => log.push(l), { repoOf: declared, escalated: new Set([MERGED]) });
  assert.match(log.join(""), /COULD NOT CLOSE ANSWERED ROW .*: HTTP 502/);
  assert.equal(world.rows.get(3101)!.state, "OPEN");
});
