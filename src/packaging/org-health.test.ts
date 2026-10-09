// no-token: gh -- pure: the four readings are functions of values handed in, `readLastMergedAt` is given a fake `run`, and the one process test below puts a stub `gh` on PATH under a scratch HOME; nothing here reaches the real one
/**
 * `packages/agent-org/src/org-health.ts` and its wiring in `work-gate.ts`, #2936: THE GATE ASKS HOW THE ORG IS DOING, AND WAKES `ceo` WITH THE EVIDENCE
 * WHEN NOTHING LANDS OR A RED PR AGES.
 *
 * THE THRESHOLDS ARE WRITTEN OUT AS 3 HOURS, 120 MINUTES, 75 TICKS AND 60 MINUTES HERE, NEVER AS THE EXPORTED CONSTANTS: a test built from the constant moves
 * with it, so raising N by one would leave it green. The literal is what makes the row's mutation (N + 1) go red, and `the constants are the table's` pins the
 * literals to the exports in ONE place, so the numbers cannot drift from the table posted on the row.
 *
 * POSITIVE CONTROL, REPLAYED FROM THE RECORD: the merges around the 2026-10-01 idle window (#2839 at 2026-09-30T19:02:50Z, then nothing for 12.4 hours until #2844 at
 * 07:25:01Z -- both times measured from `gh pr list --state merged`) with one green PR waiting, and a red PR NO SESSION CAN BE NAMED FOR (the #2880 shape, #2941) that
 * its own account has commented on. Both are OFFERED, through the same entry every "is NOT offered" below goes through. Every clear and every unknown is only worth
 * anything because these two trip.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, readdirSync, cpSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";

// --- (#3233) THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE, NOT A11IGN'S CHECKOUT ---
//
// The gate decides who owns a PR from the project's roster (`session:worker-7` is an owner only if the roster has that address) and reads its git and its
// declaration, and `work-gate.ts` run as a process does the same from its working directory. With no `$AGENT_ORG_HOST` the layout answers a11ign's live
// checkout, so a11ign editing its roster or its tree changed this file's verdict (agent-org #77 and #79). The host file is set FIRST and the tool imported AFTER
// it, dynamically; the project is `fixtures/org-health/project`, copied to a temp directory that is made a git repository with no commit, and it is the
// working directory of this process and of the gates it spawns, which inherit both.
const PROJECT_SCRATCH = mkdtempSync(join(tmpdir(), "org-health-project-"));
after(() => rmSync(PROJECT_SCRATCH, { recursive: true, force: true }));
const PROJECT = join(PROJECT_SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(PROJECT_SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: PROJECT_SCRATCH, binDir: join(PROJECT_SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(PROJECT_SCRATCH, "workers"), leads: join(PROJECT_SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
execFileSync("git", ["init", "--quiet"], { cwd: PROJECT, env: sandboxGitEnv() });
process.chdir(PROJECT);

const { NO_MERGE_HOURS, RED_PR_MINUTES, REFUSED_TICKS, PRIMARY_STALE_MINUTES, SIGNALS, noMergeReading, redPrReading, refusedRowReading,
  primaryReading, primaryStandingSince, readLastMergedAt, readLatestMerge, orgHealthReadings,
  orgHealthOrders, orgHealthTick } = await import("../org-health.ts");
const { CAUSES, JUDGMENT_CAUSES, START_CAUSES, GH_READS, UNCLAIMABLE_AFTER_TICKS, decide, withPrOwners, redPrFacts } =
  await import("../work-gate.ts");
const { profileFor } = await import("../worker-profile.ts");

const GATE_ENTRY = fileURLToPath(new URL("../work-gate.ts", import.meta.url));
const STUB_MODE = 0o755;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");

const WORK = { greenPrs: 1, claimableRows: 0 };
const NO_WORK = { greenPrs: 0, claimableRows: 0 };
const CURRENT = { behind: 0, ahead: 0, dirty: [] as string[] };
const STALE = { behind: 4, ahead: 0, dirty: ["packages/agent-org/src/work-gate.ts"] };

type Order = { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string };

/** The facts every signal reads, every one CLEAR, so a test names only the one it moves. */
const quiet = (over: Record<string, unknown> = {}) => ({ now: NOW, lastMergedAt: NOW - HOUR_MS, work: WORK, redPrs: [], refusals: {}, drift: CURRENT, primarySince: null, autoOff: { refusal: null, readAt: NOW }, ...over });

// --- the table's numbers, in one place ------------------------------------------------------------------------------

test("the constants are the table's: N = 3 h, M = 120 min, 75 ticks, 60 min, and the refused-row threshold sits above `product-manager`'s", () => {
  assert.equal(NO_MERGE_HOURS, 3);
  assert.equal(RED_PR_MINUTES, 120);
  assert.equal(REFUSED_TICKS, 75);
  assert.equal(PRIMARY_STALE_MINUTES, 60);
  assert.equal(UNCLAIMABLE_AFTER_TICKS, 15, "the 75 is 15 plus one judgment window; if the 15 moves, re-read the row's table");
  assert.ok(REFUSED_TICKS > UNCLAIMABLE_AFTER_TICKS, "ceo is told AFTER product-manager has had its window, never before");
});

// --- 1. no-merge-while-work-exists ----------------------------------------------------------------------------------

