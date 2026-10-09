/**
 * #2166: THE GUARD FOR `prune-tmp.ts` -- and the half that matters is the REFUSALS.
 *
 * The row this file closes was filed because a 16G RAM-backed `/tmp` reached 80% and a write failed with
 * `disk quota exceeded`, while the root disk read 47%. The obvious remedy -- a sweep keyed to `rv-*` --
 * sees 3 of 240 review leftovers and none of the 6.2G of dead session scratchpads that actually filled it.
 *
 * So there are two jobs here, and only one of them is easy:
 *
 * 1. **REMOVABLE, BY NAME.** A leftover whose pull request is closed, and a scratchpad no authority can
 *    find a live session behind, classify `remove` -- with the reason quoted, not merely counted.
 * 2. **REFUSED, BY NAME, WITH THE REASON QUOTED.** A live session's scratchpad and an open pull request's
 *    clone are refused. Without this half the file is `rm -rf /tmp/rv-*` wearing a better name, and the
 *    first thing it would delete is the scratchpad of whichever session ran it -- which is not a
 *    hypothetical: a session's CURRENT uuid is named by no process at all on this host (measured
 *    2026-09-23; six live `claude` processes, every argv uuid 7-9h cold).
 *
 * ## Every fixture is a real directory under a disposable root, and the process half uses a real process
 *
 * Nothing below reads or writes the real `/tmp` families: each test builds its own root under
 * `mkdtempSync` and hands that root to the tool, which is structurally unable to reach the host's
 * scratchpads from there. The one place a stub would have proved nothing -- "is this path held open by a
 * running process" -- SPAWNS A REAL PROCESS holding a real fd, and reads the answer through the real
 * `/proc`.
 *
 * ## A COUNT IS NOT A READ-BACK (#2012)
 *
 * The would-remove count read 79 before a change and 79 after it, with different membership, because the
 * population moved between runs minutes apart. Both populations here move faster than that. So every
 * assertion below names a PATH and quotes the reason the classifier gave for it; no assertion watches a
 * total, and the two that do count (the `rv-*` blind-spot control) compare two sets over the SAME fixture
 * in the same moment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVITY_WINDOW_MS, REVIEW_PREFIXES, SCRATCHPAD_ROOT,
  classifyEntry, familyOf, formatReport, heldEntries, newestMtimeMs, openPullRequests,
  processStrings, pruneTmp as pruneTmpWithClaims, removePath, selfSessions, sweepablePaths,
} from "../prune-tmp.ts";
import { claimRefusal, recordRemoval, REMOVAL_LOG_ENV } from "../worktree-removal.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

// #2782: EVERY REMOVAL WRITES A LINE AND READS THE ROW'S CLAIM, and a fixture must do neither to the host. The tests that ARE about
// either pass their own `claim` and `record` and read the log they pointed this at.
process.env[REMOVAL_LOG_ENV] = join(tmpDirForFile("removal-log-"), "worktree-removals");
const pruneTmp = (root: string, deps: NonNullable<Parameters<typeof pruneTmpWithClaims>[1]> = {}) =>
  pruneTmpWithClaims(root, { claim: () => ({ refused: false }), ...deps });

const CLI = fileURLToPath(new URL("../prune-tmp.ts", import.meta.url));

const LIVE_SESSION = "5913388d-3a80-4a63-9453-b4c7583486f6";
const DEAD_SESSION = "0b472b7e-ba86-4a9d-9f77-6793dc60461a";
const PROJECT = "-home-agent-repos-a11y-witness";
const HOUR_MS = 3_600_000;

/** Authorities with nothing live in them -- each test names the one it is actually about. */
const NOTHING_LIVE = {
  openPrs: new Set<number>(), held: new Set<string>(), selfSessions: new Set<string>(),
  now: Date.now(), mtime: () => Date.now() - 100 * HOUR_MS,
};

/** A disposable tmp root, removed after the test that made it (a `process.on("exit")` removal left 4,309 of them in `/tmp`, #3848). */
const makeRoot = (): string => tmpDir("prune-tmp-fixture-");

