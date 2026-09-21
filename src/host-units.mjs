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
import { readdirSync, readFileSync, copyFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
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
 * Every shipped unit's drift, in one call -- what both the CLI and the gate ask for. An empty list on a
 * machine with no user systemd, which is not the same claim as "this host is correct" and is why
 * `driftReport` says which of the two it is.
 * @param {Parameters<typeof unitState>[1]} [deps]
 */
export function hostUnitDrift(deps = {}) {
  if (!systemdUserAvailable(deps.systemctl ?? defaultSystemctl)) return [];
  const dir = deps.shippedDir ?? SHIPPED_DIR;
  return unitDrift(shippedUnits(dir, {}).map((u) => unitState(u, deps)));
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
 *           copy?: typeof copyFileSync, mkdir?: typeof mkdirSync, out?: (line: string) => void }} [deps]
 * @returns {string[]} the units it installed
 */
export function hostUnitsInstall({ shippedDir = SHIPPED_DIR, installedDir = INSTALLED_DIR,
  systemctl = defaultSystemctl, copy = copyFileSync, mkdir = mkdirSync,
  out = (l) => process.stdout.write(l) } = {}) {
  const units = shippedUnits(shippedDir, {});
  mkdir(installedDir, { recursive: true });
  for (const unit of units) {
    copy(join(shippedDir, unit), join(installedDir, unit));
    out(`installed ${unit}\n`);
  }
  systemctl(["daemon-reload"]);
  for (const timer of units.filter((u) => u.endsWith(".timer"))) {
    systemctl(["enable", "--now", timer]);
    out(`enabled --now ${timer}\n`);
  }
  return units;
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
