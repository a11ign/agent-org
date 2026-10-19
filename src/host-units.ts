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
import { reviewerDoorPath } from "./reviewer-door-path.ts";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync, rmSync, existsSync, realpathSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { LATEST } from "./lib/release-tag.ts";
import { installPendingFindings } from "./update-tool.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { pnpmDrift } from "./host-pnpm.ts";
import { codexClientDaemonDrift } from "./codex-drift.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { CLAUDE_EFFORTS, DECLARED_CLAUDE_MODELS, HAIKU_MODEL_ID, HAIKU_TIER_LABEL } from "./worker-profile.ts";
import { REPO } from "./project-identity.ts";
import { absentSeats } from "./herdr-agents.ts";
import { persistentEntries } from "./project-roles.ts";
import { kernelFindings } from "./host-kernel.ts";
import { TEMPLATE_SUFFIX, homeHostConfig, readUnitsDeclaration } from "./host-config.ts";
import { HOST_DATA_ENTRIES, HOST_VARIABLE, INSTALLED_DIR, PROJECT_UNITS_DIR, REPO_ROOT, SHIPPED_DIR, TOOL_ENTRIES, execCommands, isUnit, namesIn, packageScripts, programCandidates, shippedContext, shippedUnitNames, shippedUnitText, startedByEnable, textOf, type ShippedDeps, type UnitsDeclaration, unitPrefix } from "./host-units/shipped-dir.ts";
import { ROW_REVIEW_SKILL_FILES, ROW_REVIEW_SKILL_SOURCE, hostIdentityInstall, hostNotes, readSeats, readSessionModels, reviewerDoorDrift, reviewerDoorInstall, tickAppRoleSilent, tickRerenderGhWrapper, toolVersionNotes, type SeatDeps, type SessionModelDeps, writeOwnedFile } from "./host-units/tool-version-notes.ts";
import { codexTrustDrift, defaultGit, defaultSystemctl, endedOnPurpose, hostIdentityDrift, humanLoginOnHost, identityDrift, orphanedUnits, readToolVersionAgreement, remedy, supersededHostScripts, systemdUserAvailable, toolVersionFindings, type Finding, type InstalledCopyState, type WindowEnd, unitDrift, unitState } from "./host-units/gh-spawn-reached-from.ts";

/** Where Codex reads the skill from: `<home>/.codex/skills/row-review`, under the host's home as `codexTrustDrift` reads `~/.codex/config.toml`. `skillDir` places it elsewhere (a test's). @param {ShippedDeps & { skillDir?: string }} [deps] */
export function rowReviewSkillPath(deps: ShippedDeps & { skillDir?: string; } = {}): string {
  return deps.skillDir ?? join((deps.host ?? homeHostConfig()).home, ".codex", "skills", "row-review");
}

export type RowReviewSkillState = {
  state: "CURRENT" | "STALE" | "NOT INSTALLED" | "SOURCE UNREADABLE";
  target: string;
  /** The files of the skill that are missing from the host or differ from the shipped ones. */
  differing: string[];
};

/**
 * Is the installed skill the shipped one. `SOURCE UNREADABLE` is not `STALE`: two unreadable files must not compare equal (the door's rule). `NOT INSTALLED` is every
 * file absent; some absent and some present is `STALE`, because a half-installed skill is one Codex loads without its licence or without its body.
 * @param {ShippedDeps & { read?: typeof readFileSync, source?: string, skillDir?: string }} [deps]
 */
export function rowReviewSkillState(deps: ShippedDeps & { read?: typeof readFileSync; source?: string; skillDir?: string; } = {}): RowReviewSkillState {
  const { read = readFileSync, source = ROW_REVIEW_SKILL_SOURCE } = deps;
  const target = rowReviewSkillPath(deps);
  const shipped = ROW_REVIEW_SKILL_FILES.map((name) => ({ name, shipped: textOf(join(source, name), read), installed: textOf(join(target, name), read) }));
  const unreadable = shipped.filter((file) => file.shipped === null).map((file) => file.name);
  if (unreadable.length > 0) return { state: "SOURCE UNREADABLE", target, differing: unreadable };
  const differing = shipped.filter((file) => file.installed !== file.shipped).map((file) => file.name);
  const state = differing.length === 0 ? "CURRENT" : shipped.every((file) => file.installed === null) ? "NOT INSTALLED" : "STALE";
  return { state, target, differing };
}

/**
 * The skill against the repository's: nothing when CURRENT. `host:install` copies it, so the remedy line is honest here.
 * @param {Parameters<typeof rowReviewSkillState>[0]} [deps]
 * @returns {Finding[]}
 */
export function rowReviewSkillDrift(deps: Parameters<typeof rowReviewSkillState>[0] = {}): Finding[] {
  const { state, target, differing } = rowReviewSkillState(deps);
  if (state === "CURRENT") return [];
  const detail = {
    "SOURCE UNREADABLE": `the repository's src/skills/row-review/ file(s) ${differing.join(", ")} could not be read, so the installed skill cannot be compared to it.`,
    "NOT INSTALLED": `the repository ships the reviewer's row-review skill and this host has none at ${target}: an order that names it cannot run it. \`host:install\` copies it.`,
    STALE: `${differing.join(", ")} at ${target} is missing or is not the shipped copy: the reviewer reviews with a skill that was not the one reviewed and tested. \`host:install\` copies it.`,
  }[state];
  return [{ unit: target, problem: `row-review skill ${state}`, detail }];
}

/**
 * Install the skill: each file written ATOMICALLY (a temp file, then a rename, as every owned file is) into the directory THIS file decided, so the check and the
 * install cannot name two places. Refuses rather than writing an unreadable source. IDEMPOTENT: a file already equal is rewritten with the same bytes.
 * @param {Parameters<typeof rowReviewSkillState>[0] & { mkdir?: typeof mkdirSync, write?: typeof writeFileSync, chmod?: typeof chmodSync, rename?: typeof renameSync, out?: (line: string) => void }} [deps]
 * @returns {string[]} the paths it wrote
 */
export function rowReviewSkillInstall({ mkdir = mkdirSync, write = writeFileSync, chmod = chmodSync, rename = renameSync, out = (l) => process.stdout.write(l), ...where }: Parameters<typeof rowReviewSkillState>[0] & {
  mkdir?: typeof mkdirSync; write?: typeof writeFileSync; chmod?: typeof chmodSync; rename?: typeof renameSync; out?: (line: string) => void;
} = {}): string[] {
  const { read = readFileSync, source = ROW_REVIEW_SKILL_SOURCE } = where;
  const target = rowReviewSkillPath(where);
  const texts = ROW_REVIEW_SKILL_FILES.map((name) => ({ name, text: textOf(join(source, name), read) }));
  const unreadable = texts.filter((file) => file.text === null).map((file) => file.name);
  if (unreadable.length > 0) throw new Error(`cannot install the row-review skill: ${unreadable.join(", ")} of ${source} could not be read`);
  return texts.map(({ name, text }) => {
    const path = join(target, name);
    writeOwnedFile({ target: path, mode: 0o644, text: text as string, mkdir, write, chmod, rename });
    out(`installed ${path}\n`);
    return path;
  });
}

