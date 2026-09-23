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
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { localImports, stripComments } from "../../guards/src/local-import-closure.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { SPAWNS_GH } from "./acceptance-commands.mjs";

/** Where the repository keeps the units it ships. */
export const SHIPPED_DIR = fileURLToPath(new URL("../host/", import.meta.url));

/** The checkout every shipped unit names as its `WorkingDirectory`, so an `ExecStart` path resolves. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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

// --- #1974: WHICH ACCOUNT A UNIT SPENDS, DECLARED RATHER THAN INHERITED ------------------------------
//
// MEASURED 2026-09-22. `a11ign-work-tick.service` ran with no `GH_CONFIG_DIR`, so the work gate
// authenticated as `DanBeckDev` -- a PERSON -- and spent that human account's 5,000-POINT-PER-HOUR GraphQL
// budget. A POINT IS NOT A REQUEST, and this line said "requests" until #2003: the gate's five reads cost
// TWELVE points between them (measured by differencing `X-Ratelimit-Used`: `pr list` 5, ready 2, backlog 2,
// chairman-blocked 1, all-open 2), so a reader counting calls against 5,000 concludes the tick could run
// for a year. At 30 ticks an hour the gate spends 360 of the 5,000 -- 7.2%, and never the whole pool.
// The gate then refused correctly and silently ("CANNOT ASK: neither the pull-request list nor the Ready
// rows could be read"), which from inside the org is indistinguishable from a quiet queue.
//
// IDENTITY HERE IS INHERITED FROM A DOTFILE AND NEVER DECLARED. `/home/agent/.local/bin/gh` routes by
// `HERDR_WORKSPACE_ID` -- present in every org session, absent from every systemd unit -- and falls back
// to `~/.config/gh`, the human account. So a unit that does not SAY which account it is cannot get the
// right one, and nothing in this repository could see the choice being made.
//
// ASSERTED OVER THE UNITS ON DISK, never a hand-typed list of three. A fourth unit that spawns `gh`
// inherits the check the day it is added, which is the only version of this that survives the next row.

/** A `GH_CONFIG_DIR` declaration -- which `gh` config, and so which account, a unit acts as. */
const IDENTITY_LINE = /^Environment=GH_CONFIG_DIR=/;

/**
 * Every `Exec*=` command a unit runs, with systemd's own prefixes stripped (`-` ignore failure,
 * `@` argv[0] override, `+`/`!` privilege). Every `Exec` directive rather than the two this row found,
 * so an `ExecStopPost` that spends the pool is not a second incident.
 * @param {string} unitText @returns {string[]}
 */
export function execCommands(unitText) {
  return [...String(unitText ?? "").matchAll(/^Exec[A-Za-z]*=(.*)$/gm)]
    .map((m) => m[1].trim().replace(/^[-@+!:]+/, "").trim())
    .filter((command) => command !== "");
}

/** The repository's own npm scripts, which is how a unit's `npm run <name>` becomes a file path. */
export function packageScripts(repoRoot = REPO_ROOT, read = readFileSync) {
  try {
    return /** @type {Record<string, string>} */ (JSON.parse(String(read(join(repoRoot, "package.json")))).scripts ?? {});
  } catch {
    // NO SCRIPTS RESOLVE, so every `npm run` command yields no entry point and `unitsSpendingGh` comes
    // back empty. That is a SILENT PASS, and the only thing standing between it and a green suite is
    // the non-emptiness assertion on that population -- which is why that assertion is the control and
    // not a nicety.
    return {};
  }
}

/**
 * THE FILES A SHELL COMMAND WOULD ACTUALLY RUN, following `npm run` through package.json.
 * `ExecStart=/usr/bin/npm run corpus:snapshot` is a path to `corpus-snapshot.mjs` with one hop in
 * between, and a check that stopped at the word `npm` would see no entry point at all and pass.
 * @param {string} command
 * @param {{ repoRoot?: string, scripts?: Record<string, string>, exists?: typeof existsSync }} [deps]
 * @returns {string[]} absolute paths, deduplicated, that exist
 */
