// @ts-check
// THE REAL READERS, AGAINST RECORDED OUTPUT (a11ign/a11ign#3008, row 5b of 13). Each of the seven is handed what `gh api`, `systemctl show` or a file
// held when it was recorded and must give the value its source expects; each is also handed a failing call and must THROW, which is what the source
// turns into `cannot-ask`. The done-whens run through the real core and the in-memory provider on a clock the test owns.
//
// POSITIVE CONTROLS, because "no event" is what a source that never fires reports too: a green `main`, a single idle sample and an idle fleet with an
// EMPTY queue each sit beside the fixture that differs in one field and DOES produce an event.
//
// The recordings are trimmed to the fields a reader uses. They were taken from the live API on 2026-10-02 (shapes only: every name, number and
// host below is invented, and no private address is in this file).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createFakeProvider } from "../fake-provider.ts";
import { createLedger } from "../ledger.ts";
import { HOST_SOURCES, assertReadOnlyGh, createGhReader, main, runWatch } from "../watch.ts";
import { COMPLETION_FILE, writeCompletion } from "../../lib/tick-completion.ts";
import { ciPermissionEvents, observeIncidents } from "./incidents.ts";
import {
  SYSTEMD_PROPERTIES, createReaders, readCiRuns, readEpisodeStart, readFixRow, readFleetRoster, readFleetState, readGateUnit, readLastMerge, readLastTick, readTicks, readTrunkRuns, takeSample,
} from "./readers.ts";
import { observeStalls } from "./stall.ts";

const REPO = "example/project";
const MINUTE = 60_000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const iso = (/** @type {number} */ ms: number) => new Date(ms).toISOString();