/**
 * A UNIT THAT IS BYTE-CORRECT AND NAMES A PROGRAM THAT IS NOT THERE -- #2174's constraint 3.
 *
 * WHY EVERY OTHER CHECK HERE IS BLIND TO IT. `unitDrift` compares SHIPPED unit text against INSTALLED
 * unit text, so a unit installed perfectly from the tree agrees with the tree on both sides and reads
 * clean -- while `ExecStart` is repository-RELATIVE and resolves against the `WorkingDirectory` the unit
 * names, which is a DIFFERENT TREE from the one anybody installed from. A stale primary checkout, a
 * renamed script, a `WorkingDirectory` pointing at a worktree somebody deleted: in all three the unit is
 * current, `host:check` reads green, and the timer fails at its next firing on a missing file.
 *
 * MEASURED, AND IT IS WHY THIS EXISTS. Closing #2173 on 2026-09-23 the primary checkout happened to be
 * at `518de0e32` and carried `packages/agent-org/host/board-report-dispatch.sh`, so the 06:10Z board
 * edition would run. Had it been left at the `72c8fbcd5` it held earlier that day, every reading taken
 * that afternoon would have been identical and the firing would still have failed.
 *
 * **TWO FINDINGS, NEVER ONE.** "Differs from the tree" and "matches the tree and names something that is
 * not there" have different causes and different remedies -- the first is fixed by `host:install`, and
 * **the second is not fixed by it at all**, because installing the unit again reinstalls the same correct
 * text. Folding them into one finding would print the shared remedy against a fault the remedy cannot
 * touch, which is `uncovered`'s whole reason for existing one function down.
 *
 * IT READS THE INSTALLED TEXT, NOT THE SHIPPED TEXT, because the question is what the SERVICE MANAGER
 * will execute. A unit not installed at all is `unitDrift`'s finding and is skipped here, so one fault
 * never prints twice.
 *
 * WHAT IT CANNOT SEE, STATED. Only the three tools `programCandidates` can follow -- `node`, a shell, and
 * `pnpm run` through the WorkingDirectory's own `package.json`. A `bash -c '...'`, an opaque binary
 * or an absolute path outside the repository yields no candidate and is silently fine here; that is
 * `opaqueCommands`'s territory and this function does not pretend otherwise. A unit with no
 * `WorkingDirectory=` line is SKIPPED rather than guessed at -- a relative path would then resolve
 * against systemd's own default, and inventing a base directory to check against is how a checker starts
 * reporting faults that are really its own.
 * IT STILL READS THE SHIPPED TEXT, FOR ONE THING ONLY: whether the installed copy matches it. Found in
 * review of #2184 -- the finding's sentence claimed *"the unit is installed and matches the repository"*
 * on EVERY unit it charged, because it never looked. On a unit that is STALE that is a false statement
 * about the unit's state, and the remedy it prints from it (*"re-installing copies the same correct unit
 * again"*) is false too: re-installing REPLACES a stale text, and the repository's copy may name a
 * program that is there. The state is measured here and rendered by `missingProgramFinding`, so no
 * sentence in this file asserts a comparison that was never made.
 * @param {ShippedDeps & { shippedDir?: string, installedDir?: string, readDir?: typeof readdirSync,
 *           read?: typeof readFileSync, exists?: typeof existsSync }} [deps]
 * @returns {Finding[]}
 */
export function missingUnitPrograms(deps: ShippedDeps & {
    shippedDir?: string; installedDir?: string; readDir?: typeof readdirSync;
    read?: typeof readFileSync; exists?: typeof existsSync; home?: string;
} = {}): Finding[] {
  const { installedDir = INSTALLED_DIR, readDir = readdirSync, read = readFileSync, exists = existsSync, home = homedir() } = deps;
  return installedOrgUnits(installedDir, readDir, unitPrefix(deps)).flatMap((unit) => {
    const text = textOf(join(installedDir, unit), read);
    const installedCopy = installedCopyState(shippedUnitText(unit, deps), text);
    return missingForUnit(unit, text, { installedCopy, read, exists, home });
  });
}

/**
 * THE INSTALL THE HELD CHECKOUT IS WAITING FOR (a11ign/a11ign#4392): `host-install-pending`, one finding per installed unit (or the launcher) that runs a program the release
 * `update-tool` would move to lacks, and (a11ign/agent-org#714) one `package.json` finding when the release declares `dependencies` the tool's `node_modules` does not hold, which
 * `update-tool` installs itself and so reports only after that install failed. The questions live in `update-tool.ts`, which asks them before every move, so the hold and this report cannot disagree; it is in `hostUnitDrift`
 * so the gate's `hostDriftOrders` wakes `orchestrator` with the unit names from a tick that still runs. A host naming no `tool` has no checkout to hold, and reports nothing.
 * @param {ShippedDeps & { installedDir?: string, run?: (args: string[]) => string }} [deps] @returns {Finding[]}
 */
export function hostInstallPending(deps: ShippedDeps & { installedDir?: string; run?: (args: string[]) => string } = {}): Finding[] {
  const host = deps.host ?? homeHostConfig();
  if (host.tool === undefined) return [];
  return installPendingFindings({ tool: host.tool, toolVersion: host.toolVersion ?? LATEST, binDir: host.binDir, prefix: unitPrefix(deps),
    installedDir: deps.installedDir ?? INSTALLED_DIR, read: deps.read, readDir: deps.readDir, run: deps.run });
}

/**
 * THREE STATES AND NOT A BOOLEAN, for the same reason `unitState.current` is nullable: "differs from the
 * repository" and "the repository does not ship this at all" are different facts with different remedies,
 * and an orphan answering `false` to "does it match?" would print the stale sentence at a unit that has
 * nothing to be stale against. `textOf` returns null for BOTH an absent and an unreadable shipped file;
 * an unreadable one is `unitDrift`'s finding and lands here as `unshipped`, whose sentence claims only
 * that this repository has no copy to compare -- which is what a reader that could not read one knows.
 * @param {string | null} shippedText @param {string | null} installedText @returns {InstalledCopyState}
 */
function installedCopyState(shippedText: string | null, installedText: string | null): InstalledCopyState {
  if (shippedText === null) return "unshipped";
  return shippedText === installedText ? "current" : "stale";
}

/**
 * Units the project's prefix says are ours. The host runs others; those are not ours to have an opinion about.
 * @param {string} dir @param {typeof readdirSync} readDir @param {string} prefix @returns {string[]}
 */
function installedOrgUnits(dir: string, readDir: typeof readdirSync, prefix: string): string[] {
  try {
    return (readDir(dir) as string[])
      .map(String).filter((n) => n.startsWith(prefix));
  } catch {
    // NOT AN AGENT HOST, or a directory this process cannot read. `hostUnitDrift`'s `systemdUserAvailable`
    // gate has already answered the first; returning [] here keeps the second from being reported as a
    // clean host by a reader that never got to look.
    return [];
  }
}

/**
 * @param {string} unit @param {string | null} text the INSTALLED unit's text, or `null` if unreadable
 * `installedCopy` HAS NO DEFAULT, deliberately. The sentence this function's findings print depends on
 * it, and a default would let a future caller re-acquire the exact false claim review caught in #2184 --
 * "matches the repository" said by a reader that never compared -- silently and by omission.
 * @param {{ installedCopy: InstalledCopyState, read?: typeof readFileSync,
 *           exists?: typeof existsSync, home?: string }} deps @returns {Finding[]}
 */
function missingForUnit(unit: string, text: string | null, { installedCopy, read = readFileSync, exists = existsSync, home = homedir() }: {
        installedCopy: InstalledCopyState; read?: typeof readFileSync;
        exists?: typeof existsSync; home?: string;
    }): Finding[] {
  // A UNIT WHOSE TEXT CANNOT BE READ IS `unitDrift`'s FINDING, NOT THIS ONE. Guessing at what an
  // unreadable unit starts would report a second fault for one cause, which is the thing the "two
  // findings, never one" rule above exists to get right in the other direction.
  if (text === null) return [];
  const dir = workingDirectoryOf(text);
  if (dir === null) return [];
  const scripts = packageScripts(dir, read);
  const missing = [...new Set(execCommands(text)
    .flatMap((command) => programCandidates(command, { repoRoot: dir, scripts, home })))]
    .filter((path) => !exists(path));
  return missing.map((path) => missingProgramFinding({ unit, path, dir, installedCopy }));
}