export function entriesFromCommand(command, { repoRoot = REPO_ROOT, scripts = packageScripts(repoRoot),
  exists = existsSync } = {}) {
  /** @type {string[]} */
  const entries = [];
  const seen = new Set();
  /** @param {string} text */
  const follow = (text) => {
    for (const stage of String(text).split(/\|\||&&|[|;]/)) {
      const argv = stage.trim().split(/\s+/).filter(Boolean);
      const tool = basename(argv[0] ?? "");
      if (tool === "node" && argv[1]) entries.push(resolve(repoRoot, argv[1]));
      else if ((tool === "npm" || tool === "npx") && argv[1] === "run" && argv[2]) followScript(argv[2]);
    }
  };
  /** @param {string} name */
  const followScript = (name) => {
    if (seen.has(name) || typeof scripts[name] !== "string") return;
    seen.add(name);
    follow(scripts[name]);
  };
  follow(command);
  return [...new Set(entries)].filter((entry) => exists(entry));
}

/**
 * Every repository file a unit starts, across all of its `Exec*` directives.
 * @param {string} unitText @param {Parameters<typeof entriesFromCommand>[1]} [deps] @returns {string[]}
 */
export function unitEntryPoints(unitText, deps = {}) {
  return [...new Set(execCommands(unitText).flatMap((command) => entriesFromCommand(command, deps)))];
}

/** The only three tools `entriesFromCommand` can follow into a repository file. */
const ANALYSABLE_TOOLS = new Set(["node", "npm", "npx"]);

/**
 * AN `Exec*=` COMMAND THIS REPOSITORY CANNOT READ -- and NOT ASKED must not report as CLEAN (#1993).
 *
 * MEASURED 2026-09-22. `a11ign-board-report.service` starts `/home/agent/.local/bin/board-report-dispatch.sh`,
 * a host script this tree does not ship. `unitEntryPoints` follows `node <file>` and `npm run <script>`
 * and nothing else, so for this unit it returned the empty list -- and an empty list of entry points
 * reached no `gh` spawn, which `unitsSpendingGh` scored exactly as it scores a unit that genuinely
 * spawns nothing. The unit spends a human's REST pool daily on two `gh` subcommands.
 *
 * So the question a bare path answers is UNKNOWN, not NO, and the conservative reading is the only safe
 * one: a unit that starts something this repository cannot read must SAY which account it acts as,
 * because nothing here can ever work out whether it needs to.
 * @param {string} unitText @returns {string[]}
 */
export function opaqueCommands(unitText) {
  return execCommands(unitText)
    .filter((command) => !ANALYSABLE_TOOLS.has(basename(command.split(/\s+/).filter(Boolean)[0] ?? "")));
}

/**
 * `npm run <script>` SPAWNED FROM CODE, which no import edge carries.
 * `corpus-release-nightly.mjs` reaches `gh` only through `npmCliInvocation("npm", ["run",
 * "corpus:release"])` -- an import-closure walk alone reports it clean, and it is not.
 */
