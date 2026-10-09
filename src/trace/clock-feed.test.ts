// a11ign/a11ign#3517 (#3494's done-when 5): the outcome clock's "how long" is the trace store's. Fixtures only: nothing here reaches GitHub, and `gh` is an injected table.
// no-token: gh -- every `gh api` answer below is a fixture
/**
 * ONE SET OF GITHUB FACTS, TWO READERS. Each pull request and row below is written ONCE (`ITEMS`) and rendered into the two shapes GitHub gives the two readers: the
 * REST shape the store ingests (`issues/{n}`, `issues/{n}/timeline`) and the `gh pr list` / `gh issue list --json` shape the gate hands the outcome clock. The test then
 * asks the clock for its figure through the gate's own facts (`overdueFacts` into `overdueReading`) and the feed for its figure from the store's records, and holds the
 * two equal -- the `since` the clock subtracts, and the very line it states ("open 2.2 h") when it is fed the store's `since` instead.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT: that the two code paths read the same GitHub fields for the same records, so the day one of them reads another (a createdAt
 * that moves to the head's date, a claim record read as the oldest instead of the newest) this goes RED naming both numbers. It does not prove the clock READS the
 * store at run time; it does not, and `clock-feed.ts` says why.
 *
 * POSITIVE CONTROLS, each below and each RED against its mutation: `same` is RED with both numbers when they differ; a feed that read its own timestamps (a decoy a
 * second off the store's) is caught by it; and the feed ignores everything but the store's records, so a decoy beside them moves nothing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { sandboxGitEnv } from "../lib/git-env.mjs";
import { clockFeedOf, openMsOf } from "./clock-feed.ts";
import { readGithubEvents } from "./github-events.mjs";

// The project this file runs against is the recorded one `org-health.test.ts` explains (#3233): the host file is set FIRST and the tool imported AFTER it.
const PROJECT_SCRATCH = mkdtempSync(join(tmpdir(), "clock-feed-project-"));
after(() => rmSync(PROJECT_SCRATCH, { recursive: true, force: true }));
const PROJECT = join(PROJECT_SCRATCH, "project");
cpSync(fileURLToPath(new URL("../packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(PROJECT_SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: PROJECT_SCRATCH, binDir: join(PROJECT_SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(PROJECT_SCRATCH, "workers"), leads: join(PROJECT_SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
execFileSync("git", ["init", "--quiet"], { cwd: PROJECT, env: sandboxGitEnv() });
process.chdir(PROJECT);

const { overdueReading } = await import("../org-health.ts");
const { overdueFacts } = await import("../work-gate/org-health.mjs");
const { claimRecordComment } = await import("../row-claim.ts");
const { mergedStats, median } = await import("../org-retro.ts");
const { agedBacklogOrders } = await import("../work-gate.ts");

const REPO = "a11ign/a11ign";
const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-10-04T16:00:00Z");
const iso = (ms: string|number|Date|undefined) => new Date(ms).toISOString();
const ago = (minutes: number) => NOW - minutes * MINUTE_MS;
const WORKER = "a11ign-ai-workers";
const label = (...names: string[]) => names.map((name) => ({ name }));

/** A claim record at `at`: `released` is the release a holder writes on its way out. */
const claim = (session: string, at: number, released = false) => ({ at, released, session });

/**
 * Every item, once. `claims` oldest first; `closedAt` is a merge for a pull request and a close for a row. The open ones are past the clock's bound (100 min a pull
 * request, 135 a row) so the clock NAMES them and states a figure; the stopped ones are not on the clock at all, and are there for the store's own figure.
 */
