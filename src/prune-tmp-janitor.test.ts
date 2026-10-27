// no-token: gh -- every `pruneTmp` here is handed a fake `run` and `--fixtures-only` never reads the pull request list; the one `gh`-reaching family (review leftovers) is not run, and nothing imported reaches the real `gh`
// no-token: git -- `installTmpfiles` and `toolForm` never run `git`; the orphan check that does (`orphanOrigin`) is not imported here
/**
 * a11ign/a11ign#3849: THE /TMP FIXTURE JANITOR -- the third family, the small-batch shape of a run, the timer that runs it and the user
 * tmpfiles rule that ages the private tmp root.
 *
 * The incident (#3846): `/tmp` held 121,411 entries of test fixtures nothing removed, and the kernel's soft lockup at 14:09:00Z was an `rmdir`
 * over a directory that size. So the two things a janitor here must NOT do are as much of the contract as the one thing it must: it must not
 * remove in one pass what accumulated over days, and it must not remove what a process still holds.
 *
 * Every fixture lives under ONE base directory made at the top and removed in `after`, so this file leaves `/tmp` as it found it (#3848). No
 * test reads or writes the real `/tmp`; the one that needs `/proc` builds a fake `proc` directory, which is the shape `processStrings` reads.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testEach } from "./lib/test-each.ts";
const BASE = mkdtempSync(join(tmpdir(), "prune-tmp-janitor-"));
after(() => { rmSync(BASE, { recursive: true, force: true }); });

/** The smallest declaration the tool's modules read at import: a project of nobody's, so nothing here is a11ign's (`installed-layout.test.ts`'s). */
const DECLARATION = {
  schema: 1,
  tracker: [{ key: "", repo: "acme/widgets", board: { owner: "acme", number: 1 } }],
  code: [{ key: "", repo: "acme/widgets" }],
  units: { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] },
  vocabulary: {
    labels: { backlog: "backlog", needsChairman: "needs:chairman", outOfRelease: "out-of-release", blocked: "blocked" },
    prefixes: { lane: "lane:", session: "session:", answer: "answer:" },
    milestones: { roadToVersionOne: "Road to one", outOfRelease: "Out of release" },
    lanesFile: "lanes.json",
    templateFields: { acceptance: "Acceptance", closes: "Closes", fleet: "Fleet" },
    fleetQuestion: "Does it need the fleet?",
    resources: [],
  },
};

/**
 * A host file naming a project that DECLARES one, made here so no run of this file depends on the layout it sits in (a CI runner holds the tool
 * inside the project; a standalone checkout holds no declaration at all) or on a variable the caller happened to export. #3849's review.
 */
const HOST = (() => {
  const project = join(BASE, "project");
  mkdirSync(join(project, ".agent-org"), { recursive: true });
  writeFileSync(join(project, ".agent-org", "project.json"), JSON.stringify(DECLARATION));
  const host = join(BASE, "host.json");
  writeFileSync(host, JSON.stringify({ schema: 1, primary: "p", projects: [{ id: "p", checkout: project }] }));
  return host;
})();
// The tool's modules resolve their project when IMPORTED, so the host is named BEFORE they are, and only when the caller named none.
if (!process.env.AGENT_ORG_HOST) process.env.AGENT_ORG_HOST = HOST;
const {
  DOOMED_PREFIX, FIXTURE_PREFIXES, FIXTURE_WINDOW_MS, MAX_REMOVALS_PER_RUN, PAUSE_BETWEEN_REMOVALS_MS,
  agedFamilyOf, agedPaths, classifyEntry, cliFamilies, doomedPaths, familyOf, newestMtimeMs, processStrings, fixturePaths, formatDryRunReport, formatAppliedReport, pruneTmp: pruneTmpWithClaims, removeFromLeaves,
} = await import("./prune-tmp.ts");
const { installTmpfiles } = await import("./host-units.ts");
const { toolForm } = await import("./host-units/shipped-unit-texts-and-declarations.ts");
const { REMOVAL_LOG_ENV } = await import("./worktree-removal.ts");

// #2782: every removal writes a line, and a fixture must not write the host's log.
process.env[REMOVAL_LOG_ENV] = join(BASE, "worktree-removals");

const CLI = fileURLToPath(new URL("./prune-tmp.ts", import.meta.url));
const SHIPPED = fileURLToPath(new URL("../host/", import.meta.url));
const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 9, 6, 18, 0, 0);

let counter = 0;
const fresh = (label: string): string => {
  counter += 1;
  const dir = join(BASE, `${label}-${counter}`);
  mkdirSync(dir);
  return dir;
};

const noPause = () => {};
type Deps = NonNullable<Parameters<typeof pruneTmpWithClaims>[1]>;
/** One run over `root`: no real `/proc` (an empty one), no `gh`, no claim read, no sleeping, and applying. */
const run = (root: string, deps: Deps = {}) => pruneTmpWithClaims(root, {
  dryRun: false, now: NOW, procRoot: emptyProc(), run: () => "[]", claim: () => ({ refused: false }), pause: noPause, ...deps,
});

let procCounter = 0;
function emptyProc(): string {
  procCounter += 1;
  const proc = join(BASE, `proc-${procCounter}`);
  mkdirSync(join(proc, "net"), { recursive: true });
  writeFileSync(join(proc, "net", "unix"), UNIX_TABLE_HEADER);
  return proc;
}

