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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOOMED_PREFIX, FIXTURE_PREFIXES, FIXTURE_WINDOW_MS, MAX_REMOVALS_PER_RUN, PAUSE_BETWEEN_REMOVALS_MS,
  classifyEntry, doomedPaths, familyOf, fixturePaths, formatReport, pruneTmp as pruneTmpWithClaims, removeFromLeaves,
} from "./prune-tmp.mjs";
import { installTmpfiles, toolForm } from "./host-units.mjs";
import { REMOVAL_LOG_ENV } from "./worktree-removal.mjs";

const BASE = mkdtempSync(join(tmpdir(), "prune-tmp-janitor-"));
after(() => { rmSync(BASE, { recursive: true, force: true }); });
// #2782: every removal writes a line, and a fixture must not write the host's log.
process.env[REMOVAL_LOG_ENV] = join(BASE, "worktree-removals");

const CLI = fileURLToPath(new URL("./prune-tmp.mjs", import.meta.url));
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
  mkdirSync(proc);
  return proc;
}

/** A fake `/proc` in which one process names `held` in its argv, which is what `heldEntries` reads. */
function procHolding(held: string): string {
  const proc = emptyProc();
  mkdirSync(join(proc, "4242"));
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

test("#3849: a fixture a running process names is REFUSED however old it is, and its neighbour goes", () => {
  const root = fresh("held");
  const held = fixture(root, "host-units-held1", { hoursOld: 30 });
  const free = fixture(root, "host-units-free1", { hoursOld: 30 });
  const report = run(root, { procRoot: procHolding(held) });
  assert.ok(existsSync(held), "a held fixture must still be there");
  assert.equal(existsSync(free), false, "the same age, not held, must be gone: the refusal is the HELD check and not the age");
  assert.match(report.refused.find((entry) => entry.path === held)!.reason, /a running process holds this/);
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
  assert.match(formatReport(report, false), /^nothing to remove: 0 classified path\(s\) found/);
  // The control for "says so": a root WITH a removable fixture does not print that sentence.
  fixture(root, "ingest-state-one", { hoursOld: 5 });
  assert.doesNotMatch(formatReport(run(root), false), /nothing to remove/);
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
  const env = { ...process.env, AGENT_ORG_HOST: process.env.AGENT_ORG_HOST ?? hostFile() };
  const listed = spawnSync(process.execPath, [CLI, `--tmp=${root}`, "--fixtures-only"], { encoding: "utf8", env });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /WOULD REMOVE 1 of 1/);
  assert.ok(existsSync(dir));
  const applied = spawnSync(process.execPath, [CLI, `--tmp=${root}`, "--fixtures-only", "--apply"], { encoding: "utf8", env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /removed 1 of 1/);
  assert.equal(existsSync(dir), false);
});

/** A host declaration the CLI's checkout resolution accepts, for a run with no `AGENT_ORG_HOST` of its own. */
function hostFile(): string {
  const checkout = fresh("checkout");
  mkdirSync(join(checkout, ".agent-org"));
  const declaration = join(checkout, ".agent-org", "project.json");
  writeFileSync(declaration, readFileSync(fileURLToPath(new URL("../.agent-org/project.json", import.meta.url)), "utf8"));
  return join(checkout, ".agent-org", "host.json");
}

// --- THE UNITS ------------------------------------------------------------------------------------------------------------------------

const shipped = (name: string): string => readFileSync(join(SHIPPED, name), "utf8");
const directives = (text: string): string => text.split("\n").filter((line) => !line.startsWith("#")).join("\n");

test("#3849: the service runs niced and at the idle IO class, with the fixtures-only apply, and cannot outlive its timer's interval", () => {
  const service = directives(shipped("tmp-prune.service.in"));
  assert.match(service, /^Nice=19$/m, "nice -n 19");
  assert.match(service, /^IOSchedulingClass=idle$/m, "ionice -c3 is the idle class");
  assert.match(service, /^ExecStart=\/usr\/bin\/node packages\/agent-org\/src\/prune-tmp\.mjs --apply --fixtures-only$/m);
  const timer = directives(shipped("tmp-prune.timer.in"));
  assert.match(timer, /^OnUnitInactiveSec=1min$/m);
  const timeout = Number(/^TimeoutStartSec=(\d+)$/m.exec(service)?.[1]);
  assert.ok(timeout > 0 && timeout < 60, "a stuck run must be ended before the next one would start");
});

test("#3849: installed as the tool, the janitor runs prune-tmp.mjs from the tool, niced, and told where the host's declaration is", () => {
  const rendered = shipped("tmp-prune.service.in")
    .replaceAll("@@checkout@@", "/p").replaceAll("@@binDir@@", "/b").replaceAll("@@home@@", "/h").replaceAll("@@workersDir@@", "/w");
  assert.match(rendered, /^ExecStart=\/usr\/bin\/node packages\/agent-org\/src\/prune-tmp\.mjs --apply --fixtures-only$/m, "POSITIVE CONTROL: the shipped form is the one the tool form rewrites");
  const installed = toolForm("tmp-prune.service.in", rendered, { tool: "/tool", checkout: "/project", beforeTicks: [] });
  assert.match(installed, /^WorkingDirectory=\/tool$/m);
  assert.match(installed, /^Environment=AGENT_ORG_HOST=\/project\/\.agent-org\/host\.json$/m);
  assert.match(installed, /^ExecStart=\/usr\/bin\/node src\/prune-tmp\.mjs --apply --fixtures-only$/m);
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
