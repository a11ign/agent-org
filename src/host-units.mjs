#!/usr/bin/env node
// @ts-check
// command: compare the systemd units this repo SHIPS against the ones the agent host actually runs
//
// #1858: A UNIT FILE IN THE REPOSITORY IS NOT A RUNNING TIMER, and for five hours nothing could tell the
// difference.
//
// MEASURED 2026-09-21. #1844 shipped `a11ign-fleet-gated-nightly.{service,timer}` -- the scheduler built
// so the nightly fleet batch would stop depending on a session remembering to run it. It merged at
// 19:22Z. At 19:38Z the chairman asked why nothing was happening, and the answer was:
//
//     systemctl --user is-enabled a11ign-fleet-gated-nightly.timer  ->  not-found
//
// The unit was in `packages/agent-org/host/` and had never been copied to `~/.config/systemd/user/`.
// INSTALLING THE SCHEDULER DEPENDED ON A SESSION REMEMBERING -- the exact defect the scheduler was
// built to remove, one level up, and invisible because nothing compared the two directories.
//
// The second unit told the same story in a quieter way. `a11ign-corpus-snapshot.timer` WAS installed and
// WAS enabled -- and was `inactive`, with no NEXT and no LAST, on a host up for nine days. Somebody ran
// `systemctl --user enable` without `--now` and nothing ever said so. **`enabled` and `running` are
// different questions and only one of them was ever asked.**
//
// So this file asks all three, because each failed differently in the same hour:
//
//   PRESENT   is the shipped unit in ~/.config/systemd/user at all?        (fleet-gated-nightly: no)
//   CURRENT   does the installed copy still MATCH the shipped one?         (they are copies, not symlinks)
//   RUNNING   for a .timer, is it enabled AND active?                      (corpus-snapshot: enabled, not active)
//
// WHY COPIES AND NOT SYMLINKS, since a symlink would make CURRENT unfalsifiable: that is the convention
// already on the host (`ls -l ~/.config/systemd/user` shows regular files), and changing it is a decision
// about the host rather than a check on it. This reports the drift a copy allows instead of silently
// adopting a different install strategy -- and `hostUnitsInstall` below re-copies, so the remedy is one
// command either way.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, copyFileSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";

/** Where the repository keeps the units it ships. */
export const SHIPPED_DIR = fileURLToPath(new URL("../host/", import.meta.url));

/** Where a systemd USER unit has to live to be run. */
export const INSTALLED_DIR = `${process.env.HOME ?? ""}/.config/systemd/user`;

/**
 * The unit files this repository ships, sorted so a report reads the same way twice.
 * @param {string} [dir] @param {{ read?: typeof readdirSync }} [deps]
 * @returns {string[]}
 */
