// @ts-check
// module: remove a directory's contents one entry per call, within a budget of entries, never listing more than the budget can remove (A11-279, A11-303)
//
// THE INCIDENT WAS A LARGE DIRECTORY OPERATION (2026-10-25, a 26 s soft lockup in `ext4_readdir` over a `/tmp` of ~19,600 entries). So nothing here is one recursive `rm`, and nothing lists a directory whole: a batch of at
// most the budget's entries is read, removed with `unlink` and `rmdir` one call each, and the next batch is read only if budget is left. A tree that does not fit in the budget is stopped at a leaf and finished by a later pass.
import { opendirSync, rmdirSync, unlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** Entries left to remove in this pass: spent one per `unlink` or `rmdir`. */
export type Budget = { left: number };

/** Answers the path when removing it is allowed, and throws when it is not: every removal passes through one (`requirePrivate` for a run's directory, a root's own check for another). */
export type Guard = (path: string) => string;

/** At most `limit` entries of `dir`, read from a directory stream that is closed again, so a directory of any size costs a batch. */
function takeEntries(dir: string, limit: number): Dirent[] {
  const stream = opendirSync(dir);
  try {
    const taken: Dirent[] = [];
    while (taken.length < limit) {
      const entry = stream.readSync();
      if (entry === null) break;
      taken.push(entry);
    }
    return taken;
  } finally {
    stream.closeSync();
  }
}

/** Remove `dir` one entry per call until `budget` is spent. True when `dir` itself is gone. Every path passes `guard`. */
export function removeWithin(dir: string, guard: Guard, budget: Budget): boolean {
  for (;;) {
    if (budget.left === 0) return false;
    const batch = takeEntries(guard(dir), budget.left);
    if (batch.length === 0) break;
    for (const entry of batch) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!removeWithin(path, guard, budget)) return false;
      } else {
        if (budget.left === 0) return false;
        unlinkSync(guard(path));
        budget.left -= 1;
      }
    }
  }
  rmdirSync(guard(dir));
  budget.left -= 1;
  return true;
}