/**
 * ONE FAULT, THREE SENTENCES -- because the fault is the same in all three ("the program the service
 * manager will run is not there") and the REMEDY is not. The path is read off the INSTALLED text either
 * way; what changes is what this finding is entitled to say about the unit around it.
 * @param {{ unit: string, path: string, dir: string, installedCopy: InstalledCopyState }} finding
 * @returns {Finding}
 */
function missingProgramFinding({ unit, path, dir, installedCopy }: { unit: string; path: string; dir: string; installedCopy: InstalledCopyState; }): Finding {
  return { unit, problem: "PROGRAM MISSING", missingProgram: path, installedCopy,
    detail: MISSING_PROGRAM_DETAIL[installedCopy](path, dir) };
}

/** Where `ExecStart` resolved, said the same way in all three sentences. */
const resolvedAgainst = (path: string, dir: string) =>
  `the program it starts is not there: ${path}. \`ExecStart\` is resolved against this unit's own `
  + `\`WorkingDirectory=${dir}\``;

const MISSING_PROGRAM_DETAIL: Record<InstalledCopyState, (path: string, dir: string) => string> = {
  current: (path, dir) => `the unit is installed and matches the repository, and `
    + `${resolvedAgainst(path, dir)}, which is `
    + "a different tree from the one it was installed from -- so the unit text can be perfectly current "
    + "while the file it names is absent, renamed, or simply older than the merge. THE SHARED REMEDY "
    + "DOES NOT FIX THIS: re-installing copies the same correct unit again. Bring that checkout up to "
    + "date, or correct the path, and this clears.",
  // THE REMEDY MAY WELL FIX THIS ONE, and saying otherwise is what review caught. The installed text is
  // what the service manager runs, so the missing program is real NOW -- but it was read off text that
  // `host:install` is about to overwrite, and the repository's copy may name a program that is there.
  stale: (path, dir) => `${capitalised(resolvedAgainst(path, dir))}. This is read off the INSTALLED `
    + "text, which is what the service manager will run -- and that text ALSO differs from the "
    + "repository's, reported separately as STALE. So unlike a current unit, this one MAY be fixed by "
    + "the shared remedy: re-installing replaces this text with the repository's, which can name a "
    + "different program. Run the remedy, then read this again.",
  // An orphan has nothing to be stale against, so it gets neither sentence. `host:install` DELETES an
  // installed a11ign-* unit the repository does not ship, which `orphanedUnits` already says loudly.
  unshipped: (path, dir) => `${capitalised(resolvedAgainst(path, dir))}. This repository does not ship `
    + "this unit at all, so there is no repository copy for it to match or differ from -- that is "
    + "`orphanedUnits`'s finding, and the shared remedy would DELETE the unit rather than repair this "
    + "path. Settle what the unit is first; only then is a missing program a fault of ours.",
};

/** @param {string} sentence */
const capitalised = (sentence: string) => sentence.charAt(0).toUpperCase() + sentence.slice(1);

/**
 * The directory a relative `ExecStart` resolves against, or `null` when the unit declares none.
 *
 * LAST WINS, which is systemd's own rule for a repeated directive rather than a preference of ours: a
 * later `WorkingDirectory=` overrides an earlier one, and an EMPTY one resets it to the default, which
 * is a unit that declares no base directory and so is skipped. A first-match read would check a path
 * against a directory the service manager has already discarded.
 * @param {string} unitText @returns {string | null}
 */
export function workingDirectoryOf(unitText: string): string | null {
  const matches = [...String(unitText ?? "").matchAll(/^WorkingDirectory=(.*)$/gm)]
    .map((m) => m[1].trim().replace(/^-/, "").trim());
  const last = matches.length === 0 ? null : matches[matches.length - 1];
  return last === null || last === "" ? null : last;
}

/**
 * The value `AGENT_ORG_HOST` has when a service manager starts the unit, or `null` when it has none: the unit's own `Environment=` lines
 * and then its drop-ins', IN ORDER, because that is the order systemd applies them. LAST WINS for a repeated variable, and a bare
 * `Environment=` RESETS the list, both systemd's rules and not ours. An EMPTY value is `null` too: `resolveHomeCheckout` reads empty as
 * unset, so a unit that starts the tool with `AGENT_ORG_HOST=` starts it the way an unset one does.
 * @param {string[]} texts the unit file, then each `<unit>.d/*.conf` in name order @returns {string | null}
 */
export function hostVariableAsRun(texts: string[]): string | null {
  let value: string | null = null;
  for (const line of texts.flatMap((text) => text.split("\n"))) {
    const set = /^\s*Environment=(.*)$/.exec(line);
    if (set === null) continue;
    if (set[1].trim() === "") value = null;
    for (const [, quoted, single, bare] of set[1].matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
      const assignment = quoted ?? single ?? bare;
      if (assignment.startsWith(`${HOST_VARIABLE}=`)) value = assignment.slice(HOST_VARIABLE.length + 1) || null;
    }
  }
  return value;
}

/**
 * THE DROP-INS A UNIT RUNS WITH, which the chairman's own hand fix lives in (`a11ign-work-tick.service.d/agent-org-host.conf`): a check that read
 * only the unit file would refuse the one host that works. An absent directory is no drop-ins; an unreadable one is not guessed at.
 * @param {string} installedDir @param {string} unit @param {{ readDir: typeof readdirSync, read: typeof readFileSync }} deps @returns {string[]}
 */
function dropInTexts(installedDir: string, unit: string, { readDir, read }: { readDir: typeof readdirSync; read: typeof readFileSync; }): string[] {
  const dir = join(installedDir, `${unit}.d`);
  let names: string[];
  try {
    names = (readDir(dir) as string[]).map(String);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".conf")).sort().flatMap((name) => textOf(join(dir, name), read) ?? []);
}

/**
 * #3039: A UNIT THAT WOULD START THE TOOL WITHOUT SAYING WHICH PROJECT IT SERVES. A unit whose `WorkingDirectory` is the declared `tool`
 * checkout runs the tool outside the monorepo layout, where `resolveHomeCheckout` REFUSES an unset `AGENT_ORG_HOST` by name -- every tick
 * of it, from the first, as the 63 on 2026-10-02 were. `host:check` said only `STALE` of that unit and never asked "would this start?".
 * The question is asked of the unit AS IT WOULD RUN (`hostVariableAsRun`), and a unit whose working directory is anything else is not
 * this check's: the monorepo form resolves its project from the tree it sits in.
 * @param {{ unit: string, text: string, dropIns: string[], tool: string | undefined }} unit @returns {Finding[]}
 */
function unitWithoutHostVariable({ unit, text, dropIns, tool }: { unit: string; text: string; dropIns: string[]; tool: string | undefined; }): Finding[] {
  if (tool === undefined || workingDirectoryOf(text) !== tool) return [];
  if (hostVariableAsRun([text, ...dropIns]) !== null) return [];
  return [{ unit, problem: `WOULD NOT START: ${HOST_VARIABLE} IS UNSET`,
    detail: `${unit} runs from the tool's checkout (${tool}) with no ${HOST_VARIABLE} in its Environment= lines or in ${unit}.d/*.conf, so the tool `
      + `refuses to resolve its project and exits on every start. Add Environment=${HOST_VARIABLE}=<checkout>/.agent-org/host.json to the unit `
      + `(\`host:install\` renders it from host.json's \`tool\`) or to ${unit}.d/*.conf.` }];
}

/**
 * Every INSTALLED unit that would start without `AGENT_ORG_HOST`, read as the service manager would run it (#3039). An unreadable unit is
 * `unitDrift`'s finding and is skipped here, and a host that names no `tool` has no unit this applies to.
 * @param {ShippedDeps & { installedDir?: string }} [deps] @returns {Finding[]}
 */