test("no-merge: trips at exactly 3 h since the last merge with work waiting, and not one millisecond under", () => {
  const atThreshold = noMergeReading({ now: NOW, lastMergedAt: NOW - 3 * HOUR_MS, work: WORK });
  assert.equal(atThreshold.status, "tripped");
  assert.equal(atThreshold.firstTrippedAt, NOW, "first tripped = the last merge plus 3 h, derived rather than remembered");
  assert.equal(noMergeReading({ now: NOW, lastMergedAt: NOW - 3 * HOUR_MS + 1, work: WORK }).status, "clear");
});

test("no-merge: either kind of work counts (a green PR, a claimable row), and NO work is not a stall -- an empty queue is finished", () => {
  const old = NOW - 5 * HOUR_MS;
  assert.equal(noMergeReading({ now: NOW, lastMergedAt: old, work: { greenPrs: 0, claimableRows: 2 } }).status, "tripped");
  assert.equal(noMergeReading({ now: NOW, lastMergedAt: old, work: { greenPrs: 3, claimableRows: 0 } }).status, "tripped");
  assert.equal(noMergeReading({ now: NOW, lastMergedAt: old, work: NO_WORK }).status, "clear");
});

test("no-merge: a refused read is an UNKNOWN, never a clear -- the merge read, and the work read once the gap is over", () => {
  const noMerge = noMergeReading({ now: NOW, lastMergedAt: null, work: WORK });
  assert.equal(noMerge.status, "unknown");
  assert.match(noMerge.detail, /last merge could not be read/);
  const noWork = noMergeReading({ now: NOW, lastMergedAt: NOW - 5 * HOUR_MS, work: null });
  assert.equal(noWork.status, "unknown");
  assert.equal(noMergeReading({ now: NOW, lastMergedAt: NOW - HOUR_MS, work: null }).status, "clear",
    "inside the window a refused work read cannot matter, so a healthy tick is not turned into an unknown");
});

test("no-merge: the offer names ceo, carries the hours and the first-tripped time, and is keyed on that hour so it HOLDS across ticks", () => {
  const facts = quiet({ lastMergedAt: NOW - 25 * HOUR_MS, work: { greenPrs: 2, claimableRows: 1 } });
  const [order] = orgHealthOrders(orgHealthReadings(facts as never)) as Order[];
  assert.equal(order.session, "ceo");
  assert.equal(order.cause, "org-health");
  assert.match(order.prompt, /`no-merge-while-work-exists` HAS TRIPPED\. 25 h since the last merge/);
  assert.match(order.prompt, /2 green unheld PR\(s\) and 1 claimable Ready row\(s\) exist/);
  assert.match(order.prompt, /It first tripped at 2026-09-30T14:00:00Z/);
  assert.equal(order.discriminator, "no-merge-while-work-exists@2026-09-30T14");
  const later = orgHealthOrders(orgHealthReadings({ ...facts, now: NOW + 7 * MINUTE_MS } as never)) as Order[];
  assert.equal(later[0].causeKey, order.causeKey, "three ticks later: the same key, so wake holds it instead of asking again");
});

test("no-merge: a signal that CLEARS stops being offered", () => {
  const tripped = quiet({ lastMergedAt: NOW - 4 * HOUR_MS });
  assert.equal(orgHealthOrders(orgHealthReadings(tripped as never)).length, 1);
  assert.deepEqual(orgHealthOrders(orgHealthReadings({ ...tripped, lastMergedAt: NOW - 10 * MINUTE_MS } as never)), [], "a merge landed");
  assert.deepEqual(orgHealthOrders(orgHealthReadings({ ...tripped, work: NO_WORK } as never)), [], "the work was done or withdrawn");
});

// --- 2. red-pr-unattended -------------------------------------------------------------------------------------------

const redPr = (over: Record<string, unknown> = {}) => ({ number: 2901, owner: "worker-2901", redSince: NOW - 120 * MINUTE_MS, ownerCommentAts: [] as number[], ...over });

test("red-pr: trips at exactly 120 min red with no owner comment since, and not one millisecond under", () => {
  const atThreshold = redPrReading({ now: NOW, redPrs: [redPr()] });
  assert.equal(atThreshold.status, "tripped");
  assert.equal(atThreshold.firstTrippedAt, NOW, "first tripped = when the check went red plus 120 min");
  assert.equal(redPrReading({ now: NOW, redPrs: [redPr({ redSince: NOW - 120 * MINUTE_MS + 1 })] }).status, "clear");
});

test("red-pr: an owner's comment AFTER the red excuses it; one BEFORE it does not; and a comment at the very moment counts", () => {
  assert.equal(redPrReading({ now: NOW, redPrs: [redPr({ ownerCommentAts: [NOW - 30 * MINUTE_MS] })] }).status, "clear");
  assert.equal(redPrReading({ now: NOW, redPrs: [redPr({ ownerCommentAts: [NOW - 121 * MINUTE_MS] })] }).status, "tripped", "it predates the red");
  assert.equal(redPrReading({ now: NOW, redPrs: [redPr({ ownerCommentAts: [NOW - 120 * MINUTE_MS] })] }).status, "clear");
});

