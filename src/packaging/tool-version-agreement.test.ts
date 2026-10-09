// no-token: nothing here reaches a remote -- every fact the comparison reads (the tag list, the clock, each runner's version) is injected, and the readers are handed fixtures
/**
 * #3533: THE ORG KNOWS WHICH `agent-org` EVERY RUNNER RUNS, AND WHETHER IT IS THE NEWEST. The measured failure: the host ran `v0.22.0` while a11ign's repository still resolved `0.7.8`, and a
 * detector that compares only the tool checkout printed agreement. So the cases below are the ones a checkout-only reading gets wrong, and the emptiness in (1) and (3) is read against (2), which
 * differs from (3) only in the newest tag's AGE.
 *
 * Numbers refer to the row's Acceptance list.
 */
import { TSX_IMPORT } from "../tsx-import.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `org-health.mjs` resolves the project it serves at import, so the host file is set FIRST and the tool imported AFTER it (the recorded fixture project `org-health.test.ts` explains, #3233).
const SCRATCH = mkdtempSync(join(tmpdir(), "tool-version-agreement-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const lib = await import("../lib/tool-version-agreement.mjs");
const { SIGNALS, toolVersionReading, readToolAgreement } = await import("../org-health.ts");
const { agreement, agreementReport, releaseCycleMs, shippedReleaseCycleMs, readWorktree, readLastCiRun, memoFile, mainDeclaresAgentOrg, RESOLVER_LINE, lockedCommit } = lib;

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-04T20:00:00Z");
/** Written out as 13 minutes, never as `shippedReleaseCycleMs()`: the derivation is pinned on its own below, and a test that reads the constant it checks passes whatever it is. */
const CYCLE = 13 * MINUTE;
const TAGS = ["v0.9.0", "v0.21.3", "v0.22.0"];
const NEWEST_OLD = NOW - 30 * MINUTE;
const NEWEST_FRESH = NOW - 5 * MINUTE;

type Fact = Parameters<typeof agreement>[0]["runners"][number];
const tool = (version: string | null, extra: object = {}): Fact => ({ kind: "tool", runner: "tool checkout /host/agent-org", version, ...extra });
const worktree = (path: string, resolved: string | null, declared = true): Fact => ({ kind: "worktree", runner: path, resolved, declared });
const ci = (version: string | null): Fact => ({ kind: "ci", runner: "last completed ci.yml run on main (#1)", version });
const read = (runners: Fact[], over: { tags?: string[] | null; newestCutAt?: number | null } = {}) =>
  agreement({ now: NOW, tags: TAGS, newestCutAt: NEWEST_OLD, runners, cycleMs: CYCLE, ...over });

test("THE CYCLE IS DERIVED FROM THE TIMER UNIT, never typed in: the interval, the tag lag, one more tick", () => {
  assert.equal(releaseCycleMs("[Timer]\nOnBootSec=2min\nOnUnitActiveSec=2min\n"), CYCLE, "2 + 9 + 2 minutes");
  assert.equal(releaseCycleMs("[Timer]\nOnUnitActiveSec=5min\n"), 19 * MINUTE, "a different timer gives a different cycle, so it IS read from the unit");
  assert.equal(releaseCycleMs("[Timer]\nOnUnitActiveSec=90s\n"), (90 + 9 * 60 + 90) * 1000);
  assert.throws(() => releaseCycleMs("[Timer]\nOnBootSec=2min\n"), /OnUnitActiveSec/, "a unit with no interval refuses rather than guessing a cycle");
  assert.equal(shippedReleaseCycleMs(), CYCLE, "the shipped `host/work-tick.timer.in` is the 2-minute tick");
  // It must exceed the update path's own latency: the median gap between releases (10.9 minutes) is NOT the cycle, and one of them would fire on every tick.
  assert.ok(CYCLE > 9 * MINUTE + 2 * MINUTE, "longer than the tag lag plus a tick");
});

test("(1) all three readings at the newest tag give no signal -- read against (2), which differs only in the tag's age", () => {
  const result = read([tool("v0.22.0"), worktree("/w/a", "0.22.0"), ci("v0.22.0")]);
  assert.equal(result.newest, "v0.22.0");
  assert.deepEqual(result.signals, []);
  assert.deepEqual(result.readings.map((r) => r.verdict), ["current", "current", "current"]);
});

test("(2) the tool checkout at v0.21.3 with v0.22.0 cut more than one cycle ago names the runner, the version it runs and the newest tag", () => {
  const result = read([tool("v0.21.3"), ci("v0.22.0")]);
  assert.equal(result.signals.length, 1, "POSITIVE CONTROL: the case (1) and (3) are read against");
  const [signal] = result.signals;
  assert.equal(signal.runner, "tool checkout /host/agent-org");
  assert.equal(signal.version, "v0.21.3");
  assert.equal(signal.newest, "v0.22.0");
  assert.match(signal.detail, /v0\.21\.3/);
  assert.match(signal.detail, /v0\.22\.0/);
});

test("(3) the same state with v0.22.0 cut less than one cycle ago gives none -- and the bound is strict: exactly one cycle is still none", () => {
  assert.deepEqual(read([tool("v0.21.3")], { newestCutAt: NEWEST_FRESH }).signals, []);
  assert.deepEqual(read([tool("v0.21.3")], { newestCutAt: NOW - CYCLE }).signals, [], "exactly one cycle old is not OVER one");
  assert.equal(read([tool("v0.21.3")], { newestCutAt: NOW - CYCLE - 1000 }).signals.length, 1, "a second over is");
  const young = read([tool("v0.21.3")], { newestCutAt: NEWEST_FRESH });
  assert.equal(young.readings[0].verdict, "current", "waiting for its next tick is not a disagreement");
});

test("(4) a worktree resolving 0.7.8 names that worktree's path; none gives no signal before the removal row, and after it only a resolved copy does", () => {
  const behind = read([worktree("/home/agent/repos/wt-1127", "0.7.8")]);
  assert.equal(behind.signals.length, 1);
  assert.equal(behind.signals[0].runner, "/home/agent/repos/wt-1127");
  assert.equal(behind.signals[0].version, "0.7.8");
  assert.equal(behind.signals[0].kind, "worktree");

  // BEFORE the removal row the project's `main` still declares the dependency: nothing resolved is nothing to read.
  assert.deepEqual(read([worktree("/w/none", null, true)]).signals, []);
  // AFTER it (`declared: false`): still no signal for none, and a signal for a copy that RETURNED -- even one at the newest tag, and even when the newest tag is brand new.
  assert.deepEqual(read([worktree("/w/none", null, false)]).signals, []);
  const returned = read([worktree("/w/back", "0.22.0", false)], { newestCutAt: NEWEST_FRESH });
  assert.equal(returned.signals.length, 1, "a resolved copy where none is expected is the signal, whatever its version");
  assert.equal(returned.readings[0].verdict, "returned");
  assert.equal(returned.signals[0].runner, "/w/back");
});

test("(4) POSITIVE CONTROL: the host at 0.22.0 with a worktree at 0.7.8 -- a detector that reads only the tool checkout prints agreement; this one does not", () => {
  const checkoutOnly = read([tool("v0.22.0")]);
  assert.deepEqual(checkoutOnly.signals, [], "the measured failure: the checkout-only reading agrees");
  const withWorktree = read([tool("v0.22.0"), worktree("/home/agent/repos/a11y-witness", "0.7.8")]);
  assert.deepEqual(withWorktree.signals.map((s) => s.runner), ["/home/agent/repos/a11y-witness"]);
});

test("(5) a CI run that names no version is UNKNOWN, a tag list with no stable tag is UNREADABLE, an unreadable runner is NAMED -- none of them agreement", () => {
  const unnamed = read([ci(null)]);
  assert.equal(unnamed.readings[0].verdict, "unknown");
  assert.match(unnamed.readings[0].detail, /UNKNOWN/);
  assert.deepEqual(unnamed.signals, []);

  for (const tags of [["v0.22.0-rc.1", "latest", "0.22.0"], [], null]) {
    const unreadable = read([tool("v0.22.0"), ci("v0.22.0")], { tags });
    assert.notEqual(unreadable.unreadable, null, `tags ${JSON.stringify(tags)}`);
    assert.deepEqual(unreadable.readings.map((r) => r.verdict), ["unread", "unread"], "no newest tag to compare to is not agreement");
    assert.match(agreementReport(unreadable, NOW), /UNREADABLE/);
  }

  const unread = read([{ kind: "worktree", runner: "/w/denied", unreadable: "EACCES: permission denied" }, tool("v0.22.0")]);
  assert.equal(unread.readings[0].verdict, "unread");
  assert.match(agreementReport(unread, NOW), /\/w\/denied.*UNREAD.*EACCES/);

  // A newest tag whose age could not be read makes a DIFFERENCE unknown: never a signal on a guess, never agreement.
  const ageless = read([tool("v0.21.3")], { newestCutAt: null });
  assert.equal(ageless.readings[0].verdict, "unknown");
  assert.deepEqual(ageless.signals, []);
  // A tool checkout at no release names its commit and differs from the newest tag.
  const detached = read([tool(null, { commit: "abc1234" })]);
  assert.equal(detached.signals.length, 1);
  assert.match(detached.signals[0].detail, /at no release \(abc1234\)/);
});

test("(6) the released-tag comparison puts v0.9.0 below v0.22.0, and a pre-release is not the newest", () => {
  assert.equal(read([tool("v0.9.0")]).signals.length, 1, "v0.9.0 is behind v0.22.0 (a lexical sort gets this backwards)");
  assert.equal(read([tool("v0.22.0")], { tags: ["v0.9.0", "v0.22.0", "v0.23.0-rc.1"] }).newest, "v0.22.0");
  assert.equal(read([worktree("/w/a", "0.22.0")]).readings[0].verdict, "current", "`0.22.0` (a package.json) and `v0.22.0` (a tag) are the same release");
});

test("(6) host:check and org-health print the same reading for the same facts -- both call the one module", () => {
  const result = read([tool("v0.21.3"), worktree("/home/agent/repos/wt-1127", "0.7.8"), ci(null)]);
  const reading = toolVersionReading({ agreement: { result } });
  assert.equal(reading.status, "tripped");
  assert.equal(reading.signal, SIGNALS.TOOL_VERSION);
  assert.equal(reading.discriminator, `${SIGNALS.TOOL_VERSION}@v0.22.0`);
  for (const runner of ["tool checkout /host/agent-org", "/home/agent/repos/wt-1127"]) assert.ok(reading.detail.includes(runner), `the tick names ${runner}`);

  // host:check's finding is `agreementReport` of the SAME result. `host-units.ts` is run in a CHILD (it calls `git log --all`, so importing it would derive a `history` requirement, #2174).
  const script = join(SCRATCH, "findings.mjs");
  writeFileSync(script, `const { toolVersionFindings, toolVersionNotes } = await import(process.argv[2]);
const reading = JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify({ findings: toolVersionFindings(reading), notes: toolVersionNotes(reading) }));`);
  const asHost = (r: typeof result) => JSON.parse(spawnSync(process.execPath, [...TSX_IMPORT, script, pathToFileURL(fileURLToPath(new URL("../host-units.ts", import.meta.url))).href, JSON.stringify({ now: NOW, result: r })],
    { env: { AGENT_ORG_HOST: HOST_FILE }, encoding: "utf8", timeout: 60_000 }).stdout);
  const host = asHost(result);
  assert.equal(host.findings.length, 1);
  assert.equal(host.findings[0].detail, agreementReport(result, NOW));
  assert.deepEqual(host.notes, [], "a signalled reading is a finding, not a note");

  const calm = read([tool("v0.22.0"), ci(null)]);
  const calmHost = asHost(calm);
  assert.deepEqual(calmHost.findings, [], "no signal, no finding");
  assert.equal(calmHost.notes[0].detail, agreementReport(calm, NOW), "an unread or unknown runner is still PRINTED, as a note");
  assert.equal(toolVersionReading({ agreement: { result: calm } }).status, "unknown", "and the tick says it could not read it, never `clear`");
  assert.equal(toolVersionReading({ agreement: { result: read([tool("v0.22.0")]) } }).status, "clear");
  assert.equal(toolVersionReading({ agreement: null }).status, "unknown");
});

test("(6) the tick's reader asks a child, says `not asked` for a host with no tool and never throws", () => {
  const asked = readToolAgreement(() => JSON.stringify({ now: NOW, result: read([tool("v0.22.0")]) }));
  assert.equal(asked?.result.newest, "v0.22.0");
  assert.equal(readToolAgreement(() => JSON.stringify({ asked: false })), undefined);
  assert.equal(readToolAgreement(() => { throw new Error("timed out"); }), null);
  assert.equal(readToolAgreement(() => "not json"), null);
});

test("the worktree reader reads THROUGH node_modules, tells none from unreadable, and the project's `main` says whether the dependency is declared", () => {
  const dir = mkdtempSync(join(SCRATCH, "wt-"));
  assert.deepEqual(readWorktree(dir), { kind: "worktree", runner: dir, resolved: null, declared: true }, "no node_modules/agent-org is none");
  mkdirSync(join(dir, "node_modules", "agent-org"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "agent-org", "package.json"), JSON.stringify({ name: "agent-org", version: "0.7.8" }));
  assert.equal((readWorktree(dir, { declared: false }) as { resolved: string }).resolved, "0.7.8");
  writeFileSync(join(dir, "node_modules", "agent-org", "package.json"), "{ not json");
  assert.ok((readWorktree(dir) as { unreadable?: string }).unreadable, "a copy that cannot be parsed is UNREAD, not none");

  const pinned = (manifest: object) => mainDeclaresAgentOrg("/unused", () => JSON.stringify(manifest));
  assert.equal(pinned({ devDependencies: { "agent-org": "github:a11ign/agent-org#semver:^0.7.0" } }), true);
  assert.equal(pinned({ devDependencies: { tsx: "^4" } }), false, "the removal row has merged");
  assert.equal(mainDeclaresAgentOrg("/unused", () => { throw new Error("no origin/main"); }), true, "an unreadable main is the version comparison, not a silence");
});

test("the CI reader: the lockfile's version while it is pinned, the resolver line after, UNKNOWN for a run that names neither, and a log is read once", () => {
  const run = JSON.stringify({ workflow_runs: [{ id: 77, head_sha: "a".repeat(40), created_at: "2026-10-04T10:00:00Z" }] });
  const commit = "b".repeat(40);
  const lock = `  agent-org@https://codeload.github.com/a11ign/agent-org/tar.gz/${commit}:\n    resolution: {}`;
  assert.equal(lockedCommit(lock), commit);
  let logReads = 0;
  const gh = (args: string[]) => {
    if (args[0] === "api") return run;
    logReads += 1;
    return "setup\nagent-org resolved v0.22.0\ndone";
  };
  const where = { checkout: "/c", tool: "/t", repo: "a11ign/a11ign" };
  const pinned = readLastCiRun(where, { gh, git: () => lock, toolGit: () => JSON.stringify({ version: "0.7.8" }) }) as { version: string };
  assert.equal(pinned.version, "0.7.8");
  assert.equal(logReads, 0, "the lockfile answered, so no log was downloaded");

  const memoPath = join(SCRATCH, "memo.json");
  const memo = memoFile(memoPath);
  const noLock = () => { throw new Error("path 'pnpm-lock.yaml' does not exist"); };
  for (let i = 0; i < 3; i += 1) assert.equal((readLastCiRun(where, { gh, git: noLock, toolGit: noLock, memo }) as { version: string }).version, "v0.22.0");
  assert.equal(logReads, 1, "a finished run's log is read once");
  assert.match(readFileSync(memoPath, "utf8"), /"77":"v0\.22\.0"/);

  const silent = (args: string[]) => (args[0] === "api" ? run : "no resolver here");
  assert.equal((readLastCiRun(where, { gh: silent, git: noLock, toolGit: noLock }) as { version: string | null }).version, null, "the run names no version");
  const expired = (args: string[]) => {
    if (args[0] === "api") return run;
    throw Object.assign(new Error("Command failed"), { stderr: "failed to get run log: log not found" });
  };
  assert.equal((readLastCiRun(where, { gh: expired, git: noLock, toolGit: noLock }) as { version: string | null }).version, null, "an expired log is an answer about the run");
  const refused = (args: string[]) => {
    if (args[0] === "api") return run;
    throw new Error("HTTP 403 rate limit");
  };
  assert.ok((readLastCiRun(where, { gh: refused, git: noLock, toolGit: noLock }) as { unreadable?: string }).unreadable, "any other refusal is UNREAD and keeps the run's name");
  assert.ok(RESOLVER_LINE.test("x agent-org resolved v1.2.3"));
});