const RUNS_NPM_SCRIPT = /["'`]npm["'`]\s*,\s*\[\s*["'`]run["'`]\s*,\s*["'`]([^"'`]+)["'`]/g;

/**
 * DOES STARTING THIS FILE REACH A `gh` SPAWN? Two edge kinds, because the repository uses both: local
 * imports, and an `npm run` of another script. `SPAWNS_GH` is IMPORTED rather than retyped -- it is the
 * one copy `acceptance-commands.mjs` and `gh-token-jobs.test.ts` already share, so the spawns that make
 * a CI job need a token and the spawns that make a unit need an identity cannot drift apart.
 *
 * A `GH_TOKEN` read is deliberately NOT this question. A token is a credential; `GH_CONFIG_DIR` picks
 * which stored credential `gh` loads, so only an actual `gh` spawn can get the account wrong.
 * @param {string} entry
 * @param {{ read?: typeof readFileSync, exists?: typeof existsSync, imports?: typeof localImports,
 *           repoRoot?: string, scripts?: Record<string, string> }} [deps]
 * @returns {string | null} the file whose `gh` spawn it reaches, or null
 */
export function ghSpawnReachedFrom(entry, { read = readFileSync, exists = existsSync,
  imports = localImports, repoRoot = REPO_ROOT, scripts = packageScripts(repoRoot) } = {}) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = /** @type {string} */ (pending.pop());
    if (seen.has(file) || !exists(file)) continue;
    seen.add(file);
    const code = stripComments(String(read(file)));
    if (SPAWNS_GH.test(code)) return file;
    pending.push(...imports(file));
    for (const [, name] of code.matchAll(RUNS_NPM_SCRIPT)) {
      pending.push(...entriesFromCommand(`npm run ${name}`, { repoRoot, scripts, exists }));
    }
  }
  return null;
}

/**
 * EVERY SHIPPED `.service` THAT SPENDS SOMEBODY'S RATE LIMIT, and whether it says whose.
 *
 * The population, exported separately from the finding, because an emptiness assertion over it passes
 * when a glob matches nothing -- so the test asserts this is non-empty and `identityDrift` is empty, and
 * a `shippedDir` typo can no longer read as compliance.
 * @param {{ shippedDir?: string, readDir?: typeof readdirSync, read?: typeof readFileSync,
 *           exists?: typeof existsSync, imports?: typeof localImports, repoRoot?: string,
 *           scripts?: Record<string, string> }} [deps]
 * TWO WAYS IN, and the second is #1993's: `opaque` says whether the `gh` spawn was READ or merely
 * NOT RULED OUT. A unit whose `ExecStart` this repository cannot follow is charged for an identity on
 * the second footing, which is the only reading that does not score "we did not look" as "it is fine".
 * @returns {{unit: string, via: string, opaque: boolean, declared: boolean}[]}
 */
export function unitsSpendingGh({ shippedDir = SHIPPED_DIR, readDir = readdirSync,
  read = readFileSync, ...rest } = {}) {
  return shippedUnits(shippedDir, { read: readDir })
    .filter((unit) => unit.endsWith(".service"))
    .flatMap((unit) => {
      const text = String(read(join(shippedDir, unit)));
      const declared = text.split("\n").some((l) => IDENTITY_LINE.test(l.trim()));
      const reached = unitEntryPoints(text, rest)
        .map((entry) => ghSpawnReachedFrom(entry, { read, ...rest }))
        .find((hit) => hit !== null);
      // READ FIRST, AND ONLY THEN NOT-RULED-OUT: a unit this repository can follow is reported by what
      // it actually reaches, and the opaque command is the fallback rather than a second finding.
      const via = reached ?? opaqueCommands(text)[0];
      if (!via) return [];
      return [{ unit, via, opaque: !reached, declared }];
    });
}

/**
 * The finding: a unit that spawns `gh` and never says as whom, so it gets the fallback account.
 * @param {Parameters<typeof unitsSpendingGh>[0]} [deps]
 * @returns {Finding[]}
 */
export function identityDrift(deps = {}) {
  return unitsSpendingGh(deps)
    .filter((u) => !u.declared)
    .map(({ unit, via, opaque }) => ({ unit, problem: "NO IDENTITY DECLARED",
      detail: `${opaque
        ? `it starts \`${via}\`, which this repository does not ship and cannot read, so whether it `
          + "spawns `gh` is UNKNOWN rather than no (#1993)"
        : `it reaches a \`gh\` spawn (via ${via.replace(REPO_ROOT, "")})`}`
        + " and carries no `Environment=GH_CONFIG_DIR=...` line. A systemd unit has no "
        + "`HERDR_WORKSPACE_ID`, so the `gh` wrapper falls back to `~/.config/gh` -- a person's "
        + "account -- and the unit spends a human's rate limit until it runs out, then refuses "
        + "silently (#1974). Add `Environment=GH_CONFIG_DIR=/home/agent/workers/gh` to the unit, or "
        + "`/home/agent/.config/gh` where the human account is the one that can do the job (the "
        + "corpus backup's own comment is the worked example)." }));
}

/**
 * @typedef {{unit: string, problem: string, detail: string, revertsIdentity?: boolean,
 *            removesUnit?: boolean, shippedOnRef?: string}} Finding
 */

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
 * @returns {{ unit: string, present: boolean, current: boolean | null, identityRevert: string[],
 *             enabled: string | null, active: string | null }}
 */
export function unitState(unit, { shippedDir = SHIPPED_DIR, installedDir = INSTALLED_DIR,
  read = readFileSync, exists = existsSync, systemctl = defaultSystemctl } = {}) {
  const installedPath = join(installedDir, unit);
  const present = exists(installedPath);
  const shippedText = textOf(join(shippedDir, unit), read);
  const installedText = present ? textOf(installedPath, read) : null;
  // NULL, NOT FALSE, when it is not installed. "the copy differs" and "there is no copy" are different
  // findings with different remedies, and collapsing them would report the missing unit twice.
  const current = present ? shippedText !== null && shippedText === installedText : null;
  const identityRevert = installedOnlyIdentity(shippedText, installedText);
  if (!unit.endsWith(".timer")) {
    return { unit, present, current, identityRevert, enabled: null, active: null };
  }
  return { unit, present, current, identityRevert, enabled: ask(systemctl, "is-enabled", unit),
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

/**
 * A file's text, or null when it cannot be read -- which is NOT the empty string. Two unreadable files
 * would otherwise compare equal and report a drifted host as current.
 * @param {string} path @param {typeof readFileSync} read @returns {string | null}
 */
function textOf(path, read) {
  try {
    return String(read(path));
  } catch {
    return null;
  }
}

/**
 * THE `GH_CONFIG_DIR` LINES `host:install` WOULD DELETE -- installed on the host, absent from the
 * repository. This direction and not the other: the reverse (shipped, not installed) is a drift the
 * remedy FIXES, and only this one is a drift the remedy CAUSES.
 * @param {string | null} shippedText @param {string | null} installedText @returns {string[]}
 */
function installedOnlyIdentity(shippedText, installedText) {
  const shipped = new Set(identityLines(shippedText));
  return identityLines(installedText).filter((line) => !shipped.has(line));
}

/** @param {string | null} text @returns {string[]} */
function identityLines(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).filter((line) => IDENTITY_LINE.test(line));
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
 * @param {ReturnType<typeof unitState>[]} states
 * @returns {Finding[]}
 */
export function unitDrift(states) {
  return (states ?? []).flatMap((s) => {
    if (!s.present) {
      return [{ unit: s.unit, problem: "NOT INSTALLED",
        detail: `shipped in packages/agent-org/host/ and absent from ${INSTALLED_DIR}. It cannot run.` }];
    }
    if (s.current === false) {
      // #1974: THE ONE STALE THAT MUST NOT BE FIXED BY THE REMEDY. `host:install` copies the repository
      // OVER the host, so when the only thing the host has that the repository lacks is the line saying
      // which account the unit spends, the remedy deletes it -- and the failure it re-creates is the
      // silent one. Reported as its own problem rather than as detail on a STALE, because a reader
      // scanning problem words for "is this urgent" must not read it as the ordinary case.
      if (s.identityRevert?.length) {
        return [{ unit: s.unit, problem: "STALE -- REINSTALLING WOULD REVERT AN IDENTITY",
          revertsIdentity: true,
          detail: `the installed copy carries \`${s.identityRevert.join("`, `")}\` and the repository's `
            + "does not, so `npm run host:install` would DELETE that line. The unit would then inherit "
            + "whatever account `gh` falls back to -- on this host a person's -- and spend a human's "
            + "rate limit until it ran out, then refuse silently (#1974). Land the line in "
            + "packages/agent-org/host/ FIRST, then reinstall." }];
      }
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
 * NOT SHIPPED HAS TWO CAUSES AND ONLY ONE OF THEM IS RETIREMENT (#1993). Until this row the check had
 * ONE BIT -- "installed and not in the tree" -- and spelled it *NO LONGER SHIPPED*, which is an
 * inference about the past and not something the bit can carry. On 2026-09-22 it printed that over
 * `a11ign-board-report.{service,timer}`, hand-installed on 2026-09-18 and never committed: the LIVE
 * daily board dispatch, firing at 07:10 every morning. The remedy it named deletes them, and nothing
 * would have reported the loss except an edition that never arrived. `git log --diff-filter=D` is what
 * separates the two, so the report says which it found rather than assuming the safe-looking one.
 * @param {{ shippedDir?: string, installedDir?: string, readDir?: typeof readdirSync,
 *           git?: (args: string[]) => string }} [deps]
 * @returns {Finding[]}
 */
export function orphanedUnits({ shippedDir = SHIPPED_DIR, installedDir = INSTALLED_DIR,
  readDir = readdirSync, git = defaultGit } = {}) {
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
    .map((unit) => orphanFinding(unit, orphanOrigin(unit, { shippedDir, git })));
}

/**
 * @typedef {{ state: "retired" | "never" | "unreadable" } | { state: "unmerged", sha: string }} OrphanOrigin
 */

/**
 * WHERE DID THIS ORPHAN COME FROM? FOUR ANSWERS, AND THE THIRD IS WHY #2013 WAS FILED.
 *
 * `retiredHere` answers one question exactly -- did a commit in THIS history delete the unit file -- and
 * `orphanFinding` used to render its single `false` as *"NO COMMIT HERE EVER SHIPPED IT"*: a claim about
 * ADDITION read off a query about DELETION. `false` is true of three different worlds, and only two of
 * them had a case. The missing one is a unit shipped on a ref this checkout has not merged -- the state
 * every host-unit row passes through between installing a unit and merging the PR that ships it, #1858's
 * and #1993's included. Measured 2026-09-22 from the primary checkout: `host:check` called
 * `a11ign-worktree-prune.service` a hand-installed mystery while `git log --all` in the same tree, seconds
 * later, named the commit shipping it.
 *
 * THE ORDER IS LOAD-BEARING, NOT INCIDENTAL. Every RETIRED unit was also ADDED by some commit, and that
 * commit is still reachable from `--all` after the deletion -- so asking the addition question first would
 * relabel every retirement as pending. Verified against this repository's own history:
 * `a11ign-fleet-gated-nightly.timer` answers BOTH (added by 8dacbc254, deleted by b65b874a8). Deletion is
 * the later fact about a file that was added, so deletion decides.
 *
 * `null` FROM `retiredHere` STILL SHORT-CIRCUITS. A history that cannot say "never" cannot say "not
 * anywhere either", and asking `--all` on it would turn an honest UNKNOWN into a confident NEVER.
 * @param {string} unit
 * @param {{ shippedDir?: string, git?: (args: string[]) => string }} [deps]
 * @returns {OrphanOrigin}
 */
export function orphanOrigin(unit, { shippedDir = SHIPPED_DIR, git = defaultGit } = {}) {
  const retired = retiredHere(unit, { shippedDir, git });
  if (retired === true) return { state: "retired" };
  if (retired === null) return { state: "unreadable" };
  const sha = addedOnSomeRef(unit, { shippedDir, git });
  if (sha === null) return { state: "unreadable" };
  return sha === "" ? { state: "never" } : { state: "unmerged", sha };
}

/**
 * DID ANY REF'S HISTORY ADD THIS UNIT FILE? The adding commit's sha, `""` for no ref, `null` unanswerable.
 *
 * `--all` AND NOT THE DEFAULT `HEAD`, which is the entire point: the unit is absent from the checked-out
 * tree by the time this is asked, so HEAD is the one history guaranteed not to hold the answer. `--all`
 * spans every ref this checkout has, remote-tracking branches included, so a pushed and unmerged branch
 * answers here.
 *
 * `""` IS BOUNDED BY WHAT THIS CHECKOUT FETCHED, exactly as `retiredHere`'s is (#1993). The shallow guard
 * catches the depth-bounded case; it cannot catch a clone that fetched `main` alone, where no ref carries
 * the branch and the honest answer is still only "not in what I can see". That is why the `never` finding
 * keeps telling the reader to go and read the unit rather than to delete it.
 *
 * `--diff-filter=A` AND NOT A BARE `log`, so a commit that merely TOUCHED the path cannot answer a
 * question about the file coming into existence -- the same substitution one level down that this whole
 * function exists to undo.
 * @param {string} unit
 * @param {{ shippedDir?: string, git?: (args: string[]) => string }} [deps]
 * @returns {string | null}
 */
export function addedOnSomeRef(unit, { shippedDir = SHIPPED_DIR, git = defaultGit } = {}) {
  try {
    const sha = git(["log", "--all", "--diff-filter=A", "--format=%H", "-1", "--",
      join(shippedDir, unit)]).trim();
    if (sha !== "") return sha;
    return git(["rev-parse", "--is-shallow-repository"]).trim() === "true" ? null : "";
  } catch {
    return null;
  }
}

/**
 * DID A COMMIT HERE EVER DELETE THIS UNIT FILE? `true` retired, `false` never ours, `null` unanswerable.
 *
 * THREE VALUES AND NOT TWO, because a `git` that cannot answer (no history, a stub path in a test, a
 * checkout without the pack) would otherwise fall into whichever of the two branches the `catch` picked
 * -- and if it picked `retired` the check would recommend deleting a live unit for a second reason.
 * @param {string} unit
 * @param {{ shippedDir?: string, git?: (args: string[]) => string }} [deps]
 * @returns {boolean | null}
 */
export function retiredHere(unit, { shippedDir = SHIPPED_DIR, git = defaultGit } = {}) {
  try {
    if (git(["log", "--diff-filter=D", "--format=%H", "-1", "--", join(shippedDir, unit)]).trim() !== "") {
      return true;
    }
    // A SHALLOW CHECKOUT CANNOT SAY "NEVER", and it answers the question as if it could.
    //
    // MEASURED 2026-09-22 in CI, on the first run of this code: `reusable-acceptance.yml` checks out at
    // the default depth ON PURPOSE ("NO `fetch-depth: 0` HERE, DELIBERATELY -- this job never runs `git
    // diff`"), so `--diff-filter=D` saw no commits at all and reported `a11ign-fleet-gated-nightly.timer`
    // -- deleted by #1941, which this function answers `true` for on a full clone -- as NEVER SHIPPED.
    // An empty log means "no deletion IN WHAT I CAN SEE", and how much that is was chosen by whoever
    // cloned, not by this question. So the absence is only evidence when the history is whole.
    return git(["rev-parse", "--is-shallow-repository"]).trim() === "true" ? null : false;
  } catch {
    return null;
  }
}

/** Long enough to be unambiguous in a repository this size, short enough to read in a one-line problem. */
const SHORT_SHA_LENGTH = 12;

/**
 * THE ONE FACT EVERY ORPHAN FINDING MUST CARRY, whichever of the four it is: the reader's misconception
 * is that deleting the file stopped the schedule, and it is the same misconception in all four.
 */
const STILL_RUNNING = "A unit file is not a schedule: removing one from the repository does not "
  + "uninstall it, so this is still running on whatever schedule it had -- and if something replaced "
  + "it, both are now firing.";

/** ONE ORIGIN, ONE FINDING -- the four states and nothing else. @param {string} unit
 * @param {OrphanOrigin} origin @returns {Finding} */
function orphanFinding(unit, origin) {
  if (origin.state === "retired") return retiredFinding(unit);
  if (origin.state === "unmerged") return unmergedRefFinding(unit, origin.sha);
  return unknownOriginFinding(unit, origin.state === "never");
}

/**
 * THE ONE ORPHAN WHOSE REMEDY IS THE PLAIN REMEDY. A commit here deleted the unit file, so removing it
 * from the host is what somebody already decided -- and this is the branch that must stay off both
 * do-not-run lists, or the warning fires on every report and therefore on none.
 * @param {string} unit @returns {Finding}
 */
function retiredFinding(unit) {
  return { unit, problem: "ORPHANED -- RETIRED HERE",
    detail: `installed on this host and NO LONGER SHIPPED by this repository: a commit deleted its `
      + `unit file, so retiring it was the intent. ${STILL_RUNNING} \`npm run host:install\` removes it.` };
}

/**
 * SHIPPED, JUST NOT HERE YET -- AND THE REMEDY IS THE OPPOSITE ONE (#2013).
 *
 * The other two "not in this tree" findings send the reader to read the unit and its journal and decide
 * whether it is dead, because the repository has nothing to say about it. Here the repository has a
 * COMMIT to say about it, so that instruction would be a waste of an hour ending at a pull request that
 * was already open. `host:install` is still the wrong command -- it copies this tree over the host, and
 * the unit is not in THIS tree, so it would delete a unit whose own PR is in flight -- but it is wrong
 * for a reason with an expiry date, and the finding says which.
 * @param {string} unit @param {string} sha @returns {Finding}
 */
function unmergedRefFinding(unit, sha) {
  const short = sha.slice(0, SHORT_SHA_LENGTH);
  return { unit, shippedOnRef: short,
    problem: `ORPHANED -- SHIPPED ON AN UNMERGED REF ${short}`,
    detail: `installed on this host and NOT in THIS checkout's tree -- but commit ${short} ADDS its unit `
      + "file on a ref this checkout has not merged, so this is not a hand-installed mystery: it is "
      + `about to be ours. ${STILL_RUNNING} DO NOT reach for \`npm run host:install\` yet: that command `
      + "copies this tree over the host, and the unit is not in this tree, so it would DELETE a unit "
      + `whose own pull request is open. \`git branch -a --contains ${short}\` names the ref carrying it; `
      + "merge that and THEN run `npm run host:install`. The remedy here is to MERGE, not to read a "
      + "journal and work out whether it is dead (#2013)." };
}

/**
 * THE TWO ORPHANS THIS REPOSITORY CAN SAY NOTHING ABOUT -- no ref adds the file, or the history could not
 * be read at all. Since #2013 the `never` half is EARNED rather than inferred: it is the answer to
 * `git log --all --diff-filter=A`, an addition question, where it used to be read off a deletion one.
 * @param {string} unit @param {boolean} never @returns {Finding}
 */
function unknownOriginFinding(unit, never) {
  return { unit, removesUnit: true,
    problem: never ? "ORPHANED -- NEVER SHIPPED HERE" : "ORPHANED -- HISTORY UNREADABLE",
    detail: `installed on this host and NOT SHIPPED by this repository -- and ${never
      ? "NO COMMIT ON ANY REF HERE EVER SHIPPED IT, so it was installed by hand and this tree has never "
        + "been able to see what it does"
      : "this checkout's history could not be read, so whether it was ever ours is UNKNOWN"}. `
      + `${STILL_RUNNING} DO NOT reach for \`npm run host:install\`: that command DELETES it, and a unit `
      + "the repository never had is exactly the kind that is still doing something nobody here knows "
      + "about (#1993 -- this is how the live daily board dispatch came to be offered for deletion). "
      + "Read the unit and its journal first; then either ship it under packages/agent-org/host/ or "
      + "confirm it is dead." };
}

/**
 * `git`, ASKED ABOUT THIS REPOSITORY AND NOT THE CALLER'S. `sandboxGitEnv()` drops every inherited
 * `GIT_*`, because `git` exports `GIT_DIR` into every hook environment -- and `host:check` is exactly
 * the kind of command a hook or a merge worktree runs, where an inherited `GIT_DIR` would answer the
 * "was this unit ever shipped?" question about a different repository entirely.
 * @param {string[]} args
 */
const defaultGit = (args) =>
  execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", env: sandboxGitEnv() });

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
 *           readDir?: typeof readdirSync, git?: (args: string[]) => string,
 *           out?: (line: string) => void }} [deps]
 * @returns {string[]} the units it installed
 */