const ITEMS = [
  { kind: "pr", number: 9001, createdAt: ago(110) },
  { kind: "pr", number: 9002, createdAt: ago(130) },
  { kind: "pr", number: 9003, createdAt: ago(50), closedAt: ago(20) },
  { kind: "pr", number: 9004, createdAt: ago(200), closedAt: ago(120) },
  { kind: "pr", number: 9005, createdAt: ago(100), closedAt: ago(40) },
  { kind: "row", number: 9101, createdAt: ago(30 * 60), claims: [claim("worker-9101", ago(150))] },
  { kind: "row", number: 9102, createdAt: ago(30 * 60), claims: [claim("worker-9102", ago(300)), claim("worker-9102", ago(250), true), claim("worker-9102", ago(140))] },
  { kind: "row", number: 9103, createdAt: ago(30 * 60), claims: [claim("worker-9103", ago(200)), claim("worker-9103", ago(150), true)] },
  { kind: "row", number: 9104, createdAt: ago(30 * 60), claims: [claim("worker-9104", ago(100))], closedAt: ago(10) },
];
const open = (item: { kind: string; number: number; createdAt: number; closedAt?: undefined; claims?: undefined; }|{ kind: string; number: number; createdAt: number; closedAt: number; claims?: undefined; }|{ kind: string; number: number; createdAt: number; claims: { at: any; released: boolean; session: any; }[]; closedAt?: undefined; }|{ kind: string; number: number; createdAt: number; claims: { at: any; released: boolean; session: any; }[]; closedAt: number; }) => item.closedAt === undefined;

const bodyOf = ({ session, released }) => claimRecordComment({ session, branch: `agent/x-${session}`, worktree: `../wt-${session}`, nothing: null, released });

/** The REST answers the store's reader asks for, one item at a time. */
function ghFor(items: any[]) {
  return (args: (string|string[])[]) => {
    const [, number, rest] = /^repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/(\d+)(\/timeline)?/.exec(args[0]) ?? [];
    const item = items.find((candidate: { number: any; }) => String(candidate.number) === number);
    assert.ok(item, `a fixture read for an item this test does not hold: ${args[0]}`);
    // A pull request's ISSUE record reads a second after its own, as #3575's did (measured 2026-10-04): the store must ask `pulls/{n}`, which is what `pr list` reads.
    const lateIssueRecord = item.kind === "pr" && args[0].includes("/issues/") ? 1000 : 0;
    if (!rest) return { created_at: iso(item.createdAt + lateIssueRecord), user: { login: WORKER } };
    const comments = (item.claims ?? []).map((record: string|any[], index: number) => ({ id: item.number * 100 + index, event: "commented", created_at: iso(record.at), body: bodyOf(record),
      user: { login: WORKER } }));
    const closing = item.closedAt === undefined ? [] : [{ id: item.number * 100 + 50, event: item.kind === "pr" ? "merged" : "closed", created_at: iso(item.closedAt),
      actor: { login: WORKER } }];
    return [...comments, ...closing];
  };
}

/** What the store holds for every item: the real reader, over the REST fixtures. */
const STORE = readGithubEvents({ rows: ITEMS.filter((i) => i.kind === "row").map((i) => i.number), prs: ITEMS.filter((i) => i.kind === "pr").map((i) => i.number),
  repo: REPO, gh: ghFor(ITEMS) });
const storeClock = (item: { kind: string; number: number; createdAt: number; closedAt?: undefined; claims?: undefined; }|{ kind: string; number: number; createdAt: number; closedAt: number; claims?: undefined; }|{ kind: string; number: number; createdAt: number; claims: { at: any; released: boolean; session: any; }[]; closedAt?: undefined; }|{ kind: string; number: number; createdAt: number; claims: { at: any; released: boolean; session: any; }[]; closedAt: number; }|undefined) => clockFeedOf(STORE, { repo: REPO, kind: item.kind, number: item.number });

/** What the gate hands the clock for the open items, in `gh pr list` / `gh issue list --json` shape. */
function gateFacts() {
  const prsRead = ITEMS.filter((i) => i.kind === "pr" && open(i)).map((i) => ({ number: i.number, createdAt: iso(i.createdAt), isDraft: false, statusCheckRollup: [],
    headRefOid: "0123456789abcdef0123456789abcdef01234567", labels: label("session:worker-9"), reviews: [], comments: [] }));
  const rows = ITEMS.filter((i) => i.kind === "row" && open(i));
  const openRowsRead = rows.map((i) => ({ number: i.number, labels: label("in-progress", `session:worker-${i.number}`) }));
  const claimedComments = rows.map((i) => ({ number: i.number, comments: i.claims.map((record) => ({ body: bodyOf(record), createdAt: iso(record.at),
    author: { login: WORKER } })) }));
  return overdueFacts({ prsRead, openRowsRead, claimedComments, required: ["gate"], now: NOW });
}