export function unitsWithoutHostVariable(deps: ShippedDeps & { installedDir?: string; } = {}): Finding[] {
  const { installedDir = INSTALLED_DIR, readDir = readdirSync, read = readFileSync } = deps;
  const { tool } = shippedContext(deps).host();
  return installedOrgUnits(installedDir, readDir, unitPrefix(deps)).flatMap((unit) => {
    const text = textOf(join(installedDir, unit), read);
    return text === null ? [] : unitWithoutHostVariable({ unit, text, dropIns: dropInTexts(installedDir, unit, { readDir, read }), tool });
  });
}

/**
 * The same question asked of what `host:install` is ABOUT TO WRITE: the shipped text, with the drop-ins already on the host (they are not
 * ours to remove, and they are what is left running). Asked before any write, so a refusal leaves the host as it was.
 * @param {ShippedDeps & { installedDir?: string }} deps @returns {Finding[]}
 */
function shippedUnitsWithoutHostVariable(deps: ShippedDeps & { installedDir?: string; }): Finding[] {
  const { installedDir = INSTALLED_DIR, readDir = readdirSync, read = readFileSync } = deps;
  const { tool } = shippedContext(deps).host();
  return shippedUnitNames(deps).flatMap((unit) => {
    const text = shippedUnitText(unit, deps);
    return text === null ? [] : unitWithoutHostVariable({ unit, text, dropIns: dropInTexts(installedDir, unit, { readDir, read }), tool });
  });
}

/**
 * #2620: THE EIGHTEENTH ENTRY. Every file in the tool's host directory must be one the tool records (`TOOL_ENTRIES`), and every unit in
 * the project's directory one its declaration lists (`units.own`); a file that is neither is REFUSED, named, rather than adopted by
 * whichever glob it happens to match -- `shippedUnits` matches on a suffix, so a stray `.service` would otherwise be installed as the
 * tool's or the project's on nothing but its extension. `gh-leads-workspaces.txt` is refused too, saying where it went.
 * @param {ShippedDeps & { units?: UnitsDeclaration }} [deps]
 * @returns {Finding[]}
 */
export function unclassifiedEntries(deps: ShippedDeps & { units?: UnitsDeclaration; } = {}): Finding[] {
  const { shippedDir = SHIPPED_DIR, readDir = readdirSync, units } = deps;
  const { projectDir } = shippedContext(deps);
  const tool = new Set(TOOL_ENTRIES);
  const own = new Set((units ?? readUnitsDeclaration()).own);
  const strays = namesIn(shippedDir, readDir).filter((name) => !tool.has(name)).map((name) => ({
    unit: name, problem: "UNCLASSIFIED ENTRY",
    detail: Object.hasOwn(HOST_DATA_ENTRIES, name)
      ? `${name} is host data now: it is \`${HOST_DATA_ENTRIES[name]}\` in host.json, and is rendered rather than shipped`
      : `${shippedDir} holds ${name}, which is not one of the tool's ${TOOL_ENTRIES.length} entries. Add it to TOOL_ENTRIES in `
        + "host-units.ts if it is the tool's, or move it to the project's `.agent-org/units/` and list it in `units.own`",
  }));
  const foreign = projectDir === null ? [] : namesIn(projectDir, readDir).filter((name) => !own.has(name)).map((name) => ({
    unit: name, problem: "UNCLASSIFIED ENTRY",
    detail: `${projectDir} holds ${name}, which the project's declaration does not list in \`units.own\`. List it there, or remove it`,
  }));
  return [...strays, ...foreign];
}

/**
 * The classification, asked of the LIVE trees, or of a fixture whose caller HANDS the project's declaration (`units`): a test's own
 * directory of stand-in units is not a place `TOOL_ENTRIES` has an opinion about unless it says whose partition to read it against.
 * @param {ShippedDeps & { units?: UnitsDeclaration }} deps
 */
function unclassifiedInLiveTree(deps: ShippedDeps & { units?: UnitsDeclaration; }) {
  return deps.shippedDir === undefined || deps.units !== undefined ? unclassifiedEntries(deps) : [];
}

/**
 * Every shipped unit's drift, in one call -- what both the CLI and the gate ask for. An empty list on a
 * machine with no user systemd, which is not the same claim as "this host is correct" and is why
 * `driftReport` says which of the two it is.
 *
 * EIGHT QUESTIONS NOW, THE EIGHTH ASKED FIRST (#2620): is every entry of the two shipped directories classified (`unclassifiedEntries`)?
 * SEVEN BEFORE IT. Is what we ship installed (`unitDrift`), is what is installed still ours
 * (`orphanedUnits`), is a copy of what we ship still sitting where it used to be hand-placed
 * (`supersededHostScripts`, #1998), DOES THE PROGRAM EACH INSTALLED UNIT NAMES EXIST AT THE DIRECTORY IT
 * RESOLVES AGAINST (`missingUnitPrograms`, #2174), IS THE `gh` IDENTITY POLICY THE REVIEWED ONE
 * (`hostIdentityDrift`, #2332), DOES EVERY SHIPPED UNIT SAY WHICH ACCOUNT IT ACTS AS, AND IS THE ANSWER NEVER THE
 * PERSON (`identityDrift`, #1974, #2332), and can a session act at all (`permissionModeDrift`).
 *
 * THE FOURTH IS THE ONLY ONE THE OTHERS CANNOT SEE BETWEEN THEM. Every check above compares the tree to
 * the host; a unit copied perfectly from the tree agrees on both sides and reads clean while the file its
 * `ExecStart` names -- resolved against the unit's OWN `WorkingDirectory`, a different tree again -- is
 * absent. "Installed and current" was never the same claim as "the program it names exists".
 * @param {Parameters<typeof unitState>[1] & Parameters<typeof supersededHostScripts>[0]
 *   & Parameters<typeof hostIdentityDrift>[0] & Parameters<typeof identityDrift>[0] & Parameters<typeof humanLoginOnHost>[0] & Parameters<typeof codexTrustDrift>[0]
 *   & { pnpm?: Parameters<typeof pnpmDrift>[0], codexDrift?: Partial<Parameters<typeof codexClientDaemonDrift>[0]> }} [deps]
 */
export function hostUnitDrift(deps: Parameters<typeof unitState>[1] & Parameters<typeof supersededHostScripts>[0] &
Parameters<typeof hostIdentityDrift>[0] & Parameters<typeof identityDrift>[0] & Parameters<typeof humanLoginOnHost>[0] & Parameters<typeof codexTrustDrift>[0] &
{ pnpm?: Parameters<typeof pnpmDrift>[0]; codexDrift?: Partial<Parameters<typeof codexClientDaemonDrift>[0]>; } = {}) {
  if (!systemdUserAvailable(deps.systemctl ?? defaultSystemctl)) return [];
  // THE SAME GATE COVERS BOTH. A machine with no user systemd is not an agent host, so its `~/.claude`
  // posture is nobody's business either -- and a laptop told "ORG IS IN AUTO MODE" teaches its owner to
  // ignore this command, which would lose the timer finding along with it.
  // TYPED `Finding[]`: the leaf declares only the fields it sets, and a spread of its narrower type would narrow every consumer's element.
  const codexDaemonDisagreement: Finding[] = codexClientDaemonDrift({ home: (deps.host ?? homeHostConfig()).home,
    readCodexConfig: deps.readCodexConfig, ...deps.codexDrift });
  return [...unclassifiedInLiveTree(deps), ...unitDrift(shippedUnitNames(deps).map((u) => unitState(u, deps))),
    ...orphanedUnits(deps), ...emptyProjectUnitsFinding(deps), ...supersededHostScripts(deps), ...missingUnitPrograms(deps), ...hostInstallPending(deps), ...unitsWithoutHostVariable(deps),
    ...hostIdentityDrift(deps), ...reviewerDoorDrift(deps), ...rowReviewSkillDrift(deps), ...identityDrift(deps), ...humanLoginOnHost(deps), ...codexTrustDrift(deps),
    ...codexDaemonDisagreement, ...permissionModeDrift(deps), ...modelEffortDrift(deps), ...pnpmDrift({ repoRoot: REPO_ROOT, ...deps.pnpm })];
}