const UNIX_TABLE_HEADER = "Num       RefCount Protocol Flags    Type St Inode Path\n";

/** A fake `/proc` with one process directory, `4242`, and nothing in it. */
function procWithProcess(): string {
  const proc = emptyProc();
  mkdirSync(join(proc, "4242"));
  return proc;
}

/** A fake `/proc` in which one process names `held` in its argv, which is what `heldEntries` reads. */
function procHolding(held: string): string {
  const proc = procWithProcess();
  writeFileSync(join(proc, "4242", "cmdline"), `node\0${held}\0`);
  return proc;
}

function fixture(root: string, name: string, { hoursOld = 5, files = 0 }: { hoursOld?: number; files?: number } = {}): string {
  const dir = join(root, name);
  mkdirSync(dir);
  for (let i = 0; i < files; i += 1) writeFileSync(join(dir, `f${i}`), "x");
  const when = new Date(NOW - hoursOld * HOUR_MS);
  for (let i = 0; i < files; i += 1) utimesSync(join(dir, `f${i}`), when, when);
  utimesSync(dir, when, when);
  return dir;
}

const names = (dir: string): string[] => readdirSync(dir).sort();

// --- THE THIRD FAMILY -----------------------------------------------------------------------------------------------------------------

test("#3849: a directory carrying a fixture prefix is the `fixture` family, and a near miss is not", () => {
  assert.deepEqual(familyOf("verify-stamp-test-Ab12Cd"), { family: "fixture", prefix: "verify-stamp-test-" });
  assert.deepEqual(familyOf("host-units-2184-xYz789"), { family: "fixture", prefix: "host-units-" });
  // POSITIVE CONTROLS FOR THE REFUSAL HALF: a name that merely RESEMBLES a fixture, and a nested path, are the unrecognised family.
  assert.equal(familyOf("host-unitsX").family, "unknown", "the prefix ends at its dash");
  assert.equal(familyOf("host-units-").family, "unknown", "a prefix with nothing after it names no directory a test made");
  assert.equal(familyOf("board.json").family, "unknown");
  assert.equal(familyOf("tsx-1000").family, "unknown");
  assert.equal(familyOf("host-units-abc/inner").family, "unknown", "only a DIRECT child of the tmp root is a fixture");
  assert.ok(FIXTURE_PREFIXES.length >= 7, "the seven families #3848 names are all listed");
});

test("#3849: a fixture older than an hour that no process holds is removable, and the reason says so", () => {
  const root = fresh("old");
  const old = fixture(root, "closes-check-old111", { hoursOld: FIXTURE_WINDOW_MS / HOUR_MS + 1 });
  const verdict = classifyEntry(old, root, { openPrs: new Set(), held: new Set(), selfSessions: new Set(), now: NOW });
  assert.equal(verdict.verdict, "remove");
  assert.match(verdict.reason, /closes-check-\* test fixture no process holds/);
});

test("#3849: a fixture younger than an hour is REFUSED, with the reason", () => {
  const root = fresh("young");
  const young = fixture(root, "closes-check-young1", { hoursOld: 0.25 });
  const verdict = classifyEntry(young, root, { openPrs: new Set(), held: new Set(), selfSessions: new Set(), now: NOW });
  assert.equal(verdict.verdict, "refuse");
  assert.match(verdict.reason, /less than 1\.0h ago, so a test may still be using it/);
});

type Run = ReturnType<typeof run>;

/** A fixture a running process holds is REFUSED, whatever its age; each case checks its own neighbour and the reasons it was refused for. */
testEach("a fixture a running process holds is REFUSED, and its neighbour is judged on its own", [
  {
    name: "#3849: a fixture a running process names is REFUSED however old it is, and its neighbour goes",
    label: "held",
    heldName: "host-units-held1",
    otherName: "host-units-free1",
    otherHours: 30,
    check: (held: string, other: string, report: Run) => {
      assert.ok(existsSync(held), "a held fixture must still be there");
      assert.equal(existsSync(other), false, "the same age, not held, must be gone: the refusal is the HELD check and not the age");
      assert.match(report.refused.find((entry) => entry.path === held)!.reason, /a running process holds this/);
    },
  },
  {
    name: "A11-60: a leaked-family fixture younger than an hour, or one a process holds, is kept and says why",
    label: "leaked-keep",
    heldName: "installed-layout-held1",
    otherName: "patch-target-young1",
    otherHours: 0.25,
    check: (held: string, young: string, report: Run) => {
      assert.ok(existsSync(young), "a young fixture stays");
      assert.ok(existsSync(held), "a held fixture stays");
      assert.match(report.refused.find((entry) => entry.path === young)!.reason, /less than 1\.0h ago/);
      assert.match(report.refused.find((entry) => entry.path === held)!.reason, /a running process holds this/);
    },
  },
], (c) => {
  const root = fresh(c.label);
  const held = fixture(root, c.heldName, { hoursOld: 30 });
  const other = fixture(root, c.otherName, { hoursOld: c.otherHours });
  const report = run(root, { procRoot: procHolding(held) });
  c.check(held, other, report);
});

