// @ts-check
// module: the private TMPDIR of one agent session -- its name, its making, and the environment that points the session at it (A11-279, A11-303)
//
// ONE DIRECTORY PER SESSION, NAMED BY THE SESSION'S LABEL. A ticket run's label is its key and a reviewer's is its seat (`reviewer-1554`), and `<base>/run-t-<label>` is the directory a session's tests and tools write
// into through `os.tmpdir()`. The name is an interface: `run-t-` starts with `run-`, which `private-tmp.ts`'s `requirePrivate` accepts (so no removal can leave the base) and which #3849's user tmpfiles rule ages out
// after a day, and it holds the label and nothing random, so a session started again under its label is given the directory it had.
//
// A11-303: THE POOL'S RUNS HAD IT AND THEIR REVIEWERS DID NOT. A11-279 gave a ticket run its `TMPDIR` in `runEnvOf`, and the reviewers the board starts through `spawnReviewer` were opened with no `TMPDIR`, so every
// acceptance and mutation run a reviewer did wrote into the host's `/tmp` (884 entries in two hours). Every pane the board opens goes through `openPane` (`herdr-agents.ts`), which makes the session's directory here and
// puts it in the pane's environment, so a kind of session added later has one without remembering to ask.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { requirePrivate } from "./private-tmp.ts";

/** The variable that points a process's temporary files at a directory. */
export const TMPDIR_ENV = "TMPDIR";

/** The prefix of a session's directory under the base: `run-` for `requirePrivate` and the tmpfiles backstop, `t-` to tell it from a test run's `run-<stamp>-<pid>`. */
export const RUN_TMP_PREFIX = "run-t-";

/** The directory name of a session: its label, with anything outside `[A-Za-z0-9_.-]` replaced, so no label can name a path outside the base. PURE. */
export const runTmpName = (label: string): string => `${RUN_TMP_PREFIX}${label.replace(/[^A-Za-z0-9_.-]/g, "_")}`;

/** A session's private `TMPDIR` under `base`. PURE. */
export const runTmpDir = (base: string, label: string): string => join(base, runTmpName(label));

/** Make a session's directory, or say why it could not be made. A session whose directory cannot be made is started without a `TMPDIR` and not refused: the shared `/tmp` is the old behaviour, and a stopped session is worse. */
export function makeRunTmp(base: string, dir: string): string | null {
  try {
    mkdirSync(requirePrivate(dir, base), { recursive: true });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0]! : String(err);
  }
}

/** What {@link privateTmpEnv} answers: the variable to start the session with, or why it starts without one. */
export type PrivateTmp = Readonly<{ env: Record<string, string>; refusal?: undefined }> | Readonly<{ env: Record<string, never>; refusal: string }>;

/**
 * The environment that gives the session `label` its private `TMPDIR` under `base`, made before the session's shell exists. `{ env: {} }` for no `base` (a caller that gives sessions none, as every test does) and, with
 * the reason, for a directory that could not be made.
 */
export function privateTmpEnv(base: string | undefined, label: string): PrivateTmp {
  if (base === undefined) return { env: {} };
  const dir = runTmpDir(base, label);
  const refusal = makeRunTmp(base, dir);
  return refusal === null ? { env: { [TMPDIR_ENV]: dir } } : { env: {}, refusal };
}