/**
 * The project's own units directory a check or an install reads, or `null` when it reads none: a fixture handed its own `shippedDir` and no
 * `projectUnitsDir` (the rule `shippedContext` applies, named once here for #1505).
 * @param {ShippedDeps} [deps] @returns {string | null}
 */
function projectUnitsDirOf({ shippedDir, projectUnitsDir }: ShippedDeps = {}): string | null {
  if (projectUnitsDir !== undefined) return projectUnitsDir;
  return (shippedDir ?? SHIPPED_DIR) === SHIPPED_DIR ? PROJECT_UNITS_DIR : null;
}

/**
 * THE FIRST LINE OF `host:check` AND `host:install` (#1505): which checkout the project's units were read from, and its HEAD. Two directories on one
 * host gave one reading `1 problem` and another `14 files not shipped`, and neither said which checkout it had read. The checkout is the one `dir`
 * belongs to (`git rev-parse --show-toplevel`), so the line names the directory actually read, even one a test hands in.
 * @param {string | null} dir the project's units directory, or null for a run that reads none @returns {string}
 */
export function projectUnitsLine(dir: string | null, { read = readdirSync }: { read?: typeof readdirSync } = {}): string {
  if (dir === null) return "project units: none read -- this run reads no project units directory.\n";
  const files = namesIn(dir, read).length;
  let checkout = dir;
  let head = "no HEAD (not a git checkout)";
  try {
    const [top, sha] = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel", "--short", "HEAD"],
      { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n");
    checkout = top;
    head = sha;
  } catch {
    // A missing or unversioned directory is the case this line exists to show, so the line still names the directory it tried.
  }
  return `project units read from ${checkout} @ ${head}, ${files} files\n`;
}

/**
 * THE PROJECT'S UNITS DIRECTORY IS THERE AND HOLDS NONE OF ITS UNITS, while the host has installed some (#1505, the third line of the change).
 * That is what deleting a host's whole project timer set looks like from the inside: `host:install` removes every installed unit no shipped set
 * names, and an empty directory names none of the project's. A directory that does not exist is silence here, since the missing-unit check asks that.
 * @param {ShippedDeps & { installedDir?: string, readDir?: typeof readdirSync }} [deps] @returns {Finding[]}
 */
export function emptyProjectUnitsFinding(deps: ShippedDeps & { installedDir?: string; readDir?: typeof readdirSync; } = {}): Finding[] {
  const dir = projectUnitsDirOf(deps);
  const { installedDir = INSTALLED_DIR, readDir = readdirSync } = deps;
  if (dir === null) return [];
  // A directory that is not there is silence here, since the missing-unit check asks that. One that is there and cannot be read is
  // UNKNOWN, never safe: it is reported as unreadable, and the install remedy is withheld for it (`remedy`).
  const unreadable = (unit: string, err: unknown): Finding[] => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ unit, problem: "PROJECT UNITS UNREADABLE", unitsUnreadable: true,
      detail: `${unit} exists but could not be read (${(err as Error).message}), so nothing here can say which units it holds. Settle why it cannot be read before anything is installed or removed.` }];
  };
  let held: string[];
  try {
    held = readDir(dir).map(String);
  } catch (err) {
    return unreadable(dir, err);
  }
  const prefix = unitPrefix(deps);
  const isOwn = (name: string) => name.startsWith(prefix) && isUnit(name);
  if (held.some(isOwn)) return [];
  let installedNames: string[];
  try {
    installedNames = readDir(installedDir).map(String);
  } catch (err) {
    return unreadable(installedDir, err);
  }
  const installed = installedNames.filter(isOwn);
  if (installed.length === 0) return [];
  return [{ unit: dir, problem: "PROJECT UNITS EMPTY", noProjectUnits: true,
    detail: `it holds no \`${prefix}*\` unit, but ${installed.length} are installed (${installed.join(", ")}). \`host:install\` would REMOVE every installed `
      + "unit the tool does not ship, and those are this project's: the checkout these units were read from is not the one this host serves "
      + "(`AGENT_ORG_HOST`), or its units were deleted. Settle which before anything is installed or removed." }];
}

/** An install REFUSES while an entry is classified nowhere: it would copy whatever a glob matched. @param {Parameters<typeof unclassifiedInLiveTree>[0]} deps */
function refuseUnclassified(deps: Parameters<typeof unclassifiedInLiveTree>[0]) {
  const refused = unclassifiedInLiveTree(deps);
  if (refused.length === 0) return;
  throw new Error(`cannot install: ${refused.map((f) => `${f.unit}: ${f.problem}`).join("; ")} -- ${refused[0].detail}`);
}

/** An install REFUSES a unit that would start without `AGENT_ORG_HOST` (#3039), before anything is written. @param {Parameters<typeof shippedUnitsWithoutHostVariable>[0]} deps */
function refuseUnitsWithoutHostVariable(deps: Parameters<typeof shippedUnitsWithoutHostVariable>[0]) {
  const refused = shippedUnitsWithoutHostVariable(deps);
  if (refused.length === 0) return;
  throw new Error(`cannot install: ${refused.map((f) => `${f.unit}: ${f.problem}`).join("; ")} -- ${refused[0].detail}`);
}

/** Where `systemd-tmpfiles --user` reads its rules from, which is what `systemd-tmpfiles-clean.timer` (a USER unit on this host) runs over. */
export const USER_TMPFILES_DIR = `${process.env.HOME ?? ""}/.config/user-tmpfiles.d`;

/** The shipped `*.tmpfiles.conf.in` files: the name without that suffix is the name the rule is installed under, as `<name>.conf`. */
const TMPFILES_SUFFIX = `.tmpfiles.conf${TEMPLATE_SUFFIX}`;

/**
 * Copies each shipped tmpfiles rule into the user's rule directory (a11ign/a11ign#3849). VERBATIM, never rendered: the rule says `%h`, which
 * systemd expands, so there is no host value to fill in and the installed bytes are the shipped bytes. Idempotent, like the units beside it.
 * @param {ShippedDeps & { tmpfilesDir?: string, write?: typeof writeFileSync, mkdir?: typeof mkdirSync, out?: (line: string) => void }} deps
 * @returns {string[]} the rule files it wrote
 */
export function installTmpfiles(deps: ShippedDeps & { tmpfilesDir?: string; write?: typeof writeFileSync; mkdir?: typeof mkdirSync; out?: (line: string) => void; } = {}): string[] {
  const { shippedDir = SHIPPED_DIR, readDir = readdirSync, tmpfilesDir = USER_TMPFILES_DIR, write = writeFileSync, mkdir = mkdirSync,
    read = readFileSync, out = (l) => process.stdout.write(l) } = deps;
  const rules = namesIn(shippedDir, readDir).filter((name) => name.endsWith(TMPFILES_SUFFIX));
  if (rules.length > 0) mkdir(tmpfilesDir, { recursive: true });
  return rules.map((rule) => {
    const installed = `${rule.slice(0, -TMPFILES_SUFFIX.length)}.conf`;
    write(join(tmpfilesDir, installed), read(join(shippedDir, rule), "utf8"));
    out(`installed ${installed} (user tmpfiles rule)\n`);
    return installed;
  });
}

/**
 * WRITTEN, NOT COPIED (#2620): three of the units are rendered from templates, so there is no file to copy, and one path for every unit
 * means the installed bytes are always the ones `unitState` compared.
 * @param {string[]} units
 * @param {ShippedDeps & { installedDir?: string, write?: typeof writeFileSync, out?: (line: string) => void }} deps
 */