// A11-60: the prefixes the 2026-10-17 pile carried, which the list did not name until that day (`FIXTURE_PREFIXES` after its first sixteen).
const LEAKED = [
  "installed-layout-", "engineer-route-", "triage-route-", "outside-nightly-project-", "outside-nightly-stub-",
  "patch-target-", "patch-verdict-", "patch-vars-", "patch-stage-", "patch-naming-", "control-host-run-",
  "provision-role-", "agreement-", "poll-5xx-", "refusal-owners-step-", "verify-present-agent-org-",
  "urls-input-", "consumer-gate-pin-remote-", "corpus-verify-", "auto-arm-cross-repo-",
  "nvda-spec-", "nvda-zip-", "nvda-nospec-",
];

test("A11-60: each prefix the 2026-10-17 pile carried is a fixture family with a random suffix, and the bare prefix is not", () => {
  for (const prefix of LEAKED) {
    assert.equal(familyOf(`${prefix}Ab12Cd`).family, "fixture", `${prefix} with a suffix`);
    assert.equal(familyOf(prefix).family, "unknown", `${prefix} with nothing after it`);
  }
});

test("A11-60: a name next to a leaked prefix, and not under it, is unrecognised", () => {
  assert.equal(familyOf("patch-targetsAb12Cd").family, "unknown", "the prefix ends at its dash");
  assert.equal(familyOf("patchtarget-Ab12Cd").family, "unknown", "a name that drops the dash is not the fixture");
});

test("A11-60: a /tmp of 3N leaked-family fixtures needs three runs, and a fourth finds nothing and says so", () => {
  const root = fresh("leaked-threeN");
  for (let i = 0; i < 3 * MAX_REMOVALS_PER_RUN; i += 1) {
    fixture(root, `${LEAKED[i % LEAKED.length]}${String(i).padStart(4, "0")}`);
  }
  for (let pass = 1; pass <= 3; pass += 1) {
    assert.equal(run(root).removed.length, MAX_REMOVALS_PER_RUN, `run ${pass} removes exactly N`);
  }
  assert.equal(readdirSync(root).length, 0);
  const fourth = run(root);
  assert.equal(fourth.removed.length, 0);
  assert.match(formatAppliedReport(fourth), /nothing to remove: 0 classified path\(s\) found/);
});

test("#3849: a file, or a symlink, with a fixture's name is not walked at all", () => {
  const root = fresh("kinds");
  writeFileSync(join(root, "host-units-afile"), "x");
  const elsewhere = fresh("elsewhere");
  symlinkSync(elsewhere, join(root, "host-units-alink"));
  assert.deepEqual(fixturePaths(root), [], "only directories count: the fixtures make directories");
});

test("#3849: a symlink INSIDE a fixture is unlinked and never followed", () => {
  const root = fresh("link");
  const outside = fresh("outside");
  writeFileSync(join(outside, "keep"), "do not delete");
  const dir = fixture(root, "ingest-state-link1", { hoursOld: 9 });
  symlinkSync(outside, join(dir, "node_modules"));
  // The link's own stat follows it, and the directory's mtime moved when the link was made: both read OLD, as a long-dead fixture's do.
  const longAgo = new Date(NOW - 9 * HOUR_MS);
  for (const path of [dir, outside, join(outside, "keep")]) utimesSync(path, longAgo, longAgo);
  run(root);
  assert.equal(existsSync(dir), false);
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "do not delete", "the tree behind the link is the primary checkout's, in the real case");
});

// --- THE SHAPE OF A RUN: SMALL, PAUSED, AND FINISHABLE -------------------------------------------------------------------------------------

test("#3849: a /tmp of 3N fixtures needs three runs, each removing N and no more", () => {
  const root = fresh("threeN");
  for (let i = 0; i < 3 * MAX_REMOVALS_PER_RUN; i += 1) fixture(root, `trace-weekly-${String(i).padStart(4, "0")}`);
  const left = [3 * MAX_REMOVALS_PER_RUN, 2 * MAX_REMOVALS_PER_RUN, MAX_REMOVALS_PER_RUN, 0];
  for (let pass = 1; pass <= 3; pass += 1) {
    const report = run(root);
    assert.equal(report.removed.length, MAX_REMOVALS_PER_RUN, `run ${pass} removes exactly N`);
    assert.equal(readdirSync(root).length, left[pass], `after run ${pass}`);
  }
  assert.equal(readdirSync(root).length, 0);
});

test("#3849: a run over an empty /tmp removes nothing and says so", () => {
  const root = fresh("empty");
  const report = run(root);
  assert.equal(report.removed.length, 0);
  assert.equal(report.candidates, 0);
  assert.match(formatAppliedReport(report), /^tmp-entries: 0\nnothing to remove: 0 classified path\(s\) found/);
  // The control for "says so": a root WITH a removable fixture does not print that sentence.
  fixture(root, "ingest-state-one", { hoursOld: 5 });
  assert.doesNotMatch(formatAppliedReport(run(root)), /nothing to remove/);
});

