// @ts-check
// module: write a file the install owns (a unit, the host file, a key file) through a temporary file and a rename, so it is never read half written
//
// The temporary name is random and opened with `wx`, so a file or a link planted at a guessable name in a shared directory is refused, not followed.
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** @param mode the file's mode, and the directory's when it has to be made is 700 for a private file and 755 otherwise */
export function writeAtomic(path: string, text: string, mode: number) {
  mkdirSync(dirname(path), { recursive: true, mode: (mode & 0o077) === 0 ? 0o700 : 0o755 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { mode, flag: "wx" });
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}
