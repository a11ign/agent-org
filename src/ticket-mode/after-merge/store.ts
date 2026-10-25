// @ts-check
// module: the After-merge checks on disk (A11-277) -- `after-merge-checks.json` in the board's tickets directory, replaced whole by rename as `dependency-tickets.json` is
//
// The board's routes and the pool's sweep both change it, in one process. Each change reads the file, changes it and writes it back with nothing awaited in between, so neither loses the other's change.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyChecks, type ChecksFile } from "./checks.ts";

/** The file the checks are kept in: beside the queue, in the board's tickets directory. */
export const AFTER_MERGE_CHECKS_FILE = "after-merge-checks.json";

/** Where `stateDir`'s board keeps its After-merge checks. */
export const afterMergeChecksPath = (stateDir: string): string => join(stateDir, "tickets", AFTER_MERGE_CHECKS_FILE);

const STATES: readonly unknown[] = ["open", "passed", "failed", "superseded"];

/** Whether `value` is what {@link saveChecks} writes: `checks` maps ids to records with a known state. */
function isChecksFile(value: unknown): value is ChecksFile {
  if (typeof value !== "object" || value === null) return false;
  const { checks } = value as { checks?: unknown };
  if (typeof checks !== "object" || checks === null || Array.isArray(checks)) return false;
  return Object.values(checks).every((check) => typeof check === "object" && check !== null && STATES.includes((check as { state?: unknown }).state));
}

/** The checks on disk, or none when there is no file. A file that cannot be read THROWS: read as empty, it would be written over, and every result in it lost. */
export function loadChecks(path: string): ChecksFile {
  if (!existsSync(path)) return emptyChecks();
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isChecksFile(parsed)) throw new Error(`${path} is not an After-merge check record`);
  return parsed;
}

/** Replace the file whole: write beside it, then rename over it. */
export function saveChecks(path: string, file: ChecksFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(next, path);
}

/** Read the file, change it, and write it back when the change gave a new file: synchronous, so no other change can land between the read and the write. Returns the file as it now is. */
export function changeChecks(path: string, change: (file: ChecksFile) => ChecksFile): ChecksFile {
  const before = loadChecks(path);
  const after = change(before);
  if (after !== before) saveChecks(path, after);
  return after;
}
