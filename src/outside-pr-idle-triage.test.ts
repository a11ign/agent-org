// no-token: gh -- pure: `fileOutsideIdleTriage` over in-memory pull requests, an injected `run` that records the `gh` calls it would make, and an injected reader of the rows already filed; nothing here reaches `gh`, `git` or the network
/**
 * agent-org#1369: WITH `prs.ownerRouting` ON, AN OUTSIDE PULL REQUEST IDLE FOR 7 DAYS FILES EXACTLY ONE TRIAGE ROW, AND WAKES NO SESSION. #1325 orders such
 * a pull request for its review only, so nothing else moves it; the row is the orchestrator's to triage. A second tick, with the row already on the board,
 * files none. With the flag OFF nothing is filed and `gh` is not called at all.
 *
 * MUTATION (the row's Done-when): filing at most ONE row per tick (a `break` after the first filing) turns the two-pull-request test red, because the
 * second idle pull request then waits a tick it does not owe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileOutsideIdleTriage, OUTSIDE_IDLE_LABEL, OUTSIDE_IDLE_MS, outsideIdlePrs } from "./work-gate/pr-orders.ts";
import { OUTSIDE, INSIDE, reviewTrustOf, type DeclaredIdentities } from "./review-trust.ts";
import { CHAIRMAN_LOGINS } from "./work-gate/vocabulary.ts";

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

/** A recording `gh`: `issue create` takes the next number and keeps its body as an OPEN row; every other call answers nothing. */
function fakeGh(rows: { number: number; body: string; state: "OPEN" | "CLOSED" }[] = []) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create") {
      const number = 900 + rows.length;
      rows.push({ number, body: args[args.indexOf("--body") + 1], state: "OPEN" });
      return `https://github.com/a11ign/agent-org/issues/${number}\n`;
    }
    // the board read: a row on no project yet, so the filing boards it
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify({ data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    }
    return "";
  };
  const readFiled = () => rows.map((row) => row.body);
  const created = () => calls.filter((args) => args[0] === "issue" && args[1] === "create");
  return { calls, rows, run, readFiled, created };
}

const tick = (prs: Pr[], gh: ReturnType<typeof fakeGh>, enabled = true) => {
  const lines: string[] = [];
  const filed = fileOutsideIdleTriage(prs, { declared: IDENTITIES, nowMs: NOW, run: gh.run, log: (line) => lines.push(line), enabled, readFiled: gh.readFiled });
  return { filed, lines };
};

test("the idle outside pull request files exactly one row, and a second tick files none", () => {
  const gh = fakeGh();
  const prs = [outsidePr(7, IDLE)];
  assert.equal(tick(prs, gh).filed, 1);
  assert.equal(gh.created().length, 1, "one issue create on the first tick");
  const create = gh.created()[0];
  assert.equal(create[create.indexOf("--label") + 1], OUTSIDE_IDLE_LABEL);
  assert.equal(tick(prs, gh).filed, 0, "the row the first tick filed is found by its marker");
  assert.equal(gh.created().length, 1, "the second tick creates nothing");
});

test("the row wakes no session: nothing is filed to a session, and the row is boarded in the Backlog", () => {
  const gh = fakeGh();
  tick([outsidePr(7, IDLE)], gh);
  const body = gh.rows[0].body;
  assert.match(body, /woke no session/);
  assert.ok(gh.calls.some((args) => args.includes("project") && args.includes("item-edit") && args.includes("Backlog")), "the row is put in the Backlog");
  assert.ok(gh.calls.every((args) => !args.some((arg) => /session:|--assignee|workflow|dispatch/.test(arg))), "no assignee, label or workflow dispatch wakes a session");
});

test("with the flag OFF nothing is filed and gh is not called", () => {
  const gh = fakeGh();
  const { filed } = tick([outsidePr(7, IDLE), outsidePr(8, IDLE)], gh, false);
  assert.equal(filed, 0);
  assert.equal(gh.calls.length, 0, "a flag-off tick reads and writes nothing");
});

test("with the flag ON the same pull request IS filed, so the flag-off test is not an empty fixture", () => {
  const gh = fakeGh();
  assert.equal(tick([outsidePr(7, IDLE)], gh, true).filed, 1);
});

test("two idle outside pull requests each file their own row on the first tick", () => {
  const gh = fakeGh();
  const { filed } = tick([outsidePr(7, IDLE), outsidePr(8, IDLE)], gh);
  assert.equal(filed, 2);
  assert.equal(gh.created().length, 2);
  assert.notEqual(gh.rows[0].body, gh.rows[1].body);
});

test("a pull request not yet idle a week is not filed, and seven days exactly is", () => {
  const sixDays = new Date(NOW - 6 * DAY).toISOString();
  const sevenDays = new Date(NOW - OUTSIDE_IDLE_MS).toISOString();
  const gh = fakeGh();
  assert.equal(tick([outsidePr(7, sixDays)], gh).filed, 0);
  assert.equal(tick([outsidePr(8, sevenDays)], gh).filed, 1);
});

test("inside and chairman-authored pull requests are not outside, so nothing is filed for them", () => {
  const gh = fakeGh();
  const chairman: Pr = { number: 9, repo: "a11ign/agent-org", repoKey: "agent-org", isCrossRepository: false, author: { login: "DanBeckDev" }, updatedAt: IDLE };
  const worker: Pr = { number: 10, repo: "a11ign/agent-org", repoKey: "agent-org", isCrossRepository: false, author: { login: "a11ign-ai-workers" }, updatedAt: IDLE };
  assert.equal(tick([chairman, worker], gh).filed, 0);
  assert.equal(reviewTrustOf(chairman, IDENTITIES), INSIDE);
});

test("a pull request whose updatedAt does not parse is not accused", () => {
  assert.deepEqual(outsideIdlePrs([outsidePr(11, "not-a-date"), outsidePr(12, "")], IDENTITIES, NOW), []);
  assert.equal(OUTSIDE, reviewTrustOf(outsidePr(11, ""), IDENTITIES));
});

test("a row closed within the same episode still counts as filed: it is not filed again", () => {
  const gh = fakeGh();
  const prs = [outsidePr(7, IDLE)];
  tick(prs, gh);
  gh.rows[0].state = "CLOSED";
  assert.equal(tick(prs, gh).filed, 0);
  assert.equal(gh.created().length, 1);
});

test("a touch followed by another idle week is a new episode, and a new row", () => {
  const gh = fakeGh();
  tick([outsidePr(7, IDLE)], gh);
  const touchedAgo = new Date(NOW - 8 * DAY).toISOString();
  assert.equal(tick([outsidePr(7, touchedAgo)], gh).filed, 1);
  assert.equal(gh.created().length, 2);
});

test("a read that refuses files nothing, says so, and the next tick retries", () => {
  const gh = fakeGh();
  const lines: string[] = [];
  const filed = fileOutsideIdleTriage([outsidePr(7, IDLE)], {
    declared: IDENTITIES, nowMs: NOW, run: gh.run, log: (line) => lines.push(line), enabled: true,
    readFiled: () => { throw new Error("gh api refused"); },
  });
  assert.equal(filed, 0);
  assert.equal(gh.created().length, 0, "no row is created on a read that refused");
  assert.match(lines.join(""), /could not read the triage rows.*next tick retries/);
});
