// no-token: gh -- no `gh`, `herdr` or `git` is run; the rows, comments, listing and clock are fixtures (the tracker's claimed rows are the fake code host's world, A11-160 step 9), and the only files written are a temporary directory's (a11ign/agent-org#747)
// agent-org#747: THE STALL NUDGE REACHES EVERY DECLARED TRACKER'S CLAIMED ROWS. The gate's stalled-claim pass read the HOME tracker's claimed rows only, so no holder of an
// `a11ign/agent-org` row was ever nudged: 0 of its holders were in `claim-stalls.json` while all of them sat idle.
//
// EVERY "NOTHING IS ORDERED" ASSERTION HAS A TWIN: the same fixture with ONE thing changed that IS ordered, so a pass that never fires turns the twins red and one that
// always fires turns the controls red.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { claimStallTick, claimStallsNow } from "./work-gate/claim-stall-tick.ts";
import { claimStallsWithFacts, otherTrackerClaims } from "./work-gate/tick.ts";
import { readClaimedRowComments } from "./work-gate/reads.ts";
import { readOtherScopes } from "./work-gate.ts";
import { type Scope } from "./work-gate/vocabulary.ts";
import type { TrackerClaims } from "./work-gate/claim-stall-tick.ts";
import { claimRecordComment } from "./row-claim.ts";
import { STALL_INTERVAL_MS } from "./claim-stall/stall-causes-and-claim-readings.ts";
import { STOPPED_CLAIMANT_MINUTES } from "./idle-claimant.ts";
import { ledgerLine } from "./wake/session-endings.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

const MIN = 60_000;
const T0 = Date.parse("2026-10-11T09:00:00Z");
const M = STOPPED_CLAIMANT_MINUTES;
const STANDING = [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }];
const listing = (workers: Record<string, string>) => [...STANDING, ...Object.entries(workers).map(([label, status]) => ({ label, status }))];
const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };

/** The claim record exactly as `row-claim.ts` writes it, made `minutesBefore` T0 (young by default, so the no-progress clock is never the cause of a nudge). */
const claimed = (row: number, session: string, { minutesBefore = 20 } = {}) => ({ number: row, comments: [{
  body: claimRecordComment({ session, branch: `agent/x-${row}`, worktree: `../wt-${row}` }),
  createdAt: new Date(T0 - minutesBefore * MIN).toISOString(), author: { login: "a11ign-ai-workers" } }] });
const rowOf = (number: number, session: string, { claim = true } = {}) => ({ number, title: `row ${number}`, body: "", blockedBy: { nodes: [] },
  labels: [...(claim ? ["in-progress"] : []), `session:${session}`, "started"].map((name) => ({ name })) });

type Order = { session: string; cause: string; subject: string; causeKey: string; prompt: string; release?: { why: string; row: number; tracker?: string } };
const AGENT_ORG = { key: "agent-org", repo: "a11ign/agent-org" };

/** A second tracker as the gate hands it to the pass. */
const trackerOf = (rows: object[] | null, comments: object[] | null, { key, repo } = AGENT_ORG): TrackerClaims => ({ key, repo, rows, claimedComments: comments });

type World = { home?: { rows: object[]; comments: object[] }; trackers?: TrackerClaims[]; workers?: Record<string, string>; stateDir?: string; ledger?: string;
  io?: object; labelEventsOf?: (row: number, repo: string) => null; agentSessions?: Map<string, string> | null };

/** One tick `minutes` after T0, with the nudge memory in `memory`, which survives between calls as the state file does. */
function tickAt(minutes: number, w: World, memory: Record<string, unknown>, log: string[] = []): Order[] {
  const home = w.home ?? { rows: [], comments: [] };
  return claimStallTick({ rows: home.rows, claimedComments: home.comments, openPrs: [], mergedPrs: null, io: w.io ?? noGit, repo: "/repo",
    now: T0 + minutes * MIN, restartAt: null, agents: listing(w.workers ?? {}), agentSessions: w.agentSessions ?? null, stateDir: w.stateDir ?? "/state",
    ledger: () => w.ledger ?? "", log: (line: string) => log.push(line), trackers: w.trackers ?? [],
    ...(w.labelEventsOf === undefined ? {} : { labelEventsOf: w.labelEventsOf }),
    read: () => JSON.parse(JSON.stringify(memory)), write: (_path: string, state: object) => { for (const k of Object.keys(memory)) delete memory[k]; Object.assign(memory, state); },
  } as never) as unknown as Order[];
}