function scratchpad(root: string, session: string): string {
  const path = join(root, SCRATCHPAD_ROOT, PROJECT, session);
  mkdirSync(join(path, "scratchpad"), { recursive: true });
  writeFileSync(join(path, "scratchpad", "notes.txt"), "work in progress\n");
  return path;
}

/**
 * Backdates every mtime `newestMtimeMs` reads -- the entry and two levels beneath it. A fixture built a
 * millisecond ago is INSIDE the window, which is correct behaviour and the wrong fixture for a test about
 * anything else; every flow test below therefore ages what it means to have go cold, and nothing else.
 */
function age(path: string, hours: number): void {
  const when = new Date(Date.now() - hours * HOUR_MS);
  const walk = (target: string, depth: number): void => {
    for (const child of childrenOf(target)) if (depth > 0) walk(join(target, child), depth - 1);
    utimesSync(target, when, when);
  };
  walk(path, 2);
}

function childrenOf(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).map((entry) => entry.name); } catch { return []; }
}

function leftover(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "output.log"), "review output\n");
  return path;
}

// --- 1. the names themselves -------------------------------------------------------------------

test("familyOf reads the pull request number out of every spelling the host actually uses", () => {
  // Read off `/tmp` on the agents host at `d9521699e`, not imagined: six prefixes, 297 entries.
  const cases: [string, number][] = [
    ["rv1831", 1831], ["rv1541-eslint.out", 1541], ["rv-2087-settle-closed-rows.mjs.pristine", 2087],
    ["rv-2125.wake.pristine", 2125], ["review-base-1819", 1819], ["review-base-1819b", 1819],
    ["reviewer-source-2045", 2045], ["npm-cache-1837", 1837],
  ];
  for (const [name, pr] of cases) {
    assert.deepEqual(familyOf(name), { family: "review", pr }, `${name} should carry pull request #${pr}`);
  }
});

test("`rv2-` is reviewer-2's prefix, so rv2-1554 is pull request 1554 and never pull request 2", () => {
  // THE AMBIGUOUS PAIR. A leading-digit read gives 2 here, which would compare a live reviewer's
  // leftovers against the state of an ancient pull request -- and #2 has been closed for months, so the
  // wrong answer is the REMOVABLE one. `npm-cache-rv2-2184` is the same trap nested one deeper.
  assert.deepEqual(familyOf("rv2-1554-corpus.mjs.orig"), { family: "review", pr: 1554 });
  assert.deepEqual(familyOf("npm-cache-rv2-2184"), { family: "review", pr: 2184 });
  // The control: the prefix list is ordered, and reordering it is what breaks the two above.
  assert.ok(REVIEW_PREFIXES.indexOf("rv2-") < REVIEW_PREFIXES.indexOf("rv"),
    "rv2- must be tried before rv, or rv2-1554 reads as pull request 2");
  assert.ok(REVIEW_PREFIXES.indexOf("npm-cache-rv2-") < REVIEW_PREFIXES.indexOf("npm-cache-"));
});

test("a scratchpad is the uuid level and nothing shallower -- the project directory is shared", () => {
  assert.deepEqual(familyOf(`${SCRATCHPAD_ROOT}/${PROJECT}/${DEAD_SESSION}`),
    { family: "scratchpad", session: DEAD_SESSION, project: PROJECT });
  // Removing the project directory takes every live session's scratchpad with it, so it is NOT a family
  // member; neither is the root above it, nor a child that is not a uuid.
  assert.deepEqual(familyOf(`${SCRATCHPAD_ROOT}/${PROJECT}`), { family: "unknown" });
  assert.deepEqual(familyOf(SCRATCHPAD_ROOT), { family: "unknown" });
  assert.deepEqual(familyOf(`${SCRATCHPAD_ROOT}/${PROJECT}/not-a-uuid`), { family: "unknown" });
  assert.deepEqual(familyOf(`${SCRATCHPAD_ROOT}/${PROJECT}/${DEAD_SESSION}/scratchpad`), { family: "unknown" });
});

test("a prefix with no number behind it names no pull request, so it is unrecognised", () => {
  // `rv` and `review-base-` alone say a reviewer made them and nothing about which review, so nothing can
  // say whether they are finished. Named as unrecognised rather than swept on the strength of the prefix.
  for (const name of ["rv", "rv-", "review-base-", "npm-cache-", "board.json", "tsx-1000"]) {
    assert.deepEqual(familyOf(name), { family: "unknown" }, `${name} must not be claimed by a family`);
  }
});