test("#3868: every report begins with ONE `tmp-entries: <N>` line, the count of the root's own entries, in a dry run, an applied run and an empty one", () => {
  const root = fresh("count");
  for (let i = 0; i < 7; i += 1) fixture(root, i < 3 ? `trace-weekly-${i}` : `unclassified-${i}`);
  const first = (text: string) => text.split("\n")[0];
  const dry = run(root, { dryRun: true });
  assert.equal(first(formatDryRunReport(dry)), "tmp-entries: 7");
  assert.equal(readdirSync(root).length, 7, "the dry run removed nothing");
  assert.equal(first(formatAppliedReport(run(root))), "tmp-entries: 7", "an applied run reads the root as it began");
  assert.equal(readdirSync(root).length, 4, "and removes the 3 it classified");
  const next = formatAppliedReport(run(root));
  assert.equal(first(next), "tmp-entries: 4", "the next run reads what the last one left");
  assert.equal(next.match(/^tmp-entries:/gm)?.length, 1, "ONE line");
  assert.match(next, /^tmp-entries: 4\nnothing to remove/, "the nothing-to-remove report carries it too");
});

test("#3868: a run over an empty directory reads `tmp-entries: 0`, and one that cannot be read says `unknown` rather than 0", () => {
  assert.match(formatAppliedReport(run(fresh("zero"))), /^tmp-entries: 0\n/);
  assert.match(formatAppliedReport(run(join(BASE, "no-such-root"))), /^tmp-entries: unknown\n/);
});

test("#3868: the CLI prints the count on its first line", () => {
  const root = fresh("cli-count");
  fixture(root, "watch-cli-cnt1", { hoursOld: 6 });
  mkdirSync(join(root, "other"));
  const env = { ...process.env, AGENT_ORG_HOST: HOST };
  const listed = spawnSync(process.execPath, [CLI, `--tmp=${root}`, "--fixtures-only"], { encoding: "utf8", env });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.split("\n")[0], "tmp-entries: 2");
});

test("#3849: a pause follows every removal, and never fewer", () => {
  const root = fresh("pause");
  for (let i = 0; i < 5; i += 1) fixture(root, `org-retro-p${i}`, { files: 2 });
  const pauses: number[] = [];
  run(root, { pause: (ms: number) => { pauses.push(ms); } });
  const removals = 5 * 3; // two files and the directory, each
  assert.equal(pauses.length, removals);
  assert.ok(pauses.every((ms) => ms === PAUSE_BETWEEN_REMOVALS_MS));
});

test("#3849: a tree larger than the budget is taken from its leaves over several runs, never in one call", () => {
  const root = fresh("large");
  const big = fixture(root, "gh-calls-big", { files: 2 * MAX_REMOVALS_PER_RUN + 40 });
  const first = run(root);
  assert.equal(first.partial.length, 1, "the budget ran out inside the tree, so it is partly removed rather than removed or failed");
  assert.equal(first.removed.length, 0);
  assert.equal(existsSync(big), false, "the tree no longer stands under its fixture name: a rename marked it");
  const doomed = doomedPaths(root);
  assert.equal(doomed.length, 1);
  assert.equal(readdirSync(doomed[0]).length, MAX_REMOVALS_PER_RUN + 40, "exactly one run's worth is gone");
  // The doomed tree is finished at ANY age: its mtime was just refreshed by the removals, and it still goes.
  run(root);
  const third = run(root);
  assert.equal(third.removed.length, 1, "the run that finishes it reports it removed");
  assert.deepEqual(names(root), []);
});

test("#3849: removeFromLeaves takes ONE entry per call of budget 1, children before their directory", () => {
  const root = fresh("leaves");
  const tree = join(root, "tree");
  mkdirSync(join(tree, "a", "b"), { recursive: true });
  writeFileSync(join(tree, "a", "b", "leaf"), "x");
  writeFileSync(join(tree, "top"), "x");
  const standing = (): number => (existsSync(tree) ? 1 + countEntries(tree) : 0);
  let before = standing();
  let steps = 0;
  while (!removeFromLeaves(tree, { left: 1 }, noPause)) {
    steps += 1;
    assert.equal(standing(), before - 1, `step ${steps} removed exactly one entry`);
    before = standing();
    assert.ok(existsSync(tree), "the root is the LAST thing to go");
  }
  assert.equal(existsSync(tree), false);
  assert.equal(steps, 4, "five entries (leaf, b, a, top, root): four calls stop after one removal, the fifth removes the root and finishes");
});

function countEntries(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + 1 + (e.isDirectory() ? countEntries(join(dir, e.name)) : 0), 0);
}

test("#3849: a run killed in the middle of a tree leaves a state the next run finishes", () => {
  const root = fresh("killed");
  const dir = fixture(root, "dora-resumes-k1", { hoursOld: 8, files: 50 });
  let calls = 0;
  const dies = () => { calls += 1; if (calls === 20) throw new Error("killed: the process was OOM-reaped here"); };
  const killed = run(root, { pause: dies });
  assert.equal(killed.failed.length, 1, "the run that died reports a failure, not a success");
  assert.equal(existsSync(dir), false, "the rename happened BEFORE the first removal, so the half-removed tree is under the doomed name");
  assert.equal(doomedPaths(root).length, 1);
  const next = run(root);
  assert.equal(next.removed.length, 1);
  assert.deepEqual(names(root), [], "nothing is left, though the tree's own mtime read NEW at the second run");
});

test("#3849: a doomed tree a process holds is still refused", () => {
  const root = fresh("doomedheld");
  const doomed = join(root, `${DOOMED_PREFIX}host-units-x`);
  mkdirSync(doomed);
  run(root, { procRoot: procHolding(doomed) });
  assert.ok(existsSync(doomed));
  run(root);
  assert.equal(existsSync(doomed), false, "the same tree, held by nobody, goes");
});

