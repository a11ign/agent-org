// no-token: gh -- every `gh` here is the injected `run` seam `escalateStuck` already takes, and the repository declaration is injected as `repoOf`; nothing imported reaches the real one
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
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalateStuck, ESCALATION_LABEL, MAX_DELIVERIES } from "./wake.ts";

const SHA = "0123abcd";
const MERGED = `worker-3075/trunk-red/pr-agent-org#56/${SHA}`;
const PRIMARY = `worker-3075/trunk-red/pr-56/${SHA}`;
const ISSUE_URL = "https://github.com/a11ign/a11ign/issues/3101\n";
const declared = (key: string): string | null => (key === "agent-org" ? "a11ign/agent-org" : null);

type Row = { number: number; title: string; labels: { name: string }[] };

/** The title the tick files for `MERGED`, read off a first escalation so the fixture does not restate its wording. */
const filedTitle = (() => {
  const calls: string[][] = [];
  escalateStuck([`${MERGED}: x`], (a: string[]) => { calls.push(a); return a[1] === "list" ? "[]" : a[1] === "create" ? ISSUE_URL : ""; }, () => {}, { repoOf: declared });
  const create = calls.find((c) => c[1] === "create") as string[];
  return create[create.indexOf("--title") + 1];
})();

const row = (labels: string[], title = filedTitle, number = 3101): Row => ({ number, title, labels: labels.map((name) => ({ name })) });

/** One tick over a key already escalated; `open` is every open row `issue list` can see, filtered by the `--label` it is asked for. */
function tick(key: string, open: Row[]) {
  const calls: string[][] = [];
  const log: string[] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] !== "list") return "";
    const label = args[args.indexOf("--label") + 1];
    return JSON.stringify(open.filter((r) => r.labels.some((l) => l.name === label)));
  };
  escalateStuck([`${key}: delivered ${MAX_DELIVERIES} times`], run, (l: string) => log.push(l), { repoOf: declared, escalated: new Set([key]) });
  return { calls, log: log.join(""), closes: calls.filter((c) => c[1] === "close"), writes: calls.filter((c) => c[1] !== "list") };
}

test("an open filed stuck-cause row whose answer:ceo is gone is closed with a comment naming the cause key", () => {
  const { closes, log } = tick(MERGED, [row(["parked", "out-of-release"])]);
  assert.equal(closes.length, 1);
  assert.equal(closes[0][2], "3101");
  const comment = closes[0][closes[0].indexOf("--comment") + 1];
  assert.ok(comment.includes(MERGED), "the comment names the cause key");
  assert.match(comment, /answer:ceo/);
  assert.match(log, /ANSWERED #3101 \(.*\) -- answer:ceo was removed/);
});

test("a row still carrying answer:ceo is not touched", () => {
  const { writes } = tick(MERGED, [row([ESCALATION_LABEL, "parked", "out-of-release"])]);
  assert.deepEqual(writes, []);
  // CONTROL: the same row, label gone, is the one closed.
  assert.equal(tick(MERGED, [row(["parked", "out-of-release"])]).closes.length, 1);
});

test("a row filed for something else is not closed, and a cause with no row open writes nothing", () => {
  assert.deepEqual(tick(MERGED, [row(["parked"], "Stuck trunk-red: another -- a different cause")]).writes, []);
  assert.deepEqual(tick(MERGED, []).writes, [], "the row already closed: nothing to do, and no error");
});

test("a row re-routed to another session, or no longer parked, is left", () => {
  assert.deepEqual(tick(MERGED, [row(["parked", "answer:product-manager"])]).writes, [], "answer:<session> is a wait, not an answer");
  assert.deepEqual(tick(MERGED, [row(["ready", "out-of-release"])]).writes, [], "moved out of parked: closing it would discard the work");
});

test("a label row of the primary is not closed: its answer is read by the re-ask, not here", () => {
  const { calls } = tick(PRIMARY, [row(["parked"], "Some row of the primary", 56)]);
  assert.deepEqual(calls.filter((c) => c[1] === "close"), []);
  assert.deepEqual(calls.filter((c) => c[1] === "list"), [], "and no list is read for it");
});

test("a refused `gh` is reported, not thrown, and closes nothing", () => {
  const log: string[] = [];
  const refuse = () => { throw new Error("HTTP 502"); };
  escalateStuck([`${MERGED}: x`], refuse, (l: string) => log.push(l), { repoOf: declared, escalated: new Set([MERGED]) });
  assert.match(log.join(""), /COULD NOT CLOSE ANSWERED ROW .*: HTTP 502/);
});