const scratch = mkdtempSync(join(tmpdir(), "messaging-readers-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let directories = 0;
const freshDirectory = () => mkdtempSync(join(scratch, `d${(directories += 1)}-`));

/** A GET-only GitHub: the first route whose pattern matches answers, an `Error` answer throws, and every path asked is kept. */
function fakeGithub(/** @type {[RegExp, unknown][]} */ routes: [RegExp, unknown][]) {
  const calls: string[] = /** @type {string[]} */ ([]);
  return {
    calls,
    async api(/** @type {string} */ path: string) {
      calls.push(path);
      for (const [pattern, answer] of routes) {
        if (!pattern.test(path)) continue;
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer(path) : answer;
      }
      throw new Error(`no route for gh api ${path}`);
    },
  };
}

const DOWN = new Error("HTTP 502: Bad Gateway");

// ---- recordings --------------------------------------------------------------------------------------------------------------------------

const closedPulls = (/** @type {(string | null)[]} */ ...mergedAt: (string | null)[]) => mergedAt.map((merged_at, index) => ({ number: 900 - index, merged_at, updated_at: merged_at ?? "2026-10-01T00:00:00Z" }));

const trunkRun = (/** @type {Record<string, unknown>} */ more: Record<string, unknown>) => ({
  id: 1, name: "trunk", status: "completed", conclusion: "success", head_sha: "0123456789abcdef0123456789abcdef01234567", created_at: iso(NOW - 40 * MINUTE),
  updated_at: iso(NOW - 31 * MINUTE), html_url: "https://github.example/example/project/actions/runs/1", event: "push", ...more,
});

const systemdShow = (/** @type {Record<string, string>} */ properties: Record<string, string>) => Object.entries(properties).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
const seconds = (/** @type {number} */ ms: number) => `@${Math.floor(ms / 1000)}`;

const waitingRow = (/** @type {number} */ number: number, /** @type {string[]} */ labels: string[] = ["ready", "lane:any"]) => ({ number, labels: labels.map((name) => ({ name })) });
const seatsOf = (/** @type {string} */ state: string) => [{ label: "ceo", status: state }, { label: "worker-1", status: state }];

/** Every read answering as a healthy host would; `more` replaces routes. @param {Partial<{ merged: string | null, trunk: unknown, seats: any, waiting: unknown, ci: unknown }>} [more] */
function healthy(more: Partial<{ merged: string | null; trunk: unknown; seats: any; waiting: unknown; ci: unknown; }> = {}) {
  return fakeGithub([
    [/\/pulls\?/, closedPulls(more.merged === undefined ? iso(NOW - 10 * MINUTE) : more.merged)],
    [/workflows\/trunk\.yml\/runs/, { workflow_runs: more.trunk ?? [trunkRun({ updated_at: iso(NOW - 10 * MINUTE) })] }],
    [/actions\/runs\?/, { workflow_runs: more.ci ?? [trunkRun({ id: 7, name: "auto-arm" })] }],
    [/\/issues\?/, more.waiting ?? []],
  ]);
}

/** @param {{ github: any, stateDir?: string, now?: () => number, seats?: any, unitText?: string | Error, fleetStatePath?: string, completedAt?: number | null }} input  `seats` may be a function, read at each sample; `completedAt` is the tick record's time, `null` for none */
function readersFor({ github, stateDir = freshDirectory(), now = () => NOW, seats = seatsOf("idle"), unitText, fleetStatePath = join(stateDir, "fleet.json"), completedAt = NOW - MINUTE }: { github: any; stateDir?: string; now?: () => number; seats?: any; unitText?: string | Error; fleetStatePath?: string; completedAt?: number | null; }) {
  const systemctlCalls: string[][] = /** @type {string[][]} */ ([]);
  const text = unitText ?? systemdShow({ ActiveState: "activating", StateChangeTimestamp: seconds(NOW - 1000), InactiveEnterTimestamp: seconds(NOW - 60_000) });
  const completionPath = join(stateDir, COMPLETION_FILE);
  if (completedAt !== null) writeCompletion(completionPath, { at: completedAt, exit: 0 });
  const readers = createReaders({
    github, repo: REPO, stateDir, fleetStatePath, completionPath, unit: "example-work-tick.service", now, readSeats: () => (typeof seats === "function" ? seats() : seats),
    systemctl: async (argv) => { systemctlCalls.push(argv); if (text instanceof Error) throw text; return text; },
  });
  if (!existsSync(fleetStatePath)) {
    writeFileSync(fleetStatePath, "{}\n");
    utimesSync(fleetStatePath, NOW / 1000, NOW / 1000);
  }
  return { readers, stateDir, systemctlCalls };
}

// ---- readLastMerge -----------------------------------------------------------------------------------------------------------------------

describe("readLastMerge", () => {
  test("is the newest merged_at, ignoring a closed-unmerged pull request that was updated more recently", async () => {
    const github = fakeGithub([[/\/pulls\?state=closed&base=main/, closedPulls(null, "2026-10-02T09:00:00Z", "2026-10-02T11:30:00Z", "2026-10-01T08:00:00Z")]]);
    assert.equal(await readLastMerge({ github, repo: REPO }), Date.parse("2026-10-02T11:30:00Z"));
    assert.match(github.calls[0], /^repos\/example\/project\/pulls\?state=closed&base=main&sort=updated&direction=desc&per_page=30$/);
  });

  test("a failing call throws, and so does a window with no merge in it (no merge time is not 'a very old merge')", async () => {
    await assert.rejects(readLastMerge({ github: fakeGithub([[/./, DOWN]]), repo: REPO }), /502/);
    await assert.rejects(readLastMerge({ github: fakeGithub([[/./, closedPulls(null, null)]]), repo: REPO }), /no merge time is known/);
    await assert.rejects(readLastMerge({ github: fakeGithub([[/./, { message: "Not Found" }]]), repo: REPO }), /array was expected/);
  });

  test("through the source: a merge 5h59m ago is quiet and one 6h01m ago is one stall:no-merge event (the positive control)", async () => {
    for (const [age, expected] of [[5 * 60 + 59, 0], [6 * 60 + 1, 1]]) {
      const { readers } = readersFor({ github: healthy({ merged: iso(NOW - age * MINUTE) }) });
      const { events } = await observeStalls({ now: () => NOW, readers, log: () => {} });
      assert.equal(events.filter((event) => event.key === "stall:no-merge" && event.resolved === false).length, expected, `${age} minutes`);
    }
  });
});

// ---- readTrunkRuns -----------------------------------------------------------------------------------------------------------------------

describe("readTrunkRuns", () => {
  test("is the workflow's runs on main, as the source reads them", async () => {
    const runs = [trunkRun({ id: 2, conclusion: "failure" }), trunkRun({ id: 1 })];
    const github = fakeGithub([[/workflows\/trunk\.yml\/runs\?branch=main/, { total_count: 2, workflow_runs: runs }]]);
    assert.deepEqual(await readTrunkRuns({ github, repo: REPO }), runs);
    assert.equal(github.calls.length, 1);
  });

  test("a failing call and a body with no runs both throw", async () => {
    await assert.rejects(readTrunkRuns({ github: fakeGithub([[/./, DOWN]]), repo: REPO }), /502/);
    await assert.rejects(readTrunkRuns({ github: fakeGithub([[/./, { message: "Not Found" }]]), repo: REPO }), /array was expected/);
  });

  test("DONE-WHEN 2 through the real core: a red main at 29 minutes sends nothing and at 31 sends ONE, and a green main sends nothing", async () => {
    const redSince = NOW - 30 * MINUTE;
    const red = [trunkRun({ id: 5, conclusion: "failure", updated_at: iso(redSince) }), trunkRun({ id: 4, updated_at: iso(redSince - 20 * MINUTE) })];
    for (const [minutes, trunk, expected] of /** @type {[number, unknown[], number][]} */ ([[29, red, 0], [31, red, 1], [31, [trunkRun({ id: 6, updated_at: iso(redSince) })], 0]])) {
      let now = redSince + minutes * MINUTE;
      const { readers } = readersFor({ github: healthy({ trunk }), now: () => now });
      const provider = createFakeProvider();
      const ledger = createLedger({ path: join(freshDirectory(), "ledger.jsonl"), now: () => now });
      const base = { github: {}, provider, ledger, now: () => now, repo: REPO, readers, summary: { at: "08:00", timezone: "Europe/London" }, sources: HOST_SOURCES };
      await runWatch(base);
      const trunkMessages = provider.sent.filter((message) => /main is red/.test(message.text));
      assert.equal(trunkMessages.length, expected, `${minutes} minutes, ${trunk.length} run(s)`);
      if (expected === 0) continue;
      now += MINUTE;
      await runWatch(base);
      assert.equal(provider.sent.filter((message) => /main is red/.test(message.text)).length, 1, "a second pass sends nothing more");
    }
  });
});

// ---- readCiRuns --------------------------------------------------------------------------------------------------------------------------

describe("readCiRuns", () => {
  const failedRun = (/** @type {number} */ id: number, /** @type {string} */ name: string) => ({ ...trunkRun({ id, name, conclusion: "failure", updated_at: iso(NOW - id * MINUTE) }) });
  const routes = (/** @type {unknown[]} */ runs: unknown[], /** @type {string} */ message: string = "Error: Resource not accessible by integration") => /** @type {[RegExp, unknown][]} */ ([
    [/actions\/runs\?status=completed/, { workflow_runs: runs }],
    [/actions\/runs\/\d+\/jobs/, { jobs: [{ id: 5001, conclusion: "success" }, { id: 5002, conclusion: "failure" }] }],
    [/check-runs\/5002\/annotations/, [{ message, annotation_level: "failure" }]],
  ]);

  test("gives every completed run its annotations, read only for a FAILED run and only from its FAILED jobs", async () => {
    const github = fakeGithub(routes([failedRun(3, "deploy"), trunkRun({ id: 2, name: "auto-arm" })]));
    const runs = await readCiRuns({ github, repo: REPO, stateDir: freshDirectory() });
    assert.deepEqual(runs.map((run) => run.annotations.map((note: any) => note.message)), [["Error: Resource not accessible by integration"], []]);
    assert.deepEqual(github.calls.map((path) => path.replace(/^repos\/example\/project\//, "")), [
      "actions/runs?status=completed&per_page=20", "actions/runs/3/jobs?per_page=100", "check-runs/5002/annotations?per_page=100",
    ]);
  });

  test("through the source: a permission annotation is one incident:ci-permission event, and the same run with a different annotation is none", async () => {
    for (const [message, expected] of /** @type {[string, number][]} */ ([["Error: Resource not accessible by integration", 1], ["Error: process exited with code 1", 0]])) {
      const runs = await readCiRuns({ github: fakeGithub(routes([failedRun(3, "deploy")], message)), repo: REPO, stateDir: freshDirectory() });
      assert.equal(ciPermissionEvents(runs, NOW).filter((event) => event.resolved === false).length, expected, message);
    }
  });

  test("a completed run's annotations are read ONCE: the second pass costs the list and nothing else", async () => {
    const stateDir = freshDirectory();
    await readCiRuns({ github: fakeGithub(routes([failedRun(3, "deploy")])), repo: REPO, stateDir });
    const second = fakeGithub(routes([failedRun(3, "deploy")]));
    const runs = await readCiRuns({ github: second, repo: REPO, stateDir });
    assert.equal(second.calls.length, 1);
    assert.equal(runs[0].annotations.length, 1, "the kept annotations are still handed to the source");
  });

  test("a backlog of failed runs is read six at a time, and a run not yet read THROWS rather than reading as clean", async () => {
    const stateDir = freshDirectory();
    const failures = Array.from({ length: 8 }, (_, index) => failedRun(10 + index, "deploy"));
    await assert.rejects(readCiRuns({ github: fakeGithub(routes(failures)), repo: REPO, stateDir }), /2 failed run\(s\) have no annotations read yet/);
    const next = fakeGithub(routes(failures));
    const runs = await readCiRuns({ github: next, repo: REPO, stateDir });
    assert.equal(runs.length, 8);
    assert.equal(next.calls.filter((path) => /\/jobs/.test(path)).length, 2, "the six already read are not read again");
  });

  test("a failing list or jobs call throws", async () => {
    await assert.rejects(readCiRuns({ github: fakeGithub([[/./, DOWN]]), repo: REPO, stateDir: freshDirectory() }), /502/);
    await assert.rejects(readCiRuns({ github: fakeGithub([[/\/jobs/, DOWN], ...routes([failedRun(3, "deploy")])]), repo: REPO, stateDir: freshDirectory() }), /502/);
  });
});

// ---- readGateUnit ------------------------------------------------------------------------------------------------------------------------

describe("readGateUnit", () => {
  const RAN = 1790950909;
  const COMPLETED = (RAN - 120) * 1000;
  const recordIn = (/** @type {number | null} */ at: number | null, exit = 0) => {
    const path = join(freshDirectory(), COMPLETION_FILE);
    if (at !== null) writeCompletion(path, { at, exit });
    return path;
  };
  const ask = (/** @type {string | Error} */ text: string | Error, { unit = "example-work-tick.service", recordPath = recordIn(COMPLETED) } = {}) => {
    const calls: string[][] = /** @type {string[][]} */ ([]);
    const read = readGateUnit({ unit, recordPath, systemctl: async (argv) => { calls.push(argv); if (text instanceof Error) throw text; return text; } });
    return { read, calls };
  };

  test("a unit that is running reads not failed: it last RAN when it went inactive, and a tick last COMPLETED when the record says", async () => {
    const { read, calls } = ask(systemdShow({ ActiveState: "activating", StateChangeTimestamp: "@1790950951", InactiveEnterTimestamp: `@${RAN}` }));
    assert.deepEqual(await read, { failed: false, lastRunAt: RAN * 1000, lastRecordAt: COMPLETED });
    assert.deepEqual(calls, [["--user", "show", "example-work-tick.service", "--timestamp=unix", "-p", SYSTEMD_PROPERTIES]]);
  });

  test("a failed unit reads failed, and when it entered that state", async () => {
    const { read } = ask(systemdShow({ ActiveState: "failed", StateChangeTimestamp: "@1790951000", InactiveEnterTimestamp: `@${RAN}` }));
    assert.deepEqual(await read, { failed: true, failedAt: 1790951000 * 1000, lastRunAt: RAN * 1000, lastRecordAt: COMPLETED });
  });

  test("the record's time is what a tick that exited ATTENTION left, so the organisation waiting is not the gate crashing", async () => {
    const { read } = ask(systemdShow({ ActiveState: "inactive", StateChangeTimestamp: `@${RAN}`, InactiveEnterTimestamp: `@${RAN}` }), { recordPath: recordIn(COMPLETED, 1) });
    assert.equal((await read).lastRecordAt, COMPLETED);
  });

  test("a failing systemctl, a unit it knows no run of, no unit name and unparseable output all throw", async () => {
    await assert.rejects(ask(new Error("Failed to connect to bus")).read, /bus/);
    await assert.rejects(ask(systemdShow({ ActiveState: "inactive", StateChangeTimestamp: "", InactiveEnterTimestamp: "" })).read, /no such time/);
    await assert.rejects(ask(systemdShow({ ActiveState: "inactive", StateChangeTimestamp: "@0", InactiveEnterTimestamp: "@0" })).read, /no such time/);
    await assert.rejects(ask("garbage").read, /no ActiveState/);
    await assert.rejects(readGateUnit({ unit: undefined, recordPath: recordIn(COMPLETED), systemctl: async () => "" }), /name is not known/);
  });

  test("an ABSENT or UNREADABLE completion record is a thrown TypeError, never a clean reading", async () => {
    const running = systemdShow({ ActiveState: "inactive", StateChangeTimestamp: `@${RAN}`, InactiveEnterTimestamp: `@${RAN}` });
    await assert.rejects(ask(running, { recordPath: recordIn(null) }).read, (error) => error instanceof TypeError && /no work-tick completion record/.test(error.message));
    for (const [content, why] of /** @type {[string, RegExp][]} */ ([["not json", /is not JSON/], ["{}", /numeric `at`/], ['{"at":"soon","exit":0}', /numeric `at`/], ['{"at":1}', /integer `exit`/]])) {
      const recordPath = recordIn(null);
      writeFileSync(recordPath, content);
      await assert.rejects(ask(running, { recordPath }).read, (error) => error instanceof TypeError && why.test(error.message), content);
    }
  });

  test("through the source: a tick that completed 3 minutes ago is quiet, 8 minutes ago is the gate down (the positive control)", async () => {
    for (const [age, expected] of [[3, 0], [8, 1]]) {
      const unitText = systemdShow({ ActiveState: "active", StateChangeTimestamp: seconds(NOW - MINUTE), InactiveEnterTimestamp: seconds(NOW - MINUTE) });
      const { readers } = readersFor({ github: healthy(), unitText, completedAt: NOW - age * MINUTE });
      const { events } = await observeIncidents({ now: () => NOW, readers, log: () => {} });
      assert.equal(events.filter((event) => event.key === "incident:gate-crash" && event.resolved === false).length, expected, `${age} minutes`);
    }
  });

  test("through the source, the 2026-10-02 shape: the unit ran a minute ago and a tick last completed 2 hours ago is the gate down, and says so", async () => {
    const unitText = systemdShow({ ActiveState: "inactive", StateChangeTimestamp: seconds(NOW - MINUTE), InactiveEnterTimestamp: seconds(NOW - MINUTE) });
    const { readers } = readersFor({ github: healthy(), unitText, completedAt: NOW - 2 * 60 * MINUTE });
    const { events } = await observeIncidents({ now: () => NOW, readers, log: () => {} });
    const [down] = events.filter((event) => event.key === "incident:gate-crash");
    assert.equal(down.resolved, false);
    assert.match(String(down.text), /last tick that COMPLETED was at 2026-10-02T10:00:00\.000Z \(2h 00m ago\), and ticks are still starting/);
  });

  test("through the source: no record at all is cannot-ask for that kind and NO event, not an all-clear", async () => {
    const lines = /** @type {string[]} */ ([]);
    const { readers } = readersFor({ github: healthy(), completedAt: null });
    const { events, cannotAsk } = await observeIncidents({ now: () => NOW, readers, log: (line) => lines.push(line) });
    assert.equal(events.filter((event) => event.key === "incident:gate-crash").length, 0);
    assert.deepEqual(cannotAsk.map(({ source }) => source), ["incident:gate-crash"]);
    assert.match(cannotAsk[0].reason, /no work-tick completion record/);
  });
});

// ---- readFixRow --------------------------------------------------------------------------------------------------------------------------

/** What `issues?labels=incident&state=open` answers: the REST listing WITH bodies, which returns pull requests too. */
const fixRowIssue = (/** @type {number} */ number: number, /** @type {string | null} */ key: string | null, /** @type {Record<string, unknown>} */ more: Record<string, unknown> = {}) =>
  ({ number, labels: [{ name: "incident" }], body: key === null ? "no marker here" : `## What\n\nIncident: ${key}\n\nmore`, comments: 0, ...more });
const LISTING = /\/issues\?labels=incident&state=open/;
const commentOf = (/** @type {string} */ login: string, /** @type {string} */ at: string, /** @type {string} */ body: string) => ({ user: { login }, created_at: at, body });

describe("readFixRow", () => {
  const KEY = "incident:trunk-red";

  test("an open `incident` row whose body names the key, with no comment yet, is just its number", async () => {
    const github = fakeGithub([[LISTING, [fixRowIssue(3500, KEY)]]]);
    assert.deepEqual(await readFixRow({ github, repo: REPO, key: KEY }), { number: 3500 });
    assert.deepEqual(github.calls, [`repos/${REPO}/issues?labels=incident&state=open&per_page=100`], "no comments call for a row with none");
  });

  test("the newest comment BY AN ORG ACCOUNT is the one named, and a newer comment from anyone else is not the org's word", async () => {
    const github = fakeGithub([
      [LISTING, [fixRowIssue(3500, KEY, { comments: 4 })]],
      [/\/issues\/3500\/comments\?per_page=100&page=1$/, [
        commentOf("a11ign-ai-leads", "2026-10-04T10:00:00Z", "promoted"), commentOf("a11ign-ai-workers", "2026-10-04T11:00:00Z", "claimed, fixing"),
        commentOf("a-person", "2026-10-04T11:30:00Z", "any news?"), commentOf("a11ign-ai-leads", "2026-10-04T09:00:00Z", "filed"),
      ]],
    ]);
    assert.deepEqual(await readFixRow({ github, repo: REPO, key: KEY }), { number: 3500, comment: { author: "a11ign-ai-workers", at: Date.parse("2026-10-04T11:00:00Z"), text: "claimed, fixing" } });
  });

  test("the comments are read from the LAST page the listing's count names, and a page with no org comment sends the walk back one", async () => {
    const github = fakeGithub([
      [LISTING, [fixRowIssue(3500, KEY, { comments: 101 })]],
      [/page=2$/, [commentOf("a-person", "2026-10-04T12:00:00Z", "one more from outside")]],
      [/page=1$/, [commentOf("a11ign-bot", "2026-10-04T08:00:00Z", "first word")]],
    ]);
    const row = await readFixRow({ github, repo: REPO, key: KEY });
    assert.equal(row?.comment?.text, "first word");
    assert.deepEqual(github.calls.map((call) => call.split("&page=")[1]).filter(Boolean), ["2", "1"]);
  });

  test("a row with comments and none from the org is just its number (nobody from the org has spoken)", async () => {
    const github = fakeGithub([[LISTING, [fixRowIssue(3500, KEY, { comments: 1 })]], [/comments/, [commentOf("a-person", "2026-10-04T12:00:00Z", "hello")]]]);
    assert.deepEqual(await readFixRow({ github, repo: REPO, key: KEY }), { number: 3500 });
  });

  test("GitHub answering with no row that names the key is null: the one reading that says nobody has picked it up", async () => {
    assert.equal(await readFixRow({ github: fakeGithub([[LISTING, []]]), repo: REPO, key: KEY }), null);
    const others = [fixRowIssue(3501, "incident:fleet-down"), fixRowIssue(3502, null), fixRowIssue(3503, `${KEY}-extra`)];
    assert.equal(await readFixRow({ github: fakeGithub([[LISTING, others]]), repo: REPO, key: KEY }), null, "a row for another key, with no marker, or naming a longer key, is not this one's");
  });

  test("GitHub failing THROWS, which is not null (the positive control for the empty list above)", async () => {
    await assert.rejects(readFixRow({ github: fakeGithub([[LISTING, DOWN]]), repo: REPO, key: KEY }), /HTTP 502/);
    await assert.rejects(readFixRow({ github: fakeGithub([[LISTING, { message: "Bad credentials" }]]), repo: REPO, key: KEY }), /an array was expected/);
    await assert.rejects(readFixRow({ github: fakeGithub([[LISTING, [fixRowIssue(3500, KEY, { comments: 1 })]], [/comments/, DOWN]]), repo: REPO, key: KEY }), /HTTP 502/);
  });

  test("of several open items naming the key, the oldest is named", async () => {
    const github = fakeGithub([[LISTING, [fixRowIssue(3600, KEY), fixRowIssue(3510, KEY), fixRowIssue(3505, KEY)]]]);
    assert.deepEqual(await readFixRow({ github, repo: REPO, key: KEY }), { number: 3505 });
  });

  test("#3449: an open PULL REQUEST labelled `incident` with the key's line is the fix, and its `session:` label is the holder", async () => {
    const pr = fixRowIssue(3600, KEY, { pull_request: { url: "x" }, labels: [{ name: "incident" }, { name: "session:worker-3449" }] });
    const github = fakeGithub([[LISTING, [pr]]]);
    assert.deepEqual(await readFixRow({ github, repo: REPO, key: KEY }), { number: 3600, holder: "worker-3449" });
    assert.deepEqual(github.calls, [`repos/${REPO}/issues?labels=incident&state=open&per_page=100`], "only OPEN items are asked for: a merged or closed fix is not the fix in flight");
  });

  test("#3449: a pull request with no `session:` label is still the fix, with no holder; one naming another key, or none, is not", async () => {
    const bare = fixRowIssue(3601, KEY, { pull_request: {} });
    assert.deepEqual(await readFixRow({ github: fakeGithub([[LISTING, [bare]]]), repo: REPO, key: KEY }), { number: 3601 });
    const notThis = [fixRowIssue(3602, "incident:fleet-down", { pull_request: {} }), fixRowIssue(3603, null, { pull_request: {} })];
    assert.equal(await readFixRow({ github: fakeGithub([[LISTING, notThis]]), repo: REPO, key: KEY }), null);
  });

  test("#3449: a fix PR and a row both open: the older number is named, and its holder travels with it", async () => {
    const row = fixRowIssue(3700, KEY, { labels: [{ name: "incident" }, { name: "session:product-manager" }] });
    const pr = fixRowIssue(3650, KEY, { pull_request: {}, labels: [{ name: "incident" }, { name: "session:worker-1" }] });
    assert.deepEqual(await readFixRow({ github: fakeGithub([[LISTING, [row, pr]]]), repo: REPO, key: KEY }), { number: 3650, holder: "worker-1" });
  });

  test("a key that is not an incident or stall key is refused before GitHub is asked", async () => {
    const github = fakeGithub([]);
    for (const key of ["request:example/project#1", "summary:2026-10-02", "incident:", "incident:a&state=closed", ""]) {
      await assert.rejects(readFixRow({ github, repo: REPO, key }), /not an incident or stall key/, key);
    }
    assert.deepEqual(github.calls, []);
  });

  test("createReaders wires it, and every path it asks passes the read-only allowlist", async () => {
    const github = fakeGithub([[LISTING, [fixRowIssue(3503, "stall:no-merge", { comments: 1 })]], [/comments/, [commentOf("a11ign-ai-workers", "2026-10-04T11:00:00Z", "on it")]]]);
    const { readers } = readersFor({ github });
    assert.equal((await readers.readFixRow("stall:no-merge"))?.comment?.text, "on it");
    assert.equal(github.calls.length, 2);
    for (const call of github.calls) assert.doesNotThrow(() => assertReadOnlyGh(["api", call]), call);
  });
});

// ---- readEpisodeStart --------------------------------------------------------------------------------------------------------------------

describe("readEpisodeStart", () => {
  const KEY = "incident:trunk-red";
  const ledgerOf = (/** @type {Record<string, unknown>[]} */ ...lines: Record<string, unknown>[]) => {
    const path = join(freshDirectory(), "ledger.jsonl");
    writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    return path;
  };
  const line = (/** @type {string} */ ts: string, /** @type {string} */ kind: string, /** @type {string} */ status: string = "sent", /** @type {string} */ key: string = KEY) => ({ key, kind, status, ts });

  test("is when the chairman was first told of the open episode, not the later update or reminder", () => {
    const ledgerPath = ledgerOf(line("2026-10-04T10:00:00Z", "first"), line("2026-10-04T11:00:00Z", "reminder"), line("2026-10-04T11:30:00Z", "update"));
    assert.equal(readEpisodeStart({ ledgerPath, key: KEY }), Date.parse("2026-10-04T10:00:00Z"));
  });

  test("after a clear it is the NEXT episode's first send, and null when no episode is open", () => {
    const cleared = [line("2026-10-04T10:00:00Z", "first"), line("2026-10-04T10:40:00Z", "cleared")];
    assert.equal(readEpisodeStart({ ledgerPath: ledgerOf(...cleared), key: KEY }), null);
    assert.equal(readEpisodeStart({ ledgerPath: ledgerOf(...cleared, line("2026-10-04T13:00:00Z", "first")), key: KEY }), Date.parse("2026-10-04T13:00:00Z"));
  });

  test("a failed send is not being told, a withdrawn digest entry ends the episode, and another key's lines are not this one's", () => {
    const ledgerPath = ledgerOf(line("2026-10-04T10:00:00Z", "first", "failed"), line("2026-10-04T10:05:00Z", "first", "sent", "incident:fleet-down"), line("2026-10-04T10:10:00Z", "first", "digested"),
      line("2026-10-04T10:20:00Z", "withdrawn", "withdrawn"));
    assert.equal(readEpisodeStart({ ledgerPath, key: KEY }), null);
    assert.equal(readEpisodeStart({ ledgerPath, key: "incident:fleet-down" }), Date.parse("2026-10-04T10:05:00Z"));
  });

  test("a missing ledger is no episode, and createReaders reads the ledger beside the samples unless told otherwise", () => {
    assert.equal(readEpisodeStart({ ledgerPath: join(freshDirectory(), "absent.jsonl"), key: KEY }), null);
    const stateDir = freshDirectory();
    writeFileSync(join(stateDir, "ledger.jsonl"), `${JSON.stringify(line("2026-10-04T10:00:00Z", "first"))}\n`);
    assert.equal(readersFor({ github: fakeGithub([]), stateDir }).readers.readEpisodeStart(KEY), Date.parse("2026-10-04T10:00:00Z"));
  });
});

// ---- readFleetState

describe("readFleetState", () => {
  const stateFile = (/** @type {unknown} */ content: unknown, /** @type {number} */ writtenAt: number = NOW) => {
    const path = join(freshDirectory(), "fleet-watch-state.json");
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    utimesSync(path, writtenAt / 1000, writtenAt / 1000);
    return path;
  };

  test("is the state fleet-watch wrote and the time it wrote it, KEEPING ONLY THE WORKER'S NAME, never its address", () => {
    const path = stateFile({ "worker-a  host-a.example:8765": 1790750850944, "worker-b  host-b.example:8765": 1790750860000 }, NOW - 20 * MINUTE);
    const reading = readFleetState({ path });
    assert.deepEqual(reading.state, { "worker-a": 1790750850944, "worker-b": 1790750860000 });
    assert.equal(reading.writtenAt, NOW - 20 * MINUTE);
    assert.doesNotMatch(JSON.stringify(reading), /example|8765/);
  });

  test("a missing file and a file that is not an object both throw (fleet-watch's own reader calls them empty, which would be a false all-clear here)", () => {
    assert.throws(() => readFleetState({ path: join(freshDirectory(), "absent.json") }), /ENOENT/);
    assert.throws(() => readFleetState({ path: stateFile("[1, 2]") }), /an object of worker to time/);
    assert.throws(() => readFleetState({ path: stateFile("not json at all") }), SyntaxError);
  });

  test("through the source: a worker not ready for 11 minutes is one incident:fleet-down, 9 minutes is none, and a file 3 hours old is cannot-ask", async () => {
    for (const [minutes, expected] of [[9, 0], [11, 1]]) {
      const path = stateFile({ "worker-a  host-a.example:8765": NOW - minutes * MINUTE });
      const { readers } = readersFor({ github: healthy(), fleetStatePath: path });
      const { events } = await observeIncidents({ now: () => NOW, readers, log: () => {} });
      assert.equal(events.filter((event) => event.key === "incident:fleet-down" && event.resolved === false).length, expected, `${minutes} minutes`);
    }
    const stale = stateFile({ "worker-a  host-a.example:8765": NOW - 5 * 60 * MINUTE }, NOW - 3 * 60 * MINUTE);
    const { readers } = readersFor({ github: healthy(), fleetStatePath: stale });
    const result = await observeIncidents({ now: () => NOW, config: { fleetStateMaxAgeMs: 130 * MINUTE }, readers, log: () => {} });
    assert.deepEqual(result.cannotAsk.map(({ source }) => source), ["incident:fleet-down"]);
  });
});

// ---- readTicks and the samples -----------------------------------------------------------------------------------------------------------

describe("readTicks and takeSample", () => {
  /** Samples every minute for `minutes`, the first at `NOW`, then asks the stall source at the last one. */
  async function idleFor(/** @type {number} */ minutes: number, /** @type {unknown[]} */ waiting: unknown[]) {
    const stateDir = freshDirectory();
    let now = NOW;
    const { readers } = readersFor({ github: healthy({ waiting }), stateDir, now: () => now, seats: seatsOf("idle") });
    for (let elapsed = 0; elapsed <= minutes; elapsed += 1) {
      now = NOW + elapsed * MINUTE;
      await readers.takeSample();
    }
    const { events } = await observeStalls({ now: () => now, readers, log: () => {} });
    return events.filter((event) => event.key === "stall:all-idle" && event.resolved === false);
  }

  test("DONE-WHEN 3: 9 minutes of all-idle samples with rows waiting is no event, 11 minutes is one", async () => {
    assert.equal((await idleFor(9, [waitingRow(1)])).length, 0, "samples at every minute 0..9: a streak of 9 minutes");
    const fired = await idleFor(11, [waitingRow(1)]);
    assert.equal(fired.length, 1, "samples at every minute 0..11");
    assert.match(String(fired[0].text), /idle for 11m with 1 row waiting \(2 seats\)/);
  });

  test("POSITIVE CONTROLS: ONE sample alone never makes an event, and an idle fleet with an EMPTY queue makes none however long it is idle", async () => {
    assert.equal((await idleFor(0, [waitingRow(1)])).length, 0, "a single sample");
    assert.equal((await idleFor(60, [])).length, 0, "an hour idle, nothing waiting");
    assert.equal((await idleFor(60, [waitingRow(1, ["ready", "blocked"]), waitingRow(2, ["ready", "hold:worker-9"]), waitingRow(3, ["ready", "answer:ceo"])])).length, 0, "held rows are not waiting");
    assert.equal((await idleFor(60, [{ ...waitingRow(4), pull_request: {} }])).length, 0, "the issues listing returns pull requests too, and they are not rows");
  });

  test("a seat that is working breaks the streak: the event counts from the minute it went idle again", async () => {
    const stateDir = freshDirectory();
    let now = NOW;
    let seats = seatsOf("idle");
    const { readers } = readersFor({ github: healthy({ waiting: [waitingRow(1)] }), stateDir, now: () => now, seats: () => seats });
    for (let elapsed = 0; elapsed <= 22; elapsed += 1) {
      now = NOW + elapsed * MINUTE;
      seats = seatsOf(elapsed === 8 ? "working" : "idle");
      await readers.takeSample();
    }
    const { events } = await observeStalls({ now: () => now, readers, log: () => {} });
    assert.match(String(events[0].text), /idle for 13m /, "idle since minute 9, not since minute 0 (which would be 22m)");
    assert.equal(readers.readTicks().length, 23, "newest first");
    assert.equal(readers.readTicks()[0].at, now);
  });

});

describe("the samples file", () => {
  test("the history is newest first, one line per run, and bounded: the newest `limit` are read and the file is compacted only past a day's slack", async () => {
    const stateDir = freshDirectory();
    let now = NOW;
    const github = healthy();
    const limit = 10;
    const lines = () => readFileSync(join(stateDir, "samples.jsonl"), "utf8").split("\n").filter(Boolean).length;
    for (let index = 0; index < limit + 5; index += 1) {
      now = NOW + index * MINUTE;
      await takeSample({ github, repo: REPO, stateDir, now: () => now, readSeats: () => seatsOf("idle"), limit });
    }
    const ticks = readTicks({ stateDir, limit });
    assert.equal(ticks.length, limit);
    assert.equal(ticks[0].at, NOW + (limit + 4) * MINUTE);
    assert.equal(ticks[limit - 1].at, NOW + 5 * MINUTE, "the oldest five are not read");
    assert.equal(lines(), limit + 5, "appended, not rewritten, inside the slack");
    assert.deepEqual(ticks[0].seats, [{ session: "ceo", state: "idle" }, { session: "worker-1", state: "idle" }]);
    assert.equal(readTicks({ stateDir }).length, limit + 5, "the default limit is a week of samples and holds all of them");
  });

  test("past the slack the file is compacted to `limit` and the newest sample survives", async () => {
    const stateDir = freshDirectory();
    const github = healthy();
    const limit = 3;
    writeFileSync(join(stateDir, "samples.jsonl"), Array.from({ length: limit + 288 }, (_, index) => JSON.stringify({ at: NOW + index, seats: [], orders: [] })).join("\n") + "\n");
    await takeSample({ github, repo: REPO, stateDir, now: () => NOW + 99_999, readSeats: () => seatsOf("idle"), limit });
    const kept = readFileSync(join(stateDir, "samples.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).at);
    assert.deepEqual(kept, [NOW + limit + 286, NOW + limit + 287, NOW + 99_999]);
  });

  test("a sample whose seats cannot be read, or whose rows cannot be listed, THROWS and appends nothing (an empty roster would read as 'every seat idle')", async () => {
    const stateDir = freshDirectory();
    await assert.rejects(takeSample({ github: healthy(), repo: REPO, stateDir, now: () => NOW, readSeats: () => null }), /herdr could not be asked/);
    await assert.rejects(takeSample({ github: fakeGithub([[/./, DOWN]]), repo: REPO, stateDir, now: () => NOW, readSeats: () => seatsOf("idle") }), /502/);
    assert.deepEqual(readTicks({ stateDir }), []);
  });

  test("a line that is not JSON is skipped and SAID, so one bad line does not blind the source", async () => {
    const stateDir = freshDirectory();
    await takeSample({ github: healthy(), repo: REPO, stateDir, now: () => NOW, readSeats: () => seatsOf("idle") });
    writeFileSync(join(stateDir, "samples.jsonl"), `{ torn\n${readFileSync(join(stateDir, "samples.jsonl"), "utf8")}`);
    const logged: string[] = /** @type {string[]} */ ([]);
    assert.equal(readTicks({ stateDir, log: (line) => logged.push(line) }).length, 1);
    assert.match(logged.join("\n"), /1 line\(s\) .* not JSON/);
  });

  test("no samples yet is an empty history, which the source reports as cannot-ask", async () => {
    const { readers } = readersFor({ github: healthy() });
    const result = await observeStalls({ now: () => NOW, readers, log: () => {} });
    assert.ok(result.cannotAsk.some(({ source, reason }) => source === "stall:all-idle" && /no tick has been recorded/.test(reason)));
  });
});

// ---- the allowlist, the account's calls, and `main` --------------------------------------------------------------------------------------

describe("the read-only gh allowlist covers `gh api`", () => {
  const READS = [
    "repos/example/project/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=30",
    "repos/example/project/issues?labels=ready&state=open&per_page=100",
    "repos/example/project/issues?labels=incident&state=open&per_page=100",
    "repos/example/project/issues/3500/comments?per_page=100&page=2",
    "repos/example/project/actions/runs?status=completed&per_page=20",
    "repos/example/project/actions/workflows/trunk.yml/runs?branch=main&per_page=20",
    "repos/example/project/actions/runs/37018902747/jobs?per_page=100",
    "repos/example/project/check-runs/5002/annotations?per_page=100",
  ];

  test("every path the readers use is allowed", () => {
    for (const path of READS) assert.doesNotThrow(() => assertReadOnlyGh(["api", path]), path);
  });

  test("a method flag, a field, an input, another path and another verb are each refused", () => {
    const path = READS[0];
    for (const argv of [["api", path, "-X", "POST"], ["api", "-X", "DELETE", path], ["api", path, "-f", "state=closed"], ["api", path, "--input", "x.json"],
      ["api", "repos/example/project/issues/1/labels"], ["api", "repos/example/project/issues/1/comments/2"], ["api", "repos/example/project/git/refs"], ["api", "user"], ["api", "graphql"], ["api", "repos/example/project/pulls/1/merge"]]) {
      assert.throws(() => assertReadOnlyGh(argv), /reads only/, argv.join(" "));
    }
  });

  test("the real reader's `api` builds `gh api <path>` and parses what it printed", async () => {
    const commands: unknown = /** @type {string[][]} */ ([]);
    const reader = createGhReader({ run: async (argv) => { commands.push([...argv]); return '{"workflow_runs": []}'; } });
    assert.deepEqual(await reader.api(READS[3]), { workflow_runs: [] });
    assert.deepEqual(commands, [["api", READS[3]]]);
    await assert.rejects(reader.api("repos/example/project/issues/1/labels"), /reads only/);
  });
});

describe("what one run costs and what `main` does with the readers", () => {
  test("DONE-WHEN 4: a run with nothing failing makes FOUR gh api calls on the core pool, one per reader that asks GitHub", async () => {
    const github = healthy({ waiting: [waitingRow(1)] });
    const { readers } = readersFor({ github });
    const provider = createFakeProvider();
    const ledger = createLedger({ path: join(freshDirectory(), "ledger.jsonl"), now: () => NOW });
    await runWatch({ github: {}, provider, ledger, now: () => NOW, repo: REPO, readers, summary: { at: "08:00", timezone: "Europe/London" }, sources: HOST_SOURCES });
    assert.deepEqual(github.calls.map((path) => path.replace(/\?.*$/, "").replace(/^repos\/example\/project\//, "")), [
      "issues", "pulls", "actions/workflows/trunk.yml/runs", "actions/runs",
    ]);
  });

  test("fleet-watch runs HOURLY, so a state file 59 minutes old is a reading and one 3 hours old is cannot-ask (the margin lives in watch.mjs)", async () => {
    for (const [ageMinutes, expectedCannotAsk] of [[59, 0], [180, 1]]) {
      const path = join(freshDirectory(), "fleet-watch-state.json");
      writeFileSync(path, "{}\n");
      utimesSync(path, (NOW - ageMinutes * MINUTE) / 1000, (NOW - ageMinutes * MINUTE) / 1000);
      const { readers } = readersFor({ github: healthy(), fleetStatePath: path });
      const logged: never[] = /** @type {string[]} */ ([]);
      const ledger = createLedger({ path: join(freshDirectory(), "ledger.jsonl"), now: () => NOW });
      await runWatch({ github: {}, provider: createFakeProvider(), ledger, now: () => NOW, repo: REPO, readers, summary: { at: "08:00", timezone: "Europe/London" }, sources: HOST_SOURCES, log: (line) => logged.push(line) });
      assert.equal(logged.filter((line) => /cannot-ask incident:fleet-down/.test(line)).length, expectedCannotAsk, `${ageMinutes} minutes old`);
    }
  });

  test("runWatch without readers does not ask the host sources, and with them it does (and a missing reader is cannot-ask, not a crash)", async () => {
    const ask = async (readers: any) => {
      const logged: string[] = /** @type {string[]} */ ([]);
      const reads = { issuesLabelled: async () => [], issueComments: async () => [], mergedPullsSince: async () => [], redPulls: async () => [] };
      const ledger = createLedger({ path: join(freshDirectory(), "ledger.jsonl"), now: () => NOW });
      const result = await runWatch({ github: reads, provider: createFakeProvider(), ledger, now: () => NOW, repo: REPO, readers, summary: { at: "23:59", timezone: "UTC" }, log: (line) => logged.push(line) });
      return { logged, result };
    };
    assert.deepEqual((await ask(undefined)).logged, []);
    const partial = await ask({});
    assert.deepEqual(partial.result.failures, []);
    assert.ok(partial.logged.some((line) => /cannot-ask stall:no-merge: .*no reader named `readLastMerge`/.test(line)), partial.logged.join("\n"));
    assert.ok(partial.logged.some((line) => /cannot-ask incident:trunk-red/.test(line)));
  });

  test("`main` hands a real host's readers to the run only when it builds its own reader, so an injected one never reaches systemd or herdr", async () => {
    const root = mkdtempSync(join(scratch, "root-"));
    mkdirSync(join(root, ".agent-org"));
    writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify({
      tracker: [{ key: "", repo: REPO }], messaging: { provider: "telegram", tokenFile: "~/.config/agent-org/t", chairmanFile: "~/.config/agent-org/c" },
    }));
    const err: string[] = /** @type {string[]} */ ([]);
    const reads = { issuesLabelled: async () => [], issueComments: async () => [], mergedPullsSince: async () => [], redPulls: async () => [] };
    const code = await main({ root, home: freshDirectory(), env: { GH_CONFIG_DIR: "/x/gh" }, github: reads, now: () => NOW, providers: { telegram: () => createFakeProvider() }, out: () => {}, err: (line) => err.push(line) });
    assert.equal(code, 0);
    assert.deepEqual(err.filter((line) => /cannot-ask|work-tick unit/.test(line)), []);
    const asked: string[] = /** @type {string[]} */ ([]);
    await main({ root, home: freshDirectory(), env: { GH_CONFIG_DIR: "/x/gh" }, github: reads, readers: {}, now: () => NOW, providers: { telegram: () => createFakeProvider() }, out: () => {}, err: (line) => asked.push(line) });
    assert.ok(asked.some((line) => /cannot-ask stall:no-merge/.test(line)), "POSITIVE CONTROL: with readers handed over the host sources ARE asked");
  });
});

// ---- the liaison's checked facts (a11ign/a11ign#3420) ------------------------------------------------------------------------------------
describe("readFleetRoster: who fleet-watch last saw answer, by name, from the two files it writes", () => {
  /**
   * Both files, written at `wroteAt`. `workers` is name -> how long before the write the worker last ANSWERED (0 = the last poll); `notReady` is the state file.
   * @param {Record<string, number>} workers @param {Record<string, number>} [notReady] @param {{ wroteAt?: number, stateWroteAt?: number }} [times]
   */
  function fleetFiles(workers: Record<string, number>, notReady: Record<string, number> = {}, { wroteAt = NOW - 10 * MINUTE, stateWroteAt = wroteAt }: { wroteAt?: number; stateWroteAt?: number; } = {}) {
    const directory = freshDirectory();
    const statePath = join(directory, "fleet-watch-state.json");
    const capturesPath = join(directory, "fleet-captures-state.json");
    writeFileSync(statePath, JSON.stringify(notReady));
    utimesSync(statePath, stateWroteAt / 1000, stateWroteAt / 1000);
    const seen = Object.fromEntries(Object.entries(workers).map(([name, behind]) => [name, { captures: 0, seenAt: wroteAt - behind, lastRoseAt: null, rises: [] }]));
    writeFileSync(capturesPath, JSON.stringify({ since: wroteAt - 1000 * MINUTE, workers: seen }));
    utimesSync(capturesPath, wroteAt / 1000, wroteAt / 1000);
    return { statePath, capturesPath };
  }
  const ROSTER = { "worker-a": 0, "worker-b": 0, "worker-c": 0, "worker-d": 3 * 60 * MINUTE };

  test("up is who answered the last poll and is not in the non-ready state; down is the rest of the roster, the box that stopped answering included", () => {
    const files = fleetFiles(ROSTER, { "worker-b": NOW - 30 * MINUTE });
    const reading = readFleetRoster({ ...files, now: NOW });
    assert.deepEqual(reading.up, ["worker-a", "worker-c"]);
    assert.deepEqual(reading.down, ["worker-b", "worker-d"]);
    assert.equal(reading.polledAt, NOW - 10 * MINUTE);
  });

  test("POSITIVE CONTROL: a fleet that has ALL stopped answering is all down; 'the newest stamp' would have called the last to answer up", () => {
    const files = fleetFiles({ "worker-a": 5 * 60 * MINUTE, "worker-b": 6 * 60 * MINUTE });
    const reading = readFleetRoster({ ...files, now: NOW });
    assert.deepEqual(reading.up, []);
    assert.deepEqual(reading.down, ["worker-a", "worker-b"]);
  });

  test("a healthy fleet has an EMPTY non-ready file and is all up: the file that cannot say who is up is not what up is read from", () => {
    const reading = readFleetRoster({ ...fleetFiles({ "worker-a": 0, "worker-b": 0 }), now: NOW });
    assert.deepEqual([reading.up, reading.down], [["worker-a", "worker-b"], []]);
  });

  test("KEEPS ONLY THE NAME, whichever file names a worker by `<name>  <host>:<port>`", () => {
    const files = fleetFiles({ "worker-a  host-a.example:8765": 0, "worker-b  host-b.example:8765": 0 }, { "worker-b  host-b.example:8765": NOW - MINUTE });
    const reading = readFleetRoster({ ...files, now: NOW });
    assert.deepEqual([reading.up, reading.down], [["worker-a"], ["worker-b"]]);
    assert.doesNotMatch(JSON.stringify(reading), /example|8765/);
  });

  test("a watcher that stopped is not a reading: EITHER file older than the limit throws, and one file inside it does not rescue the other", () => {
    const old = NOW - 3 * 60 * MINUTE;
    for (const times of [{ wroteAt: old }, { wroteAt: NOW - MINUTE, stateWroteAt: old }]) {
      assert.throws(() => readFleetRoster({ ...fleetFiles(ROSTER, {}, times), now: NOW }), /fleet-watch last wrote its state \d+ minutes ago/);
    }
    assert.doesNotThrow(() => readFleetRoster({ ...fleetFiles(ROSTER, {}, { wroteAt: NOW - 120 * MINUTE }), now: NOW }), "POSITIVE CONTROL: inside the limit it reads");
  });

  test("a missing file, a roster nobody is on and a worker with no stamp all THROW: none is 'nothing is down'", () => {
    const files = fleetFiles(ROSTER);
    assert.throws(() => readFleetRoster({ statePath: join(freshDirectory(), "absent.json"), capturesPath: files.capturesPath, now: NOW }), /ENOENT/);
    assert.throws(() => readFleetRoster({ statePath: files.statePath, capturesPath: join(freshDirectory(), "absent.json"), now: NOW }), /ENOENT/);
    assert.throws(() => readFleetRoster({ ...fleetFiles({}), now: NOW }), /names no worker/);
    writeFileSync(files.capturesPath, JSON.stringify({ workers: { "worker-a": {} } }));
    assert.throws(() => readFleetRoster({ ...files, now: NOW }), /worker-a has no numeric seenAt/);
    writeFileSync(files.capturesPath, "[]");
    assert.throws(() => readFleetRoster({ ...files, now: NOW }), /a `workers` object was expected/);
  });
});

describe("readLastTick: when the gate last COMPLETED a tick", () => {
  test("is the record's time, and no record is a throw naming that no tick is known to have completed", () => {
    const path = join(freshDirectory(), COMPLETION_FILE);
    writeCompletion(path, { at: NOW - 4 * MINUTE, exit: 0 });
    assert.deepEqual(readLastTick({ recordPath: path }), { at: NOW - 4 * MINUTE });
    assert.throws(() => readLastTick({ recordPath: join(freshDirectory(), COMPLETION_FILE) }), /no tick is known to have completed/);
  });
});
