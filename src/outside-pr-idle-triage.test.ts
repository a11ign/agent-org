// no-token: gh -- pure: `fileOutsideIdleTriage` over in-memory pull requests and the fake code host's world (the rows already filed, the rows it files); nothing here reaches `gh`, `git` or the network (A11-160, step 9)
/**
 * agent-org#1369: WITH `prs.ownerRouting` ON, AN OUTSIDE PULL REQUEST IDLE FOR 7 DAYS FILES EXACTLY ONE TRIAGE ROW, AND WAKES NO SESSION. #1325 orders such
 * a pull request for its review only, so nothing else moves it; the row is the orchestrator's to triage. A second tick, with the row already on the board,
 * files none. With the flag OFF nothing is filed and `gh` is not called at all.
 *
 * MUTATION (the row's Done-when): filing at most ONE row per tick (a `break` after the first filing) turns the two-pull-request test red, because the
 * second idle pull request then waits a tick it does not owe.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fileOutsideIdleTriage, OUTSIDE_IDLE_LABEL, OUTSIDE_IDLE_MS, outsideIdlePrs } from "./work-gate/pr-orders.ts";
import { OUTSIDE, INSIDE, reviewTrustOf, type DeclaredIdentities } from "./review-trust.ts";
import { CHAIRMAN_LOGINS } from "./work-gate/vocabulary.ts";
import { forgetActivation, messagingHost } from "./plugins/fakes/messaging-world.test.support.ts";

type Pr = Record<string, unknown>;

const NOW = Date.parse("2026-10-15T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
/** The identities the org declares, passed in so the test does not read the host: the chairman and the shared worker account are inside. */
const IDENTITIES: DeclaredIdentities = { exact: [...CHAIRMAN_LOGINS, "a11ign-ai-workers"], pattern: [] };

/** An outside pull request: a fork, opened by a stranger, last updated at `updatedAt`. */
const outsidePr = (number: number, updatedAt: string, over: Pr = {}): Pr => ({
  number, repo: "a11ign/agent-org", repoKey: "agent-org", isCrossRepository: true, author: { login: "some-stranger" }, updatedAt, ...over,
});
const IDLE = new Date(NOW - 14 * DAY).toISOString();

afterEach(() => forgetActivation());

/** The `gh` the caller is handed: the fake code host acts on its own state and never runs it, so anything that does fails the case. */
const noGh = (args: string[]): string => { throw new Error(`no gh expected, got ${args.join(" ")}`); };

/** The fake code host's world, in place: no row filed yet. `rows()` are the triage rows it holds, `calls` every operation the caller asked of the code host, with its request. */
function fakeWorld() {
  const { world, calls } = messagingHost("a11ign/agent-org");
  const rows = () => [...world.rows.values()].filter((row) => row.labels.includes(OUTSIDE_IDLE_LABEL));
  return { world, calls, rows };
}

const tick = (prs: Pr[], enabled = true) => {
  const lines: string[] = [];
  const filed = fileOutsideIdleTriage(prs, { declared: IDENTITIES, nowMs: NOW, run: noGh, log: (line) => lines.push(line), enabled });
  return { filed, lines };
};

test("the idle outside pull request files exactly one row, and a second tick files none", () => {
  const filed = fakeWorld();
  const prs = [outsidePr(7, IDLE)];
  assert.equal(tick(prs).filed, 1);
  assert.equal(filed.rows().length, 1, "one row on the first tick");
  assert.deepEqual(filed.world.labelsCreated, [OUTSIDE_IDLE_LABEL], "its label is made");
  assert.equal(filed.rows()[0].labels[0], OUTSIDE_IDLE_LABEL);
  assert.equal(tick(prs).filed, 0, "the row the first tick filed is found by its marker");
  assert.equal(filed.rows().length, 1, "the second tick creates nothing");
});

test("the row wakes no session: nothing is filed to a session, and the row is boarded in the Backlog", () => {
  const filed = fakeWorld();
  tick([outsidePr(7, IDLE)]);
  const [row] = filed.rows();
  assert.match(row.body, /woke no session/);
  assert.deepEqual([row.onBoard, row.boardStatus], [true, "Backlog"], "the row is put in the Backlog");
  assert.ok(row.labels.every((label) => !/^session:/.test(label)), `no session label wakes a session: ${row.labels.join(", ")}`);
  const allowed = ["readRowsByLabel", "ensureTriageLabel", "createRow", "boardFiledRow"];
  assert.deepEqual(filed.calls.filter((call) => !allowed.includes(call.op)), [], "it asks the code host to read the filed rows, make the label, file the row and board it, and nothing else (no assignee, no dispatch)");
});

