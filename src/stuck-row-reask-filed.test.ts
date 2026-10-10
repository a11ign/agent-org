// no-token: gh -- every `gh` here is the injected `run` seam `escalateStuck` already takes, and the repository declaration is injected as `repoOf`; nothing imported reaches the real one
/**
 * #656: A FILED STUCK-CAUSE ROW IS ASKED ONCE MORE AN HOUR AFTER IT IS ANSWERED, AS A LABEL ROW IS.
 *
 * #622 closes the row `fileRepositoryRow` filed when its `answer:ceo` is removed, and says the existing re-ask files a new one an hour
 * later. It did not: `reaskCleared` is called for a label row only, and a filed row's key stays in the ledger's `escalated` set, so a cause
 * still true after the close was silent until its causeKey changed. The once-rule's memory is the closed rows of the title, read back.
 *
 * THE CLAIMS, each with its control in the same fixture: a row closed an hour ago whose cause is still emitted is filed once more; one
 * closed less than an hour ago is not; a second closed row of the title is not followed by a third; an open row of the title is not
 * doubled. Make `reaskFiledRow` never file and the first goes red; make it file whatever it finds and the other three do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalateStuck, ESCALATION_LABEL, MAX_DELIVERIES, REASK_AFTER_MS } from "./wake.ts";

const SHA = "0123abcd";
const MERGED = `worker-3075/trunk-red/pr-agent-org#56/${SHA}`;
const PRIMARY = `worker-3075/trunk-red/pr-56/${SHA}`;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const ISSUE_URL = "https://github.com/a11ign/a11ign/issues/3200\n";
const declared = (key: string): string | null => (key === "agent-org" ? "a11ign/agent-org" : null);

type Hit = { number: number; title: string; state: "OPEN" | "CLOSED"; closedAt: string | null };

/** The title the tick files for `MERGED`, read off a first escalation so the fixture does not restate its wording. */
const filedTitle = (() => {
  const calls: string[][] = [];
  escalateStuck([`${MERGED}: x`], (a: string[]) => { calls.push(a); return a[1] === "list" ? "[]" : a[1] === "create" ? ISSUE_URL : ""; }, () => {}, { repoOf: declared });
  const create = calls.find((c) => c[1] === "create") as string[];
  return create[create.indexOf("--title") + 1];
})();

const closedAgo = (ms: number, number = 3101, title = filedTitle): Hit => ({ number, title, state: "CLOSED", closedAt: new Date(NOW - ms).toISOString() });
const opened = (number = 3102, title = filedTitle): Hit => ({ number, title, state: "OPEN", closedAt: null });

/** One tick over a key already escalated whose cause is still emitted; `hits` is what the title search answers. */
function tick(key: string, hits: Hit[]) {
  const calls: string[][] = [];
  const log: string[] = [];
  const posts: { row: number; body: string }[] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === "create") return ISSUE_URL;
    if (args[1] !== "list") return "";
    if (args.includes("--search")) return JSON.stringify(hits);
    return "[]";
  };
  const ask = { post: (row: number, body: string) => { posts.push({ row, body }); }, stateOf: () => "idle", now: () => NOW };
  const labelled = escalateStuck([`${key}: delivered ${MAX_DELIVERIES} times`], run, (l: string) => log.push(l), { repoOf: declared, escalated: new Set([key]), ask });
  const creates = calls.filter((c) => c[1] === "create");
  return { calls, creates, posts, labelled, log: log.join("") };
}

test("a filed row closed an hour ago whose cause is still emitted is filed once more", () => {
  const { creates, labelled, log, posts } = tick(MERGED, [closedAgo(REASK_AFTER_MS)]);
  assert.equal(creates.length, 1);
  assert.equal(creates[0][creates[0].indexOf("--title") + 1], filedTitle, "the same title: it is the dedupe key");
  assert.ok(creates[0].includes(ESCALATION_LABEL), "born waiting on ceo");
  assert.deepEqual(labelled, [3200]);
  assert.match(log, /ASKED AGAIN #3200 -> answer:ceo \(.*#3101 closed 60 minutes ago, cause still true\)/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].row, 3200);
  assert.ok(posts[0].body.includes(MERGED) && posts[0].body.includes("#3101"), "the comment names the cause and the row that asked before");
});

test("a row closed less than an hour ago is not filed again", () => {
  assert.deepEqual(tick(MERGED, [closedAgo(REASK_AFTER_MS - 60_000)]).creates, []);
  // CONTROL: the same row one minute older is the one filed.
  assert.equal(tick(MERGED, [closedAgo(REASK_AFTER_MS + 60_000)]).creates.length, 1);
});

test("a second closed row of the title is not followed by a third", () => {
  const { creates, log } = tick(MERGED, [closedAgo(3 * REASK_AFTER_MS, 3101), closedAgo(2 * REASK_AFTER_MS, 3200)]);
  assert.deepEqual(creates, []);
  assert.doesNotMatch(log, /ASKED AGAIN/);
  // CONTROL: the first of them alone is filed from.
  assert.equal(tick(MERGED, [closedAgo(3 * REASK_AFTER_MS, 3101)]).creates.length, 1);
});

test("an open row of the title is the question already asked, and is not doubled", () => {
  assert.deepEqual(tick(MERGED, [closedAgo(2 * REASK_AFTER_MS), opened()]).creates, []);
});

test("a row of another title is not the row, and a title never filed has nothing to ask again", () => {
  assert.deepEqual(tick(MERGED, [closedAgo(2 * REASK_AFTER_MS, 3101, "Stuck trunk-red: another -- a different cause")]).creates, []);
  assert.deepEqual(tick(MERGED, []).creates, [], "no closed row: the cause was never asked, so there is no 'once more'");
});

test("a label row of the primary is not read here: its re-ask is `reaskCleared`", () => {
  const { calls } = tick(PRIMARY, [closedAgo(2 * REASK_AFTER_MS)]);
  assert.deepEqual(calls.filter((c) => c.includes("--search")), []);
});

test("a caller with no asker files nothing, as the label row's re-ask does", () => {
  const calls: string[][] = [];
  escalateStuck([`${MERGED}: x`], (a: string[]) => { calls.push(a); return "[]"; }, () => {}, { repoOf: declared, escalated: new Set([MERGED]) });
  assert.deepEqual(calls.filter((c) => c.includes("--search") || c[1] === "create"), []);
});

test("a refused `gh` is reported, not thrown, and files nothing", () => {
  const log: string[] = [];
  const run = (args: string[]) => { if (args.includes("--search")) throw new Error("HTTP 502"); return "[]"; };
  const ask = { post: () => {}, stateOf: () => "idle", now: () => NOW };
  escalateStuck([`${MERGED}: x`], run, (l: string) => log.push(l), { repoOf: declared, escalated: new Set([MERGED]), ask });
  assert.match(log.join(""), /COULD NOT ASK AGAIN \(.*\): HTTP 502/);
});