/** The comparison this file exists for: RED with BOTH numbers named when the clock's figure is not the store's. */
function same(clockMs: number|null, storeMs: number|null, what: string) {
  if (clockMs !== storeMs) throw new Error(`${what}: the outcome clock says ${clockMs} and the trace store says ${storeMs}`);
}

/** The "open ..." figure the clock states for an item in its reading. @returns {string | undefined} */
const statedOpen = (reading: { signal?: string; status?: "tripped"|"clear"|"unknown"; detail: any; firstTrippedAt?: number|null|undefined; discriminator?: string|undefined; prompt?: string|undefined; }, number: number): string | undefined => new RegExp(`#${number} \\((?:PR|row), [^,]+, open ([^,]+),`).exec(reading.detail ?? "")?.[1];

test("the clock's `since` is the store's, for every item on the clock -- a pull request's opening and a row's NEWEST claim -- and an unknown is unknown in both", () => {
  const facts = gateFacts();
  const named = facts.items.map((item) => item.number).sort();
  assert.deepEqual(named, [9001, 9002, 9101, 9102, 9103], "POSITIVE CONTROL: the clock is on the five open items, a release-ended claim included, so the loop below has something to compare");
  for (const item of facts.items) {
    const fromStore = storeClock(ITEMS.find((candidate) => candidate.number === item.number)).since;
    if (item.since === null || fromStore === null) assert.equal(item.since, fromStore, `#${item.number}: unknown on one side and a time on the other`);
    else same(item.since, fromStore, `#${item.number} since`);
  }
  assert.equal(facts.items.find((item) => item.number === 9103).since, null, "a row whose newest record is a RELEASE has no age on the clock");
  assert.equal(storeClock(ITEMS.find((i) => i.number === 9103)).since, null, "and none in the store");
  assert.equal(storeClock(ITEMS.find((i) => i.number === 9102)).since, ago(140), "the NEWEST claim, the third record, not the first");
});

test("the line the clock STATES is the same line when it is fed the store's `since`, so the figure a reader sees is the store's", () => {
  const facts = gateFacts();
  const stated = overdueReading({ now: NOW, ...facts });
  const fromStore = overdueReading({ now: NOW, items: facts.items.map((item) => ({ ...item, since: storeClock(ITEMS.find((i) => i.number === item.number)).since })),
    unread: facts.unread });
  assert.equal(stated.status, "tripped", "POSITIVE CONTROL: the clock names something, so there is a figure to compare");
  for (const number of [9001, 9002, 9101, 9102]) {
    assert.ok(statedOpen(stated, number), `#${number} is named, with a figure`);
    assert.equal(statedOpen(stated, number), statedOpen(fromStore, number), `#${number}: the clock's own figure against the figure from the store`);
  }
  assert.equal(stated.detail, fromStore.detail, "the whole reading is the same line");
});

test("a merged pull request and a closed row have the store's wall-clock, which does not move with `now`", () => {
  const merged = storeClock(ITEMS.find((i) => i.number === 9003));
  assert.deepEqual(merged, { bornAt: ago(50), since: ago(50), stoppedAt: ago(20) });
  assert.equal(openMsOf(merged, NOW), 30 * MINUTE_MS);
  assert.equal(openMsOf(merged, NOW + 1000 * MINUTE_MS), 30 * MINUTE_MS, "a stopped clock is not a function of the time it is asked");
  const closed = storeClock(ITEMS.find((i) => i.number === 9104));
  assert.equal(openMsOf(closed, NOW), 90 * MINUTE_MS, "a row's clock runs from its newest claim to its close");
  const running = storeClock(ITEMS.find((i) => i.number === 9001));
  assert.equal(running.stoppedAt, null);
  assert.equal(openMsOf(running, NOW), 110 * MINUTE_MS, "a running one is the time since it opened");
  assert.equal(openMsOf(storeClock(ITEMS.find((i) => i.number === 9103)), NOW), null, "no age is null, never zero");
});