/** The minutes, one tick a minute apart from 0 to `until`, at which a fixture orders a nudge (releases are not nudges). */
function nudgedAt(w: World, until = 30): { at: number[]; first: Order | undefined; memory: Record<string, any> } {
  const memory: Record<string, any> = {};
  const at: number[] = [];
  let first: Order | undefined;
  for (let m = 0; m <= until; m++) {
    const orders = tickAt(m, w, memory).filter((o) => o.release === undefined);
    if (orders.length > 0) { at.push(m); first ??= orders[0]; }
  }
  return { at, first, memory };
}

const agentOrgRow = (over: Partial<World> = {}): World => ({ trackers: [trackerOf([rowOf(476, "worker-agent-org-476")], [claimed(476, "worker-agent-org-476")])],
  workers: { "worker-agent-org-476": "idle" }, ...over });
const homeRow = (over: Partial<World> = {}): World => ({ home: { rows: [rowOf(476, "worker-476")], comments: [claimed(476, "worker-476")] },
  workers: { "worker-476": "idle" }, ...over });

test("the figure: an idle holder with no PR is nudged at 10 minutes, and the 120-minute interval is the no-progress clock's, not this one's", () => {
  assert.equal(M, 10);
  assert.equal(STALL_INTERVAL_MS, 120 * MIN);
});