test("red-pr: A PR WITH NO OWNER AT ALL IS UNATTENDED, whatever has been said on it", () => {
  const orphan = redPr({ owner: null, ownerCommentAts: [NOW - 5 * MINUTE_MS] });
  const reading = redPrReading({ now: NOW, redPrs: [orphan] });
  assert.equal(reading.status, "tripped");
  assert.match(reading.detail, /#2901 \(red 2 h, NO OWNER\)/);
  assert.equal(redPrReading({ now: NOW, redPrs: [{ ...orphan, owner: "worker-1" }] }).status, "clear", "the same comment excuses a PR that HAS an owner");
});

test("red-pr: a refused PR read, or a red PR with no check time, is an UNKNOWN and not a clear", () => {
  assert.equal(redPrReading({ now: NOW, redPrs: null }).status, "unknown");
  const undated = redPrReading({ now: NOW, redPrs: [redPr({ redSince: null })] });
  assert.equal(undated.status, "unknown");
  assert.match(undated.detail, /1 red PR\(s\) carried no check time/);
  assert.equal(redPrReading({ now: NOW, redPrs: [] }).status, "clear", "no red PR at all is the one genuine clear");
  assert.equal(redPrReading({ now: NOW, redPrs: [redPr({ redSince: null }), redPr({ number: 2902, redSince: NOW - 3 * HOUR_MS })] }).status, "tripped",
    "an undated PR does not hide a dated one that has tripped");
});

test("red-pr: ONE order for the set, oldest first and capped at five, keyed on the OLDEST one's trip hour", () => {
  const redPrs = [1, 2, 3, 4, 5, 6, 7].map((n) => redPr({ number: 2900 + n, redSince: NOW - (n + 2) * HOUR_MS }));
  const [order, ...rest] = orgHealthOrders(orgHealthReadings(quiet({ redPrs }) as never)) as Order[];
  assert.equal(rest.length, 0, "one order per tripped signal, however many PRs");
  assert.match(order.prompt, /7 PR\(s\) red over 120 min with no comment from their owner since: #2907 \(red 9 h/);
  assert.match(order.prompt, /, and 2 more/);
  assert.equal(order.discriminator, "red-pr-unattended@2026-10-01T05", "the oldest went red at 03:00 (nine hours before NOW), so it tripped at 05:00");
});

// --- 3. ready-row-refused -------------------------------------------------------------------------------------------

test("refused-row: trips at exactly 75 ticks and not at 74, quoting the refusal and naming the row", () => {
  const seen = (ticks: number) => ({ "2845": { reason: "--worktree=../wt-2845 ALREADY EXISTS, stamped by `worker-9`", ticks } });
  const at = refusedRowReading({ refusals: seen(75) });
  assert.equal(at.status, "tripped");
  assert.match(at.detail, /1 Ready row\(s\) refused over 75 ticks: 2845 \(75 ticks, about 2\.6 h\): --worktree=\.\.\/wt-2845 ALREADY EXISTS/);
  assert.equal(refusedRowReading({ refusals: seen(74) }).status, "clear");
  assert.equal(refusedRowReading({ refusals: {} }).status, "clear");
});

test("refused-row: the counter is READ, not recounted -- the key does not move as the streak grows, and a refused read is an unknown", () => {
  const key = (ticks: number) => refusedRowReading({ refusals: { "2845": { reason: "r", ticks } } }).discriminator;
  assert.equal(key(75), key(200), "keyed on the rows, because the counter carries ticks and no time");
  assert.equal(key(75), "ready-row-refused@2845");
  assert.notEqual(refusedRowReading({ refusals: { "2845": { reason: "r", ticks: 75 }, "2846": { reason: "r", ticks: 80 } } }).discriminator, key(75), "a second row is a new question");
  assert.equal(refusedRowReading({ refusals: null }).status, "unknown");
});

// --- 4. primary-not-at-main -----------------------------------------------------------------------------------------

test("primary: trips at exactly 60 min off origin/main and not one millisecond under; a current primary is clear at any age", () => {
  const since = NOW - 60 * MINUTE_MS;
  const at = primaryReading({ now: NOW, drift: STALE, since });
  assert.equal(at.status, "tripped");
  assert.match(at.detail, /off origin\/main for 60 min \(since 2026-10-01T11:00:00Z\): 4 commit\(s\) behind, 0 ahead, 1 dirty tracked path\(s\)/);
  assert.equal(primaryReading({ now: NOW, drift: STALE, since: since + 1 }).status, "clear");
  assert.equal(primaryReading({ now: NOW, drift: CURRENT, since: NOW - 30 * HOUR_MS }).status, "clear");
});

test("primary: a primary that could not be asked, or an age nothing could read, is an UNKNOWN -- and a stale one says it was not read as clear", () => {
  assert.equal(primaryReading({ now: NOW, drift: null, since: null }).status, "unknown");
  const undated = primaryReading({ now: NOW, drift: STALE, since: null });
  assert.equal(undated.status, "unknown");
  assert.match(undated.detail, /nothing dated how long/);
});

test("primary: the age is the OLDEST of the oldest missing commit and the oldest dirty file, and a failed read is no age", () => {
  const run = (args: string[]) => { assert.ok(args.includes("HEAD..refs/remotes/origin/main")); return "2026-10-01T09:30:00+01:00\n"; };
  const mtimes: Record<string, number> = { "a.mjs": Date.parse("2026-10-01T10:00:00Z"), "b.mjs": Date.parse("2026-10-01T07:00:00Z") };
  assert.equal(primaryStandingSince({ behind: 3, dirty: ["a.mjs", "b.mjs"] }, { root: "/p", run, mtimeOf: (p) => mtimes[p] }), Date.parse("2026-10-01T07:00:00Z"));
  assert.equal(primaryStandingSince({ behind: 3, dirty: [] }, { root: "/p", run, mtimeOf: () => 0 }), Date.parse("2026-10-01T08:30:00Z"));
  assert.equal(primaryStandingSince({ behind: 0, dirty: ["a.mjs"] }, { root: "/p", run: () => { throw new Error("not asked"); }, mtimeOf: (p) => mtimes[p] }),
    Date.parse("2026-10-01T10:00:00Z"), "behind is zero, so git is not asked at all");
  assert.equal(primaryStandingSince({ behind: 3, dirty: [] }, { root: "/p", run: () => { throw new Error("git refused"); }, mtimeOf: () => 0 }), null);
  assert.equal(primaryStandingSince(null, { root: "/p" }), null);
});

// --- the last merge, read -------------------------------------------------------------------------------------------

test("readLastMergedAt: the latest merged_at, ONE call; a refusal, `null` and nonsense are all null -- never a long time ago", () => {
  const calls: string[][] = [];
  const answers = (out: string) => (args: string[]) => { calls.push(args); return out; };
  assert.equal(readLastMergedAt(answers("2026-10-01T07:25:01Z\n"), "a11ign/a11ign"), Date.parse("2026-10-01T07:25:01Z"));
  assert.equal(calls.length, 1);
  assert.match(calls[0].join(" "), /repos\/a11ign\/a11ign\/pulls\?state=closed&sort=updated&direction=desc/);
  assert.equal(readLastMergedAt(answers("null\n"), "a/b"), null, "no merged PR among the newest-updated");
  assert.equal(readLastMergedAt(answers("not a date"), "a/b"), null);
  assert.equal(readLastMergedAt(() => { throw new Error("HTTP 403"); }, "a/b"), null);
});

// --- (#4047) the org's latest merge, across the project and agent-org ------------------------------------------------

const PROJECT_REPO = "a11ign/a11ign";
const TOOL_REPO = "a11ign/agent-org";
/** A fake `gh`: each repository answers with its own newest `merged_at` (raw, as `--jq` prints it), `"refused"` throws, and every call is kept. */
const mergesOf = (byRepo: Record<string, string>, calls: string[] = []) => (args: string[]) => {
  const repo = /repos\/([^/]+\/[^/]+)\/pulls/.exec(args.join(" "))?.[1] ?? "";
  calls.push(repo);
  if (byRepo[repo] === "refused") throw new Error("HTTP 403");
  return `${byRepo[repo]}\n`;
};
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const CLAIMABLE = { greenPrs: 0, claimableRows: 1 };
/** The reading the tick makes of a last merge `readLatestMerge` found: the facts the gate builds, handed to the same decider. */
const readingOf = (last: { at: number, repo: string } | null) =>
  noMergeReading({ now: NOW, lastMergedAt: last?.at ?? null, lastMergedIn: last?.repo ?? null, work: CLAIMABLE });

test("#4047: a project merge at T-7h and an agent-org merge at T-10min is a last merge of T-10min, so a claimable row does not trip", () => {
  const calls: string[] = [];
  const last = readLatestMerge(mergesOf({ [PROJECT_REPO]: ago(7 * HOUR_MS), [TOOL_REPO]: ago(10 * MINUTE_MS) }, calls), [PROJECT_REPO, TOOL_REPO]);
  assert.deepEqual(last, { at: NOW - 10 * MINUTE_MS, repo: TOOL_REPO });
  assert.deepEqual(calls, [PROJECT_REPO, TOOL_REPO], "ONE call per repository");
  assert.equal(readingOf(last).status, "clear");
});

test("#4047: the reverse order picks the project's merge, and the detail of a trip names the repository of the last merge", () => {
  const last = readLatestMerge(mergesOf({ [PROJECT_REPO]: ago(20 * MINUTE_MS), [TOOL_REPO]: ago(7 * HOUR_MS) }), [PROJECT_REPO, TOOL_REPO]);
  assert.deepEqual(last, { at: NOW - 20 * MINUTE_MS, repo: PROJECT_REPO });
  assert.equal(readingOf(last).status, "clear");
  const old = readLatestMerge(mergesOf({ [PROJECT_REPO]: ago(5 * HOUR_MS), [TOOL_REPO]: ago(4 * HOUR_MS) }), [PROJECT_REPO, TOOL_REPO]);
  assert.match(readingOf(old).detail, new RegExp(`\\(.* in ${TOOL_REPO}\\)`), "the later of the two is named");
  assert.doesNotMatch(noMergeReading({ now: NOW, lastMergedAt: NOW - 4 * HOUR_MS, work: CLAIMABLE }).detail, / in /, "a caller that names none says none");
});

test("#4047 POSITIVE CONTROL: both repositories' merges older than 3 h with a claimable row still trips", () => {
  const last = readLatestMerge(mergesOf({ [PROJECT_REPO]: ago(7 * HOUR_MS), [TOOL_REPO]: ago(4 * HOUR_MS) }), [PROJECT_REPO, TOOL_REPO]);
  const reading = readingOf(last);
  assert.equal(reading.status, "tripped");
  assert.equal(reading.firstTrippedAt, NOW - 4 * HOUR_MS + 3 * HOUR_MS, "the gap runs from the NEWER merge");
});

test("#4047: a refused read of EITHER repository is unknown, never the other's time; a repository with no merged PR is skipped, and none anywhere is unknown", () => {
  const fresh = ago(10 * MINUTE_MS);
  for (const refused of [PROJECT_REPO, TOOL_REPO]) {
    const answers = { [PROJECT_REPO]: ago(7 * HOUR_MS), [TOOL_REPO]: ago(7 * HOUR_MS), [refused]: "refused" };
    assert.equal(readLatestMerge(mergesOf(answers), [PROJECT_REPO, TOOL_REPO]), null, `${refused} refused`);
    assert.equal(readingOf(null).status, "unknown");
  }
  assert.equal(readLatestMerge(mergesOf({ [PROJECT_REPO]: "not a date", [TOOL_REPO]: fresh }), [PROJECT_REPO, TOOL_REPO]), null, "unparseable is a refusal too");
  assert.deepEqual(readLatestMerge(mergesOf({ [PROJECT_REPO]: "null", [TOOL_REPO]: fresh }), [PROJECT_REPO, TOOL_REPO]), { at: NOW - 10 * MINUTE_MS, repo: TOOL_REPO },
    "an empty repository says nothing about the others");
  assert.equal(readLatestMerge(mergesOf({ [PROJECT_REPO]: "null", [TOOL_REPO]: "null" }), [PROJECT_REPO, TOOL_REPO]), null);
  assert.equal(readLatestMerge(mergesOf({}), []), null, "no repository to ask is no answer");
});

test("#4047: the tick's default reads every declared code repository through readLatestMerge, and hands its repository on", () => {
  const source = readFileSync(fileURLToPath(new URL("../work-gate/org-health.ts", import.meta.url)), "utf8");
  assert.match(source, /lastMergedAt = \(\) => readLatestMerge\(defaultRun, mergeRepositories\(\)\)/);
  assert.match(source, /\.\.\.lastMerge\(lastMergedAt\(\)\)/);
});

// --- orders and the tick --------------------------------------------------------------------------------------------

test("two tripped signals are TWO orders, each carrying the other, and unknowns and clears emit nothing", () => {
  const facts = quiet({ lastMergedAt: NOW - 4 * HOUR_MS, drift: STALE, primarySince: NOW - 5 * HOUR_MS, refusals: null });
  const readings = orgHealthReadings(facts as never);
  assert.deepEqual(readings.map((r) => [r.signal, r.status]), [["no-merge-while-work-exists", "tripped"], ["red-pr-unattended", "clear"],
    ["ready-row-refused", "unknown"], ["primary-not-at-main", "tripped"], ["fleet-auto-off-refusing", "clear"]]);
  const orders = orgHealthOrders(readings) as Order[];
  assert.deepEqual(orders.map((o) => o.subject), ["no-merge-while-work-exists", "primary-not-at-main"]);
  assert.match(orders[0].prompt, /ALSO TRIPPED \(1\): primary-not-at-main\./);
  assert.match(orders[1].prompt, /ALSO TRIPPED \(1\): no-merge-while-work-exists\./);
});

test("the tick SAYS each unknown on stderr and does not say a tripped signal; it never throws", () => {
  const said: string[] = [];
  const orders = orgHealthTick(quiet({ lastMergedAt: null, refusals: null, drift: null }) as never, { log: (l) => said.push(l) });
  assert.deepEqual(orders, [], "three unknowns and one clear: nothing to offer");
  assert.equal(said.length, 3);
  assert.match(said.join(""), /org-health: no-merge-while-work-exists UNKNOWN -- the last merge could not be read.*not read as clear/);
  const tripped: string[] = [];
  assert.equal(orgHealthTick(quiet({ lastMergedAt: NOW - 4 * HOUR_MS }) as never, { log: (l) => tripped.push(l) }).length, 1);
  assert.deepEqual(tripped, [], "a tripped signal's report is its order: a line written every tick would be offered by repeating-lines as a fault");
  const broke: string[] = [];
  assert.deepEqual(orgHealthTick(quiet({ redPrs: [null] }) as never, { log: (l) => broke.push(l) }), []);
  assert.match(broke.join(""), /org-health: could not run/);
});

// --- the causes exist and are classified ----------------------------------------------------------------------------

test("`org-health` is declared once: in CAUSES and JUDGMENT_CAUSES, NOT a START cause, with a profile that is not a refusal", () => {
  assert.ok(CAUSES.includes("org-health"));
  assert.ok(JUDGMENT_CAUSES.includes("org-health"), "durable: wake holds it for the judgment window instead of re-asking every twenty minutes");
  assert.ok(!START_CAUSES.includes("org-health"), "it starts no work, and a drain is exactly when an org that is not landing should be told");
  const profile = profileFor("org-health");
  assert.ok("model" in profile, "a refused lookup would carry `refusal`, not a profile");
  assert.equal(profile.model, "sonnet");
  assert.equal(profile.effort, "high");
  assert.ok(GH_READS.unconditional.some((r: string) => r.includes("readLastMergedAt")), "the one new read is counted where reads are counted");
});

// --- POSITIVE CONTROL, replayed from the record ---------------------------------------------------------------------

/** What `gh api ... --jq '[.[] | select(.merged_at != null) | .merged_at] | max'` prints over this list: the latest merged_at, or `null`. */
const jqLatestMerge = (list: { merged_at: string | null }[]) => () =>
  list.map((p) => p.merged_at).filter((t): t is string => t !== null).sort().at(-1) ?? "null";

// The pull requests merged around the idle window, newest-updated first, as `gh pr list --state merged` returned them (2026-10-01), plus one closed unmerged.
const MERGES_AROUND_THE_IDLE_WINDOW = [
  { number: 2844, merged_at: "2026-10-01T07:25:01Z" }, { number: 2843, merged_at: "2026-10-01T07:31:41Z" },
  { number: 2839, merged_at: "2026-09-30T19:02:50Z" }, { number: 2838, merged_at: "2026-09-30T18:10:16Z" }, { number: 2837, merged_at: null },
];

test("POSITIVE CONTROL: at 05:30Z on 2026-10-01 the merge list says 10 h since #2839, a green PR waits, and the gap is OFFERED to ceo", () => {
  const before = MERGES_AROUND_THE_IDLE_WINDOW.filter((p) => p.merged_at === null || p.merged_at < "2026-10-01T05:30:00Z");
  const lastMergedAt = readLastMergedAt(jqLatestMerge(before), "a11ign/a11ign");
  assert.equal(lastMergedAt, Date.parse("2026-09-30T19:02:50Z"));
  const orders = orgHealthTick({ ...quiet(), now: Date.parse("2026-10-01T05:30:00Z"), lastMergedAt, work: WORK } as never, { log: () => undefined }) as Order[];
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /10 h since the last merge \(2026-09-30T19:02:50Z\); 1 green unheld PR\(s\)/);
  assert.match(orders[0].prompt, /It first tripped at 2026-09-30T22:02:50Z/, "three hours after #2839");
  const after = readLastMergedAt(jqLatestMerge(MERGES_AROUND_THE_IDLE_WINDOW), "a11ign/a11ign");
  assert.deepEqual(orgHealthTick({ ...quiet(), now: Date.parse("2026-10-01T07:40:00Z"), lastMergedAt: after, work: WORK } as never, { log: () => undefined }), [],
    "the control: the same org after #2843 landed is healthy and is not offered");
});

const ROWS = [{ number: 11, labels: [{ name: "in-progress" }, { name: "session:worker-11" }] }];
const redHead = { number: 2880, headRefOid: "24b0e94f00000000", isDraft: false, headRefName: "agent/some-slug", labels: [], closingIssuesReferences: [],
  author: { login: "a11ign-ai-workers" },
  statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-01T14:05:00Z", completedAt: "2026-10-01T14:40:00Z" }] };

test("POSITIVE CONTROL: the #2880 shape, a red PR NO SESSION CAN BE NAMED FOR that its own account has commented on, is OFFERED once it is 120 min red", () => {
  const prs = withPrOwners([{ ...redHead, comments: [{ author: { login: "a11ign-ai-workers" }, createdAt: "2026-10-01T15:00:00Z" }] }], ROWS, () => null);
  const decided = decide({ prs, readyRows: [], openRows: ROWS });
  assert.equal(decided.find((o: Order) => o.cause === "pr-checks-failing")!.session, "ceo", "the precondition: nobody could be named");
  const facts = redPrFacts(prs, decided);
  assert.deepEqual(facts, [{ number: 2880, owner: null, redSince: Date.parse("2026-10-01T14:40:00Z"), ownerCommentAts: [Date.parse("2026-10-01T15:00:00Z")] }],
    "red since the FIRST failing check FINISHED, when the first order was given");
  const at = (iso: string) => (orgHealthOrders(orgHealthReadings(quiet({ now: Date.parse(iso), lastMergedAt: Date.parse(iso) - HOUR_MS, redPrs: facts }) as never)) as Order[]);
  assert.equal(at("2026-10-01T16:39:59Z").length, 0, "119 min 59 s");
  const [order] = at("2026-10-01T16:40:00Z");
  assert.match(order.prompt, /#2880 \(red 2 h, NO OWNER\)/);
  assert.equal(order.discriminator, "red-pr-unattended@2026-10-01T16");
});

test("redPrFacts consumes the orders `pr-checks-failing` gave: a PR whose red the gate excuses is not listed, an owned one carries its session and ONLY its own account's comments", () => {
  const owned = { ...redHead, number: 2881, labels: [{ name: "session:worker-7" }], comments: [{ author: { login: "a11ign-ai-workers" }, createdAt: "2026-10-01T15:00:00Z" },
    { author: { login: "reviewer-9" }, createdAt: "2026-10-01T15:30:00Z" }, { author: { login: "a11ign-ai-workers" }, createdAt: "garbage" }] };
  const green = { ...redHead, number: 2882, statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] };
  const prs = withPrOwners([owned, green], ROWS, () => null);
  const decided = decide({ prs, readyRows: [], openRows: ROWS });
  assert.deepEqual(redPrFacts(prs, decided), [{ number: 2881, owner: "worker-7", redSince: Date.parse("2026-10-01T14:40:00Z"),
    ownerCommentAts: [Date.parse("2026-10-01T15:00:00Z")] }]);
  assert.deepEqual(redPrFacts(prs, []), [], "no pr-checks-failing order, no listing: the exclusions are the order's, not a second copy here");
});

// --- #2956: red is decided ONCE (`red-pr.ts`'s `isBrokenRed`), so a hold's red is never offered to ceo ----------------------------------------

const rollupCheck = (name: string, conclusion: string, completedAt: string) => ({ name, status: "COMPLETED", conclusion, startedAt: completedAt, completedAt });
const HOLD_RED = [rollupCheck("deliberateRefusals", "FAILURE", "2026-10-01T18:27:00Z"), rollupCheck("gate", "FAILURE", "2026-10-01T18:30:00Z")];
/** #2883's shape: an OWNED PR (`session:worker-7`) that `ceo` holds, a hold by somebody else WAS no answer from the owner (#2400 clause 1) until #2993, which made it one. */
const heldByCeo = (extra: unknown[] = [], over: Record<string, unknown> = {}) => ({ ...redHead, number: 2883, labels: [{ name: "session:worker-7" }, { name: "hold:ceo" }],
  statusCheckRollup: [...HOLD_RED, ...extra], ...over });

/** The facts the gate builds for `org-health`, and whether the signal is OFFERED three hours after the first red. */
function offeredFor(pr: object) {
  const prs = withPrOwners([pr], ROWS, () => null);
  const decided = decide({ prs, readyRows: [], openRows: ROWS });
  const facts = redPrFacts(prs, decided);
  const now = Date.parse("2026-10-01T21:45:00Z");
  const orders = orgHealthOrders(orgHealthReadings(quiet({ now, lastMergedAt: now - HOUR_MS, redPrs: facts }) as never)) as Order[];
  return { ordered: decided.some((o: Order) => o.cause === "pr-checks-failing"), facts, orders };
}

test("#2956/#2993 PRECONDITION: a PR held by `ceo` and owned by a worker is NOT ordered by `pr-checks-failing` while only the hold is red, and IS once a real job is -- org-health's decider is asked on its own", () => {
  // Before #2993 this asserted `true`: a hold by somebody else was no answer from the owner (#2400 clause 1), so the order still went and the
  // test below could only prove org-health's decider by contrast. The order now asks `isHeldRed` too, so the contrast is gone and the control
  // moves to the real red, which must still reach the owner.
  assert.equal(offeredFor(heldByCeo()).ordered, false, "the hold's own red is an answer, whoever placed it");
  assert.equal(offeredFor(heldByCeo([rollupCheck("ts / run", "FAILURE", "2026-10-01T19:00:00Z")])).ordered, true, "a real red under the same hold still orders its owner");
});

test("#2956: org-health does NOT offer a held PR whose only red is the hold's; it DOES offer a held PR with a REAL red, dated by THAT check; and still a PR with no owner", () => {
  const held = offeredFor(heldByCeo());
  assert.deepEqual(held.facts, [], "not even LISTED: listed with no time it would be an UNKNOWN said on stderr every tick, a repeating line about a decision");
  assert.deepEqual(held.orders, [], "the hold's deliberateRefusals + gate: a decision, not a breakage");
  const real = offeredFor(heldByCeo([rollupCheck("ts / run", "FAILURE", "2026-10-01T19:00:00Z")]));
  assert.equal(real.facts[0].redSince, Date.parse("2026-10-01T19:00:00Z"), "red since the REAL check, not the hold's gate at 18:30");
  assert.match(real.orders[0].prompt, /#2883 \(red 3 h, owner worker-7\)/);
  const ownerless = offeredFor({ ...redHead, number: 2880, statusCheckRollup: [rollupCheck("gate", "FAILURE", "2026-10-01T18:00:00Z")] });
  assert.match(ownerless.orders[0].prompt, /#2880 \(red 4 h, NO OWNER\)/, "the #2936 control, unchanged");
});

// --- #2956: one decider, found from the TREE, with its own positive controls -------------------------------------------------------------------

const AGENT_ORG_SRC = fileURLToPath(new URL("../", import.meta.url));
/** The decider, which defines red and so cannot be asked to import itself -- excluded in CODE, with the reason beside it. */
const SELF = "red-pr.ts";
/**
 * Modules that read the rollup and decide something that is NOT "how many PRs are red, or for how long", each with the reason. SHRINK-ONLY:
 * the ceiling is today's length, a stale entry fails below, and a module that starts counting red PRs belongs on `isBrokenRed`, not here.
 */
const EXEMPT: Record<string, string> = {
  "merge-queue.ts": "decides whether ONE queued PR may merge from its required checks; counts and ages nothing",
  "queue-stalled.ts": "reads the gate verdict of an ARMED PR to tell a stalled queue from a slow one",
  "work-gate/pr-orders.ts": "the order logic (`redOnlyFromAHold` asks `isHeldRed`, #2993; the rest is who is asked, not how many are red), `HOLD_RED_JOBS` pinned equal to red-pr.ts's in org-retro.test.ts",
};
const EXEMPT_CEILING = 3;

/** Code with every `//`, `/* *\/` comment removed, so a header that NAMES `statusCheckRollup` does not enlist its file. */
const codeOf = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/\s.*$/gm, "");
/** What makes a module a reader of red: the rollup itself, a red conclusion spelt out, or the decider's own vocabulary. */
const READS_RED = /\bstatusCheckRollup\b|["'](?:FAILURE|TIMED_OUT|STARTUP_FAILURE)["']|\b(?:redChecks|brokenChecks|isBrokenRed)\b/;
/** `brokenChecks` IS the decider (`isBrokenRed` is its `.length > 0`), so importing either is asking `red-pr.ts` rather than re-deciding. */
const IMPORTS_DECIDER = /import\s*\{[^}]*\b(?:isBrokenRed|brokenChecks)\b[^}]*\}\s*from\s*["'][^"']*red-pr\.ts["']/;

/** `null` when the module is not a reader of red or is on the decider; otherwise WHY it is an offender. */
function redOffence(file: string, source: string): string | null {
  const code = codeOf(source);
  if (!READS_RED.test(code) || IMPORTS_DECIDER.test(code) || file in EXEMPT) return null;
  return `${file} reads red state and neither imports isBrokenRed from red-pr.ts nor is exempt with a reason`;
}

function agentOrgModules(): { file: string; source: string }[] {
  const listed = readdirSync(AGENT_ORG_SRC, { recursive: true, encoding: "utf8" }).filter((f) => /\.(mjs|ts)$/.test(f) && !f.includes("node_modules"));
  return listed.filter((f) => !/\.test\.(mjs|ts)$/.test(f) && f !== SELF).map((file) => ({ file, source: readFileSync(join(AGENT_ORG_SRC, file), "utf8") }));
}

test("#2956 ONE DECIDER: every agent-org module that reads red PR state imports `isBrokenRed` or is exempt WITH A REASON; the exemptions only shrink", () => {
  const modules = agentOrgModules();
  const readers = modules.filter((m) => READS_RED.test(codeOf(m.source))).map((m) => m.file);
  for (const control of ["org-retro.ts", "org-health.ts"]) assert.ok(readers.includes(control), `POSITIVE CONTROL: ${control} must be in the scanned population (${readers.join(", ")})`);
  assert.deepEqual(modules.flatMap((m) => redOffence(m.file, m.source) ?? []), []);
  assert.deepEqual(Object.keys(EXEMPT).filter((f) => !readers.includes(f)), [], "a stale exemption: that module no longer reads red state, so remove the entry");
  assert.ok(Object.values(EXEMPT).every((why) => why.length > 20), "every exemption names its reason");
  assert.ok(Object.keys(EXEMPT).length <= EXEMPT_CEILING, `the exemption list may shrink, never grow: ${EXEMPT_CEILING}`);
});

test("#2956 ONE DECIDER, both directions: a fixture module with its own FAILURE set is an offender, and the same module importing the decider is not", () => {
  const own = `const RED = new Set(["FAILURE", "TIMED_OUT"]);\nexport const count = (prs) => prs.filter((p) => p.statusCheckRollup.some((c) => RED.has(c.conclusion))).length;\n`;
  assert.match(redOffence("fixture-own-set.mjs", own) ?? "", /fixture-own-set\.mjs reads red state/);
  const comment = `// statusCheckRollup is read by org-health, "FAILURE" is its conclusion\nexport const x = 1;\n`;
  assert.equal(redOffence("fixture-comment-only.mjs", comment), null, "a comment that NAMES the rollup does not enlist the file");
  const decided = `import { isBrokenRed } from "./red-pr.ts";\nexport const count = (prs) => prs.filter(isBrokenRed).length; // statusCheckRollup\n`;
  assert.equal(redOffence("fixture-decided.mjs", decided), null, "the remedy, applied, stops the complaint");
});

// --- the gate as a process ------------------------------------------------------------------------------------------

/** The real gate with a stub `gh` that answers the two list reads with `[]` and REFUSES every other call, and no journal. */
function gateAsAProcess() {
  const dir = mkdtempSync(join(tmpdir(), "org-health-gate-"));
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\ncase \"$*\" in\n  \"pr list\"*|\"issue list\"*) printf '%s' '[]' ;;\n  *) exit 1 ;;\nesac\n");
    writeFileSync(join(dir, "journalctl"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "gh"), STUB_MODE);
    chmodSync(join(dir, "journalctl"), STUB_MODE);
    return spawnSync(process.execPath, [GATE_ENTRY], { encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("THE GATE AS A PROCESS runs the question: a refused merge read is said on stderr as an UNKNOWN, and is not offered as a stall", () => {
  const ran = gateAsAProcess();
  assert.match(ran.stderr, /org-health: no-merge-while-work-exists UNKNOWN -- the last merge could not be read/, ran.stderr);
  const orders = ran.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Order);
  assert.deepEqual(orders.filter((o) => o.cause === "org-health"), [], "a refusal is not evidence of a stall");
  assert.deepEqual(SIGNALS.NO_MERGE, "no-merge-while-work-exists");
});

// --- 7. THE OUTCOME CLOCK (#3486) replaced #2970's `pr-not-progressing` and its tests, which were this section: they are in `outcome-clock.test.ts` ---
