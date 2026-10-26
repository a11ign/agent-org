// @ts-check
// module: the board clears the agent-owned entries earlier runs left in the shared /tmp, a bounded number a pass (A11-303)
//
// WHY THE BOARD DOES IT ITSELF. `/tmp` was back over 10,000 entries on 2026-10-26, nearly all of them left by test runs before sessions had a private `TMPDIR` (`session-tmp.ts`). The janitor that exists (`prune-tmp.ts`) removes only
// the families it can name, and the rest of the pile stays. Once no session writes to `/tmp` any more, what is there is the legacy this clears: an entry the agent owns, not modified for a day, and held open by no process.
//
// IT NEVER LISTS OR REMOVES A HUGE DIRECTORY IN ONE GO. The directory is read as a stream, {@link LEGACY_EXAMINED_PER_PASS} names a pass from a cursor that moves on (tmpfs lists the newest first, so a sweep that always began at the
// front would look at the entries it must leave for ever), and each removal is one `unlink` or `rmdir` within the pass's budget (`bounded-removal.ts`). A directory is renamed to {@link DOOMED_PREFIX} first, which is one
// atomic call, and what it buys is a state: a tree the budget stopped half way no longer looks young (removing its children refreshed its mtime), so the next pass finds it by its name and finishes it.
//
// WHAT IT LEAVES. Anything another user owns; anything a process has open or stands in; a socket, pipe or device (a listening socket is no open file of anyone's, and its path is how its clients find it); and the names a
// session keeps alive without writing to them (dot entries such as `.X11-unix`, `claude-<uid>` and `tmux-<uid>`, `ssh-*`, `systemd-private-*`).
import { existsSync, lstatSync, opendirSync, readdirSync, readlinkSync, renameSync, unlinkSync, type Stats } from "node:fs";
import { join, resolve, sep } from "node:path";
import { type Budget, removeWithin } from "./bounded-removal.ts";
import { type PoolContext } from "./pool-context.ts";
import { log } from "./pool-state.ts";

/** The shared temporary directory of the host, which every session used before it had a private one. */
export const LEGACY_TMP_ROOT = "/tmp";

/** How long an entry must have gone unmodified before the sweep takes it. */
export const LEGACY_MIN_AGE_MS = 24 * 60 * 60_000;

/** The most names of `/tmp` one pass looks at, each with one `lstat`: a directory of any size costs this much a pass. */
export const LEGACY_EXAMINED_PER_PASS = 1_000;

/** The furthest into the directory the cursor goes before it starts again from the front, so the names a pass skips are bounded too. */
export const LEGACY_CURSOR_LIMIT = 20_000;

/** The name a directory is renamed to before its removal starts, so a pass that stops half way can be finished by the next. */
export const DOOMED_PREFIX = ".org-sweep-";

/** The names a session keeps alive without writing to them, or the system owns. A dot entry is kept unless it is a half-removed tree of this sweep's own. */
const KEPT = /^(?:\.(?!org-sweep-)|claude-\d+$|tmux-\d+$|ssh-|systemd-private-|snap-private-tmp$)/;

/** Where the sweep looks and as whom: the directory (`/tmp`), the user whose entries it takes (the process's own when absent), and the `/proc` it asks which entries are open (the machine's when absent). */
export type LegacyTmp = Readonly<{ root: string; uid?: number; procRoot?: string }>;

/** What the pool remembers of the sweep between passes: how far into the directory the last pass got, and the half-removed trees to finish first. */
export type LegacySweepState = { skip: number; doomed: string[] };

export const newLegacySweepState = (): LegacySweepState => ({ skip: 0, doomed: [] });

/** The names the processes of `procRoot` hold open or stand in under `root`, as the entries' own names, or null when `/proc` cannot be listed ("nobody holds it" and "could not look" are not the same answer). */
export function openEntriesOf(root: string, procRoot = "/proc"): Set<string> | null {
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const prefix = `${resolve(root)}${sep}`;
  const held = new Set<string>();
  const note = (target: string): void => { if (target.startsWith(prefix)) held.add(target.slice(prefix.length).split(sep)[0]!); };
  for (const pid of pids) {
    const dir = join(procRoot, pid);
    for (const link of ["cwd", "exe"]) {
      try { note(readlinkSync(join(dir, link))); } catch { /* gone, or not ours to read */ }
    }
    let fds: string[] = [];
    try { fds = readdirSync(join(dir, "fd")); } catch { /* gone, or not ours to read */ }
    for (const fd of fds) {
      try { note(readlinkSync(join(dir, "fd", fd))); } catch { /* closed between the two calls */ }
    }
  }
  return held;
}

/** The next `take` names of `root` after the first `skip`, read from a stream and no further, and whether the directory ended inside them. */
function namesFrom(root: string, skip: number, take: number): { names: string[]; ended: boolean } {
  const stream = opendirSync(root);
  try {
    const names: string[] = [];
    for (let seen = 0; seen < skip + take; seen++) {
      const entry = stream.readSync();
      if (entry === null) return { names, ended: true };
      if (seen >= skip) names.push(entry.name);
    }
    return { names, ended: false };
  } finally {
    stream.closeSync();
  }
}

