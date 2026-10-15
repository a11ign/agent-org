// no-token: GhRun
// agent-org#982: a repository that changed with no event behind it at a reconcile is reported as a missed delivery, once per pass.
// agent-org#1207: the change is confirmed by the content the probe read (the newest `updated_at` and the item count), not by the tag alone.
// Every test drives `refreshTickSnapshot` itself (the real reconcile) with `run` and the filer injected, so the default `ghRun` is never reached (hence the `no-token` line above).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run } from "./ci-failure-class.ts";
import type { Drift } from "./event-drift.ts";
import type { GhRun } from "./tick-snapshot.ts";
import { connectionOf, readsRowsByLabel } from "./packaging/rows-by-label-fixtures.ts";
import { tmpDir, tmpDirForFile } from "./lib/tmp-fixture.ts";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE, as `tick-snapshot-events.test.ts` does: `event-drift.ts` imports `ci-failure-class.ts`, which resolves the checkout it serves
// when it is imported, so the host is set BEFORE the dynamic import and the row's acceptance command needs no environment of its own.
const SCRATCH = tmpDirForFile("event-drift-");
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { countSuppressed, fileDrift, groupOf, probeName, readSuppressed, suppressedPath } = await import("./event-drift.ts");
const { factsOf, refreshTickSnapshot, probePaths } = await import("./tick-snapshot.ts");

const SEC = 1000;
const DAY = "2026-10-11";
const T0 = Date.parse("2026-10-11T19:00:00Z");
const REPO = "a11ign/agent-org";
const RECONCILE_SECONDS = 20 * 60;
const [ISSUES, RUNS] = probePaths(REPO);
const healthy = (changed: string[] = []) => ({ changed: new Set(changed), healthy: true, reconcileEverySeconds: RECONCILE_SECONDS });

/** What a probe reads: the tag it is answered with and the body under it. */
type Reading = { tag: string; body: string };
/** The body an issues list answers with: one item per `updated_at`, newest first, as `probePaths` sorts it. */
const issuesOf = (...updated: string[]) => JSON.stringify(updated.map((updated_at, i) => ({ number: 100 - i, updated_at })));
/** The body an Actions answer has: its `workflow_runs`, one per `updated_at`. */
const runsOf = (...updated: string[]) => JSON.stringify({ total_count: updated.length, workflow_runs: updated.map((updated_at) => ({ updated_at })) });
const ISSUES_BODY = issuesOf("2026-10-11T18:00:00Z", "2026-10-11T17:00:00Z");
const ISSUES_NEW_ITEM = issuesOf("2026-10-11T19:05:00Z", "2026-10-11T18:00:00Z", "2026-10-11T17:00:00Z");
const ISSUES_NEWER = issuesOf("2026-10-11T19:50:00Z", "2026-10-11T19:05:00Z", "2026-10-11T18:00:00Z", "2026-10-11T17:00:00Z");
const RUNS_BODY = runsOf("2026-10-11T18:30:00Z");
const RUNS_NEW_RUN = runsOf("2026-10-11T19:06:00Z", "2026-10-11T18:30:00Z");

/** `steady`'s reading of a path: the tag held since the baseline, and the body it was read with. */
const steadyReading = (path: string): Reading => (path.includes("/actions/runs") ? { tag: "t1", body: RUNS_BODY } : { tag: "t1", body: ISSUES_BODY });
/** A `gh` answering 200 with the reading chosen per path at call time. */
const gh = (readingFor: (path: string) => Reading): GhRun => (args) => {
  const { tag, body } = readingFor(args[args.length - 1]);
  return { stdout: `HTTP/2.0 200 OK\r\nEtag: "${tag}"\r\n\r\n${body}`, status: 0 };
};
/** `steady`, but the probe at `path` answers `reading` instead. */
const instead = (path: string, reading: Reading): GhRun => gh((p) => (p === path ? reading : steadyReading(p)));
const steady = gh(steadyReading);
const issuesMoved = instead(ISSUES, { tag: "t2", body: ISSUES_NEW_ITEM });
const runsMoved = instead(RUNS, { tag: "t2", body: RUNS_NEW_RUN });
/** A new ETag over the SAME items: how an anonymous and an authenticated read of one list differ (agent-org#1207). */
const sameBodyNewTag = instead(ISSUES, { tag: "t2", body: ISSUES_BODY });
/** Every repository in `repos` has a new issue at the top of its list. */
const everyMoved = (repos: string[]): GhRun => gh((path) => (repos.some((r) => probePaths(r)[0] === path) ? { tag: "t2", body: ISSUES_NEW_ITEM } : steadyReading(path)));