test("POSITIVE: an idle holder of a claimed row in a SECOND declared tracker, with no PR, is nudged `continue` at the figure (the home row is, as before)", () => {
  const other = nudgedAt(agentOrgRow());
  assert.equal(other.at[0], M, "nudged at the figure, and not before");
  assert.equal(other.first?.cause, "claim-stalled");
  assert.equal(other.first?.session, "worker-agent-org-476");
  assert.match(other.first?.prompt ?? "", /CONTINUE NOW/);
  assert.equal(other.first?.subject, "row-agent-org#476", "the order's subject names the tracker");
  assert.match(other.first?.causeKey ?? "", /^worker-agent-org-476\/claim-stalled\/row-agent-org#476\/nudge-\d+$/, "and so is the key the wake ledger records its delivery under");
  assert.match(other.first?.prompt ?? "", /agent-org#476/, "and the prompt says WHICH repository its number is of");
  const home = nudgedAt(homeRow());
  assert.equal(home.at[0], M, "the control: the home tracker's row, which the pass always read");
  assert.equal(home.first?.subject, "row-476", "and its order is spelled as it was");
  assert.doesNotMatch(home.first?.prompt ?? "", /agent-org#/);
});

test("NEGATIVE: a holder whose row is NOT claimed (no `in-progress`) in the second tracker is not nudged, and has no memory entry", () => {
  const unclaimed = agentOrgRow({ trackers: [trackerOf([rowOf(476, "worker-agent-org-476", { claim: false })], [])] });
  const { at, memory } = nudgedAt(unclaimed);
  assert.deepEqual(at, []);
  assert.deepEqual(memory, {}, "nothing is remembered about it");
  assert.equal(nudgedAt(agentOrgRow()).at[0], M, "twin: the same row carrying the claim label is nudged");
});

test("`agent-org#476` and the home tracker's `476` keep SEPARATE memory entries and separate order subjects (twin: one entry would be shared)", () => {
  const w: World = { ...homeRow(), ...agentOrgRow(), home: homeRow().home, workers: { "worker-476": "idle", "worker-agent-org-476": "idle" } };
  const { memory, first } = nudgedAt(w, 1);
  assert.deepEqual(Object.keys(memory).sort(), ["476", "agent-org#476"], "two entries, one per tracker");
  assert.equal(memory["476"].session, "worker-476");
  assert.equal(memory["agent-org#476"].session, "worker-agent-org-476");
  const orders = tickAt(M, w, memory);
  assert.deepEqual(orders.map((o) => o.subject).sort(), ["row-476", "row-agent-org#476"], "one nudge each");
  assert.notEqual(orders[0].causeKey, orders[1].causeKey);
  assert.ok(first === undefined, "and neither was nudged before the figure");
});

test("the second tracker's nudge memory is READ BACK: the nudge is not re-sent once the wake ledger shows it delivered (twin: undelivered is offered again)", () => {
  const w = agentOrgRow();
  const memory: Record<string, any> = {};
  tickAt(0, w, memory);
  const [nudge] = tickAt(M, w, memory);
  assert.ok(nudge, "nudged");
  assert.equal(memory["agent-org#476"].nudgedAt, T0 + M * MIN, "and remembered under the namespaced slot");
  assert.equal(tickAt(M + 1, w, memory).filter((o) => o.release === undefined).length, 1, "twin: not delivered, so it is offered again");
  const delivered = { ...w, ledger: ledgerLine(T0 + M * MIN + 1000, nudge.causeKey) };
  assert.deepEqual(tickAt(M + 2, delivered, memory).filter((o) => o.release === undefined), [], "delivered under the NAMESPACED key, so it is not sent a second time");
});

test("a release of a second tracker's row IS ordered, carrying the tracker's key so the performer reads that tracker (agent-org#834; twin: the home row's carries none)", () => {
  const later = M + STALL_INTERVAL_MS / MIN + 1;
  const run = (w: World) => {
    const memory: Record<string, any> = {};
    tickAt(0, w, memory);
    const [nudge] = tickAt(M, w, memory);
    const delivered = { ...w, ledger: ledgerLine(T0 + M * MIN + 1000, nudge.causeKey) };
    const log: string[] = [];
    const orders = tickAt(later, delivered, memory, log);
    return { orders, log: log.join(""), memory };
  };
  const home = run(homeRow());
  const homeReleases = home.orders.filter((o) => o.release !== undefined);
  assert.deepEqual(homeReleases.map((o) => [o.release?.why, o.release?.row, o.release?.tracker]), [["stalled", 476, undefined]], "the control: the home row's release names no tracker");
  const other = run(agentOrgRow());
  const releases = other.orders.filter((o) => o.release !== undefined);
  assert.deepEqual(releases.map((o) => [o.release?.why, o.release?.row, o.release?.tracker]), [["stalled", 476, "agent-org"]], "the second tracker's is ordered, and names it");
  assert.equal(releases[0].subject, "row-agent-org#476", "under the namespaced subject, so it is never the home row's");
  assert.equal(releases[0].session, "worker-agent-org-476");
  assert.doesNotMatch(other.log, /NOT ordered/, "and the pass no longer says it withholds it");
});

test("an UNREADABLE second tracker yields no order and says why, and its memory is KEPT (twin: read, the same row is nudged; an empty list would forget it)", () => {
  const seeded = { "agent-org#476": { session: "worker-agent-org-476", idleSince: T0 }, "9": { session: "worker-9", idleSince: T0 } };
  const rows = [rowOf(476, "worker-agent-org-476")];
  const comments = [claimed(476, "worker-agent-org-476")];
  const workers = { "worker-agent-org-476": "idle" };
  for (const [what, tracker] of [["its open rows", trackerOf(null, null)], ["the comments on its claimed rows", trackerOf(rows, null)]] as const) {
    const log: string[] = [];
    const memory: Record<string, any> = JSON.parse(JSON.stringify(seeded));
    const orders = tickAt(M, { trackers: [tracker], workers }, memory, log);
    assert.deepEqual(orders, [], `${what} could not be read: no order`);
    assert.match(log.join(""), /tracker `agent-org` \(a11ign\/agent-org\): .*could not be read.*UNREAD, which is not "no claim"/, `${what}: said as unread, with the reason`);
    assert.ok("agent-org#476" in memory, `${what}: the tracker's memory is kept (an unread tracker is not an empty one)`);
  }
  const memory: Record<string, any> = JSON.parse(JSON.stringify(seeded));
  const [order] = tickAt(M, { trackers: [trackerOf(rows, comments)], workers }, memory);
  assert.equal(order?.subject, "row-agent-org#476", "twin: the same tracker, read, nudges the same holder");
  const gone: Record<string, any> = JSON.parse(JSON.stringify(seeded));
  tickAt(M, { trackers: [trackerOf([], [])], workers }, gone);
  assert.ok(!("agent-org#476" in gone), "and a tracker READ as having no claim does forget it: the unread case is not that");
});

test("a home tracker that could not be read does not stop a second tracker's evaluation, and the second tracker's unread does not stop the home's", () => {
  const w: World = { ...agentOrgRow(), home: { rows: [rowOf(476, "worker-476")], comments: null as never }, workers: { "worker-476": "idle", "worker-agent-org-476": "idle" } };
  const log: string[] = [];
  const memory: Record<string, any> = {};
  tickAt(0, w, memory, log);
  const orders = tickAt(M, w, memory, log);
  assert.deepEqual(orders.map((o) => o.subject), ["row-agent-org#476"], "the second tracker is nudged");
  assert.match(log.join(""), /the comments on the claimed rows could not be read -- NO claim was evaluated/, "and the home tracker's refusal is said as it was");
  const both = tickAt(M, { ...w, trackers: [trackerOf(null, null)] }, {}, []);
  assert.deepEqual(both, [], "twin: with both unread nothing is ordered");
});

test("a session's label history is read from ITS tracker: the home `labelEvents` is never asked for a second tracker's row", () => {
  const asked: [number, string][] = [];
  const homeAsked: number[] = [];
  const io = { ...noGit, labelEvents: (row: number) => { homeAsked.push(row); return null; } };
  const old = { ...agentOrgRow(), trackers: [trackerOf([rowOf(476, "worker-agent-org-476")], [claimed(476, "worker-agent-org-476", { minutesBefore: STALL_INTERVAL_MS / MIN * 3 })])] };
  tickAt(M, { ...old, io, labelEventsOf: (row: number, repo: string) => { asked.push([row, repo]); return null; } }, {});
  assert.deepEqual(homeAsked, [], "the home reader is not asked about an agent-org row (it would read the HOME row of that number)");
  assert.deepEqual(asked, [[476, "a11ign/agent-org"]], "the tracker's own reader is, with its repository");
});

test("a restart notice for a second tracker's holder is namespaced the same way: its slot, its subject and its delivery key", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-other-tracker-"));
  try {
    const slot = "agent-org#worker-agent-org-476/476";
    writeFileSync(`${dir}/agent-sessions.json`, JSON.stringify({ "worker-476/476": "old-home", [slot]: "old" }));
    const w: World = { ...agentOrgRow(), home: homeRow().home, stateDir: dir, workers: { "worker-476": "idle", "worker-agent-org-476": "idle" },
      agentSessions: new Map([["worker-476", "old-home"], ["worker-agent-org-476", "new"]]) };
    const orders = tickAt(0, w, {});
    assert.equal(orders.length, 1);
    assert.equal(orders[0].subject, "row-agent-org#476");
    assert.match(orders[0].causeKey, /^worker-agent-org-476\/claim-stalled\/row-agent-org#476\/restart-new$/);
    const acked = JSON.parse(readFileSync(`${dir}/agent-sessions.json`, "utf8"));
    assert.equal(acked["worker-476/476"], "old-home", "the home tracker's slot is left as it was");
    assert.equal(acked[slot], "old", "and the notice is remembered only once delivered (twin below)");
    const delivered = tickAt(1, { ...w, ledger: ledgerLine(T0, orders[0].causeKey) }, {});
    assert.deepEqual(delivered, [], "delivered under the namespaced key: not sent again");
    assert.equal(JSON.parse(readFileSync(`${dir}/agent-sessions.json`, "utf8"))[slot], "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the reads `work-gate.ts` makes for the pass -----------------------------------------------------------------------------------------

const scopeOf = (key: string, repo: string | null, openRows: object[] | null): { scope: Scope; read: ReturnType<typeof readOtherScopes>[number]["read"] } => ({
  scope: { key, code: null, tracker: repo === null ? null : { repo } },
  read: { prs: [], readyRows: [], promotableRows: [], chairmanBlocked: [], openRows, codeRepo: undefined, trackerRepo: repo ?? undefined } as never });

/**
 * The fake code host in place, its world holding the claimed row 476 (with `comments` comments). The by-label read and the newest-comments read note what they were asked (the tracker's repository for the newest comments; the
 * label and state for the list), and the by-label read makes ONE call to the `run` it is handed, as the executor does, so the repository the caller AIMED it at is seen: `aimedAt` is the repository of each such call.
 */
function claimedRowHost(comments = 0) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  const bodies = Array.from({ length: comments }, (_, i) => ({ id: world.nextCommentId++, body: `comment ${i}`, createdAt: "2026-10-10T00:00:00Z" }));
  world.rows.set(476, fakeRow(world, 476, { labels: ["in-progress", "session:worker-agent-org-476", "started"], comments: bodies }));
  const lists: { label: string; state: string }[] = [];
  const newestFor: string[] = [];
  const aimedAt: (string | undefined)[] = [];
  const list = host.rows!.readRowsByLabel;
  host.rows!.readRowsByLabel = (request) => {
    lists.push({ label: request.label, state: request.state });
    (request.run as (args: string[], repo?: string) => string)(["fake-rows-by-label"]);
    return list(request);
  };
  const newest = host.rows!.newestCommentsOf;
  host.rows!.newestCommentsOf = (request) => { newestFor.push(request.repo); return newest(request); };
  substituteCodeHost(host);
  const run = (args: string[], repo?: string): string => { aimedAt.push(repo); void args; return "[]"; };
  return { world, lists, newestFor, aimedAt, run };
}

test("`otherTrackerClaims` asks each tracker's own repository for the comments of its claimed rows, and only a tracker that holds one", () => {
  const { run, aimedAt, lists } = claimedRowHost();
  const trackers = otherTrackerClaims([
    scopeOf("agent-org", "a11ign/agent-org", [rowOf(476, "worker-agent-org-476")]),
    scopeOf("quiet", "a11ign/quiet", [rowOf(1, "worker-1", { claim: false })]),
    scopeOf("layer", null, []),
    scopeOf("refused", "a11ign/refused", null),
  ] as never, run);
  assert.deepEqual(trackers.map((t) => [t.key, t.repo, t.rows === null ? null : t.rows.length, t.claimedComments === null ? null : t.claimedComments.length]),
    [["agent-org", "a11ign/agent-org", 1, 1], ["quiet", "a11ign/quiet", 1, null], ["refused", "a11ign/refused", null, null]],
    "a scope with no tracker has no rows; a refused lane is `rows: null` and is never an empty one");
  assert.deepEqual(aimedAt, ["a11ign/agent-org"], "ONE read, of the one tracker with a claimed row, aimed at that tracker");
  assert.deepEqual(lists, [{ label: "in-progress", state: "OPEN" }], "and it is the open `in-progress` rows it asked for");
});

test("the capped re-read of a second tracker's comments names THAT repository (twin: the home one by default)", () => {
  const { run, world, newestFor } = claimedRowHost(101);
  const rows = readClaimedRowComments(run, "a11ign/agent-org");
  assert.equal(rows?.[0].comments[0].id, world.rows.get(476)!.comments[1].id, "the newest page replaced the capped one (the first comment is not in it)");
  assert.equal(rows?.[0].comments.length, 100);
  assert.deepEqual(newestFor, ["a11ign/agent-org"]);
  readClaimedRowComments(run, "a11ign/a11ign");
  assert.deepEqual(newestFor, ["a11ign/agent-org", "a11ign/a11ign"], "twin: aimed at the home tracker it asks the home repository");
});

test("`claimStallsNow` hands the pass the trackers only once the home rows and pull requests are read, and asks for the trackers once", () => {
  let asked = 0;
  const seen: { trackers?: TrackerClaims[] }[] = [];
  const tick = ((input: { trackers?: TrackerClaims[] }) => { seen.push(input); return []; }) as never;
  const trackers = () => { asked += 1; return [trackerOf([rowOf(476, "worker-agent-org-476")], [claimed(476, "worker-agent-org-476")])]; };
  const log: string[] = [];
  claimStallsNow(null, null, [], { tick, trackers, log: (l) => log.push(l), merged: () => [], elsewhere: () => ({ open: [], merged: [] }) });
  assert.equal(seen.length, 0, "home rows unread: nothing is evaluated, for any tracker");
  assert.equal(asked, 0, "and no tracker's comments were read for nothing");
  claimStallsNow([], [], [], { tick, trackers, log: (l) => log.push(l), merged: () => [], elsewhere: () => ({ open: [], merged: [] }) });
  assert.equal(asked, 1);
  assert.equal(seen[0].trackers?.[0].key, "agent-org");
  assert.equal(Object.hasOwn(seen[0], "trackers"), true);
});

test("THE GATE'S OWN WIRING: `claimStallsWithFacts` evaluates the declared trackers' claimed rows from the lanes it was handed (twin: the same lanes without the tracker)", () => {
  const evaluated: string[] = [];
  const tick = ((input: { trackers?: TrackerClaims[] }) => { evaluated.push(...(input.trackers ?? []).map((t) => `${t.key}:${t.rows?.length}:${t.claimedComments?.length}`)); return []; }) as never;
  const { run } = claimedRowHost();
  const stubs = { tick, merged: () => [], elsewhere: () => ({ open: [], merged: [] }), log: () => undefined, run };
  const lanes = [scopeOf("agent-org", "a11ign/agent-org", [rowOf(476, "worker-agent-org-476")])] as never;
  claimStallsWithFacts([], [], [], lanes, stubs);
  assert.deepEqual(evaluated, ["agent-org:1:1"], "the tracker's rows and the comments of its claimed one reach the pass");
  evaluated.length = 0;
  claimStallsWithFacts([], [], [], [] as never, stubs);
  assert.deepEqual(evaluated, [], "twin: no declared second tracker, nothing more than there was");
});
