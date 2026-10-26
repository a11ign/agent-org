// no-token: none -- the directories and the stand-in /proc are a test's own, the clock is injected, and nothing is spawned
//
// A11-303: THE BOARD CLEARS THE LEGACY ENTRIES OF THE SHARED /tmp ITSELF. An entry the agent owns, not modified for a day and open by no process is taken; a bounded number a pass; never by listing or removing a huge directory in one go.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { poolFixture } from "./pool-fixture.ts";
import { DOOMED_PREFIX, isLegacy, LEGACY_EXAMINED_PER_PASS, LEGACY_MIN_AGE_MS, newLegacySweepState, openEntriesOf, sweepLegacyTmp, type LegacyTmp } from "./legacy-tmp.ts";
import { MAX_REMOVALS_PER_PASS, sweepRunTmp } from "./run-isolation.ts";
import type { Budget } from "./bounded-removal.ts";
import type { PoolContext } from "./pool-context.ts";

const NOW = Date.UTC(2026, 9, 26, 21, 0, 0);
const OWN = process.getuid!();

/** A pool context that holds only what the legacy sweep reads: the directory it is given, the clock, and the cursor it keeps. */
const ctxOver = (legacyTmp: LegacyTmp | undefined, now = NOW): PoolContext => ({ deps: { legacyTmp }, now: () => now, legacySweep: newLegacySweepState() }) as unknown as PoolContext;

/** A `/proc` of the processes `held` describes: each `[pid, kind, target]` is a link of that process, `cwd` or `fd/<n>`. */
function fakeProc(held: readonly (readonly [number, string, string])[] = []): string {
  const proc = tmpDir("legacy-proc-");
  for (const [pid, kind, target] of held) {
    const dir = join(proc, String(pid));
    mkdirSync(join(dir, "fd"), { recursive: true });
    symlinkSync(target, join(dir, kind === "cwd" ? "cwd" : join("fd", kind)));
  }
  return proc;
}

const age = (path: string, ms: number): void => { const at = new Date(NOW - ms); utimesSync(path, at, at); };
const names = (root: string): string[] => readdirSync(root).toSorted();
const budgetOf = (left = MAX_REMOVALS_PER_PASS): Budget => ({ left });
const DAY = LEGACY_MIN_AGE_MS;

test("A11-303: an entry the agent owns is taken once it is a day old and not before", () => {
  const root = tmpDir("legacy-tmp-");
  writeFileSync(join(root, "ae-old"), "");
  writeFileSync(join(root, "ae-edge"), "");
  writeFileSync(join(root, "ae-young"), "");
  mkdirSync(join(root, "tmp.OldDir"));
  writeFileSync(join(root, "tmp.OldDir", "inner"), "");
  age(join(root, "ae-old"), DAY + 1000);
  age(join(root, "ae-edge"), DAY);
  age(join(root, "ae-young"), DAY - 1000);
  age(join(root, "tmp.OldDir"), 3 * DAY);
  sweepLegacyTmp(ctxOver({ root, procRoot: fakeProc() }), budgetOf());
  assert.deepEqual(names(root), ["ae-young"], "a file of a day and a bit, a file of exactly a day, and a directory with what it holds are gone; the young one stays");
});

test("A11-303: an entry another user owns is left, however old", () => {
  const root = tmpDir("legacy-tmp-");
  writeFileSync(join(root, "ae-theirs"), "");
  writeFileSync(join(root, "ae-ours"), "");
  age(join(root, "ae-theirs"), 5 * DAY);
  age(join(root, "ae-ours"), 5 * DAY);
  sweepLegacyTmp(ctxOver({ root, uid: OWN + 1, procRoot: fakeProc() }), budgetOf());
  assert.deepEqual(names(root), ["ae-ours", "ae-theirs"], "taken as another user, none is the agent's");
  sweepLegacyTmp(ctxOver({ root, uid: OWN, procRoot: fakeProc() }), budgetOf());
  assert.deepEqual(names(root), [], "CONTROL: as the user who owns them, both go");
});