test("with the flag OFF nothing is filed and the code host is not asked", () => {
  const filed = fakeWorld();
  const { filed: count } = tick([outsidePr(7, IDLE), outsidePr(8, IDLE)], false);
  assert.equal(count, 0);
  assert.deepEqual(filed.calls, [], "a flag-off tick reads and writes nothing");
  assert.equal(filed.world.rows.size, 0);
});

test("with the flag ON the same pull request IS filed, so the flag-off test is not an empty fixture", () => {
  const filed = fakeWorld();
  assert.equal(tick([outsidePr(7, IDLE)], true).filed, 1);
  assert.ok(filed.calls.length > 0);
});

test("two idle outside pull requests each file their own row on the first tick", () => {
  const filed = fakeWorld();
  const { filed: count } = tick([outsidePr(7, IDLE), outsidePr(8, IDLE)]);
  assert.equal(count, 2);
  assert.equal(filed.rows().length, 2);
  assert.notEqual(filed.rows()[0].body, filed.rows()[1].body);
});

test("a pull request not yet idle a week is not filed, and seven days exactly is", () => {
  const sixDays = new Date(NOW - 6 * DAY).toISOString();
  const sevenDays = new Date(NOW - OUTSIDE_IDLE_MS).toISOString();
  fakeWorld();
  assert.equal(tick([outsidePr(7, sixDays)]).filed, 0);
  assert.equal(tick([outsidePr(8, sevenDays)]).filed, 1);
});

test("inside and chairman-authored pull requests are not outside, so nothing is filed for them", () => {
  const filed = fakeWorld();
  const chairman: Pr = { number: 9, repo: "a11ign/agent-org", repoKey: "agent-org", isCrossRepository: false, author: { login: "DanBeckDev" }, updatedAt: IDLE };
  const worker: Pr = { number: 10, repo: "a11ign/agent-org", repoKey: "agent-org", isCrossRepository: false, author: { login: "a11ign-ai-workers" }, updatedAt: IDLE };
  assert.equal(tick([chairman, worker]).filed, 0);
  assert.equal(filed.rows().length, 0);
  assert.equal(reviewTrustOf(chairman, IDENTITIES), INSIDE);
});

test("a pull request whose updatedAt does not parse is not accused", () => {
  assert.deepEqual(outsideIdlePrs([outsidePr(11, "not-a-date"), outsidePr(12, "")], IDENTITIES, NOW), []);
  assert.equal(OUTSIDE, reviewTrustOf(outsidePr(11, ""), IDENTITIES));
});

test("a row closed within the same episode still counts as filed: it is not filed again", () => {
  const filed = fakeWorld();
  const prs = [outsidePr(7, IDLE)];
  tick(prs);
  filed.rows()[0].state = "CLOSED";
  assert.equal(tick(prs).filed, 0);
  assert.equal(filed.rows().length, 1);
});

test("a touch followed by another idle week is a new episode, and a new row", () => {
  const filed = fakeWorld();
  tick([outsidePr(7, IDLE)]);
  const touchedAgo = new Date(NOW - 8 * DAY).toISOString();
  assert.equal(tick([outsidePr(7, touchedAgo)]).filed, 1);
  assert.equal(filed.rows().length, 2);
});

test("a read that refuses files nothing, says so, and the next tick retries", () => {
  const filed = fakeWorld();
  filed.world.failures.set("readRowsByLabel", new Error("gh api refused"));
  const { filed: count, lines } = tick([outsidePr(7, IDLE)]);
  assert.equal(count, 0);
  assert.equal(filed.rows().length, 0, "no row is created on a read that refused");
  assert.match(lines.join(""), /could not read the triage rows.*next tick retries/);
  filed.world.failures.delete("readRowsByLabel");
  assert.equal(tick([outsidePr(7, IDLE)]).filed, 1, "CONTROL: the next tick, with the read answering, files it");
});
