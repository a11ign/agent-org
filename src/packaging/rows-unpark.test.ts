// no-token: gh -- `unpark-satisfied.ts` reaches GitHub only through the `UnparkIo` or the `run` it is given, and every one this file builds is a fake over an in-memory
// tracker, so nothing here writes a row (a11ign/agent-org#5177, under a11ign/a11ign#5177).
//
// a11ign/agent-org#5177: a parked row whose every native `blockedBy` edge has closed is un-parked on the tick, and that holds in EVERY declared tracker, not only the home one
// (agent-org#904 sat parked ~18h after its three edges closed, because the seam read the home repository alone).
//
// THE POSITIVE CONTROL for every "writes nothing" case is the first test: the SAME harness un-parks a row there, so an empty `calls` is a reading of a wired pass and not of one that
// cannot write. Each case that stays parked differs from that control by ONE fact.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyCanaryState } from "../org-health/fleet-build-incident.ts";
import { withMachineryFlag } from "../org-health.ts";
import { AUTO_UNPARK_FLAG, COMMENT_MARKER, PARKED, githubIo, readSatisfaction, unparkOtherTrackers, unparkSatisfied, withTrackerRows, type UnparkIo } from "../unpark-satisfied.ts";
import { waitTickFacts } from "../work-gate/org-health.ts";
import type { WaitFacts } from "../wait-condition.ts";

const NOW = Date.parse("2026-10-11T00:05:00Z");
const PASSED = "2026-10-11T00:00:00Z";
const FUTURE = "2026-10-14T00:00:00Z";
const CLOSED_AT = Date.parse("2026-10-08T05:00:00Z");
const HOME = "a11ign/a11ign";
const OTHER = "a11ign/agent-org";

/** A body the claim rule accepts: Region, Acceptance and Open-check each with content. */
const COMPLETE = "## What it is\n\nthe work\n\n## Region\n\n```\nsrc/thing.mjs\n```\n\n## Acceptance\n\n```bash\nnode --test src/thing.test.mjs\n```\n\n## Open-check\n\n```\n$ ls src/thing.mjs\nls: cannot access\n```\n";

/** @param {number} number @param {string} state the edge's state as GitHub lists it */
const edge = (number: number, state: "OPEN" | "CLOSED") => ({ number, state });
/** @param {number} number @param {string[]} labels @param {Record<string, any>} [more] a row as the tick's open-row read gives it */
const tickRow = (number: number, labels: string[], more: Record<string, any> = {}) => ({ number, title: `row ${number}`, labels: labels.map((name) => ({ name })), body: COMPLETE, blockedBy: { nodes: [] }, ...more });
const closedAll = [edge(900, "CLOSED"), edge(901, "CLOSED"), edge(902, "CLOSED")];

/**
 * A home tracker in memory, the way `unpark-satisfied.test.ts` builds one: `labels` is what each row carries and `calls` logs every write and read.
 * @param {Record<number, string[]>} rows
 */
function world(rows: Record<number, string[]>) {
  const labels = Object.fromEntries(Object.entries(rows).map(([n, l]) => [n, [...l]]));
  const calls: string[] = [];
  const comments: Record<number, string[]> = {};
  const io: UnparkIo = {
    readLabels: (n) => { calls.push(`readLabels ${n}`); return { labels: [...labels[n]], state: "OPEN" }; },
    setLabels: (n, set) => { calls.push(`setLabels ${n} ${set.join(",")}`); labels[n] = [...set]; },
    promote: (n) => { calls.push(`promote ${n}`); labels[n] = ["ready", ...labels[n].filter((l) => l !== "backlog")]; return { ok: true }; },
    mergedClosers: (n) => { calls.push(`mergedClosers ${n}`); return []; },
    closedAt: () => CLOSED_AT,
    comment: (n, body) => { calls.push(`comment ${n}`); (comments[n] ??= []).push(body); },
  };
  return { io, labels, calls, comments };
}

/**
 * ONE GITHUB CLI, answering for a row of ANY repository the way `gh` does: `issue view`, the label `PUT`, `issue comment`, the close time and the closing-PR
 * GraphQL read. Every argument list is kept in `calls`, so a test can say which repository each write named.
 * @param {string} repo the repository the row lives in @param {Record<number, string[]>} rows
 */
function ghFor(repo: string, rows: Record<number, string[]>) {
  const labels = Object.fromEntries(Object.entries(rows).map(([n, l]) => [n, [...l]]));
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ labels: labels[Number(args[2])].map((name) => ({ name })), state: "OPEN" });
    if (args[0] === "api" && args[2] === "PUT") {
      labels[Number(args[3].split("/")[4])] = args.filter((a) => a.startsWith("labels[]=")).map((a) => a.slice("labels[]=".length));
      return "";
    }
    if (args[0] === "api" && args[1] === "graphql") return JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } } });
    if (args[0] === "api") return "2026-10-08T05:00:00Z\n";
    if (args[0] === "issue" && args[1] === "comment") return "";
    throw new Error(`the fake ${repo} has no answer for: ${args.join(" ")}`);
  };
  return { run, labels, calls };
}