test("A11-303: an entry a process has open or stands in is left, whatever it is called; one it cannot see is not guessed at", () => {
  const root = tmpDir("legacy-tmp-");
  for (const name of ["held-file", "held-cwd", "held-nested", "free"]) { mkdirSync(join(root, name)); writeFileSync(join(root, name, "inner"), ""); age(join(root, name), 4 * DAY); }
  mkdirSync(join(root, "held-nested", "deep"));
  const proc = fakeProc([[101, "3", join(root, "held-file", "inner")], [102, "cwd", join(root, "held-cwd")], [103, "7", join(root, "held-nested", "deep", "x.log (deleted)")]]);
  assert.deepEqual([...openEntriesOf(root, proc)!].toSorted(), ["held-cwd", "held-file", "held-nested"], "the first path segment under the directory, from an fd, a cwd and a deleted file");
  sweepLegacyTmp(ctxOver({ root, procRoot: proc }), budgetOf());
  assert.deepEqual(names(root), ["held-cwd", "held-file", "held-nested"], "only the one nothing holds is taken");
  const blind = tmpDir("legacy-tmp-");
  writeFileSync(join(blind, "ae-old"), "");
  age(join(blind, "ae-old"), 4 * DAY);
  sweepLegacyTmp(ctxOver({ root: blind, procRoot: join(blind, "no-proc-here") }), budgetOf());
  assert.deepEqual(names(blind), ["ae-old"], "a /proc that cannot be listed says nothing about what is open, so nothing is taken");
});

test("A11-303: a pass takes at most the budget, and the next pass takes more", () => {
  const root = tmpDir("legacy-tmp-");
  const total = MAX_REMOVALS_PER_PASS + 120;
  for (let at = 0; at < total; at++) { writeFileSync(join(root, `ae-${at}`), ""); age(join(root, `ae-${at}`), 2 * DAY); }
  const ctx = ctxOver({ root, procRoot: fakeProc() });
  sweepLegacyTmp(ctx, budgetOf());
  assert.equal(readdirSync(root).length, total - MAX_REMOVALS_PER_PASS, "one pass removes its budget and no more");
  sweepLegacyTmp(ctx, budgetOf());
  assert.equal(readdirSync(root).length, 0, "the next pass finishes it");
});

test("A11-303: a pass looks at no more than LEGACY_EXAMINED_PER_PASS names, and the cursor moves on so the old entries behind the young are reached", () => {
  const root = tmpDir("legacy-tmp-");
  const total = LEGACY_EXAMINED_PER_PASS * 2 + 300;
  const old = new Set<string>();
  for (let at = 0; at < total; at++) {
    const name = `ae-${at}`;
    writeFileSync(join(root, name), "");
    if (at % 7 === 0) { age(join(root, name), 2 * DAY); old.add(name); }
  }
  const ctx = ctxOver({ root, procRoot: fakeProc() });
  sweepLegacyTmp(ctx, budgetOf(Infinity));
  const left = new Set(readdirSync(root));
  const removed = [...old].filter((name) => !left.has(name));
  assert.ok(removed.length > 0 && removed.length < old.size, `the first pass reaches some of the old entries (${removed.length} of ${old.size}), not all: it examined ${LEGACY_EXAMINED_PER_PASS} of ${total} names`);
  for (let pass = 0; pass < 4; pass++) sweepLegacyTmp(ctx, budgetOf(Infinity));
  assert.deepEqual(readdirSync(root).filter((name) => old.has(name)), [], "a few passes later every old entry is gone");
  assert.equal(readdirSync(root).length, total - old.size, "and every young one is left");
});

test("A11-303: a directory the budget stopped in is finished by the next pass, though removing its children made it young", () => {
  const root = tmpDir("legacy-tmp-");
  mkdirSync(join(root, "tmp.Big"));
  for (let at = 0; at < 30; at++) writeFileSync(join(root, "tmp.Big", `f${at}`), "");
  age(join(root, "tmp.Big"), 2 * DAY);
  const ctx = ctxOver({ root, procRoot: fakeProc() });
  sweepLegacyTmp(ctx, budgetOf(10));
  assert.deepEqual(names(root), [`${DOOMED_PREFIX}tmp.Big`], "it was renamed whole and 10 of its entries removed, so the name it had no longer stands");
  assert.equal(readdirSync(join(root, `${DOOMED_PREFIX}tmp.Big`)).length, 20);
  for (let pass = 0; pass < 3; pass++) sweepLegacyTmp(ctx, budgetOf(10));
  assert.deepEqual(names(root), [], "three more passes of 10 take the rest, and then the directory itself (30 files and the directory are 31 removals)");
  // The state is not needed to find it: a pass of another instance, with a cursor of its own, takes it by its name at any age.
  mkdirSync(join(root, `${DOOMED_PREFIX}tmp.Half`));
  writeFileSync(join(root, `${DOOMED_PREFIX}tmp.Half`, "f"), "");
  sweepLegacyTmp(ctxOver({ root, procRoot: fakeProc() }, NOW), budgetOf());
  assert.deepEqual(names(root), []);
});