/** Is `name`, as `info` reads it, an entry this sweep takes: the user's own, a file, directory or link, not kept by name, and old (a half-removed tree of this sweep's is taken at any age)? PURE. */
export function isLegacy(name: string, info: Pick<Stats, "uid" | "mtimeMs" | "isFile" | "isDirectory" | "isSymbolicLink">, { uid, now }: Readonly<{ uid: number; now: number }>): boolean {
  if (info.uid !== uid || KEPT.test(name)) return false;
  if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) return false;
  return name.startsWith(DOOMED_PREFIX) || now - info.mtimeMs >= LEGACY_MIN_AGE_MS;
}

/** The guard of a removal under `root`: a path is allowed only when it is inside an entry of `root`, never `root` itself and never above or beside it. */
const underRoot = (root: string) => (path: string): string => {
  const resolved = resolve(path);
  if (!resolved.startsWith(`${resolve(root)}${sep}`)) throw new Error(`legacy-tmp: refusing ${resolved}: not inside ${resolve(root)}`);
  return resolved;
};

/** What one pass has to hand a removal: the config, the clock and the budget, and the open entries, asked for once and only when an entry is there to take. */
type Pass = { config: LegacyTmp; uid: number; now: number; budget: Budget; open: () => Set<string> | null; guard: (path: string) => string };

/** Take `name` out of the directory: a file or link is unlinked, a directory is renamed to {@link DOOMED_PREFIX} and removed within the budget, and kept in `state` to be finished when the budget ran out in it. */
function take(pass: Pass, name: string, state: LegacySweepState): void {
  const { config: { root }, budget, guard } = pass;
  const path = join(root, name);
  if (!lstatSync(path).isDirectory()) {
    unlinkSync(guard(path));
    budget.left -= 1;
    return;
  }
  const doomed = name.startsWith(DOOMED_PREFIX) ? name : `${DOOMED_PREFIX}${name}`;
  if (doomed !== name) renameSync(guard(path), guard(join(root, doomed)));
  if (!removeWithin(join(root, doomed), guard, budget)) state.doomed.push(doomed);
}

/** Take each of `names` that is legacy and open by no process, until the budget is spent. Returns how many no longer stand under their names. */
function takeLegacy(pass: Pass, names: readonly string[], state: LegacySweepState): number {
  const { config: { root }, uid, now, budget } = pass;
  const legacy = names.filter((name) => {
    try {
      return isLegacy(name, lstatSync(join(root, name)), { uid, now });
    } catch {
      return false;
    }
  });
  const open = legacy.length === 0 ? null : pass.open();
  let gone = 0;
  for (const name of legacy.filter((each) => open?.has(each) === false)) {
    if (budget.left === 0) break;
    try {
      take(pass, name, state);
      gone += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`the legacy entry ${join(root, name)} could not be removed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return gone;
}

/** The open entries of `config.root`, read the first time they are asked for in a pass and remembered after, and said in the log when `/proc` could not be read. */
function openOnce(config: LegacyTmp): () => Set<string> | null {
  let read: { open: Set<string> | null } | undefined;
  return () => {
    if (read === undefined) {
      read = { open: openEntriesOf(config.root, config.procRoot) };
      if (read.open === null) log(`${config.procRoot ?? "/proc"} could not be listed, so no legacy entry of ${config.root} was taken: "no process holds it" was not read.`);
    }
    return read.open;
  };
}

/**
 * One pass over `/tmp` (`ctx.deps.legacyTmp`): the trees an earlier pass left half removed, then the next {@link LEGACY_EXAMINED_PER_PASS} names after the cursor, within `budget`. Does nothing when the pool names no directory
 * (every test, and an instance started without one). Never throws.
 */
export function sweepLegacyTmp(ctx: PoolContext, budget: Budget): void {
  const config = ctx.deps.legacyTmp;
  const uid = config?.uid ?? process.getuid?.();
  if (config === undefined || uid === undefined || budget.left === 0) return;
  const state = ctx.legacySweep;
  const pass: Pass = { config, uid, now: ctx.now(), budget, open: openOnce(config), guard: underRoot(config.root) };
  try {
    const pending = state.doomed.splice(0);
    takeLegacy(pass, pending, state);
    state.doomed.push(...pending.filter((name) => !state.doomed.includes(name) && existsSync(join(config.root, name))));
    if (budget.left === 0) return;
    const { names, ended } = namesFrom(config.root, state.skip, LEGACY_EXAMINED_PER_PASS);
    const gone = takeLegacy(pass, names, state);
    const next = state.skip + names.length - gone;
    state.skip = ended || next > LEGACY_CURSOR_LIMIT ? 0 : next;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`${config.root} could not be swept: ${(err as Error).message.split("\n")[0]}`);
  }
}