function writeShippedUnits(units: string[], deps: ShippedDeps & { installedDir?: string; write?: typeof writeFileSync; out?: (line: string) => void; }) {
  const { installedDir = INSTALLED_DIR, write = writeFileSync, out = (l) => process.stdout.write(l) } = deps;
  for (const unit of units) {
    const text = shippedUnitText(unit, deps);
    if (text === null) throw new Error(`cannot install ${unit}: the shipped copy could not be read`);
    write(join(installedDir, unit), text);
    out(`installed ${unit}\n`);
  }
}

/**
 * Copy every shipped unit into place and start every timer AND every long-running service (#3025). IDEMPOTENT -- re-running it on a correct
 * host changes nothing, which is what lets it be the single remedy every message here names.
 *
 * `enable --now`, NEVER a bare `enable`: the bare form is what left `a11ign-corpus-snapshot.timer`
 * enabled and dead for nine days, and an installer that can reproduce the bug it exists to fix is not
 * an installer. For the listener the SERVICE is what is enabled: no timer starts it, so a bare `enable` would leave it dead until a reboot.
 * @param {ShippedDeps & { installedDir?: string, systemctl?: (args: string[]) => string,
 *           write?: typeof writeFileSync, mkdir?: typeof mkdirSync, rm?: typeof rmSync,
 *           git?: (args: string[]) => string, out?: (line: string) => void }} [deps]
 * @returns {string[]} the units it installed
 */
export function hostUnitsInstall(deps: ShippedDeps & {
    installedDir?: string; systemctl?: (args: string[]) => string;
    write?: typeof writeFileSync; mkdir?: typeof mkdirSync; rm?: typeof rmSync;
    git?: (args: string[]) => string; out?: (line: string) => void;
} = {}): string[] {
  const { installedDir = INSTALLED_DIR, systemctl = defaultSystemctl, mkdir = mkdirSync, rm = rmSync,
    out = (l) => process.stdout.write(l) } = deps;
  const { shippedDir = SHIPPED_DIR, readDir = readdirSync, git = defaultGit } = deps;
  out(projectUnitsLine(projectUnitsDirOf(deps), { read: readDir }));
  refuseUnclassified(deps);
  refuseUnitsWithoutHostVariable(deps);
  // `readDir` IS INJECTED THROUGH TO BOTH DISCOVERIES, and the first version of this hard-wired
  // `readdirSync` into the `orphanedUnits` call below. A test could not reach the removal path at all,
  // so deleting the ENTIRE removal loop killed zero tests -- it passed vacuously, which is the same
  // defect this file's own `no-token` header was written to catch one level up. Found by mutating it.
  const units = shippedUnitNames(deps);
  mkdir(installedDir, { recursive: true });
  writeShippedUnits(units, deps);
  installTmpfiles(deps);
  // REMOVED BEFORE THE RELOAD, so systemd never re-reads a unit that is on its way out. `disable --now`
  // first because deleting the file leaves an enabled symlink in `timers.target.wants` behind, and a
  // dangling want is a warning on every subsequent `daemon-reload` -- noise that trains an operator to
  // ignore this command's output.
  const orphans = orphanedUnits({ ...deps, shippedDir, installedDir, readDir, git });
  const compared = `${shippedDir} and ${projectUnitsDirOf(deps) ?? "no project units directory"}`;
  for (const { unit } of orphans) out(`ORPHAN ${unit} -- not shipped by the directories compared: ${compared}\n`);
  for (const { unit } of orphans) {
    if (startedByEnable(unit, unitPrefix(deps))) systemctl(["disable", "--now", unit]);
    rm(join(installedDir, unit), { force: true });
    out(`REMOVED ${unit} -- no longer shipped by this repository\n`);
  }
  systemctl(["daemon-reload"]);
  for (const started of units.filter((u) => startedByEnable(u, unitPrefix(deps)))) {
    const ended = windowEndedOnPurpose(started, { ...deps, installedDir, systemctl });
    if (ended !== null) {
      out(`SKIPPED ${started} -- its window ended (${ended.cause}, ${ended.ticks} ticks, ${ended.at}); arm it with shadow-window.ts --arm\n`);
      continue;
    }
    systemctl(["enable", "--now", started]);
    out(`enabled --now ${started}\n`);
  }
  return units;
}

/**
 * The window end the installer must NOT undo (#3484): the same reading `windowEndNotes` calls `EXPECTED DISABLED`, so the checker and the
 * installer cannot disagree about one unit. Only a timer systemd reports `disabled` WITH a `stop` row is declined: a timer disabled with no
 * record, or one whose stop a later marker superseded, is somebody's deliberate stop or a re-armed window and keeps `enable --now`, and an
 * enabled one is enabled again as before (idempotent, and what restarts one that is enabled but dead -- #1858).
 * @param {string} unit @param {Parameters<typeof unitState>[1]} deps @returns {WindowEnd | null}
 */
function windowEndedOnPurpose(unit: string, deps: Parameters<typeof unitState>[1]): WindowEnd | null {
  const state = unitState(unit, deps);
  return endedOnPurpose(state) ? state.windowEnded ?? null : null;
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
  read = readFileSync, exists = existsSync }: { settingsPath?: string; read?: typeof readFileSync; exists?: typeof existsSync; } = {}): Finding[] {
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
      detail: `could not be parsed (${(cause as Error).message}), so the permission posture `
        + "is UNKNOWN rather than wrong. Fix the JSON first." }];
  }
  if (mode === "bypassPermissions") return [];
  return [{ unit: name, problem: "ORG IS IN AUTO MODE",
    detail: `permissions.defaultMode is ${mode === null ? "unset" : `\`${mode}\``}. Sessions cannot act `
      + "on shared resources and cannot ask either (AskUserQuestion is removed by agentArgs, #1744), so "
      + `they stop mid-task with no signal. ${remedy}` }];
}

/**
 * THE EFFORT SETTING THAT GOES WITH A MODEL IS HOST STATE TOO (#2783). `modelSettings.<model id>.effortLevel` in
 * `~/.claude/settings.json` is keyed by the exact model id, so moving the org to a new model drops every session to that
 * model's default effort until somebody adds the entry -- and nothing in the repository recorded that anybody had.
 * Checked against `DECLARED_CLAUDE_MODELS`: a declared model whose entry is missing, unrecognised or LOWER is a finding;
 * higher is not (nobody is hurt by more effort than the org asked for).
 *
 * CHECKS AND CANNOT FIX, for `permissionModeDrift`'s reason: the file is outside the repository. An absent or
 * unparseable file is `permissionModeDrift`'s finding and is not repeated here -- it already says the posture is
 * unknown, and a second copy would only send a reader to the same file twice.
 * @param {{ settingsPath?: string, read?: typeof readFileSync, exists?: typeof existsSync,
 *   declared?: Record<string, { id: string, effortLevel: string }> }} [deps]
 * @returns {Finding[]}
 */
export function modelEffortDrift({ settingsPath = `${process.env.HOME ?? ""}/.claude/settings.json`,
  read = readFileSync, exists = existsSync, declared = DECLARED_CLAUDE_MODELS }: {
        settingsPath?: string; read?: typeof readFileSync; exists?: typeof existsSync;
        declared?: Record<string, { id: string; effortLevel: string; }>;
    } = {}): Finding[] {
  if (!exists(settingsPath)) return [];
  let entries;
  try {
    entries = JSON.parse(String(read(settingsPath)))?.modelSettings ?? {};
  } catch {
    return [];
  }
  const rank = (level: unknown) => CLAUDE_EFFORTS.indexOf((level as never));
  return Object.entries(declared).flatMap(([alias, { id, effortLevel }]) => {
    const has = entries?.[id]?.effortLevel;
    if (rank(has) >= rank(effortLevel)) return [];
    const found = has === undefined ? "has no entry" : `is ${JSON.stringify(has)}`;
    return [{ unit: "~/.claude/settings.json", problem: `EFFORT NOT SET FOR ${id}`,
      detail: `modelSettings.${id}.effortLevel ${found}, and the org declares \`${effortLevel}\` for \`${alias}\` `
        + "(worker-profile.ts `DECLARED_CLAUDE_MODELS`), so sessions on it run at the model's default effort. "
        + `Add \`"modelSettings": { "${id}": { "effortLevel": "${effortLevel}" } }\` by hand: this check cannot fix a `
        + "file outside the repository." }];
  });
}