/** A filer that records each pass's drifts and answers `accept` (a refused filing is `false`). */
const filer = (accept: () => boolean = () => true) => {
  const filed: Drift[][] = [];
  return { filed, fileDrift: (drifts: readonly Drift[]) => { filed.push([...drifts]); return accept(); } };
};

/** An incident row as the fake keeps it: what `gh` lists for an open or a closed incident. */
type StoredRow = { number: number; body: string; state: "OPEN" | "CLOSED"; labels: { name: string }[]; createdAt: string; closedAt: string | null };

/**
 * A fake `gh` that keeps the incident rows `fileDrift` files (agent-org#1330): the by-label read lists them, `issue create` adds one, `issue edit` changes one, and
 * every other call answers empty. `fileDrift` is the real one, run against this `gh`, so a join and a fold are read back from the rows and not assumed.
 */
function incidentStore() {
  const rows: StoredRow[] = [];
  const creates: string[][] = [];
  const logs: string[] = [];
  const run: Run = (args) => {
    const read = readsRowsByLabel(args);
    if (read !== null) return connectionOf(rows.filter((row) => row.state === read.state));
    if (args.some((arg) => arg.includes("projectItems"))) return JSON.stringify({ data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    if (args[0] === "issue" && args[1] === "create") {
      creates.push(args);
      const number = 1000 + rows.length + 1;
      rows.push({ number, body: args[args.indexOf("--body") + 1], state: "OPEN", labels: [], createdAt: new Date(T0).toISOString(), closedAt: null });
      return `https://github.com/${REPO}/issues/${number}\n`;
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const row = rows.find((r) => r.number === Number(args[2]))!;
      if (args.includes("--body")) row.body = args[args.indexOf("--body") + 1];
      for (let i = 0; i < args.length; i++) if (args[i] === "--add-label") row.labels.push({ name: args[i + 1] });
    }
    return "";
  };
  return {
    run, rows, creates, logs,
    close: (number: number, atMs: number) => {
      const row = rows.find((r) => r.number === number)!;
      row.state = "CLOSED";
      row.closedAt = new Date(atMs).toISOString();
    },
    fileDrift: (drifts: readonly Drift[]) => fileDrift(drifts, { run, log: (line) => logs.push(line) }),
  };
}

/** A cache directory that has been read once at T0 (baseline: no drift is possible on a first reading). */
function baselined(repos: string[] = [REPO]) {
  const dir = tmpDir("event-drift-");
  refreshTickSnapshot({ repos, homeRepo: REPO, configDir: dir, run: steady, nowMs: T0, events: healthy() });
  return dir;
}
type Filer = { fileDrift: (drifts: readonly Drift[]) => boolean };
const reconcileAll = (dir: string, repos: string[], run: GhRun, at: number, f: Filer, changed: string[] = []) =>
  refreshTickSnapshot({ repos, homeRepo: REPO, configDir: dir, run, nowMs: T0 + at * SEC, events: healthy(changed), fileDrift: f.fileDrift });
const reconcile = (dir: string, run: GhRun, at: number, f: Filer, changed: string[] = []) => reconcileAll(dir, [REPO], run, at, f, changed);

test("POSITIVE CONTROL: a probe whose tag AND content moved at a reconcile with no event files one incident naming the repository, the window and the probe", () => {
  const dir = baselined();
  const f = filer();
  const lines = reconcile(dir, issuesMoved, RECONCILE_SECONDS, f);
  assert.equal(f.filed.length, 1);
  assert.deepEqual(f.filed[0], [{ repo: REPO, probe: "issues list", windowStartS: T0 / SEC, nowS: T0 / SEC + RECONCILE_SECONDS }]);
  assert.match(lines[0], /MISSED DELIVERY inferred from the issues list probe, incident filed/);
  const later = filer();
  reconcile(baselined(), runsMoved, RECONCILE_SECONDS, later);
  assert.equal(later.filed[0][0].probe, "actions/runs", "the other probe names itself");
});

test("NEGATIVE CONTROL: a probe that moved with an event naming the repository is not drift, and an unchanged probe is not either", () => {
  const withEvent = filer();
  const lines = reconcile(baselined(), issuesMoved, RECONCILE_SECONDS, withEvent, [REPO.toUpperCase()]);
  assert.deepEqual(withEvent.filed, [], "an event in the queue explains the move, whatever case GitHub spells the repository in");
  assert.doesNotMatch(lines[0], /MISSED DELIVERY/);
  const quiet = filer();
  reconcile(baselined(), steady, RECONCILE_SECONDS, quiet);
  assert.deepEqual(quiet.filed, []);
});

test("POSITIVE CONTROL (agent-org#1431): an event that named the repository after its baseline explains the move at the due reconcile, so no drift is filed; the next baseline is that reconcile's read", () => {
  const dir = baselined();
  const f = filer();
  // Tick 1: the event names the repository and its content moved with it. The repository is not due, so nothing is re-read.
  reconcile(dir, issuesMoved, 60, f, [REPO]);
  // The due reconcile reads the moved content with no event in its own tick: the event above is the explanation, not a lost delivery.
  const due = reconcile(dir, issuesMoved, 60 + RECONCILE_SECONDS, f);
  assert.deepEqual(f.filed, [], "the baseline is older than the event, but the event named the repository after it was read");
  assert.doesNotMatch(due[0], /MISSED DELIVERY/);
  assert.match(due[0], /CHANGED \(no event\)/);
  // The reconcile that found nothing read the content again, so a later move with no event is judged from THAT read, and its window starts there.
  reconcile(dir, instead(ISSUES, { tag: "t3", body: ISSUES_NEWER }), 60 + 2 * RECONCILE_SECONDS, f);
  assert.deepEqual(f.filed, [[{ repo: REPO, probe: "issues list", windowStartS: (T0 + (60 + RECONCILE_SECONDS) * SEC) / SEC, nowS: (T0 + (60 + 2 * RECONCILE_SECONDS) * SEC) / SEC }]]);
});

test("the window of a drift starts at the time its baseline was READ, even when a later tick re-read the content on the poll path while the receiver was down (agent-org#1431)", () => {
  const dir = baselined();
  const f = filer();
  refreshTickSnapshot({ repos: [REPO], homeRepo: REPO, configDir: dir, run: steady, nowMs: T0 + 60 * SEC, events: { ...healthy(), healthy: false }, fileDrift: f.fileDrift });
  const lines = reconcile(dir, issuesMoved, RECONCILE_SECONDS, f);
  assert.deepEqual(f.filed, [[{ repo: REPO, probe: "issues list", windowStartS: (T0 + 60 * SEC) / SEC, nowS: T0 / SEC + RECONCILE_SECONDS }]], "the content was read at T0+60, not at the T0 the window was last moved");
  assert.match(lines[0], /MISSED DELIVERY inferred from the issues list probe, incident filed/);
});

test("NEGATIVE CONTROL: a tag that moved over the SAME content is not drift and files nothing, while the probe still says CHANGED", () => {
  const dir = baselined();
  const f = filer();
  const lines = reconcile(dir, sameBodyNewTag, RECONCILE_SECONDS, f);
  assert.deepEqual(f.filed, [], "a new ETag over the same items is not a missed delivery");
  assert.doesNotMatch(lines[0], /MISSED DELIVERY/);
  assert.match(lines[0], /CHANGED \(no event\)/);
});

test("a tag that moved over the same content is counted for the day, not filed, and the content is carried so the next such tag is counted too", () => {
  const dir = baselined();
  reconcile(dir, sameBodyNewTag, RECONCILE_SECONDS, filer());
  reconcile(dir, instead(ISSUES, { tag: "t3", body: ISSUES_BODY }), 2 * RECONCILE_SECONDS, filer());
  assert.equal(readSuppressed(suppressedPath(join(dir, "read-cache")))[DAY], 2);
});

test("the tally keeps the last 14 UTC days and nothing older", () => {
  const path = join(tmpDir("event-drift-tally-"), "suppressed.json");
  for (let day = 0; day < 16; day++) countSuppressed(path, Date.parse("2026-10-01T12:00:00Z") + day * 24 * 3600 * SEC, 1);
  const kept = Object.keys(readSuppressed(path));
  assert.equal(kept.length, 14);
  assert.equal(kept[0], "2026-10-16");
  assert.equal(kept.at(-1), "2026-10-03");
});

test("a repository not yet due is not probed at all, and a first reading is a baseline, never drift", () => {
  const dir = baselined();
  const calls: string[][] = [];
  const f = filer();
  reconcile(dir, (args) => { calls.push(args); return issuesMoved(args); }, RECONCILE_SECONDS - 1, f);
  assert.deepEqual([calls.length, f.filed.length], [0, 0], "inside the window a quiet tick still asks GitHub nothing");
  const fresh = filer();
  refreshTickSnapshot({ repos: [REPO], homeRepo: REPO, configDir: tmpDir("event-drift-first-"), run: issuesMoved, nowMs: T0, events: healthy(), fileDrift: fresh.fileDrift });
  assert.deepEqual(fresh.filed, [], "no tag was held, so there is nothing the probe moved from");
});

test("a tag held WITHOUT the content it was read with (a file written before this check) is a baseline: a move is not confirmed by content", () => {
  const dir = baselined();
  const path = join(dir, "read-cache", "etags.json");
  const tags = JSON.parse(readFileSync(path, "utf8"));
  for (const held of Object.values(tags) as { facts?: unknown }[]) delete held.facts;
  writeFileSync(path, JSON.stringify(tags));
  const f = filer();
  const lines = reconcile(dir, issuesMoved, RECONCILE_SECONDS, f);
  assert.deepEqual(f.filed, []);
  assert.match(lines[0], /CHANGED \(no event\)/);
});

test("a moved tag whose body cannot be read as the list it was asked for is not confirmed, so it is not drift", () => {
  for (const body of ["<html>rate limited</html>", JSON.stringify([{ number: 1 }])]) {
    const f = filer();
    const lines = reconcile(baselined(), instead(ISSUES, { tag: "t2", body }), RECONCILE_SECONDS, f);
    assert.deepEqual(f.filed, [], body);
    assert.match(lines[0], /CHANGED/);
  }
});

test("the probe pair runs ONCE at a due reconcile, and the same drift is not filed again by the next ticks; a second reconcile that finds the repository moved again joins the OPEN row", () => {
  const dir = baselined();
  const calls: string[][] = [];
  const store = incidentStore();
  const counting = (args: string[]) => { calls.push(args); return issuesMoved(args); };
  reconcile(dir, counting, RECONCILE_SECONDS, store);
  assert.equal(calls.length, 2);
  assert.equal(store.creates.length, 1, "the first reconcile files one row");
  const first = store.rows[0].body;
  reconcile(dir, counting, RECONCILE_SECONDS + 60, store);
  reconcile(dir, counting, RECONCILE_SECONDS + 120, store);
  assert.equal(store.creates.length, 1, "per tick it is filed once: the window moved when it was");
  assert.equal(calls.length, 2, "and the following ticks asked nothing");
  reconcile(dir, instead(ISSUES, { tag: "t3", body: ISSUES_NEWER }), 2 * RECONCILE_SECONDS, store);
  assert.equal(store.creates.length, 1, "a second reconcile that finds the same repository moved again joins the open row and files no second one");
  assert.deepEqual(store.rows.map((row) => row.state), ["OPEN"]);
  assert.equal(store.rows[0].body, first, "and the join leaves the first window in the row's Step, as it was filed");
  assert.match(first, /reconcile window 2026-10-11T19:00:00Z to 2026-10-11T19:20:00Z/);
});

test("a repository set that moves again within the quiet window after its row CLOSED is folded into that row; after the window it files a row of its own", () => {
  const dir = baselined();
  const store = incidentStore();
  reconcile(dir, issuesMoved, RECONCILE_SECONDS, store);
  const closedAt = 2 * RECONCILE_SECONDS;
  store.close(store.rows[0].number, T0 + closedAt * SEC);
  reconcile(dir, instead(ISSUES, { tag: "t3", body: ISSUES_NEWER }), closedAt, store);
  assert.equal(store.creates.length, 1, "inside the quiet window the closed row takes it: no row is filed");
  assert.deepEqual(store.rows.map((row) => row.state), ["CLOSED"]);
  assert.match(store.logs.join(""), new RegExp(`${REPO} moved again within the quiet window after incident #${store.rows[0].number} closed; folded into it, no row filed`));
  const ISSUES_NEWEST = issuesOf("2026-10-12T10:00:00Z", "2026-10-11T19:50:00Z");
  const late = closedAt + 24 * 60 * 60 + RECONCILE_SECONDS;
  reconcile(dir, instead(ISSUES, { tag: "t4", body: ISSUES_NEWEST }), late, store);
  assert.equal(store.creates.length, 2, "past the quiet window the next move is a row of its own");
  assert.deepEqual(store.rows.map((row) => row.state), ["CLOSED", "OPEN"]);
});

test("a DIFFERENT repository set that drifts while the first row is open files its own row, and the first row is left as it was", () => {
  const OTHER = "a11ign/other";
  const dir = baselined([REPO, OTHER]);
  const store = incidentStore();
  reconcileAll(dir, [REPO, OTHER], issuesMoved, RECONCILE_SECONDS, store);
  assert.equal(store.creates.length, 1, "the first pass drifts one repository: one row");
  const first = store.rows[0].body;
  const bothMoved = gh((path) => (path === ISSUES || path === probePaths(OTHER)[0] ? { tag: "t3", body: ISSUES_NEWER } : steadyReading(path)));
  reconcileAll(dir, [REPO, OTHER], bothMoved, 2 * RECONCILE_SECONDS, store);
  assert.equal(store.creates.length, 2, "the set is not the first set, so it is a row of its own");
  assert.equal(store.rows[0].body, first, "and the first row is not rewritten");
  assert.match(store.rows[1].body, new RegExp(`${REPO}: issues list; ${OTHER}: issues list moved`));
});

test("a closed-row read that fails files nothing and reports the filing as not made, so the next tick retries it", () => {
  const drift: Drift = { repo: REPO, probe: "issues list", windowStartS: T0 / SEC, nowS: T0 / SEC + RECONCILE_SECONDS };
  const logs: string[] = [];
  const run: Run = () => { throw new Error("gh refused"); };
  const filed = fileDrift([drift], { run, log: (line) => logs.push(line), record: () => { throw new Error("recorded without reading the rows"); } });
  assert.equal(filed, false);
  assert.match(logs.join(""), /could not read the incident rows \(gh refused\); the next tick retries/);
});

test("seven repositories drifted in one pass are filed as ONE incident naming every one of them", () => {
  const SEVEN = Array.from({ length: 7 }, (_, i) => `a11ign/repo-${i + 1}`);
  const dir = baselined(SEVEN);
  const f = filer();
  const lines = reconcileAll(dir, SEVEN, everyMoved(SEVEN), RECONCILE_SECONDS, f);
  assert.equal(f.filed.length, 1, "one fileDrift call for the pass");
  assert.deepEqual(f.filed[0].map((d) => d.repo), SEVEN);
  assert.equal(lines.filter((line) => /incident filed/.test(line)).length, 7);
  const { signature } = groupOf(f.filed[0]);
  for (const repo of SEVEN) assert.match(signature.check, new RegExp(`${repo}: issues list`));
});

test("a filing `gh` refused is retried the next tick and not lost; once filed it is not filed again", () => {
  const dir = baselined();
  let accept = false;
  const f = filer(() => accept);
  const first = reconcile(dir, issuesMoved, RECONCILE_SECONDS, f);
  assert.match(first[0], /incident NOT filed, retried next tick/);
  accept = true;
  const second = reconcile(dir, issuesMoved, RECONCILE_SECONDS + 60, f);
  assert.equal(f.filed.length, 2, "the window stayed open, so the probe read CHANGED against the same tag again");
  assert.equal(groupOf(f.filed[0]).key, groupOf(f.filed[1]).key, "and it is the same window: recordIncident joins a row that was in fact created");
  assert.match(second[0], /incident filed/);
  reconcile(dir, issuesMoved, RECONCILE_SECONDS + 120, f);
  assert.equal(f.filed.length, 2);
});

test("the default filer reaches `recordIncident` with the group and reports its refusal as `false`", () => {
  const drift: Drift = { repo: REPO, probe: "issues list", windowStartS: T0 / SEC, nowS: T0 / SEC + RECONCILE_SECONDS };
  const seen: string[] = [];
  const run = () => connectionOf([]);
  assert.equal(fileDrift([drift], { run, log: () => {}, record: (group, deps) => { seen.push(group.key); assert.equal(deps.run, run); return 982; } }), true);
  assert.equal(fileDrift([drift], { run, log: () => {}, record: () => null }), false);
  assert.deepEqual(seen, [`event-drift:${REPO}`], "keyed by the repository set, with no window");
  assert.equal(probeName(ISSUES), "issues list");
});

test("factsOf reads the newest updated_at and the count of an issues list or an Actions answer, and nothing it cannot confirm", () => {
  assert.deepEqual(factsOf(`HTTP/2.0 200 OK\r\nEtag: "t"\r\n\r\n${ISSUES_NEW_ITEM}`), { newest: "2026-10-11T19:05:00Z", count: 3 });
  assert.deepEqual(factsOf(`HTTP/2.0 200 OK\r\n\r\n${RUNS_NEW_RUN}`), { newest: "2026-10-11T19:06:00Z", count: 2 });
  assert.deepEqual(factsOf("HTTP/2.0 200 OK\r\n\r\n[]"), { newest: null, count: 0 });
  assert.equal(factsOf("HTTP/2.0 200 OK\r\n\r\n<html>"), undefined);
  assert.equal(factsOf("HTTP/2.0 200 OK\r\n"), undefined, "no blank line: no body");
});

test("the incident text names every repository, the window and the probe, says it is inferred, and names both false-drift sources (printed for the PR)", () => {
  const drifts: Drift[] = [
    { repo: REPO, probe: "actions/runs", windowStartS: T0 / SEC, nowS: T0 / SEC + RECONCILE_SECONDS },
    { repo: "a11ign/other", probe: "issues list", windowStartS: T0 / SEC, nowS: T0 / SEC + RECONCILE_SECONDS },
  ];
  const { signature, key } = groupOf(drifts);
  assert.equal(groupOf([drifts[1], drifts[0]]).key, key, "the group does not depend on the order the pass found them in");
  const text = [`key: ${key}`, `check: ${signature.check}`, `step: ${signature.step}`, `line: ${signature.line}`].join("\n");
  console.log(text);
  assert.match(signature.check, /a11ign\/agent-org: actions\/runs; a11ign\/other: issues list moved/);
  assert.match(signature.step, /2026-10-11T19:00:00Z to 2026-10-11T19:20:00Z/);
  assert.match(signature.line, /INFERRED from the probe, not seen/);
  assert.match(signature.line, /Project board edit/);
  assert.match(signature.line, /after this probe within the same tick/);
});