test("#3849: --fixtures-only walks neither the review nor the scratchpad family", () => {
  const root = fresh("only");
  const review = fixture(root, "rv-2049-leftover", { hoursOld: 99 });
  const mine = fixture(root, "host-units-only1", { hoursOld: 99 });
  const report = run(root, { families: ["fixture", "doomed"] });
  assert.ok(existsSync(review), "a review leftover is #2166's announced cycle's, not the timer's");
  assert.equal(existsSync(mine), false);
  assert.equal(report.examined, 1);
});

test("#3849: the CLI over a fixture root, dry by default and removing under --apply", () => {
  const root = fresh("cli");
  const dir = fixture(root, "watch-cli-cli1", { hoursOld: 6 });
  const env = { ...process.env, AGENT_ORG_HOST: HOST };
  const listed = spawnSync(process.execPath, [CLI, `--tmp=${root}`, "--fixtures-only"], { encoding: "utf8", env });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /WOULD REMOVE 1 of 1/);
  assert.ok(existsSync(dir));
  const applied = spawnSync(process.execPath, [CLI, `--tmp=${root}`, "--fixtures-only", "--apply"], { encoding: "utf8", env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /removed 1 of 1/);
  assert.equal(existsSync(dir), false);
});

// --- THE AGED FAMILY (A11-348) --------------------------------------------------------------------------------------------------------
//
// The board asked a person "/tmp holds 1,738 entries" because the named families (fixtures, review leftovers, scratchpads) were the whole of what
// the janitor could call dead, and the pile was the workers' own logs, body files and `a11-<n>-*` scratch directories. An entry the agent user owns
// that nothing has written for a day is dead by the ticket's own reading, whatever it is called -- unless something still holds it.

const ME = process.getuid?.() ?? 0;

/** A file or directory directly under `root`, last written `hoursOld` hours before NOW (a directory with `files` children, all of that age). */
function leftover(root: string, name: string, { hoursOld = 30, files = null }: { hoursOld?: number; files?: number | null } = {}): string {
  const path = join(root, name);
  if (files === null) writeFileSync(path, "x");
  else {
    mkdirSync(path);
    for (let i = 0; i < files; i += 1) writeFileSync(join(path, `f${i}`), "x");
  }
  const when = new Date(NOW - hoursOld * HOUR_MS);
  for (const child of files === null ? [] : readdirSync(path)) utimesSync(join(path, child), when, when);
  utimesSync(path, when, when);
  return path;
}

test("A11-348: an entry of the agent user that nothing has written for over 24 hours is removed, whatever it is called, and a younger one stays", () => {
  const root = fresh("aged");
  const log = leftover(root, "agr.log", { hoursOld: 25 });
  const scratch = leftover(root, "a11-290-accept.9qrIRo", { hoursOld: 48, files: 2 });
  const young = leftover(root, "body7.md", { hoursOld: 23 });
  const report = run(root, { families: ["aged"] });
  assert.equal(existsSync(log), false, "a day-old file goes");
  assert.equal(existsSync(scratch), false, "a two-day-old directory goes with what is in it");
  assert.ok(existsSync(young), "23 hours is inside the window");
  assert.deepEqual(report.removed.sort(), [scratch, log].sort());
  assert.match(report.refused.find((entry) => entry.path === young)?.reason ?? "", /^written less than 24\.0h ago/);
});

test("A11-348: the window is the entry's NEWEST write two levels down, not its own mtime", () => {
  const root = fresh("aged-newest");
  const busy = leftover(root, "run-state", { hoursOld: 72, files: 1 });
  const recent = new Date(NOW - HOUR_MS);
  utimesSync(join(busy, "f0"), recent, recent);
  utimesSync(busy, new Date(NOW - 72 * HOUR_MS), new Date(NOW - 72 * HOUR_MS));
  run(root, { families: ["aged"] });
  assert.ok(existsSync(busy), "its directory reads three days old, but a file in it was written an hour ago");
});

test("A11-348: an entry a running process holds is not removed, however old, and goes once nothing does", () => {
  const root = fresh("aged-held");
  const heldFile = leftover(root, "open.log", { hoursOld: 99 });
  const heldDir = leftover(root, "work-dir", { hoursOld: 99, files: 1 });
  const report = run(root, { families: ["aged"], procRoot: procHolding(`${heldFile} ${join(heldDir, "f0")}`) });
  assert.ok(existsSync(heldFile) && existsSync(heldDir));
  assert.match(report.refused.find((entry) => entry.path === heldFile)?.reason ?? "", /a running process holds this open/);
  assert.match(report.refused.find((entry) => entry.path === heldDir)?.reason ?? "", /a running process holds this open/, "a process inside a directory holds the directory");
  run(root, { families: ["aged"] });
  assert.equal(existsSync(heldFile) || existsSync(heldDir), false, "the same entries, held by nobody, go");
});

