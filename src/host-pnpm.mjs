// A LEAF, `node:` IMPORTS ONLY: `host-units.mjs` resolves the project it serves when it is imported and refuses a host with none declared, so a
// check that needs only a PATH and a `package.json` lives where it can be asked without one (#2896).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * IS `pnpm` ON THE PATH, AND IS IT THE ONE THE PROJECT DECLARES (#2896)? The tick's own pre-step is `pnpm run primary:update`, and a
 * host without `pnpm` ran it, failed, and said nothing: it was absent from the agent host until 2026-10-01 and nothing here noticed.
 * `installedCopy` and `running` were never the claim that matters: a unit can be current, enabled and active while the program its
 * `ExecStartPre` names is not on the PATH.
 *
 * ASKED OF THE PATH THIS PROCESS HOLDS, because the tick runs the gate (and so this file) under the unit's declared PATH and a person
 * runs `host:check` under theirs: the two readings disagree exactly when a unit's PATH lacks the directory `pnpm` lives in.
 * The version is read with a cwd that is NOT the project's, because pnpm 10 re-executes the version a project's `packageManager`
 * names, and a version read inside the project would always agree with it.
 *
 * A PROJECT THAT DECLARES NO pnpm IS NOT ASKED. An unreadable `package.json` is not "declares none" either, but it is
 * `missingUnitPrograms`'s kind of finding and is not repeated here.
 * CHECKS AND CANNOT FIX: `host:install` installs units, never programs.
 * @param {{ path?: string, repoRoot: string, read?: typeof readFileSync, exists?: typeof existsSync,
 *   version?: (pnpm: string) => string }} deps `repoRoot` is REQUIRED: the project this host serves, which this leaf does not resolve itself
 * @returns {import("./host-units.mjs").Finding[]}
 */
export function pnpmDrift({ path = process.env.PATH ?? "", repoRoot, read = readFileSync, exists = existsSync,
  version = installedPnpmVersion }) {
  const wanted = declaredPnpmVersion(repoRoot, read);
  if (wanted === null) return [];
  const found = path.split(":").filter(Boolean).map((dir) => join(dir, "pnpm")).find((candidate) => exists(candidate));
  const install = `Install pnpm@${wanted} where the units' PATH finds it (\`~/.local/bin\` holds \`gh\` and \`herdr\` on this host; `
    + "https://pnpm.io/installation). `host:install` installs units and not programs, so it does not fix this.";
  if (found === undefined) {
    return [{ unit: "pnpm", problem: "NOT ON THE PATH", hostProgram: true,
      detail: `no \`pnpm\` in ${path === "" ? "an empty PATH" : `PATH=${path}`}, and package.json declares \`pnpm@${wanted}\`, `
        + `so \`pnpm run primary:update\` and every other \`pnpm run\` remedy fails here. ${install}` }];
  }
  let has;
  try {
    has = version(found).trim();
  } catch (cause) {
    return [{ unit: "pnpm", problem: "DOES NOT RUN", hostProgram: true,
      detail: `${found} is on the PATH and \`${found} --version\` failed (${/** @type {Error} */ (cause).message}), so its version `
        + `is UNKNOWN rather than wrong. ${install}` }];
  }
  if (has === wanted) return [];
  return [{ unit: "pnpm", problem: "VERSION DIFFERS FROM packageManager", hostProgram: true,
    detail: `${found} is ${has}, and package.json declares \`pnpm@${wanted}\`. ${install}` }];
}

/**
 * The version `packageManager` pins when it names pnpm (`pnpm@10.34.5` or `pnpm@10.34.5+sha512...`), else null: no manifest, no
 * field or another manager all mean this project asks nothing of pnpm.
 * @param {string} repoRoot @param {typeof readFileSync} read @returns {string | null}
 */
function declaredPnpmVersion(repoRoot, read) {
  try {
    const declared = JSON.parse(String(read(join(repoRoot, "package.json"), "utf8"))).packageManager;
    return typeof declared === "string" ? /^pnpm@([^+\s]+)/.exec(declared)?.[1] ?? null : null;
  } catch {
    return null;
  }
}

/** `<pnpm> --version` run from the temp directory, never the project (see {@link pnpmDrift}). @param {string} pnpm */
const installedPnpmVersion = (pnpm) =>
  execFileSync(pnpm, ["--version"], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000 });
