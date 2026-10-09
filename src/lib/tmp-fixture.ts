// no-token: none -- makes and removes temporary directories; nothing here reaches `gh`, `herdr` or `git`
/**
 * (#3848) A TEST'S TEMPORARY DIRECTORY, REMOVED BY THE RUNNER'S OWN TEARDOWN.
 *
 * Measured 2026-10-06: `/tmp` held 121,411 entries, 6,448 of them `verify-stamp-test-*`, every one made by a test that called `mkdtempSync` and
 * never removed it. The cheapest `rmdir` is the one never needed (#3846's soft lockup was a `node` in `rmdir` over a 5.4 MB `/tmp`).
 *
 * `tmpDir` is `mkdtempSync` plus the removal, so a test cannot make one without registering it. The removal runs in `afterEach`, which is what
 * makes a killed run leave at most the directory in flight rather than every directory the file made. `tmpDirForFile` is for a directory made
 * at import time or in a `before`, which every test in the file shares: `afterEach` would take it from under the second test, so it goes in `after`.
 *
 * `afterEach` and `after` come from `node:test` as an ESM import, deliberately: under rstest the resolve hook redirects an ESM `node:test` to
 * rstest's hooks and does not redirect `require` (`walk-scope.ts` measured an `after` from `require("node:test")` never firing).
 *
 * NOT FOR A TEST THAT RUNS ITS CASES CONCURRENTLY: `afterEach` would remove a directory a sibling case is still using. No file here does; a
 * file that must takes its own `t.after`.
 */
import { after, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const perTest = new Set<string>();
const perFile = new Set<string>();

function removeAll(made: Set<string>): void {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  made.clear();
}

afterEach(() => removeAll(perTest));
after(() => { removeAll(perTest); removeAll(perFile); });

/**
 * A fresh directory under the system temp directory, removed after the test that made it.
 * `prefix` is what a reader of `/tmp` sees if the removal ever fails; `parent` is a directory to make it in instead of the system's, such as one `tmpDirForFile` holds, removed with it either way.
 */
export function tmpDir(prefix: string, parent = tmpdir()): string {
  const dir = mkdtempSync(join(parent, prefix));
  perTest.add(dir);
  return dir;
}

/** A fresh directory removed once, when the file's last test is done: for one every test in the file shares. */
export function tmpDirForFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  perFile.add(dir);
  return dir;
}