test("A11-348: a directory holding a bound unix socket is held, though no process has it open as a path", () => {
  const root = fresh("aged-socket");
  const server = leftover(root, "qs-AbC123", { hoursOld: 99, files: 1 });
  const proc = emptyProc();
  writeFileSync(join(proc, "net", "unix"), `${UNIX_TABLE_HEADER}0000: 00000002 00000000 00010000 0001 01 1234 ${join(server, "s")}\n0000: 00000002 00000000 00010000 0001 01 1235 @abstract\n`);
  const report = run(root, { families: ["aged"], procRoot: proc });
  assert.ok(existsSync(server));
  assert.match(report.refused[0].reason, /a running process holds this open/);
  run(root, { families: ["aged"] });
  assert.equal(existsSync(server), false, "with the socket gone from the table, it goes");
});

test("A11-348: an entry of another user is refused with its owner named, and so is one whose owner cannot be read", () => {
  const root = fresh("aged-owner");
  const theirs = leftover(root, "x11-socket", { hoursOld: 99 });
  const report = run(root, { families: ["aged"], uid: 4242 });
  assert.ok(existsSync(theirs));
  assert.match(report.refused[0].reason, new RegExp(`^owned by uid ${ME}, not the agent user's 4242`));
  const unreadable = run(root, { families: ["aged"], uid: ME, owner: () => "unknown" });
  assert.ok(existsSync(theirs));
  assert.match(unreadable.refused[0].reason, /its owner and filesystem could not be read/);
});

test("A11-348: the scratchpad root, nested paths and the other families are not the aged family's", () => {
  assert.deepEqual(agedFamilyOf("body.md"), { family: "aged" });
  assert.deepEqual(agedFamilyOf(".agents"), { family: "aged" });
  assert.deepEqual(agedFamilyOf("claude-1000"), { family: "unknown" }, "its mtime says nothing about the sessions written to inside it");
  assert.deepEqual(agedFamilyOf("claude-1001"), { family: "unknown" }, "the scratchpad root of any uid");
  assert.deepEqual(agedFamilyOf("claude-code.log"), { family: "aged" }, "only the root's own spelling is the root");
  assert.deepEqual(agedFamilyOf("body.md/inner"), { family: "unknown" });
  assert.deepEqual(agedFamilyOf("host-units-Ab12Cd"), { family: "unknown" }, "a fixture is the fixture family's");
  assert.deepEqual(agedFamilyOf("rv-2049-leftover"), { family: "unknown" }, "a review leftover waits for its pull request to close");
  assert.deepEqual(agedFamilyOf(`${DOOMED_PREFIX}x`), { family: "unknown" });
  const root = fresh("aged-excluded");
  const scratchRoot = leftover(root, "claude-1000", { hoursOld: 99, files: 1 });
  const review = leftover(root, "rv-2049-leftover", { hoursOld: 99, files: 1 });
  const wanted = leftover(root, "old.md", { hoursOld: 99 });
  assert.deepEqual(agedPaths(root).map((path) => path.slice(root.length + 1)), ["old.md"]);
  run(root, { families: ["aged"] });
  assert.ok(existsSync(scratchRoot) && existsSync(review));
  assert.equal(existsSync(wanted), false);
});

test("A11-348: without the aged owner a name from no family is still unrecognised, as before", () => {
  const root = fresh("aged-off");
  const verdict = classifyEntry(join(root, "board.json"), root, { openPrs: new Set(), held: new Set(), selfSessions: new Set(), now: NOW });
  assert.deepEqual([verdict.verdict, verdict.family], ["refuse", "unknown"]);
  assert.match(verdict.reason, /unrecognised: no family owns this name/);
});

test("A11-348: a run that names no families never removes an aged entry, however old: the aged family is asked for by name", () => {
  const root = fresh("aged-not-default");
  const old = leftover(root, "agr.log", { hoursOld: 99 });
  const report = run(root);
  assert.ok(existsSync(old));
  assert.equal(report.candidates, 0, "not even walked");
  assert.deepEqual(cliFamilies(["--apply"]), undefined);
});

test("A11-348: an entry on another filesystem than the root is refused, and one whose status cannot be read is too", () => {
  const root = fresh("aged-mount");
  const mount = leftover(root, "mounted", { hoursOld: 99, files: 1 });
  const here = (path: string) => ({ uid: ME, dev: path === root ? 1 : 2 });
  const report = run(root, { families: ["aged"], owner: here });
  assert.ok(existsSync(join(mount, "f0")), "what is mounted there is untouched");
  assert.match(report.refused[0].reason, /^a mount point: it is on another filesystem than the tmp root/);
  const onRoot = run(root, { families: ["aged"], owner: () => ({ uid: ME, dev: 1 }) });
  assert.deepEqual(onRoot.removed, [mount], "the control: the same entry on the root's own device goes");
});

test("A11-348: a process's executable keeps its directory, though the process names the directory nowhere else", () => {
  const root = fresh("aged-exe");
  const server = leftover(root, "server-dir", { hoursOld: 99, files: 1 });
  const proc = procWithProcess();
  symlinkSync(join(server, "f0"), join(proc, "4242", "exe"));
  const report = run(root, { families: ["aged"], procRoot: proc });
  assert.ok(existsSync(server));
  assert.match(report.refused[0].reason, /a running process holds this open/);
});