export function hostUnitsInstall({ shippedDir = SHIPPED_DIR, installedDir = INSTALLED_DIR,
  systemctl = defaultSystemctl, copy = copyFileSync, mkdir = mkdirSync, rm = rmSync,
  readDir = readdirSync, git = defaultGit, out = (l) => process.stdout.write(l) } = {}) {
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
  for (const { unit } of orphanedUnits({ shippedDir, installedDir, readDir, git })) {
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
 * @returns {Finding[]}
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
 * @param {Finding[]} drift
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
    + remedy(drift);
}

/**
 * THE REMEDY IS SHARED, AND THAT IS THE TRAP (#1974).
 *
 * Every finding here names one command, which is what makes the report actionable -- and it means a
 * session clearing two harmless ORPHANED units runs the same `host:install` that reverts an identity on
 * a third. The trap is not that the remedy is wrong for the orphans; it is right for them. It is that
 * nothing in between says the command is no longer safe to run blind.
 *
 * So the warning goes on the REMEDY LINE, not only on the finding, because the reader who gets hurt is
 * the one who scrolled past the finding that was not theirs.
 *
 * WHICH IS WHY #2013's THIRD STATE NEEDED A THIRD PARAGRAPH RATHER THAN A SEAT ON `removesUnit`. Both
 * flags mean "this command would delete a unit", and a unit shipped on an unmerged ref genuinely would
 * be deleted -- but the SENTENCE `removesUnit` prints is *"this repository has no record of ever shipping
 * it"*, which is the exact overstatement the row is about, printed in the one place the careless reader
 * does read. Sharing the flag would have moved the wrong claim rather than fixed it.
 * @param {Finding[]} drift @returns {string}
 */
function remedy(drift) {
  const line = "  Remedy for all of them: npm run host:install\n";
  const reverts = drift.filter((d) => d.revertsIdentity);
  const removes = drift.filter((d) => d.removesUnit);
  const pending = drift.filter((d) => d.shippedOnRef);
  if (reverts.length === 0 && removes.length === 0 && pending.length === 0) return line;
  return "  !! DO NOT RUN THE REMEDY YET -- it would change this host in a way nothing here would\n"
    + "     report afterwards.\n"
    + reverts.map((d) => `     ${d.unit} is installed with a \`GH_CONFIG_DIR\` the repository does not `
      + "ship,\n     and `host:install` copies the repository over the host. Land that line in\n"
      + "     packages/agent-org/host/ first.\n").join("")
    + removes.map((d) => `     ${d.unit} would be DELETED, and this repository has no record of ever\n`
      + "     shipping it -- so nothing here knows what stops when it goes. Read it and its journal\n"
      + "     first, then ship it under packages/agent-org/host/ or confirm it is dead.\n").join("")
    + pending.map((d) => `     ${d.unit} would be DELETED, and commit ${d.shippedOnRef} ships it on a ref\n`
      + "     this checkout has not merged -- so the remedy would undo work that is already done.\n"
      + "     Merge that ref first; this command is then the right one.\n").join("")
    + "     Once the lines above are settled this command is safe and fixes everything above.\n"
    + line;
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
