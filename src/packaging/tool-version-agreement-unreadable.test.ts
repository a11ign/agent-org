// no-token: gh -- the runs and logs are the fake code host's, except the last case, whose `gh` is a stub on PATH that answers from a file; nothing here reaches GitHub
/**
 * #3746: A RUNNER READING THAT CANNOT CHANGE IS NOT A READING. `a11ign/a11ign`'s `ci.yml` has run on `pull_request` and `merge_group` since 2026-09-18 and on `push` to `main` never again, so
 * `?branch=main&status=completed&per_page=1` answered the 2026-09-18 push run for ever, whose log names no version: UNKNOWN on every release, with no event that could clear it. And the run
 * that DOES gate `main` carries no `agent-org resolved` line either: since #3534 the resolver prints `##[notice]resolved v0.54.2, the newest stable of 143 tags, ...`, so the reader had to
 * learn that line too, and learn what it means: a CI that clones the newest tag on every run is not "behind" when a release is cut after its last run.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, cpSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

// The host file is set FIRST and the tool imported AFTER it, as `tool-version-agreement.test.ts` does (`org-health.ts` resolves its project at import, #3233).
const SCRATCH = mkdtempSync(join(tmpdir(), "tool-version-unreadable-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { agreement, readLastCiRun, memoFile, RESOLVER_LINE } = await import("../lib/tool-version-agreement.ts");
const { toolVersionReading } = await import("../org-health/board-truth-and-access-readings.ts");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-06T01:00:00Z");
const CYCLE = 13 * MINUTE;
const WHERE = { checkout: "/c", tool: "/t", repo: "a11ign/a11ign" };
const RESOLVED_NEWEST = "##[notice]resolved v0.54.2, the newest stable of 143 tags, into /home/runner/work/_temp/agent-org";

/** A completed `ci.yml` run as the code host's `gatingCiRunOf` answers it. */
const gating = (id: number, event: string, createdAt: string) => ({ id, sha: String(id).padStart(40, "0"), createdAt, event });

/** The merge-queue run that gates `main` today, which the code host answers (the plugin's own tests hold which of a repository's runs it picks). */
const GATING = gating(37389463315, "merge_group", "2026-10-05T23:36:36Z");

const noLock = () => { throw new Error("path 'pnpm-lock.yaml' does not exist"); };
const io = (extra: object = {}) => ({ git: noLock, toolGit: noLock, ...extra });
const LOGS = { 37389463315: `setup\n${RESOLVED_NEWEST}\ndone` };

/** The fake code host, substituted for the process's, holding `run` as the repository's gating run and `logs` by run id (a run with no entry has a log that says nothing about the tool). */
function seededHost(run: ReturnType<typeof gating> | null, logs: Record<number, string>) {
  const host = createFakeCodeHost();
  host.rowsWorld.tail.plumbing.ciRuns.set(WHERE.repo, run);
  for (const [id, log] of Object.entries(logs)) host.rowsWorld.tail.plumbing.runLogs.set(Number(id), log);
  if (run !== null && !(run.id in logs)) host.rowsWorld.tail.plumbing.runLogs.set(run.id, "a log that never names the tool");
  substituteCodeHost(host);
  return host;
}
const logReadsOf = (host: ReturnType<typeof createFakeCodeHost>) => host.rowsWorld.calls.filter((call) => call.startsWith("ciRunLogOf")).length;

afterEach(() => forgetActivation());