/**
 * The labels of the row a worker is named for, or `null` when GitHub would not say. `gh api` spends the REST pool and not GraphQL's, which
 * the gate's every-tick reads already strain (#4148).
 * @param {number} row @returns {string[] | null}
 */
function readRowLabels(row: number): string[] | null {
  try {
    const out = execFileSync("gh", ["api", `repos/${REPO}/issues/${row}`, "--jq", "[.labels[].name]"], { encoding: "utf8", timeout: 30_000 });
    return JSON.parse(out);
  } catch {
    return null;  // unreadable is not "unlabelled": the caller does not take a tier from it, and judges the worker as any other
  }
}

/**
 * The keys of the trackers beyond the first that the project declares, or `[]` when the declaration could not be read: an unreadable declaration
 * is "no key is known", so a keyed name is judged against the org's models alone, which fails toward the finding. Read lazily and on a keyed name only.
 * @returns {readonly string[]}
 */
function readTrackerKeys(): readonly string[] {
  try {
    return homeProjectDeclaration().tracker.map((tracker) => tracker.key).filter((key) => key !== "");
  } catch {
    return [];
  }
}

/**
 * The (tracker key, row) an engineer instance is named for, or `null` when the name is none: `worker-<n>` for the first tracker's row (key `""`) and
 * `worker-<key>-<n>` for a declared tracker's, the grammar `row-claim`'s `claimNames` writes. A key is never one that ends in `-<digits>`, so a name
 * cannot parse two ways, and a key no tracker declares (`worker-capture-2407`) names no worker's row.
 * @param {string} name @param {() => readonly string[]} trackerKeys
 * @returns {{ key: string, number: number } | null}
 */
function workerInstance(name: string, trackerKeys: () => readonly string[]): { key: string; number: number } | null {
  const found = /^worker-(?:([a-z0-9-]+)-)?([1-9][0-9]*)$/.exec(name);
  if (found === null) return null;
  const key = found[1] ?? "";
  if (key !== "" && (/-[0-9]+$/.test(key) || !trackerKeys().includes(key))) return null;
  return { key, number: Number(found[2]) };
}

/**
 * The `model` each persistent seat's roster entry DECLARES (#4740), by seat name, or `null` when the roster would not be read. A seat that declares
 * none is absent from the table, and a malformed one is too: the launcher refuses it (`SEAT NOT STARTED`) and says so itself.
 * @returns {Record<string, string> | null}
 */
function readSeatModels(): Record<string, string> | null {
  try {
    return Object.fromEntries(persistentEntries().flatMap(({ name, model, refusal }) => model === undefined || refusal !== undefined ? [] : [[name, model]]));
  } catch {
    return null;  // unreadable is not "declares nothing": the caller judges the seat against the org's models as before, and `persistentSeatNotes` names the roster
  }
}

/**
 * The model id a roster `model` stands for, or `null` when this file knows no id for it. The launcher passes the value to `--model` UNCHANGED
 * (`seatStartFlags`, wake.ts) and the `claude` CLI resolves it, so what can be resolved here is what the org itself names: a full id as written,
 * `haiku` as `HAIKU_MODEL_ID`, and the aliases `declared` is keyed by. A context suffix (`opus[1m]`) names a window, not a model, so it is dropped before comparing (not checked against a live transcript).
 * @param {string} model @param {Record<string, { id: string }>} declared
 * @returns {string | null}
 */
function declaredModelId(model: string, declared: Record<string, { id: string }>): string | null {
  const base = model.replace(/\[[^\]]*\]$/, "");
  if (base.includes("-")) return base;  // a full id, as `profileFor` reads one
  if (base === "haiku") return HAIKU_MODEL_ID;
  return declared[base]?.id ?? null;
}

type ExpectedModels =
  | { ids: string[]; source: "org" }
  | { ids: string[]; source: "worker" }
  | { ids: string[]; source: "tier"; row: number }
  | { ids: string[]; source: "roster"; declaredAs: string };

/**
 * THE MODEL A SESSION IS EXPECTED TO RUN. Four things decide it, the most specific first:
 *
 * - **Its roster entry (#4762).** A persistent seat whose entry declares a `model` is expected on THAT model alone (#4740: a11ign#4760 declared the
 *   liaison on Haiku, and judging it against Sonnet called the declared state drift, with a remedy that would have undone the declaration). A declared
 *   alias this file cannot resolve ({@link declaredModelId}) yields `null`: nothing to judge it against, so not a finding -- the other answer is a guess.
 * - **Its row's tier (#4457).** A `tier:haiku` row gets a `claude-haiku-5-5` worker BY DESIGN (`HAIKU_TIER_LABEL`), so judging that worker against
 *   Sonnet alone called the intended state drift, and its remedy (`/model sonnet`) would have undone the saving the tier is for. A worker is named
 *   for its row, so the row's labels decide.
 * - **Its start (agent-org#795).** An engineer instance (`worker-<n>`, or `worker-<key>-<n>` for another tracker's row) is STARTED by the gate on a profile the router
 *   chose (`routeOnly`, `engineer-route.ts`): Sonnet (the org's declared model) or `HAIKU_MODEL_ID`, and a routed row carries no label saying which. So it is
 *   expected on the org's models OR Haiku. That is for engineer instances ONLY: a standing seat on Haiku is still the resumed-session drift this finding
 *   exists for (#2783), and the roster entry above is how a seat declares Haiku. A keyed worker's row is another tracker's, which `readRowLabels` cannot read
 *   (it would read the first tracker's row of that number), so it takes no tier from a label. A name that is not one of these is judged below.
 * - **The org's declared models.** Every other session, a seat declaring nothing.
 * @param {string} name @param {SessionModelDeps} deps @param {Record<string, string> | null} seatModels {@link readSeatModels}, read once per check
 * @returns {ExpectedModels | null}
 */
function expectedModels(name: string, { declared = DECLARED_CLAUDE_MODELS, rowLabels = readRowLabels, trackerKeys = readTrackerKeys }: SessionModelDeps, seatModels: Readonly<Record<string, string>> | null): ExpectedModels | null {
  const seatModel = seatModels?.[name];
  if (seatModel !== undefined) {
    const id = declaredModelId(seatModel, declared);
    return id === null ? null : { ids: [id], source: "roster", declaredAs: seatModel };
  }
  const orgIds = Object.values(declared).map((m) => m.id);
  const worker = workerInstance(name, trackerKeys);
  if (worker === null) return { ids: orgIds, source: "org" };
  if (worker.key === "" && rowLabels(worker.number)?.includes(HAIKU_TIER_LABEL)) return { ids: [HAIKU_MODEL_ID], source: "tier", row: worker.number };
  return { ids: [...orgIds, HAIKU_MODEL_ID], source: "worker" };
}