// --- 2. REMOVABLE, by name, with the reason ----------------------------------------------------

test("a scratchpad whose session is dead classifies REMOVE, and says why", () => {
  const root = makeRoot();
  const path = scratchpad(root, DEAD_SESSION);
  const verdict = classifyEntry(path, root, NOTHING_LIVE);
  assert.equal(verdict.verdict, "remove");
  assert.equal(verdict.path, path);
  assert.match(verdict.reason, /no live session claims it/);
  assert.match(verdict.reason, /nothing has written here for 100\.0h/);
});

test("a review leftover whose pull request is CLOSED classifies REMOVE, naming the pull request", () => {
  const root = makeRoot();
  const path = leftover(root, "rv-2087-settle-closed-rows.mjs.pristine");
  // #2087 is absent from the open set -- which is the whole authority, so the set is the fixture.
  const verdict = classifyEntry(path, root, { ...NOTHING_LIVE, openPrs: new Set([2049, 2166]) });
  assert.equal(verdict.verdict, "remove");
  assert.match(verdict.reason, /pull request #2087 is closed/);
});

// --- 3. REFUSED, by name, with the reason quoted -- the half that matters -----------------------

test("REFUSED: the sweeping session's OWN scratchpad, named by CLAUDE_CODE_SESSION_ID", () => {
  // The failure this whole file exists to prevent. A session's CURRENT uuid appears in NO process argv
  // and is held open by nothing (measured 2026-09-23), so every other authority here reads it as dead --
  // this refusal is the only thing between a sweep and its own working directory.
  const root = makeRoot();
  const path = scratchpad(root, LIVE_SESSION);
  const verdict = classifyEntry(path, root,
    { ...NOTHING_LIVE, selfSessions: selfSessions({ CLAUDE_CODE_SESSION_ID: LIVE_SESSION }) });
  assert.equal(verdict.verdict, "refuse");
  assert.equal(verdict.path, path);
  assert.equal(verdict.reason,
    `this is the sweeping session's OWN scratchpad (CLAUDE_CODE_SESSION_ID=${LIVE_SESSION})`);
});

test("REFUSED: a review clone for an OPEN pull request, naming the number", () => {
  const root = makeRoot();
  const path = leftover(root, "rv-2049-acceptance.log");
  const verdict = classifyEntry(path, root, { ...NOTHING_LIVE, openPrs: new Set([2049]) });
  assert.equal(verdict.verdict, "refuse");
  assert.equal(verdict.path, path);
  assert.equal(verdict.reason, "pull request #2049 is OPEN -- this is somebody's current review");
});

test("REFUSED: a path a REAL running process holds open, read through the REAL /proc", () => {
  // The one authority a stub would prove nothing about. A real child process opens a real file inside the
  // fixture scratchpad and stays alive while the assertion runs.
  const root = makeRoot();
  const held = scratchpad(root, DEAD_SESSION);
  const other = scratchpad(root, "1284648c-2242-4e93-b448-b33d52294c79");
  const file = join(held, "scratchpad", "notes.txt");
  const child = spawn(process.execPath,
    ["-e", `const fs=require("node:fs");fs.openSync(${JSON.stringify(file)},"r");setTimeout(()=>{},60000)`],
    { stdio: "ignore" });
  try {
    waitFor(() => heldEntries([held], processStrings()) !== "unknown"
      && (heldEntries([held], processStrings()) as Set<string>).has(held));
    const strings = processStrings();
    const verdict = classifyEntry(held, root, { ...NOTHING_LIVE, held: heldEntries([held, other], strings) });
    assert.equal(verdict.verdict, "refuse");
    assert.equal(verdict.reason,
      "a running process holds this open, names it in its argv, or is standing in it");
    // The positive control for that refusal: a sibling nothing holds is still removable in the same read,
    // so the refusal came from the open fd rather than from the walk refusing everything.
    assert.equal(classifyEntry(other, root, { ...NOTHING_LIVE, held: heldEntries([held, other], strings) }).verdict,
      "remove");
  } finally {
    child.kill("SIGKILL");
  }
});

test("REFUSED: a path written inside the window, however dead its session looks", () => {
  const root = makeRoot();
  const path = scratchpad(root, DEAD_SESSION);
  const now = Date.now();
  const verdict = classifyEntry(path, root,
    { ...NOTHING_LIVE, now, mtime: () => now - (ACTIVITY_WINDOW_MS - HOUR_MS) });
  assert.equal(verdict.verdict, "refuse");
  assert.match(verdict.reason, /written 23\.0h ago, inside the 24\.0h window/);
});

test("REFUSED: every authority that cannot answer refuses, and none of them defaults to removable", () => {
  // The collapse this replaces: `[ "$(... 2>/dev/null)" != 0 ]` reading an ERRORED empty result the same
  // as a real answer. Here the wrong default is unrecoverable rather than merely wrong, so each way of
  // failing to look gets its own sentence.
  const root = makeRoot();
  const review = leftover(root, "rv-2087-x");
  const pad = scratchpad(root, DEAD_SESSION);
  const cases: [string, object, RegExp][] = [
    [review, { openPrs: "unknown" }, /open pull request list could not be read, so #2087 cannot be called closed/],
    [pad, { held: "unknown" }, /\/proc could not be listed/],
    [pad, { mtime: () => "unknown" }, /newest write time could not be read, so it is not known to be cold/],
  ];
  for (const [path, override, reason] of cases) {
    const verdict = classifyEntry(path, root, { ...NOTHING_LIVE, ...override } as never);
    assert.equal(verdict.verdict, "refuse", `${path} under ${JSON.stringify(Object.keys(override))}`);
    assert.match(verdict.reason, reason);
  }
});

test("REFUSED: a name no family owns, and anything outside the root that was walked", () => {
  const root = makeRoot();
  const stranger = join(root, "board.json");
  writeFileSync(stranger, "{}");
  const unknown = classifyEntry(stranger, root, NOTHING_LIVE);
  assert.equal(unknown.verdict, "refuse");
  assert.match(unknown.reason, /unrecognised: no family owns this name/);
  // Containment, asked of the classifier rather than assumed of the walk.
  const outside = classifyEntry("/etc/passwd", root, NOTHING_LIVE);
  assert.equal(outside.verdict, "refuse");
  assert.match(outside.reason, /outside .* -- this tool removes nothing it did not walk/);
  assert.equal(classifyEntry(join(root, "..", "elsewhere"), root, NOTHING_LIVE).verdict, "refuse");
});

// --- 4. the blind spot the row is named after --------------------------------------------------

test("an `rv-*` glob sees a fraction of what the classifier does -- the row's own finding, as a control", () => {
  // The shape measured on the host: 3 of 240. Reproduced here over one fixture read in one moment, so the
  // two numbers are comparable -- a count taken minutes apart would not be (#2012).
  const root = makeRoot();
  const names = ["rv1831", "rv1541-eslint.out", "rv-2087-x", "rv2-1554-corpus.mjs.orig",
    "review-base-1819", "reviewer-source-2045", "npm-cache-1837", "npm-cache-rv2-2184"];
  for (const name of names) leftover(root, name);
  scratchpad(root, DEAD_SESSION);
  const globbed = readdirSync(root).filter((name) => name.startsWith("rv-"));
  const classified = sweepablePaths(root);
  assert.equal(globbed.length, 1, "the glob the hand cleanup implies matches one of these eight");
  assert.equal(classified.length, names.length + 1, "the classifier reaches all eight, plus the scratchpad");
  // The part the glob cannot reach AT ALL, which is where the 6.2G was.
  assert.ok(classified.some((path) => path.includes(SCRATCHPAD_ROOT)),
    "no `/tmp/rv-*` pattern reaches a session scratchpad");
});

// --- 5. the authorities themselves -------------------------------------------------------------

test("openPullRequests answers `unknown` for every way of failing to read the list, never a short one", () => {
  // ABSENCE FROM THIS SET AUTHORISES A REMOVAL, so a listing that came back short must not look empty.
  assert.equal(openPullRequests({ run: () => { throw new Error("gh: command not found"); } }), "unknown");
  assert.equal(openPullRequests({ run: () => "not json" }), "unknown");
  assert.equal(openPullRequests({ run: () => '{"number":1}' }), "unknown", "an object is not a listing");
  assert.equal(openPullRequests({ run: () => '[{"number":"2049"}]' }), "unknown", "a non-integer number");
  // Truncation: a listing that comes back AT the limit has been cut off, and the entries beyond it would
  // read as closed. The limit is discovered from the argv the function itself passes, not restated here.
  let limit = 0;
  openPullRequests({ run: (_cmd, args) => { limit = Number(args[args.indexOf("--limit") + 1]); return "[]"; } });
  assert.ok(limit >= 300, "the limit must sit far above any plausible open count");
  const full = JSON.stringify(Array.from({ length: limit }, (_u, i) => ({ number: i + 1 })));
  assert.equal(openPullRequests({ run: () => full }), "unknown", "a listing at the limit is truncated");
  // The positive control for all of the above: a real, short listing IS read, and an empty one is an answer.
  assert.deepEqual(openPullRequests({ run: () => '[{"number":2049},{"number":2166}]' }), new Set([2049, 2166]));
  assert.deepEqual(openPullRequests({ run: () => "[]" }), new Set());
});

test("processStrings answers `unknown` when /proc cannot be listed, not an empty set", () => {
  assert.equal(processStrings(join(makeRoot(), "no-such-proc")), "unknown");
  assert.equal(heldEntries(["/tmp/anything"], "unknown"), "unknown");
  // And the real one is a list, which is what the held test above then reads through.
  assert.ok(Array.isArray(processStrings()), "the real /proc is readable on this host");
});

test("heldEntries matches at a path boundary, so /tmp/rv-21 is not held by a process naming /tmp/rv-210", () => {
  const strings = ["node --out=/tmp/rv-210/log.txt"];
  const held = heldEntries(["/tmp/rv-21", "/tmp/rv-210"], strings) as Set<string>;
  assert.deepEqual([...held], ["/tmp/rv-210"]);
  // Substring rather than prefix is deliberate: an argv carries a path mid-string, and over-refusing is
  // the side this errs towards. Both forms are pinned so neither can be dropped as incidental.
  assert.deepEqual([...(heldEntries(["/tmp/rv-21"], ["/tmp/rv-21"]) as Set<string>)], ["/tmp/rv-21"]);
  assert.deepEqual([...(heldEntries(["/tmp/rv-21"], ["cd /tmp/rv-21/sub && x"]) as Set<string>)], ["/tmp/rv-21"]);
});

test("newestMtimeMs reads INSIDE the directory, because the top-level mtime understates liveness", () => {
  // Measured on the host: the live session `e624ede0…` had a top-level mtime of 13:00 while its own
  // `tasks/` read 21:56 -- nine hours of a session working, invisible to a `stat` of the entry itself.
  const root = makeRoot();
  const path = scratchpad(root, DEAD_SESSION);
  const tasks = join(path, "tasks");
  mkdirSync(tasks);
  writeFileSync(join(tasks, "live.json"), "{}");
  const old = new Date(Date.now() - 200 * HOUR_MS);
  utimesSync(path, old, old);
  utimesSync(join(path, "scratchpad"), old, old);
  assert.ok(newestMtimeMs(path) !== "unknown" && Date.now() - (newestMtimeMs(path) as number) < HOUR_MS,
    "the fresh `tasks/` inside must win over the stale directory mtime");
  // And it is `unknown`, never a time, when there is nothing to read.
  assert.equal(newestMtimeMs(join(root, "gone")), "unknown");
});

// --- 6. the whole flow, and what --apply actually does ------------------------------------------

test("pruneTmp's dry run removes NOTHING and its --apply removes only what it classified removable", () => {
  const root = makeRoot();
  const dead = scratchpad(root, DEAD_SESSION);
  const live = scratchpad(root, LIVE_SESSION);
  const closed = leftover(root, "rv-2087-x");
  const open = leftover(root, "rv-2049-y");
  for (const path of [dead, live, closed, open]) age(path, 100);
  const deps = {
    env: { CLAUDE_CODE_SESSION_ID: LIVE_SESSION }, procRoot: join(root, "no-proc-here"),
    run: () => '[{"number":2049}]',
  };
  // `procRoot` above points at nothing on purpose for ONE assertion -- that an unreadable /proc refuses
  // everything rather than sweeping it. This is the "could not look" arm, run end to end.
  const blind = pruneTmp(root, { ...deps, dryRun: true });
  assert.equal(blind.removable.length, 0, "an unreadable /proc must not authorise a single removal");
  // Named per path rather than counted: the live scratchpad is refused by the SELF authority, which is
  // asked first because "this is your own scratchpad" is the more actionable sentence -- the other three
  // reach the /proc refusal, and the whole population is accounted for either way.
  assert.deepEqual(
    Object.fromEntries(blind.refused.map((entry) => [entry.path, /\/proc could not be listed/.test(entry.reason)])),
    { [dead]: true, [closed]: true, [open]: true, [live]: false });

  const dry = pruneTmp(root, { ...deps, procRoot: "/proc", dryRun: true });
  assert.deepEqual(dry.removable.map((entry) => entry.path).sort(), [closed, dead].sort());
  assert.deepEqual(dry.removed, [], "a dry run removes nothing");
  assert.ok([dead, live, closed, open].every(existsSync), "nothing on disk moved");
  assert.equal(dry.examined, 4);

  const applied = pruneTmp(root, { ...deps, procRoot: "/proc", dryRun: false });
  assert.deepEqual(applied.removed.sort(), [closed, dead].sort());
  assert.deepEqual(applied.failed, []);
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(closed), false);
  // THE HALF THAT MATTERS, read back on disk rather than in the report: both refusals survived --apply.
  assert.ok(existsSync(live), "the live session's scratchpad must still be there after --apply");
  assert.ok(existsSync(open), "the open pull request's leftover must still be there after --apply");
  assert.ok(applied.refused.some((entry) => entry.path === live
    && entry.reason.includes(`CLAUDE_CODE_SESSION_ID=${LIVE_SESSION}`)));
  assert.ok(applied.refused.some((entry) => entry.path === open && entry.reason.includes("#2049 is OPEN")));
});

test("a removal that fails is reported as still-there, never counted as removed", () => {
  const root = makeRoot();
  const dead = scratchpad(root, DEAD_SESSION);
  age(dead, 100);
  const report = pruneTmp(root, {
    dryRun: false, procRoot: "/proc", env: {}, run: () => "[]",
    remove: () => { throw new Error("EBUSY: resource busy or locked"); },
  });
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.failed.map((entry) => entry.path), [dead]);
  assert.match(report.failed[0].reason, /EBUSY/);
  assert.ok(existsSync(dead));
  assert.match(formatReport(report, false), /could NOT be removed and are still there/);
});