test("RED: a clock figure that differs from the store's fails with BOTH numbers named", () => {
  same(5, 5, "control"); // the comparison is quiet on agreement; the quiet case is the two tests above
  assert.throws(() => same(110 * MINUTE_MS, 110 * MINUTE_MS + 1000, "#9001 since"), /#9001 since: the outcome clock says 6600000 and the trace store says 6601000/);
});

test("RED: a feed that read its OWN timestamps rather than the store's is caught, and the real feed follows the store", () => {
  const item = ITEMS.find((i) => i.number === 9001);
  const decoy = { ...item, createdAt: item.createdAt + 1000 };
  const ownStopwatch = Date.parse(iso(decoy.createdAt));
  assert.throws(() => same(ownStopwatch, storeClock(item).since, "#9001 since"), /the outcome clock says \d+ and the trace store says \d+/);
  const decoyed = readGithubEvents({ rows: [], prs: [9001], repo: REPO, gh: ghFor([decoy]) });
  assert.equal(clockFeedOf(decoyed, { repo: REPO, kind: "pr", number: 9001 }).since, decoy.createdAt, "the feed follows the STORE: move the store's record and it moves");
});

test("a record of another repository with the same number dates nothing here, and an item the store does not hold has no clock", () => {
  const elsewhere = readGithubEvents({ rows: [], prs: [9001], repo: "someone/else", gh: ghFor([{ ...ITEMS[0], createdAt: ago(10) }]) });
  assert.equal(clockFeedOf([...STORE, ...elsewhere], { repo: REPO, kind: "pr", number: 9001 }).since, ago(110));
  assert.equal(clockFeedOf(elsewhere, { repo: REPO, kind: "pr", number: 9001 }).since, null, "POSITIVE CONTROL: the other repository's records alone date nothing for this one");
  assert.deepEqual(clockFeedOf([], { repo: REPO, kind: "row", number: 1 }), { bornAt: null, since: null, stoppedAt: null });
});

// --- THE OTHER FIGURES IN #928'S READINGS THAT COUNT A ROW'S OR PULL REQUEST'S OWN TIME, joined the same way (the audit is in the pull request) ---------------------------

test("#928's `median open-to-merge` (`org-retro.mjs` `mergedStats`) is the median of the store's wall-clock for the same pull requests", () => {
  const mergedPrs = ITEMS.filter((i) => i.kind === "pr" && !open(i));
  const read = mergedStats(mergedPrs.map((i) => ({ number: i.number, createdAt: iso(i.createdAt), mergedAt: iso(i.closedAt) })), { since: ago(1000), until: NOW });
  assert.equal(read.count, 3, "POSITIVE CONTROL: three merged pull requests, so there is a median to compare");
  const fromStore = median(mergedPrs.map((i) => openMsOf(storeClock(i), NOW) / MINUTE_MS));
  same(read.medianMinutes, fromStore, "median open-to-merge (minutes)");
  assert.equal(read.medianMinutes, 60, "the middle of 30, 60 and 80");
});

test("#928's `HAS BEEN IN BACKLOG` age (`agedBacklogOrders`) states the same age when the row's filing time is the store's", () => {
  const item = ITEMS.find((i) => i.number === 9101);
  const row = { number: item.number, createdAt: iso(item.createdAt), title: "t", repoKey: null };
  const fromGate = agedBacklogOrders([row], NOW);
  assert.equal(fromGate.length, 1, "POSITIVE CONTROL: a 30-hour row is named, so there is a figure to compare");
  const filed = storeClock(item).bornAt;
  assert.equal(filed, item.createdAt, "the store's `filed` record is the row's `createdAt`");
  const fromStore = agedBacklogOrders([{ ...row, createdAt: iso(filed) }], NOW);
  assert.equal(fromGate[0].prompt, fromStore[0].prompt);
});