test("A11-303: a link is removed as itself, its target left; a name a session keeps alive is left; only a file, a directory or a link is ever taken", () => {
  const root = tmpDir("legacy-tmp-");
  const target = tmpDir("legacy-tmp-target-");
  writeFileSync(join(target, "keep.txt"), "not the sweep's");
  symlinkSync(target, join(root, "link"));
  for (const kept of [".X11-unix", "claude-1000", "tmux-1000", "ssh-AbCd", "systemd-private-1234-x", "snap-private-tmp"]) { mkdirSync(join(root, kept)); age(join(root, kept), 9 * DAY); }
  sweepLegacyTmp(ctxOver({ root, procRoot: fakeProc() }, Date.now() + 3 * DAY), budgetOf());
  assert.deepEqual(names(root).filter((name) => name === "link"), [], "the link, made just now, is three days old on the clock the pool is given, and is removed");
  assert.deepEqual(readdirSync(target), ["keep.txt"], "and its target is left");
  assert.deepEqual(names(root), [".X11-unix", "claude-1000", "snap-private-tmp", "ssh-AbCd", "systemd-private-1234-x", "tmux-1000"]);
  const info = (over: Partial<{ uid: number; mtimeMs: number; file: boolean; dir: boolean; link: boolean }>) => ({ uid: OWN, mtimeMs: NOW - 2 * DAY, ...over, isFile: () => over.file ?? true, isDirectory: () => over.dir ?? false, isSymbolicLink: () => over.link ?? false });
  assert.equal(isLegacy("ae-x", info({}), { uid: OWN, now: NOW }), true);
  assert.equal(isLegacy("ae-sock", info({ file: false }), { uid: OWN, now: NOW }), false, "a socket, pipe or device is no file, directory or link: its path is how its clients find it");
  assert.equal(isLegacy(`${DOOMED_PREFIX}x`, info({ mtimeMs: NOW }), { uid: OWN, now: NOW }), true, "a half-removed tree of the sweep's own is taken at any age");
  assert.equal(isLegacy(".hidden", info({}), { uid: OWN, now: NOW }), false);
});

test("A11-303: the board's own sweep clears /tmp as well as the run directories, and does nothing in /tmp when the pool names no directory", async () => {
  const root = tmpDir("legacy-tmp-");
  writeFileSync(join(root, "ae-old"), "");
  age(join(root, "ae-old"), 2 * DAY);
  sweepRunTmp(ctxOver(undefined));
  assert.deepEqual(names(root), ["ae-old"], "no directory named: untouched");
  sweepRunTmp(ctxOver({ root, procRoot: fakeProc() }));
  assert.deepEqual(names(root), [], "named: the sweep that removes the run directories removes it too");
  // And the pool's tick runs it, with the pool's clock: it is the same function, called from the pass.
  writeFileSync(join(root, "ae-older"), "");
  age(join(root, "ae-older"), 2 * DAY);
  const made = poolFixture({ keys: [], now: () => NOW });
  await made.restart({ legacyTmp: { root, procRoot: fakeProc() } }).tick();
  assert.deepEqual(names(root), []);
});

test("A11-303: a directory that is not there is nothing to sweep, and a sweep that fails says so and does not throw", () => {
  assert.doesNotThrow(() => sweepLegacyTmp(ctxOver({ root: join(tmpDir("legacy-tmp-"), "missing"), procRoot: fakeProc() }), budgetOf()));
  const root = tmpDir("legacy-tmp-");
  writeFileSync(join(root, "ae-old"), "");
  age(join(root, "ae-old"), 2 * DAY);
  assert.doesNotThrow(() => sweepLegacyTmp(ctxOver({ root, procRoot: fakeProc() }), budgetOf(0)));
  assert.ok(existsSync(join(root, "ae-old")), "a spent budget removes nothing");
});

test("A11-303: a half-removed tree that a process holds is left, and is still the next pass's to finish once the process lets go", () => {
  const root = tmpDir("legacy-tmp-");
  const doomed = `${DOOMED_PREFIX}tmp.Held`;
  mkdirSync(join(root, doomed));
  writeFileSync(join(root, doomed, "f"), "");
  const ctx = ctxOver({ root, procRoot: fakeProc([[201, "cwd", join(root, doomed)]]) });
  ctx.legacySweep.doomed.push(doomed);
  sweepLegacyTmp(ctx, budgetOf());
  assert.deepEqual(names(root), [doomed], "held: left");
  assert.deepEqual(ctx.legacySweep.doomed, [doomed], "and remembered, not forgotten until the cursor comes round");
  (ctx.deps as { legacyTmp: LegacyTmp }).legacyTmp = { root, procRoot: fakeProc() };
  sweepLegacyTmp(ctx, budgetOf());
  assert.deepEqual(names(root), [], "let go: finished");
});