export function shippedUnits(dir = SHIPPED_DIR, { read = readdirSync } = {}) {
  try {
    return read(dir)
      .map(String)
      .filter((n) => n.endsWith(".service") || n.endsWith(".timer"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * ONE UNIT'S THREE ANSWERS, as data rather than as a sentence.
 *
 * `enabled` and `active` are SEPARATE FIELDS and not one boolean, because that is precisely the
 * distinction `a11ign-corpus-snapshot.timer` fell through: `is-enabled` said `enabled` and `is-active`
 * said `inactive`, and a single "is it on?" flag would have had to pick one and would have picked wrong.
 *
 * @param {string} unit
 * @param {{ shippedDir?: string, installedDir?: string,
 *           read?: typeof readFileSync, exists?: typeof existsSync,
 *           systemctl?: (args: string[]) => string }} [deps]
 * @returns {{ unit: string, present: boolean, current: boolean | null,
 *             enabled: string | null, active: string | null }}
 */
export function unitState(unit, { shippedDir = SHIPPED_DIR, installedDir = INSTALLED_DIR,
  read = readFileSync, exists = existsSync, systemctl = defaultSystemctl } = {}) {
  const installedPath = join(installedDir, unit);
  const present = exists(installedPath);
  // NULL, NOT FALSE, when it is not installed. "the copy differs" and "there is no copy" are different
  // findings with different remedies, and collapsing them would report the missing unit twice.
  const current = present ? sameBytes(join(shippedDir, unit), installedPath, read) : null;
  if (!unit.endsWith(".timer")) return { unit, present, current, enabled: null, active: null };
  return { unit, present, current, enabled: ask(systemctl, "is-enabled", unit),
    active: ask(systemctl, "is-active", unit) };
}

/**
 * `systemctl` answers on stdout AND exits non-zero for the interesting answers -- `is-active` exits 3 for
 * `inactive`, `is-enabled` exits 1 for `disabled`. Reading only the exit code loses the word, and letting
 * the throw escape would turn "this timer is off", the finding, into a crash.
 * @param {(args: string[]) => string} systemctl @param {string} verb @param {string} unit
 * @returns {string | null} the word systemd used, or null when systemd could not be asked at all
 */
function ask(systemctl, verb, unit) {
  try {
    return systemctl([verb, unit]).trim() || null;
  } catch (error) {
    const out = String(/** @type {{ stdout?: unknown }} */ (error)?.stdout ?? "").trim();
    return out === "" ? null : out;
  }
}

/** @param {string} a @param {string} b @param {typeof readFileSync} read */
function sameBytes(a, b, read) {
  try {
    return String(read(a)) === String(read(b));
  } catch {
    return false;
  }
}

/**
 * THE FINDINGS, one line each, or an empty list when the host matches the repository.
 *
 * A HOST THAT CANNOT BE ASKED REPORTS NOTHING, and that is deliberate rather than lax. This runs in CI
 * and in every developer checkout, where `~/.config/systemd/user` does not exist and `systemctl --user`
 * is not a command -- and a check that cried "no timers installed!" on a Mac would be turned off within
 * a day, taking the real finding with it. The signal is a unit that IS shipped on a host that DOES run
 * systemd; everywhere else this is silent by construction.
 *
 * @param {{unit: string, present: boolean, current: boolean | null,
 *          enabled: string | null, active: string | null}[]} states
 * @returns {{unit: string, problem: string, detail: string}[]}
 */
export function unitDrift(states) {
  return (states ?? []).flatMap((s) => {
    if (!s.present) {
      return [{ unit: s.unit, problem: "NOT INSTALLED",
        detail: `shipped in packages/agent-org/host/ and absent from ${INSTALLED_DIR}. It cannot run.` }];
    }
    if (s.current === false) {
      return [{ unit: s.unit, problem: "STALE",
        detail: "the installed copy differs from the one in the repository -- these are copies, not "
          + "symlinks, so a merged edit does NOT reach the host until it is reinstalled." }];
    }
    if (!s.unit.endsWith(".timer")) return [];
    if (s.enabled === null && s.active === null) return [];
    if (s.enabled !== "enabled") {
      return [{ unit: s.unit, problem: "NOT ENABLED",
        detail: `systemd says \`${s.enabled}\` -- it will not come back after a reboot.` }];
    }
    if (s.active !== "active" && s.active !== "activating") {
      // THE ONE THAT ACTUALLY HAPPENED, and the one a single "is it on?" boolean would have missed:
      // `enable` without `--now` leaves a timer enabled and not running, with no NEXT and no LAST.
      return [{ unit: s.unit, problem: "ENABLED BUT NOT RUNNING",
        detail: `systemd says \`${s.active}\` -- enabled without \`--now\`, so it has no next firing. `
          + "This is the state a11ign-corpus-snapshot.timer sat in for nine days." }];
    }
    return [];
  });
}

/**
 * DOES THIS MACHINE RUN SYSTEMD USER UNITS AT ALL?
 *
 * The gate that keeps this check honest, and it was missing from the first version of this file -- whose
 * own comment already claimed the property. Run on the Mac this was written on, that version reported all
 * six shipped units "NOT INSTALLED", which is true and completely useless: a developer checkout is not a
 * host that failed to install anything, and a check that fires on every laptop is one somebody silences
 * within a day, taking the real finding with it.
 *
 * `systemctl --user show-environment` is the probe rather than `which systemctl`, because the binary
 * exists on machines with no user manager running (a container, a CI runner) and answers there too.
 * @param {(args: string[]) => string} systemctl
 */
export function systemdUserAvailable(systemctl = defaultSystemctl) {
  try {
    systemctl(["show-environment"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * UNITS THE HOST STILL RUNS THAT THIS REPOSITORY NO LONGER SHIPS -- the inverse of every other check
 * here, and the one that was missing on the day it mattered.
 *
 * MEASURED 2026-09-22. #1941 retired `a11ign-fleet-gated-nightly.{service,timer}`: the 01:00 batch
 * became `work-gate.mjs`'s `fleet-batch-due` cause, and the unit files were DELETED from
 * `packages/agent-org/host/` precisely so `host:install` could not put the clock back beside the gate
 * cause. The PR merged. And the timer was still installed, still `enabled`, still `active`, and still
 * scheduled for 01:00 the next morning:
 *
 *     Wed 2026-09-23 01:00:00 UTC   a11ign-fleet-gated-nightly.timer
 *
 * **Deleting a unit from the repository does not remove it from the host.** So the org was one night
 * away from dispatching the same fleet batch twice, from two mechanisms at two cadences -- the exact
 * outcome the deletion was written to prevent.
 *
 * AND `host:check` SAID EVERYTHING WAS FINE, because every check it had asked "is what we ship
 * installed?" and none asked "is what is installed still ours?". It printed
 * "every shipped unit is installed, current and running" over a live orphan. It was caught by hand, by
 * going to look -- which is the one way of finding things this file exists to replace.
 *
 * SCOPED TO THIS ORG'S OWN PREFIX. The host runs units nobody here wrote (`launchpadlib-cache-clean`,
 * anything the distribution ships), and reporting those would be both wrong and the fastest possible
 * route to somebody ignoring this command. Only `a11ign-*` is ours to have an opinion about.
 *
 * `readDir` RATHER THAN `read`, and the name is load-bearing: `hostUnitDrift` hands ONE deps bag to
 * `unitState` (whose `read` is `readFileSync`) and to this (whose read is `readdirSync`). Sharing the
 * name makes the bag's type unsatisfiable -- tsc's own words, "Type 'utf8' has no properties in common".
 * @param {{ shippedDir?: string, installedDir?: string, readDir?: typeof readdirSync }} [deps]
 * @returns {{unit: string, problem: string, detail: string}[]}
 */
export function orphanedUnits({ shippedDir = SHIPPED_DIR, installedDir = INSTALLED_DIR,
  readDir = readdirSync } = {}) {
  const shipped = new Set(shippedUnits(shippedDir, { read: readDir }));
  /** @type {string[]} */
  let installed;
  try {
    installed = readDir(installedDir).map(String);
  } catch {
    // NO DIRECTORY IS NOT AN EMPTY DIRECTORY, but for this question they coincide: nothing is installed,
    // so nothing is orphaned. The missing-unit half of the check already reports the absence.
    return [];
  }
  return installed
    .filter((n) => n.startsWith(ORG_UNIT_PREFIX))
    .filter((n) => n.endsWith(".service") || n.endsWith(".timer"))
    .filter((n) => !shipped.has(n))
    .sort()
    .map((unit) => ({ unit, problem: "ORPHANED",
      detail: "installed on this host and NO LONGER SHIPPED by this repository. A deleted unit file does "
        + "not uninstall itself, so this is still running on whatever schedule it had -- and if something "
        + "replaced it, both are now firing. `npm run host:install` removes it." }));
}

/** Units this repository owns. The host runs others; those are not ours to have an opinion about. */
export const ORG_UNIT_PREFIX = "a11ign-";

/**
 * Every shipped unit's drift, in one call -- what both the CLI and the gate ask for. An empty list on a
 * machine with no user systemd, which is not the same claim as "this host is correct" and is why
 * `driftReport` says which of the two it is.
 *
 * THREE QUESTIONS NOW, and the third is the inverse of the first two: is what we ship installed
 * (`unitDrift`), is what is installed still ours (`orphanedUnits`), and can a session act at all
 * (`permissionModeDrift`).
 * @param {Parameters<typeof unitState>[1]} [deps]
 */
export function hostUnitDrift(deps = {}) {
  if (!systemdUserAvailable(deps.systemctl ?? defaultSystemctl)) return [];
  const dir = deps.shippedDir ?? SHIPPED_DIR;
  // THE SAME GATE COVERS BOTH. A machine with no user systemd is not an agent host, so its `~/.claude`
  // posture is nobody's business either -- and a laptop told "ORG IS IN AUTO MODE" teaches its owner to
  // ignore this command, which would lose the timer finding along with it.
  return [...unitDrift(shippedUnits(dir, {}).map((u) => unitState(u, deps))),
    ...orphanedUnits(deps), ...permissionModeDrift(deps)];
}

/** @param {string[]} args */
const defaultSystemctl = (args) =>
  execFileSync("systemctl", ["--user", ...args], { encoding: "utf8" });

/**
 * Copy every shipped unit into place and start every timer. IDEMPOTENT -- re-running it on a correct
 * host changes nothing, which is what lets it be the single remedy every message here names.
 *
 * `enable --now`, NEVER a bare `enable`: the bare form is what left `a11ign-corpus-snapshot.timer`
 * enabled and dead for nine days, and an installer that can reproduce the bug it exists to fix is not
 * an installer.
 * @param {{ shippedDir?: string, installedDir?: string, systemctl?: (args: string[]) => string,
 *           copy?: typeof copyFileSync, mkdir?: typeof mkdirSync, rm?: typeof rmSync,
 *           readDir?: typeof readdirSync, out?: (line: string) => void }} [deps]
 * @returns {string[]} the units it installed
 */
export function hostUnitsInstall({ shippedDir = SHIPPED_DIR, installedDir = INSTALLED_DIR,
  systemctl = defaultSystemctl, copy = copyFileSync, mkdir = mkdirSync, rm = rmSync,
  readDir = readdirSync, out = (l) => process.stdout.write(l) } = {}) {
  // `readDir` IS INJECTED THROUGH TO BOTH DISCOVERIES, and the first version of this hard-wired
  // `readdirSync` into the `orphanedUnits` call below. A test could not reach the removal path at all,
  // so deleting the ENTIRE removal loop killed zero tests -- it passed vacuously, which is the same
  // defect this file's own `no-token` header was written to catch one level up. Found by mutating it.
  const units = shippedUnits(shippedDir, { read: readDir });
  mkdir(installedDir, { recursive: true });
  for (const unit of units) {
    copy(join(shippedDir, unit), join(installedDir, unit));
    out(`installed ${unit}\n`);
  }
  // REMOVED BEFORE THE RELOAD, so systemd never re-reads a unit that is on its way out. `disable --now`
  // first because deleting the file leaves an enabled symlink in `timers.target.wants` behind, and a
  // dangling want is a warning on every subsequent `daemon-reload` -- noise that trains an operator to
  // ignore this command's output.
  for (const { unit } of orphanedUnits({ shippedDir, installedDir, readDir })) {
    if (unit.endsWith(".timer")) systemctl(["disable", "--now", unit]);
    rm(join(installedDir, unit), { force: true });
    out(`REMOVED ${unit} -- no longer shipped by this repository\n`);
  }
  systemctl(["daemon-reload"]);
  for (const timer of units.filter((u) => u.endsWith(".timer"))) {
    systemctl(["enable", "--now", timer]);
    out(`enabled --now ${timer}\n`);
  }
  return units;
}

/**
 * THE PERMISSION POSTURE, which is a host fact exactly as much as an installed timer is.
 *
 * MEASURED 2026-09-21. `orchestrator` did every step of the corpus backup, reached the upload, and
 * STOPPED: its own permission classifier refused the publish as "Modify Shared Resources". It could not
 * ask a human either -- `agentArgs` removes `AskUserQuestion` on purpose (#1744), because a session that
 * stops to ask is one herdr reports as `blocked` and nothing can wake. So the org was configured to be
 * UNABLE TO ACT AND UNABLE TO ASK, on exactly the class of operation that matters.
 *
 * WHY THE FLAG DID NOT COVER IT. `agentArgs` passes `--dangerously-skip-permissions`, but only on
 * `herdr agent start` -- when a session does not yet exist. herdr RESUMES one that does, as a bare
 * `claude --resume <uuid>` with no flags, and it re-resumes every session when it restarts itself: all
 * six came back at 18:47:27 that day in one instant, in auto mode. A LAUNCH FLAG CANNOT HOLD A POSTURE
 * ACROSS A RESUME, so the org silently reverted every time herdr bounced.
 *
 * USER-LEVEL SETTINGS ARE THE FIX AND PROJECT-LEVEL CANNOT SUBSTITUTE. `permissions.defaultMode` in
 * `~/.claude/settings.json` is read at process start, so a resume picks it up. The same key in the
 * repository's own `.claude/settings.json` does NOTHING -- verified twice here before the user-level one
 * was tried -- and that is correct design rather than a gap: a project file that could grant itself
 * bypass would make cloning a repository an escalation.
 *
 * SO THIS CHECKS AND CANNOT FIX. The file is outside the repository, which is exactly why it needs a
 * check: nothing here can enforce it, and nothing here would have noticed it revert.
 * @param {{ settingsPath?: string, read?: typeof readFileSync, exists?: typeof existsSync }} [deps]
 * @returns {{unit: string, problem: string, detail: string}[]}
 */
export function permissionModeDrift({ settingsPath = `${process.env.HOME ?? ""}/.claude/settings.json`,
  read = readFileSync, exists = existsSync } = {}) {
  const name = "~/.claude/settings.json";
  const remedy = "Set `permissions.defaultMode` to \"bypassPermissions\". A launch flag does not survive "
    + "herdr resuming the session, so this file is the only thing that holds.";
  if (!exists(settingsPath)) {
    return [{ unit: name, problem: "NO SETTINGS FILE",
      detail: `absent, so every session runs under the default classifier. ${remedy}` }];
  }
  let mode;
  try {
    mode = JSON.parse(String(read(settingsPath)))?.permissions?.defaultMode ?? null;
  } catch (cause) {
    // A FILE THAT CANNOT BE PARSED IS NOT A FILE THAT SAYS "default". Reporting it as the wrong mode
    // would send a reader to change a key in a file that will not load whatever they put in it.
    return [{ unit: name, problem: "UNREADABLE",
      detail: `could not be parsed (${/** @type {Error} */ (cause).message}), so the permission posture `
        + "is UNKNOWN rather than wrong. Fix the JSON first." }];
  }
  if (mode === "bypassPermissions") return [];
  return [{ unit: name, problem: "ORG IS IN AUTO MODE",
    detail: `permissions.defaultMode is ${mode === null ? "unset" : `\`${mode}\``}. Sessions cannot act `
      + "on shared resources and cannot ask either (AskUserQuestion is removed by agentArgs, #1744), so "
      + `they stop mid-task with no signal. ${remedy}` }];
}

/**
 * NOT ASKED and ALL CORRECT read identically as an empty list, so the report must not say the second
 * when it means the first -- that substitution is this repository's most-repeated defect.
 * @param {{unit: string, problem: string, detail: string}[]} drift
 * @param {boolean} [asked] whether systemd could be asked at all
 */
export function driftReport(drift, asked = true) {
  if (!asked) {
    return "host units: NOT CHECKED -- this machine runs no systemd user manager, so it is not an "
      + "agent host. That is not a claim that any host is correct.\n";
  }
  if (drift.length === 0) return "host units: every shipped unit is installed, current and running.\n";
  return `host units: ${drift.length} problem(s).\n`
    + drift.map((d) => `  ${d.unit}: ${d.problem}\n    ${d.detail}\n`).join("")
    + "  Remedy for all of them: npm run host:install\n";
}

function main() {
  refuseUnknownFlags(["--install"], { entry: import.meta.url, command: "npm run host:check" });
  const asked = systemdUserAvailable();
  if (process.argv.slice(2).includes("--install")) {
    hostUnitsInstall();
    process.stdout.write(driftReport(hostUnitDrift(), asked));
    return;
  }
  const drift = hostUnitDrift();
  process.stdout.write(driftReport(drift, asked));
  if (drift.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