test("the reader reads the run the code host names as the one that gates `main` today -- the merge_group run -- and the version its resolver printed", () => {
  seededHost(GATING, LOGS);
  const fact = readLastCiRun(WHERE, io()) as { runner: string; version: string | null; resolvesNewest?: boolean; unreadable?: string };
  assert.equal(fact.unreadable, undefined);
  assert.match(fact.runner, /#37389463315/, "the merge_group run, as the code host named it");
  assert.match(fact.runner, /merge_group run/);
  assert.equal(fact.version, "v0.54.2");
  assert.equal(fact.resolvesNewest, true, "the notice says the NEWEST stable tag was cloned for that run");
});

test("a CI that clones the newest tag on every run is current by construction, not behind a release cut after its last run", () => {
  seededHost(GATING, LOGS);
  const fact = readLastCiRun(WHERE, io()) as Parameters<typeof agreement>[0]["runners"][number];
  const result = agreement({ now: NOW, tags: ["v0.54.2", "v0.54.3", "v0.54.4"], newestCutAt: NOW - HOUR, runners: [fact], cycleMs: CYCLE });
  assert.equal(result.readings[0].verdict, "current", "v0.54.4 was cut an hour ago, after the run: the next run takes it");
  assert.deepEqual(result.signals, []);
  assert.equal(toolVersionReading({ agreement: { result } }).status, "clear");
  // The flag is what decides it: the same version WITHOUT it is a pinned runner and is behind, so the exemption is not a blanket one.
  const pinned = agreement({ now: NOW, tags: ["v0.54.2", "v0.54.4"], newestCutAt: NOW - HOUR, runners: [{ ...fact, resolvesNewest: undefined }], cycleMs: CYCLE });
  assert.equal(pinned.readings[0].verdict, "behind");
});

test("a repository with no merge queue is still read: the run the code host names is a push run, and its older resolver line names a tag", () => {
  seededHost(gating(5, "push", "2026-10-05T10:00:00Z"), { 5: "agent-org resolved v0.22.0" });
  const fact = readLastCiRun(WHERE, io()) as { runner: string; version: string | null; resolvesNewest?: boolean };
  assert.match(fact.runner, /push run \(#5/);
  assert.equal(fact.version, "v0.22.0");
  assert.notEqual(fact.resolvesNewest, true, "the older resolver line names a tag, not the newest-at-run-time");
});

test("THE UNREADABLE CASE IS NOT HIDDEN: no run on any event is still not agreement, and org-health says UNKNOWN rather than clear", () => {
  seededHost(null, {});
  const none = readLastCiRun(WHERE, io()) as Parameters<typeof agreement>[0]["runners"][number];
  assert.match((none as { unreadable?: string }).unreadable ?? "", /no completed run/);
  const result = agreement({ now: NOW, tags: ["v0.54.4"], newestCutAt: NOW - HOUR, runners: [none], cycleMs: CYCLE });
  assert.equal(result.readings[0].verdict, "unread");
  assert.equal(toolVersionReading({ agreement: { result } }).status, "unknown");

  // And a merge_group run whose log names no tool is still UNKNOWN (an expired log is an answer about the run, not a clear).
  seededHost(GATING, {});
  const silent = readLastCiRun(WHERE, io()) as Parameters<typeof agreement>[0]["runners"][number];
  const unnamed = agreement({ now: NOW, tags: ["v0.54.4"], newestCutAt: NOW - HOUR, runners: [silent], cycleMs: CYCLE });
  assert.equal(unnamed.readings[0].verdict, "unknown");
});

test("AN UNREADABLE RUNNER IS ONE READING, NOT ONE PER RELEASE: the unknown's words do not carry the newest release, so the same unreadable runner says the same thing on the next one", () => {
  seededHost(GATING, {});
  const silent = readLastCiRun(WHERE, io()) as Parameters<typeof agreement>[0]["runners"][number];
  const onRelease = (newest: string) => toolVersionReading({ agreement: { result: agreement({ now: NOW, tags: ["v0.54.0", newest], newestCutAt: NOW - HOUR, runners: [silent], cycleMs: CYCLE }) } });
  const [first, next] = [onRelease("v0.54.4"), onRelease("v0.54.5")];
  assert.equal(first.status, "unknown");
  assert.equal(first.detail, next.detail, "a reason that has not changed is not a new reading");
  assert.doesNotMatch(first.detail, /0\.54\.\d/, "no release number in it");
  assert.equal(first.discriminator, undefined, "and an unknown has no discriminator to be offered under");
});

test("a finished run's log is read once, and the memo keeps what the notice meant (newest-at-run-time), not just the tag", () => {
  const host = seededHost(GATING, LOGS);
  const memoPath = join(SCRATCH, "memo.json");
  const memo = memoFile(memoPath);
  for (let i = 0; i < 3; i += 1) {
    const fact = readLastCiRun(WHERE, io({ memo })) as { version: string; resolvesNewest?: boolean };
    assert.equal(fact.version, "v0.54.2");
    assert.equal(fact.resolvesNewest, true);
  }
  assert.equal(logReadsOf(host), 1);
  assert.match(readFileSync(memoPath, "utf8"), /"37389463315":"v0\.54\.2 newest"/);
  // A memo file written before this change holds the bare tag: still read, as the pinned runner it was.
  writeFileSync(memoPath, JSON.stringify({ 37389463315: "v0.54.2" }));
  const old = readLastCiRun(WHERE, io({ memo: memoFile(memoPath) })) as { version: string; resolvesNewest?: boolean };
  assert.equal(old.version, "v0.54.2");
  assert.notEqual(old.resolvesNewest, true);
});

test("the resolver notice, as GitHub prints it into a log, is matched, and so is the older `agent-org resolved` form", () => {
  assert.equal(RESOLVER_LINE.exec(`ts / run\tUNKNOWN STEP\t2026-10-05T23:37:05.0607895Z ${RESOLVED_NEWEST}`)?.[1], "v0.54.2");
  assert.equal(RESOLVER_LINE.exec("x agent-org resolved v1.2.3")?.[1], "v1.2.3");
  assert.equal(RESOLVER_LINE.exec("the lockfile resolved v1.2.3 packages"), null, "`resolved` alone, with no notice around it, is not the resolver");
});

test("a real merge_group log is megabytes: the default `gh` reads one whole, with the notice at its END (measured: 5.0 MB, where a 1 MiB buffer ended the read in UNREAD)", () => {
  const bin = join(SCRATCH, "stub-bin");
  mkdirSync(bin);
  const runs = join(SCRATCH, "runs.json");
  writeFileSync(runs, JSON.stringify({ workflow_runs: [{ id: 37389463315, head_sha: String(37389463315).padStart(40, "0"), event: "merge_group", created_at: "2026-10-05T23:36:36Z" }] }));
  const stub = `#!/bin/sh\nif [ "$1" = api ]; then cat '${runs}'; else head -c 3000000 /dev/zero | tr '\\0' 'x'; echo; echo '${RESOLVED_NEWEST}'; fi\n`;
  writeFileSync(join(bin, "gh"), stub);
  chmodSync(join(bin, "gh"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    const fact = readLastCiRun(WHERE, { git: noLock, toolGit: noLock }) as { version?: string | null; unreadable?: string };
    assert.equal(fact.unreadable, undefined);
    assert.equal(fact.version, "v0.54.2");
  } finally {
    process.env.PATH = before;
  }
});