/** What the finding says about where the expectation came from and what, if anything, the reader can do. */
function modelDriftDetail(model: string, expected: ExpectedModels): string {
  const ids = expected.ids.map((i) => `\`${i}\``).join(", ");
  const found = `its last answer came from \`${model}\``;
  switch (expected.source) {
    case "roster":
      return `${found}; its roster entry declares \`${expected.declaredAs}\`${expected.declaredAs === expected.ids[0] ? "" : ` (${ids})`}. A resumed session keeps its saved model, not the roster's. `
        + `Run \`/model ${expected.declaredAs}\` in that session: this check reads and cannot switch it.`;
    case "tier":
      return `${found}; row #${expected.row} carries \`${HAIKU_TIER_LABEL}\`, so the tier expects ${ids}. The tier was not applied to this worker; this check reads and cannot switch it.`;
    case "worker":
      return `${found}; the org declares ${expected.ids.filter((id) => id !== HAIKU_MODEL_ID).map((i) => `\`${i}\``).join(", ")}, and a worker may also be on \`${HAIKU_MODEL_ID}\` when the router chose it at its start. `
        + "A resumed session keeps its saved model, not settings.json's. Run `/model <alias>` in that session: this check reads and cannot switch it.";
    default:
      return `${found}; the org declares ${ids}. A resumed session keeps its saved model, not settings.json's. Run \`/model <alias>\` in that session: this check reads and cannot switch it.`;
  }
}

/** @param {SessionModelDeps} [deps] @returns {Finding[]} */
export function sessionModelDrift(deps: SessionModelDeps = {}): Finding[] {
  const sessions = readSessionModels(deps);
  const seatModels = sessions.length === 0 ? null : (deps.seatModels ?? readSeatModels)();
  return sessions.flatMap(({ name, model }) => {
    const expected = expectedModels(name, deps, seatModels);
    if (model === null || expected === null || expected.ids.includes(model)) return [];
    return [{ unit: `session ${name}`, problem: "SESSION ON AN UNDECLARED MODEL", detail: modelDriftDetail(model, expected) }];
  });
}

/** @param {SeatDeps} [deps] @returns {Finding[]} */
export function persistentSeatDrift(deps: SeatDeps = {}): Finding[] {
  const { seats, agents } = readSeats(deps);
  if (seats === null || agents === null) return [];
  return absentSeats(seats, agents).map((seat) => ({
    unit: `seat ${seat}`, problem: "PERSISTENT SEAT NOT RUNNING", seatAbsent: true,
    detail: `the roster marks \`${seat}\` persistent and herdr lists no workspace labelled \`${seat}\`, so whatever is routed to it is refused. `
      + "The work tick starts it on its next run; if it is still absent after one, that tick's `SEAT NOT STARTED` line says why." }));
}

/**
 * NOT ASKED and ALL CORRECT read identically as an empty list, so the report must not say the second
 * when it means the first -- that substitution is this repository's most-repeated defect.
 * @param {Finding[]} drift

 * @param {Finding[]} [notes] what is reported and is NOT a failure (#2332): they never enter the count, the
 *   exit code or the remedy line, and are printed even when nothing else drifted.
 */
/** The report for a machine that systemd could not be asked about: it says so, and claims nothing about any host. */
export function hostUnitsNotChecked(): string {
  return "host units: NOT CHECKED -- this machine runs no systemd user manager, so it is not an "
    + "agent host. That is not a claim that any host is correct.\n";
}

export function driftReport(drift: Finding[], notes: Finding[] = []) {
  const noted = notes.length === 0 ? "" : "notes (not failures):\n"
    + notes.map((d) => `  ${d.unit}: ${d.problem}\n    ${d.detail}\n`).join("");
  if (drift.length === 0) {
    return `host units: every shipped unit is installed, current and running, the gh identity files match, and the reviewer door is CURRENT.\n${noted}`;
  }
  return `host units: ${drift.length} problem(s).\n`
    + drift.map((d) => `  ${d.unit}: ${d.problem}\n    ${d.detail}\n`).join("")
    + remedy(drift) + noted;
}

/**
 * `--json`: the SAME findings the report is built from, as data -- #2174's seam for `work-gate.ts`.
 *
 * THE GATE SPAWNS THIS RATHER THAN IMPORTING IT, and the reason is measured rather than stylistic. A
 * direct `import { hostUnitDrift }` in `work-gate.ts` costs nothing at load -- +1 file on a closure of
 * 21, 39.3ms against 39.4ms -- but it drags this file's `git log --all` (`addedOnSomeRef`) into the
 * gate's CAPABILITY closure, and the gate is imported by `row-claim/runner-rule.ts`, which most of the
 * packaging suite reaches. MEASURED with `deriveClosureRequirements` over
 * `packages/lab/src/packaging/*.test.ts`: the files deriving a `history` requirement go from **4 to 28**.
 * That is a standing `History: full` tax on 24 test files that will never call this code, levied on
 * whoever next writes a PR whose Acceptance happens to name one of them.
 *
 * A PROCESS BOUNDARY IS THE CHEAPER FENCE. It costs one node startup per tick and leaves the gate's
 * closure at 4. And it buys a property an import cannot: THE GATE AND THE HUMAN READ THE SAME
 * INSTRUMENT. The woken session runs `pnpm run host:check`; the gate runs the same file in the same tree,
 * so the two can never disagree about what drifted -- which is the failure mode a second reader of the
 * same question always eventually produces (`regionRefusalReason`'s header records one that disagreed in
 * BOTH directions).
 *
 * `asked` IS CARRIED, because `findings: []` alone cannot say whether this is a correct host or a
 * machine that was never askable, and that substitution is this file's most-repeated warning.
 */
function jsonReport() {
  const asked = systemdUserAvailable();
  // THE TICK'S TWO TURNS AT agent-org#790, in this order and BEFORE the findings are read: the wrapper is re-rendered first, so a switch that merged this minute is not reported
  // DIVERGED by the process that just fixed it, and the detector asks about what the re-render could not mend. Both only on a host with a user systemd, which is an agent host.
  const rerendered = asked ? tickRerenderGhWrapper() : [];
  if (asked) tickAppRoleSilent();
  // `notes` ARE NOT `findings`: the gate wakes a session on any finding, and a global `user.name` is not
  // something to wake anybody for (#2332).
  return `${JSON.stringify({ asked, findings: asked ? hostFindings() : [],
    notes: asked ? [...rerendered, ...hostNotes()] : [] })}\n`;
}

/**
 * `hostUnitDrift` PLUS THE LIVE SESSIONS' MODELS (#2783), asked of herdr. It is here and not inside `hostUnitDrift` because
 * that function is pure of the running org -- twenty tests hand it a fixture host -- while this one reads whoever is running.
 */
function hostFindings() {
  return [...hostUnitDrift(), ...sessionModelDrift(), ...persistentSeatDrift(), ...kernelFindings()];
}

function main() {
  refuseUnknownFlags(["--install", "--json", "--allow-no-apps"], { entry: import.meta.url, command: "pnpm run host:check" });
  if (process.argv.slice(2).includes("--json")) {
    process.stdout.write(jsonReport());
    return;
  }
  const asked = systemdUserAvailable();
  if (process.argv.slice(2).includes("--install")) {
    hostUnitsInstall();
    hostIdentityInstall({ allowNoApps: process.argv.slice(2).includes("--allow-no-apps") });
    reviewerDoorInstall();
    rowReviewSkillInstall();
    const findings = hostFindings();
    process.stdout.write(asked ? driftReport(findings, hostNotes()) : hostUnitsNotChecked());
    return;
  }
  const versions = readToolVersionAgreement();
  const drift = [...hostFindings(), ...toolVersionFindings(versions)];
  process.stdout.write(projectUnitsLine(projectUnitsDirOf()) + (asked ? driftReport(drift, [...hostNotes(), ...toolVersionNotes(versions)]) : hostUnitsNotChecked()));
  if (drift.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();

// The door the gate posts through is the door the host installs: one definition, re-exported here (#1311).
export { reviewerDoorPath };