test("the delete re-checks containment itself, because no walk can hand it a path to refuse", () => {
  // The ONE mutant of fifteen that the rest of this file did not kill: deleting this check changed
  // nothing any test could see, because `classifyEntry` refuses an outside path before the walk ever
  // reaches the delete. So the only line in the module that destroys anything is asked directly.
  const root = makeRoot();
  const outside = tmpDir("prune-tmp-elsewhere-");
  try {
    let asked: string | null = null;
    const failure = removePath(outside, root, (target) => { asked = target; });
    assert.match(String(failure), /refused at the delete: .* is not under /);
    assert.equal(asked, null, "the remove must not even be attempted");
    assert.ok(existsSync(outside), "and nothing outside the root moved");
    // The positive control, in the same call shape: a path INSIDE the root is removed for real.
    const inside = scratchpad(root, DEAD_SESSION);
    assert.equal(removePath(inside, root), null);
    assert.equal(existsSync(inside), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("formatReport prints the examined count and every refusal's reason, rather than counting them", () => {
  const root = makeRoot();
  age(scratchpad(root, LIVE_SESSION), 100);
  age(scratchpad(root, DEAD_SESSION), 100);
  const report = pruneTmp(root, {
    dryRun: true, procRoot: "/proc", env: { CLAUDE_CODE_SESSION_ID: LIVE_SESSION }, run: () => "[]",
  });
  const printed = formatReport(report, true);
  // "0 removable" and "0 removable of 1,306 examined" are different claims, and only the second can be
  // seen to be wrong: a sweep that walked nothing prints the cleanest possible output (#933).
  assert.match(printed, /WOULD REMOVE 1 of 2 classified path\(s\)/);
  assert.match(printed, /nothing has been removed; pass --apply/);
  // The refusal is READABLE, which is what the row asked for -- a refusal folded into a total is a silent
  // skip wearing a number.
  assert.match(printed, new RegExp(`${LIVE_SESSION}.*\\[scratchpad\\] -- this is the sweeping session's OWN`));
  assert.ok(!/removed 1 of/.test(printed), "a dry run must never print the word the applied run prints");
});

// --- 7. the CLI, spawned for real --------------------------------------------------------------

/** A `gh` on PATH that answers a fixed open-pull-request listing, so the CLI test spends no API pool. */
function fakeGh(root: string, json: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s' '${json}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

test("the CLI defaults to the listing, and only --apply removes -- the argv path, run as a process", () => {
  // `dryRun` is decided in argv and nowhere else, so it is exercised rather than reasoned about. The
  // default is the listing because a command whose name reads as a report is one somebody runs to LOOK --
  // `prune-worktrees.ts` paid for the other way round by deleting three sessions' worktrees.
  const root = makeRoot();
  const dead = scratchpad(root, DEAD_SESSION);
  const open = leftover(root, "rv-2049-y");
  for (const path of [dead, open]) age(path, 100);
  const env = { ...process.env, PATH: `${fakeGh(root, '[{"number":2049}]')}:${process.env.PATH}` };

  const listed = spawnSync(process.execPath, [CLI, `--tmp=${root}`], { encoding: "utf8", env });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /WOULD REMOVE 1 of 2 classified path\(s\)/);
  assert.match(listed.stdout, new RegExp(`${open}\\s+\\[review\\] -- pull request #2049 is OPEN`));
  assert.ok(existsSync(dead), "the default run must not have removed anything");

  const removed = spawnSync(process.execPath, [CLI, `--tmp=${root}`, "--apply"], { encoding: "utf8", env });
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /removed 1 of 2 classified path\(s\)/);
  assert.equal(existsSync(dead), false);
  assert.ok(existsSync(open), "--apply must still refuse the open pull request's leftover");
});

test("the CLI refuses a flag it does not read, and a --tmp that is not there", () => {
  const root = makeRoot();
  const typo = spawnSync(process.execPath, [CLI, `--tmp=${root}`, "--dry-run"], { encoding: "utf8" });
  assert.notEqual(typo.status, 0, "a flag this command ignores must not run the default and report success");
  assert.match(typo.stderr + typo.stdout, /--dry-run/);
  const missing = spawnSync(process.execPath, [CLI, `--tmp=${join(root, "nope")}`], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /does not exist -- nothing was read or written/);
});

/** Spins until `ready()` or the deadline -- the child process needs a moment to open its fd. */
function waitFor(ready: () => boolean, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},50)"]);
  }
  assert.fail("the child process never appeared in /proc holding its fd");
}