test("A11-348: young entries sorted ahead of an old one do not use up the reads that reach it", () => {
  const root = fresh("aged-starve");
  for (let i = 0; i < 12; i += 1) leftover(root, `a-young-${i}`, { hoursOld: 1, files: 1 });
  const old = leftover(root, "z-old.log", { hoursOld: 99 });
  const report = run(root, { families: ["aged"], maxExamined: 3 });
  assert.equal(existsSync(old), false, "twelve young entries come first by name, and the old one is still read and removed");
  assert.equal(report.refused.length, 12);
});

test("A11-348: a run stops walking when its wall-clock budget is spent, and the next one takes the rest", () => {
  const root = fresh("aged-clock");
  const old = leftover(root, "agr.log", { hoursOld: 99 });
  const stopped = run(root, { families: ["aged"], maxMs: -1 });
  assert.deepEqual([stopped.examined, existsSync(old)], [0, true]);
  assert.match(formatAppliedReport(stopped), /1 more classified path\(s\) were not looked at/);
  run(root, { families: ["aged"] });
  assert.equal(existsSync(old), false);
});

test("A11-348: a socket table that cannot be read refuses every aged entry, however old, rather than reading as 'no socket is bound'", () => {
  const root = fresh("aged-no-table");
  const old = leftover(root, "qs-AbC123", { hoursOld: 99, files: 1 });
  const noTable = emptyProc();
  rmSync(join(noTable, "net"), { recursive: true });
  assert.equal(processStrings(noTable), "unknown", "the table is part of what 'held' is read from");
  const report = run(root, { families: ["aged"], procRoot: noTable });
  assert.ok(existsSync(old));
  assert.match(report.refused[0].reason, /\/proc could not be listed/);
  assert.deepEqual(processStrings(emptyProc()), [], "the control: a readable, empty table is an empty answer");
});

test("A11-348: an activity marker that cannot be listed or read makes the age unknown, and the entry is refused", { skip: process.getuid?.() === 0 ? "root reads a mode-000 directory" : false }, () => {
  const root = fresh("aged-unreadable");
  const busy = leftover(root, "session", { hoursOld: 99, files: 1 });
  const tasks = join(busy, "tasks");
  mkdirSync(tasks);
  writeFileSync(join(tasks, "t"), "x");
  const old = new Date(NOW - 99 * HOUR_MS);
  for (const path of [join(tasks, "t"), tasks, busy]) utimesSync(path, old, old);
  chmodSync(tasks, 0o000);
  try {
    assert.equal(newestMtimeMs(busy), "unknown", "the top level reads three days old, but what is in tasks/ cannot be read");
    const report = run(root, { families: ["aged"] });
    assert.ok(existsSync(busy));
    assert.match(report.refused[0].reason, /its newest write time could not be read/);
  } finally {
    chmodSync(tasks, 0o755);
  }
  assert.equal(newestMtimeMs(busy), old.getTime(), "the control: readable again, the same tree is three days cold");
  run(root, { families: ["aged"] });
  assert.equal(existsSync(busy), false);
});

test("A11-348: a symlink is unlinked, never followed, and a half-removed aged directory is renamed so the next run finishes it", () => {
  const root = fresh("aged-shape");
  const outside = fresh("aged-outside");
  writeFileSync(join(outside, "keep"), "x");
  const link = join(root, "old-link");
  symlinkSync(outside, link);
  const big = leftover(root, "big-scratch", { hoursOld: 99, files: 5 });
  const linkTime = new Date(NOW - 99 * HOUR_MS);
  lutimesSync(link, linkTime, linkTime);
  const first = run(root, { families: ["aged"], maxRemovals: 3 });
  assert.ok(existsSync(join(outside, "keep")), "what the link points at is untouched");
  assert.equal(first.partial.length, 1);
  assert.ok(first.partial[0].includes(DOOMED_PREFIX), "marked, so a later run finds it at any age");
  run(root, { families: ["aged", "doomed"], now: NOW });
  assert.equal(readdirSync(root).filter((name) => name !== "old-link").length, 0);
  assert.equal(existsSync(big), false);
  assert.equal(lstatSync(outside).isDirectory(), true);
});