/** @param {boolean} on the flag's state, as `machinery-canary.json` holds it */
const canary = (on: boolean) => (on ? withMachineryFlag(emptyCanaryState(), { name: AUTO_UNPARK_FLAG, on: true }) : emptyCanaryState());
const NO_FACTS: WaitFacts = { items: {} };

test("(1) POSITIVE CONTROL: a parked row whose three native edges are all closed is un-parked to ready, one comment naming each edge", () => {
  const w = world({ 10: ["parked", "lane:any"] });
  const rows = [tickRow(10, ["parked", "lane:any"], { blockedBy: { nodes: closedAll } })];
  const result = unparkSatisfied({ rows, facts: NO_FACTS, now: NOW }, w.io);
  assert.deepEqual(result.unparked, [{ number: 10, to: "ready", why: null }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(w.labels[10], ["ready", "lane:any"], "parked is gone, ready is on, and the lane label is kept");
  assert.equal(w.comments[10].length, 1, "one comment per transition");
  assert.ok(w.comments[10][0].startsWith(COMMENT_MARKER));
  for (const n of [900, 901, 902]) assert.match(w.comments[10][0], new RegExp(`blockedBy #${n} \\(closed\\)\` -- true since 2026-10-08T05:00:00\\.000Z`), `#${n} is named with its close`);
});

test("(2) one OPEN edge among the three keeps the row parked and writes nothing; its twin with that edge closed is un-parked", () => {
  const open = world({ 11: ["parked"] });
  const rows = [tickRow(11, ["parked"], { blockedBy: { nodes: [edge(900, "CLOSED"), edge(901, "OPEN"), edge(902, "CLOSED")] } })];
  assert.deepEqual(unparkSatisfied({ rows, facts: NO_FACTS, now: NOW }, open.io), { unparked: [], unread: [], errors: [] });
  assert.deepEqual(open.calls, [], "no read, no write, no comment for a row that is still waiting");
  assert.match(JSON.stringify(readSatisfaction(rows[0], NO_FACTS, NOW)), /still waiting on blockedBy/);

  const twin = world({ 11: ["parked"] });
  const closed = [tickRow(11, ["parked"], { blockedBy: { nodes: closedAll } })];
  assert.equal(unparkSatisfied({ rows: closed, facts: NO_FACTS, now: NOW }, twin.io).unparked.length, 1, "the twin differs by the one edge and is un-parked");
});

test("(3) a future Not-before keeps the row parked, even with every edge closed; once it passes the same row is un-parked", () => {
  const w = world({ 12: ["parked"] });
  const future = [tickRow(12, ["parked"], { body: `${COMPLETE}\nNot-before: ${FUTURE}\n`, blockedBy: { nodes: closedAll } })];
  assert.deepEqual(unparkSatisfied({ rows: future, facts: NO_FACTS, now: NOW }, w.io).unparked, []);
  assert.deepEqual(w.calls, [], "the date has not come, so nothing is read or written");
  assert.match(JSON.stringify(readSatisfaction(future[0], NO_FACTS, NOW)), /still waiting on Not-before/);

  const passed = [tickRow(12, ["parked"], { body: `${COMPLETE}\nNot-before: ${PASSED}\n`, blockedBy: { nodes: closedAll } })];
  assert.equal(unparkSatisfied({ rows: passed, facts: NO_FACTS, now: NOW }, w.io).unparked.length, 1);
});

test("(4) a row carrying needs:chairman stays parked even with every edge closed, and nothing is written for it", () => {
  const w = world({ 13: ["parked", "needs:chairman"] });
  const rows = [tickRow(13, ["parked", "needs:chairman"], { blockedBy: { nodes: closedAll } })];
  const result = unparkSatisfied({ rows, facts: NO_FACTS, now: NOW }, w.io);
  assert.deepEqual([result.unparked, result.errors, w.calls], [[], [], []]);
  assert.match(JSON.stringify(readSatisfaction(rows[0], NO_FACTS, NOW)), /needs:chairman/);
});

test("(5) a Waiting-for on another repository is answered by THAT repository's fact, never the home one: an unread one keeps the row parked", () => {
  // `Waiting-for: closed #902` on an agent-org row names agent-org#902. The home facts hold a `#902` that is closed; that must not answer for it.
  const row = tickRow(14, ["parked"], { body: `${COMPLETE}\nWaiting-for: closed #902\n`, repoKey: OTHER, repo: OTHER, blockedBy: { nodes: closedAll } });
  const homeFacts: WaitFacts = { items: { "#902": { state: "closed", labels: [], resolvedAt: CLOSED_AT, changedAt: CLOSED_AT } } };
  const verdict = readSatisfaction(row, homeFacts, NOW, () => CLOSED_AT);
  assert.equal(verdict.verdict, "unread", "the home #902 is not agent-org#902, so the condition is unknown");
});

test("(6) the other tracker's pass is OFF without `rows.autoUnpark`: a parked agent-org row with every edge closed is not read or written", () => {
  const gh = ghFor(OTHER, { 904: ["parked", "lane:any"] });
  const log: string[] = [];
  unparkOtherTrackers({ state: canary(false), scopes: [{ repo: OTHER, rows: [tickRow(904, ["parked", "lane:any"], { blockedBy: { nodes: closedAll } })] }], facts: NO_FACTS, now: NOW, run: gh.run, log: (line) => log.push(line) });
  assert.deepEqual(gh.calls, [], "flag off: nothing is asked of GitHub about the row");
  assert.deepEqual(gh.labels[904], ["parked", "lane:any"]);
});

test("(7) with `rows.autoUnpark` ON, an agent-org #904-shaped row is un-parked IN ITS OWN REPOSITORY, and promotion is refused there, routed to product-manager", () => {
  const gh = ghFor(OTHER, { 904: ["parked", "lane:any"] });
  const log: string[] = [];
  unparkOtherTrackers({ state: canary(true), scopes: [{ repo: OTHER, rows: [tickRow(904, ["parked", "lane:any"], { blockedBy: { nodes: closedAll } })] }], facts: NO_FACTS, now: NOW, run: gh.run, log: (line) => log.push(line) });

  const writes = gh.calls.filter((args) => args[0] === "api" && args[2] === "PUT");
  assert.deepEqual(writes.map((args) => args[3]), [`repos/${OTHER}/issues/904/labels`, `repos/${OTHER}/issues/904/labels`], "both label writes (backlog first, then the routed set) name agent-org");
  assert.deepEqual(gh.labels[904], ["backlog", "answer:product-manager", "lane:any"], "parked is gone; the refused promotion is routed, not left plain backlog");
  assert.ok(gh.calls.some((args) => args[0] === "issue" && args[1] === "comment" && args[2] === "904" && args[3] === "--repo" && args[4] === OTHER), "the comment names agent-org");
  assert.ok(!gh.calls.filter((args) => args[1] !== "comment").some((args) => args.some((a) => a.includes(HOME))), "no read or write names the home repository (the comment's body may say so: it names the home tracker)");
  assert.match(log.join(""), /DID unpark #904 -> backlog \(answer:product-manager: `row-file --promote` acts only on a11ign\/a11ign, the home tracker/);
});

test("(8) the other tracker's read is refused: a row whose facts cannot be read is named as unread and nothing is written", () => {
  const gh = ghFor(OTHER, { 905: ["parked"] });
  const log: string[] = [];
  const row = tickRow(905, ["parked"], { body: `${COMPLETE}\nWaiting-for: closed #950\n`, blockedBy: { nodes: closedAll } });
  unparkOtherTrackers({ state: canary(true), scopes: [{ repo: OTHER, rows: [row] }], facts: NO_FACTS, now: NOW, run: gh.run, log: (line) => log.push(line) });
  assert.deepEqual(gh.calls.filter((args) => args[0] === "api" && args[2] === "PUT"), []);
  assert.match(log.join(""), /agent-org#905 is parked and NOT un-parked/);
});

test("the other tracker's GitHub writes name that tracker, and a promotion from it is refused without a call", () => {
  const gh = ghFor(OTHER, {});
  const io = githubIo(gh.run, { repo: OTHER });
  io.comment(7, "x");
  io.setLabels(7, ["ready"]);
  assert.deepEqual(gh.calls.map((args) => args.join(" ").includes(HOME)), [false, false]);
  assert.equal(io.promote(7).ok, false, "promotion from a row of another tracker is refused");
});

const MERGED_1116 = JSON.stringify({ state: "closed", closed_at: "2026-10-08T05:00:00Z", updated_at: "2026-10-08T05:00:00Z", merged_at: "2026-10-08T05:00:00Z", labels: [] });
const NO_RELEASES = { distTags: () => null, tagExists: () => null };

test("(9) the reviewer's path: a non-home row's `Waiting-for: merged #1116` is read against ITS repository, so the satisfied wait un-parks it; the home's #1116 cannot answer for it", () => {
  const waiting = tickRow(904, ["parked", "lane:any"], { body: `${COMPLETE}\nWaiting-for: merged #1116\n`, repoKey: "agent-org", repo: OTHER, blockedBy: { nodes: closedAll } });
  const otherScopes = [{ scope: { tracker: { repo: OTHER } }, read: { openRows: [waiting] } }];
  const reads: string[] = [];
  const run = (args: string[]): string => {
    reads.push(args[1]);
    if (args[1] === `repos/${OTHER}/issues/1116`) return MERGED_1116;
    throw new Error(`the fake has no answer for: ${args.join(" ")}`);
  };

  // THE CONTROL: the wait read as the tick made it before this change, which held the home rows alone. The other tracker's row is never in it, so its reference is unknown.
  const homeOnly = waitTickFacts({ prsRead: [], openRowsRead: [], now: NOW, run, readers: NO_RELEASES });
  assert.equal(readSatisfaction(waiting, homeOnly!.facts, NOW)!.verdict, "unread", "the row's own #1116 is not in the facts, so its satisfied wait cannot un-park it");

  // The flag OFF keeps the home-only list, so the facts are the ones the tick always read.
  assert.deepEqual(withTrackerRows([], otherScopes, canary(false)), [], "flag off: the other tracker's rows are not added to the wait read");

  // The change: the other tracker's rows are in the list with their repository, so `Waiting-for: merged #1116` is read as agent-org#1116.
  const facts = waitTickFacts({ prsRead: [], openRowsRead: withTrackerRows([], otherScopes, canary(true)), now: NOW, run, readers: NO_RELEASES });
  assert.deepEqual(reads, [`repos/${OTHER}/issues/1116`], "the reference is read ONCE, against agent-org, never against the home repository");
  assert.equal(facts!.facts.items[`${OTHER}#1116`]?.state, "merged", "the fact is keyed by its repository");

  const gh = ghFor(OTHER, { 904: ["parked", "lane:any"] });
  const log: string[] = [];
  unparkOtherTrackers({ state: canary(true), scopes: [{ repo: OTHER, rows: [waiting] }], facts: facts!.facts, now: NOW, run: gh.run, log: (line) => log.push(line) });
  assert.ok(!gh.labels[904].includes(PARKED), "the satisfied wait lets the row be un-parked in its own repository");
  assert.equal(readSatisfaction(waiting, facts!.facts, NOW)!.verdict, "satisfied", "the same row is satisfied once the reference is read against its own repository");
});

const CLOSED_902 = JSON.stringify({ state: "closed", closed_at: "2026-10-08T05:00:00Z", updated_at: "2026-10-08T05:00:00Z", merged_at: null, labels: [] });

test("(10) #905's shape: a parked agent-org row whose one native edge has closed, with `Waiting-for: closed #902` and `Waits-on-done-when: 902.1`, is un-parked through the full read", () => {
  const row = tickRow(905, ["parked", "lane:any"], { body: `${COMPLETE}\nWaiting-for: closed #902\nWaits-on-done-when: 902.1\n`, repoKey: OTHER, repo: OTHER, blockedBy: { nodes: [edge(902, "CLOSED")] } });
  const otherScopes = [{ scope: { tracker: { repo: OTHER } }, read: { openRows: [row] } }];
  const run = (args: string[]): string => {
    if (args[1] === `repos/${OTHER}/issues/902`) return CLOSED_902;
    throw new Error(`the fake has no answer for: ${args.join(" ")}`);
  };
  const facts = waitTickFacts({ prsRead: [], openRowsRead: withTrackerRows([], otherScopes, canary(true)), now: NOW, run, readers: NO_RELEASES });
  assert.equal(readSatisfaction(row, facts!.facts, NOW, () => CLOSED_AT)!.verdict, "satisfied", "the reference is read against agent-org, and `Waits-on-done-when` is not a standing wait");

  const gh = ghFor(OTHER, { 905: ["parked", "lane:any"] });
  unparkOtherTrackers({ state: canary(true), scopes: [{ repo: OTHER, rows: [row] }], facts: facts!.facts, now: NOW, run: gh.run, log: () => undefined });
  assert.ok(!gh.labels[905].includes(PARKED), "parked is lifted in agent-org");
});

test("(11) a refused other-tracker read (`openRows: null`, which `readLanes` gives for a failed `gh` list) is NAMED in the log and skipped; it is not dropped silently", () => {
  const gh = ghFor(OTHER, { 905: ["parked"] });
  const log: string[] = [];
  unparkOtherTrackers({ state: canary(true), scopes: [{ repo: OTHER, rows: null }], facts: NO_FACTS, now: NOW, run: gh.run, log: (line) => log.push(line) });
  assert.deepEqual(gh.calls.filter((args) => args[0] === "api" && args[2] === "PUT"), []);
  assert.match(log.join(""), /agent-org rows were not read/, "a null read names the tracker, as the pass's own doc promises");
});