// --- #2782: A WHOLE SCRATCHPAD GOES, AND ANY WORKTREE INSIDE IT GOES TOO. `wt-2623` was deleted under a live claim and this sweep
// writes no line at all. So each removal is logged BEFORE the delete, names the worktrees it takes, and a worktree whose ROW
// still carries a `session:` label refuses the whole path. ---

/** A worktree planted inside `dir`, with the gitdir pointer and `HEAD` that `worktreeBranch` reads, and an owner file. */
function plantWorktree(dir: string, name: string, branch: string, owner: string | null): string {
  const tree = join(dir, "scratchpad", name);
  const gitdir = join(dir, "scratchpad", ".gitdirs", name);
  mkdirSync(tree, { recursive: true });
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(tree, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`);
  if (owner !== null) writeFileSync(join(tree, ".a11y-owner"), `${owner}\n`);
  return tree;
}
const rowsGh = (rows: Record<number, string[]>) => (args: string[]) => {
  const labels = rows[Number(args[2])];
  if (labels === undefined) throw new Error("gh: row not found");
  return JSON.stringify({ state: "OPEN", labels: labels.map((name) => ({ name })) });
};

test("#2782 DONE-WHEN 3: a dead scratchpad HOLDING a worktree whose row is claimed is REFUSED whole; one holding an unclaimed row's is removed", () => {
  const root = makeRoot();
  const claimed = scratchpad(root, DEAD_SESSION);
  const free = scratchpad(root, "9a1f2b3c-4d5e-4f60-8a7b-0c1d2e3f4a5b");
  plantWorktree(claimed, "wt-2623", "agent/2623-followup", null);
  plantWorktree(free, "wt-2000", "agent/done-2000", "worker-2000");
  for (const path of [claimed, free]) age(path, 100);
  const gh = rowsGh({ 2623: ["in-progress", "session:worker-2623"], 2000: [] });
  const log = join(root, "removals.log");
  const report = pruneTmp(root, { dryRun: false, procRoot: "/proc", env: {}, run: () => "[]",
    claim: (tree) => claimRefusal(tree, { gh }), record: (line) => recordRemoval(line, { env: { [REMOVAL_LOG_ENV]: log } }) });
  assert.ok(existsSync(claimed), "the scratchpad holding a claimed row's worktree is still there: with a nested `.git` file its delete takes the tree with it");
  assert.ok(report.refused.some((entry) => entry.path === claimed && /row #2623, which still carries session:worker-2623/.test(entry.reason)));
  // THE OTHER HALF: without it, "refuse everything" passes.
  assert.equal(existsSync(free), false, "an unclaimed row's scratchpad must still be removed");
  assert.deepEqual(report.removed, [free]);
});

test("#2782 DONE-WHEN 1: a removal is logged BEFORE the delete, names the worktrees inside it and what their owner files read", () => {
  const root = makeRoot();
  const dead = scratchpad(root, DEAD_SESSION);
  const tree = plantWorktree(dead, "wt-2000", "agent/done-2000", "worker-2000");
  age(dead, 100);
  const log = join(root, "removals.log");
  const linesAtDelete: string[] = [];
  pruneTmp(root, { dryRun: false, procRoot: "/proc", env: {}, run: () => "[]",
    record: (line) => recordRemoval(line, { env: { [REMOVAL_LOG_ENV]: log } }),
    remove: () => { linesAtDelete.push(readFileSync(log, "utf8")); } });
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ["removing", "removed"]);
  assert.equal(lines[0].path, dead);
  assert.equal(lines[0].caller, "prune-tmp.ts");
  assert.match(lines[0].owner, new RegExp(`${tree}=worker-2000`), "the owner file is read before the tree is gone");
  assert.match(lines[0].detail, /holds worktree\(s\)/);
  assert.match(linesAtDelete[0], /"event":"removing"/, "the line was already on disk when the delete ran");
});

test("#2782: a log that cannot be written refuses the removal", () => {
  const root = makeRoot();
  const dead = scratchpad(root, DEAD_SESSION);
  age(dead, 100);
  const refused = pruneTmp(root, { dryRun: false, procRoot: "/proc", env: {}, run: () => "[]",
    record: () => { throw new Error("ENOSPC"); } });
  assert.ok(existsSync(dead), "nothing was deleted");
  assert.deepEqual(refused.removed, []);
  assert.match(refused.failed[0].reason, /removal log could not be written/);
});

test("#2782: the DRY RUN lists a claimed row's scratchpad as REFUSED -- a path it calls removable is one --apply removes -- and writes no line", () => {
  const root = makeRoot();
  const claimed = scratchpad(root, DEAD_SESSION);
  plantWorktree(claimed, "wt-2623", "agent/2623-followup", null);
  age(claimed, 100);
  const lines: unknown[] = [];
  const gh = rowsGh({ 2623: ["session:worker-2623"] });
  const report = pruneTmp(root, { dryRun: true, procRoot: "/proc", env: {}, run: () => "[]",
    claim: (tree) => claimRefusal(tree, { gh }), record: (line) => { lines.push(line); } });
  assert.deepEqual(report.removable, []);
  assert.ok(report.refused.some((entry) => entry.path === claimed && /session:worker-2623/.test(entry.reason)));
  assert.deepEqual(lines, [], "a listing removes nothing, so it logs no removal");
});