test("A11-348: --timer is the fixtures, the unfinished trees and the aged entries, and no other family", () => {
  assert.deepEqual(cliFamilies(["--apply", "--timer"]), ["fixture", "doomed", "aged"]);
  assert.deepEqual(cliFamilies(["--apply", "--fixtures-only"]), ["fixture", "doomed"]);
  assert.equal(cliFamilies(["--apply"]), undefined);
  const root = fresh("timer");
  const review = fixture(root, "rv-2049-leftover", { hoursOld: 99 });
  const old = leftover(root, "agr.log", { hoursOld: 99 });
  const timer = (...flags: string[]) => {
    const result = spawnSync(process.execPath, [CLI, `--tmp=${root}`, "--timer", ...flags], { encoding: "utf8", env: { ...process.env, AGENT_ORG_HOST: HOST } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const listed = timer();
  assert.match(listed, /WOULD REMOVE 1 of 1/);
  assert.match(listed, new RegExp(`${old}  \\[aged\\] -- the agent user's own, and no process holds it, and nothing has written here for \\d+\\.\\dh`));
  assert.ok(existsSync(old), "a dry run removes nothing");
  timer("--apply");
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(review), "the review family still waits for its announced cycle");
});

test("A11-348: the report tallies thousands of young aged entries by reason instead of printing each", () => {
  const root = fresh("aged-tally");
  for (let i = 0; i < 25; i += 1) leftover(root, `fresh-${i}.log`, { hoursOld: 1 });
  const report = formatDryRunReport(run(root, { families: ["aged"], dryRun: true }));
  assert.equal(report.split("\n").filter((line) => line.includes("[aged]") && !line.includes("...and")).length, 10);
  assert.match(report, /\.\.\.and 15 more \[aged\] -- written less than 24\.0h ago, so a run may still be using it/);
});

// --- THE UNITS ------------------------------------------------------------------------------------------------------------------------

const shipped = (name: string): string => readFileSync(join(SHIPPED, name), "utf8");
const directives = (text: string): string => text.split("\n").filter((line) => !line.startsWith("#")).join("\n");

test("#3849: the service runs niced and at the idle IO class, with the --timer apply, and cannot outlive its timer's interval", () => {
  const service = directives(shipped("tmp-prune.service.in"));
  assert.match(service, /^Nice=19$/m, "nice -n 19");
  assert.match(service, /^IOSchedulingClass=idle$/m, "ionice -c3 is the idle class");
  assert.match(service, /^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/prune-tmp\.ts --apply --timer$/m);
  const timer = directives(shipped("tmp-prune.timer.in"));
  assert.match(timer, /^OnUnitInactiveSec=1min$/m);
  const timeout = Number(/^TimeoutStartSec=(\d+)$/m.exec(service)?.[1]);
  assert.ok(timeout > 0 && timeout < 60, "a stuck run must be ended before the next one would start");
});

test("#3849: installed as the tool, the janitor runs prune-tmp.ts from the tool, niced, and told where the host's declaration is", () => {
  const rendered = shipped("tmp-prune.service.in")
    .replaceAll("@@checkout@@", "/p").replaceAll("@@binDir@@", "/b").replaceAll("@@home@@", "/h").replaceAll("@@workersDir@@", "/w");
  assert.match(rendered, /^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/prune-tmp\.ts --apply --timer$/m, "POSITIVE CONTROL: the shipped form is the one the tool form rewrites");
  const installed = toolForm("tmp-prune.service.in", rendered, { tool: "/tool", checkout: "/project", beforeTicks: [] });
  assert.match(installed, /^WorkingDirectory=\/tool$/m);
  assert.match(installed, /^Environment=AGENT_ORG_HOST=\/project\/\.agent-org\/host\.json$/m);
  assert.match(installed, /^ExecStart=%h\/\.local\/bin\/node src\/prune-tmp\.ts --apply --timer$/m);
  assert.match(installed, /^Nice=19$/m);
});

test("#3849: host:install copies the shipped tmpfiles rule verbatim into the user's rule directory, and installs nothing when none ships", () => {
  const tmpfilesDir = join(fresh("rules"), "user-tmpfiles.d");
  const out: string[] = [];
  const written = installTmpfiles({ tmpfilesDir, out: (line: string) => { out.push(line); } });
  assert.deepEqual(written, ["a11ign-tmp.conf"]);
  assert.equal(readFileSync(join(tmpfilesDir, "a11ign-tmp.conf"), "utf8"), shipped("a11ign-tmp.tmpfiles.conf.in"), "the installed bytes are the shipped bytes");
  assert.match(out.join(""), /installed a11ign-tmp\.conf/);
  // THE CONTROL: a host directory with no rule installs nothing and does not even create the rule directory.
  const none = join(fresh("none"), "user-tmpfiles.d");
  assert.deepEqual(installTmpfiles({ shippedDir: fresh("noshipped"), tmpfilesDir: none, out: noPause }), []);
  assert.equal(existsSync(none), false);
});

// --- THE USER TMPFILES RULE -----------------------------------------------------------------------------------------------------------

const haveTmpfiles = spawnSync("systemd-tmpfiles", ["--version"], { encoding: "utf8" }).status === 0;

test("#3849: the user tmpfiles rule ages `run-*` out after a day and leaves a young one, read from the SHIPPED file", { skip: haveTmpfiles ? false : "systemd-tmpfiles is not installed here, so the rule cannot be run" }, () => {
  const rule = directives(shipped("a11ign-tmp.tmpfiles.conf.in"));
  assert.match(rule, /^e %h\/\.cache\/a11ign\/tmp - - - mM:1d$/m, "the rule names the private tmp root and a one-day age");
  const home = fresh("home");
  const root = join(home, ".cache", "a11ign", "tmp");
  const old = join(root, "run-old"), young = join(root, "run-new");
  for (const dir of [old, young]) {
    mkdirSync(join(dir, "file-0"), { recursive: true });
    writeFileSync(join(dir, "file-0", "t.test.ts"), "x");
  }
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * HOUR_MS);
  for (const path of [old, join(old, "file-0"), join(old, "file-0", "t.test.ts")]) utimesSync(path, threeDaysAgo, threeDaysAgo);
  const conf = join(fresh("conf"), "a11ign-tmp.conf");
  writeFileSync(conf, rule.replaceAll("%h", home));
  const clean = () => spawnSync("systemd-tmpfiles", ["--user", "--clean", conf], { encoding: "utf8" });
  const result = clean();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(old), false, "the old run is gone, directories and all, in ONE pass");
  assert.ok(existsSync(join(young, "file-0", "t.test.ts")), "the new run is untouched");
});
