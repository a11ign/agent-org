import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, chmodSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppIdentity } from "../app-token.ts";
import { reviewerDoorPath } from "../reviewer-door-path.ts";
import { agreementReport } from "../lib/tool-version-agreement.ts";
import { appRoleSilent, appRoleSilentEvents, type LedgerSource, type MintFailure, type SilentRole } from "../app-role-silent.ts";
import { FAILURE_LEDGER_FILE, recordFailures } from "../failure-ledger.ts";
import { readAgents, herdrRun } from "../herdr-agents.ts";
import { persistentRoles } from "../project-roles.ts";
import { kernelNotes } from "../host-kernel.ts";
import { GITHUB_ROLES, type GithubRole, HostConfigRefusal, homeHostConfig, roleIdentity, stateEntryPath } from "../host-config.ts";
import { compileCacheNotes, endedOnPurpose, ghWrapperFile, hostIdentityNotes, ownedIdentityFiles, readToolVersionAgreement, seatWrapperNotes, type Finding, unitState } from "./host-identity-drift.ts";
import { shippedUnitNames, textOf, type HostConfig } from "./shipped-units.ts";

/** The reading when no runner is behind: reported, never a failure, and never silent (an unreadable runner is named). @param {ReturnType<typeof readToolVersionAgreement>} reading @returns {Finding[]} */
export function toolVersionNotes(reading: ReturnType<typeof readToolVersionAgreement>): Finding[] {
  if (reading === null || reading.result.signals.length > 0) return [];
  return [{ unit: "agent-org versions", problem: "READING", detail: agreementReport(reading.result, reading.now) }];
}

/** Every note `host:check` reports beside its findings; none of them is a failure. @returns {Finding[]} */
export function hostNotes(): Finding[] {
  return [...hostIdentityNotes(), ...compileCacheNotes(), ...seatWrapperNotes(), ...sessionModelNotes(), ...persistentSeatNotes(), ...windowEndNotes(), ...kernelNotes()];
}

/**
 * WHY A DISABLED TIMER IS QUIET (#2971): `unitDrift` says nothing about it, and silence would read the same as a timer nobody looked at.
 * @param {Parameters<typeof unitState>[1]} [deps] @returns {Finding[]}
 */
export function windowEndNotes(deps: Parameters<typeof unitState>[1] = {}): Finding[] {
  return shippedUnitNames(deps).filter((unit) => unit.endsWith(".timer")).map((unit) => unitState(unit, deps))
    .filter(endedOnPurpose).map((s) => ({ unit: s.unit, problem: "EXPECTED DISABLED -- ITS WINDOW ENDED",
      detail: `its window record holds a \`stop\` row (${s.windowEnded?.cause}, ${s.windowEnded?.ticks} ticks, ${s.windowEnded?.at}) `
        + "and no marker newer than it, so `disabled` is where it was meant to end. Not a failure: `host:install` skips it "
        + "(`SKIPPED -- its window ended`), and it is armed again by `shadow-window.ts --arm`, after which this note goes and `NOT ENABLED` returns if it is still off." }));
}

/**
 * Write every owned identity file, each ATOMICALLY (a temp file in the same directory, then a rename): `gh`
 * is executed by every agent, so a half-written copy is a broken `gh` for the whole org for as long as the
 * write takes. IDEMPOTENT, like `hostUnitsInstall`. Refuses rather than writing an unreadable source, and refuses the `gh` wrapper that
 * `writeGhWrapper` refuses (A11-84), unless `allowNoApps` says the host really dropped its Apps.
 * @param {Parameters<typeof ownedIdentityFiles>[0] & { mkdir?: typeof mkdirSync, write?: typeof writeFileSync,
 *           chmod?: typeof chmodSync, rename?: typeof renameSync, out?: (line: string) => void, allowNoApps?: boolean }} [deps]
 * @returns {string[]} the paths it wrote
 */
export function hostIdentityInstall({ mkdir = mkdirSync, write = writeFileSync, chmod = chmodSync,
  rename = renameSync, out = (l) => process.stdout.write(l), allowNoApps = false, ...where }: Parameters<typeof ownedIdentityFiles>[0] & {
        mkdir?: typeof mkdirSync; write?: typeof writeFileSync;
        chmod?: typeof chmodSync; rename?: typeof renameSync; out?: (line: string) => void; allowNoApps?: boolean;
    } = {}): string[] {
  const gh = ghWrapperFile(where).target;
  return ownedIdentityFiles(where).map(({ label, target, mode, expected }) => {
    if (expected === null) throw new Error(`cannot install ${label}: the shipped copy could not be read`);
    if (target === gh) writeGhWrapper({ target, mode, text: expected, host: where.host ?? homeHostConfig(), allowNoApps, mkdir, write, chmod, rename, read: where.read });
    else writeOwnedFile({ target, mode, text: expected, mkdir, write, chmod, rename });
    out(`installed ${target}\n`);
    return target;
  });
}

/** One file, ATOMICALLY: a temp file in the same directory, then a rename. `hostIdentityInstall` and `rerenderGhWrapper` write through this one, so there is one definition of "installed". */
export function writeOwnedFile({ target, mode, text, mkdir, write, chmod, rename }: { target: string; mode: number; text: string;
    mkdir: typeof mkdirSync; write: typeof writeFileSync; chmod: typeof chmodSync; rename: typeof renameSync; }): void {
  mkdir(dirname(target), { recursive: true });
  const temp = `${target}.installing`;
  write(temp, text);
  chmod(temp, mode);
  rename(temp, target);
}

// --- A11-84: THE ROUTING WRAPPER HAS ONE WRITER, AND THAT WRITER REFUSES A WRAPPER THAT NAMES NO APP -------------------------------------------
//
// INCIDENT 2026-10-17: from 19:39Z to 20:59Z `~/.local/bin/gh` held a rendering whose App role table was empty, so no App token was minted for any role and every
// call went out as the account or unauthenticated (agent-org#1738's two verdicts did not post). The rendering came from a host declaration that named no App, and the
// tick wrote it over a wrapper that named four, because `rerenderGhWrapper` rewrites any identity block that differs. So every path that puts this file on the host
// goes through `writeGhWrapper`, which refuses, writes nothing and says why, when the text it would write holds no App while the host declares one, when it would
// drop the Apps the installed copy names (unless `host:install --allow-no-apps` says the host really dropped them), or when it runs its minter from a temporary
// directory, which is a scratch checkout's. A test run may not write the real home's bin directory at all (`AGENT_ORG_UNDER_TEST`, set by the rstest config).

/** The Apps a host declares, as the roles `GITHUB_ROLES` names that are `github-apps`. */
function appRolesOf(host: Readonly<HostConfig>): GithubRole[] {
  return GITHUB_ROLES.filter((role) => roleIdentity(host, role).mode === "github-apps");
}

/** The default of `APP_ROLES` in a rendered wrapper, the one place a role table is written as a list. */
const WRAPPER_ROLE_DEFAULT = /^APP_ROLES=\$\{A11Y_APP_ROLES-([^}\n]*)\}$/m;
/** An arm of `app_declared()`: one role, one app. A table with no arm mints nothing, whatever `APP_ROLES` says. */
const WRAPPER_APP_ARM = /^ {4}[a-z]+\) app_id=/gm;
/** The minter's path, as the rendered wrapper names it: the one default the mint reads. */
const WRAPPER_MINT_SCRIPT = /^  app_script=\$\{A11Y_APP_TOKEN_SCRIPT:-([^}\n]+)\}$/m;
/** The defaults of the two scripts a rendered wrapper RUNS: the App minter and the authoring switch's flag script (`${TMPDIR:-/tmp}` is a scratch file, not a script). */
const WRAPPER_SCRIPT_DEFAULTS = /\$\{(?:A11Y_APP_TOKEN_SCRIPT|A11Y_GH_FLAG_SCRIPT):-([^}\n]+)\}/g;

/**
 * The roles a rendered or installed wrapper routes to an App: `[]` for an empty table, and `null` for text with no role table at all (a copy from before #4900).
 * @param {string} text @returns {string[] | null}
 */
export function wrapperRoles(text: string): string[] | null {
  const roles = WRAPPER_ROLE_DEFAULT.exec(text)?.[1];
  if (roles === undefined) return null;
  return [...text.matchAll(WRAPPER_APP_ARM)].length === 0 ? [] : roles.split(" ").filter((role) => role !== "");
}

/**
 * The first path a rendered wrapper defaults into `/tmp`, or `null`: the scratch-checkout wrapper the incident's copy was (`/tmp/claude-1000/...`). It is the system
 * `/tmp` and not `os.tmpdir()`, because a test run's own temporary directory is a fixture's, and every such fixture renders from one.
 */
function temporaryDefault(text: string): string | null {
  const temp = resolve("/tmp");
  for (const [, value] of text.matchAll(WRAPPER_SCRIPT_DEFAULTS)) {
    if (value === temp || value.startsWith(`${temp}/`)) return value;
  }
  return null;
}

/** The real home's `.local/bin`, found by the account's home and NOT by `$HOME`, which a test overrides (the incident's `binDir` came in through a copied host file). */
const realBinDirectory = () => join(userInfo().homedir, ".local", "bin");

/**
 * THE ONE WRITER OF `gh`: write the routing wrapper `text` to `target`, ATOMICALLY, or refuse and write nothing. Refuses, each with its reason, when
 *   1. the text names no App while `host` declares `github-apps` roles (the render is broken, or the declaration is not the host's);
 *   2. the text names no App and the installed copy names some, unless `allowNoApps` (the downgrade: the incident's case, which `host:install --allow-no-apps` takes);
 *   3. (production, not a test run) the text runs its minter from a temporary directory;
 *   4. `under` (a test run) and the target is inside the real home's bin directory.
 * A refusal is a `HostConfigRefusal` and never a partial write. The tick turns it into a note, and the instance's start-up and `doctor` say it.
 * @param {{ target: string, mode: number, text: string, host: Readonly<HostConfig>, allowNoApps?: boolean, under?: boolean, realBin?: string,
 *           mkdir?: typeof mkdirSync, write?: typeof writeFileSync, chmod?: typeof chmodSync, rename?: typeof renameSync, read?: typeof readFileSync }} request
 */
export function writeGhWrapper({ target, mode, text, host, allowNoApps = false, under = process.env.AGENT_ORG_UNDER_TEST === "1", realBin = realBinDirectory(),
  mkdir = mkdirSync, write = writeFileSync, chmod = chmodSync, rename = renameSync, read = readFileSync }: {
    target: string; mode: number; text: string; host: Readonly<HostConfig>; allowNoApps?: boolean; under?: boolean; realBin?: string;
    mkdir?: typeof mkdirSync; write?: typeof writeFileSync; chmod?: typeof chmodSync; rename?: typeof renameSync; read?: typeof readFileSync;
  }): void {
  const refuse = (why: string): never => {
    throw new HostConfigRefusal("gh", `${why}, so ${target} is not written`, target);
  };
  const inside = relative(resolve(realBin), resolve(target));
  if (under && inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
    refuse("a test run may not write the real home's bin directory: a test takes its bin directory from a fixture");
  }
  // Production only: a test run's fixtures are checkouts in the runner's own temporary directory, so under a test run the real-bin tripwire above is the guard,
  // and it refuses the one write that matters (the machine's own wrapper).
  const scratch = temporaryDefault(text);
  if (!under && scratch !== null) refuse(`the wrapper runs ${scratch}, which is in a temporary directory, so it was rendered from a scratch checkout`);
  const rendered = wrapperRoles(text) ?? refuse("the rendered text has no App role table to check");
  const declared = appRolesOf(host);
  if (rendered.length === 0 && declared.length > 0) {
    refuse(`host.json declares github-apps roles (${declared.join(", ")}), but the rendered wrapper names none`);
  }
  if (rendered.length === 0 && !allowNoApps) {
    const installed = textOf(target, read);
    const named = installed === null ? [] : wrapperRoles(installed) ?? [];
    if (named.length > 0) {
      refuse(`the rendered wrapper names no App role and the installed one names ${named.join(", ")}: that drops their identity. `
        + "`host:install --allow-no-apps` writes it, for a host that really dropped its Apps");
    }
  }
  writeOwnedFile({ target, mode, text, mkdir, write, chmod, rename });
}

/**
 * What is wrong with the installed `gh` wrapper, said as a reason, or `null` when it is the one `host.json` declares: no file, a file that is not the shipped
 * rendering of the declaration, or a table that names no App while the host declares one. The reason says which, so `doctor` and the start-up can name the fix.
 * @param {Parameters<typeof ownedIdentityFiles>[0] & { read?: typeof readFileSync }} [deps] @returns {string | null}
 */
export function ghWrapperDivergence(deps: Parameters<typeof ownedIdentityFiles>[0] & { read?: typeof readFileSync } = {}): string | null {
  const host = deps.host ?? homeHostConfig();
  const { read = readFileSync } = deps;
  const { target, expected } = ghWrapperFile({ ...deps, host });
  if (expected === null) return "the repository's gh wrapper could not be read, so this host cannot be compared to it";
  const installed = textOf(target, read);
  if (installed === null) return `there is no gh wrapper at ${target}`;
  if (installed === expected) return null;
  const declared = appRolesOf(host);
  const named = wrapperRoles(installed) ?? [];
  if (named.length === 0 && declared.length > 0) {
    return `${target} names no App role, but host.json declares ${declared.join(", ")}, so no App token is minted for any of them`;
  }
  return wrapperIdentity(installed) === wrapperIdentity(expected)
    ? `${target} is not the wrapper this repository renders from host.json, though its App roles agree`
    : `${target} names ${named.join(", ") || "no App"}, and host.json declares ${declared.join(", ") || "no App"}`;
}

/** What `mintFailure` runs: the wrapper's minter with the declared app and a token directory of its own, and what it printed. */
export type MintRun = (script: string, role: string, env: Record<string, string>) => { status: number | null; stdout: string; stderr: string };

/** The default `MintRun`: `node` runs the minter, as `host/gh` runs it, with no stdin, so the probe never reads a caller's. */
const runMinter: MintRun = (script, role, env) => {
  const result = spawnSync(process.env.A11Y_APP_NODE ?? "node", [script, role], { encoding: "utf8", timeout: 30_000, input: "", env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr || (result.error?.message ?? "") };
};

/**
 * Why `role`'s token mint fails, or `null` when it mints (or the host declares no App for it). It runs the minter the INSTALLED wrapper would run, with the declared
 * app, into a token directory of its own, so the probe never reads or writes the cache the wrapper reads.
 * @param {GithubRole} role @param {{ host?: Readonly<HostConfig>, run?: MintRun }} [deps] @returns {string | null}
 */
export function mintFailure(role: GithubRole, { host = homeHostConfig(), run = runMinter }: { host?: Readonly<HostConfig>; run?: MintRun } = {}): string | null {
  const identity = roleIdentity(host, role);
  if (identity.mode !== "github-apps") return null;
  const script = WRAPPER_MINT_SCRIPT.exec(ghWrapperFile({ host }).expected ?? "")?.[1];
  if (script === undefined) return "the wrapper names no minter, so no App token can be minted";
  const dir = mkdtempSync(join(tmpdir(), "gh-mint-probe-"));
  try {
    const result = run(script, role, { A11Y_APP_ID: identity.appId, A11Y_APP_KEY_PATH: identity.keyPath,
      A11Y_APP_INSTALLATION_ID: identity.installationId ?? "", A11Y_APP_TOKEN_DIR: dir });
    const token = result.stdout.trim();
    if (result.status === 0 && token !== "" && !/\s/.test(token)) return null;
    return result.stderr.split("\n").find((line) => line.trim() !== "") ?? `the minter exited ${result.status}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * THE DETECTOR, as `doctor` and the instance's start-up read it: the installed wrapper's divergence and each declared role's mint. A host file that cannot be read
 * throws, which the caller says as "cannot be checked".
 * @param {Parameters<typeof ghWrapperDivergence>[0] & { run?: MintRun }} [deps]
 * @returns {{ divergence: string | null, mints: { role: string, failure: string | null }[] }}
 */
export function ghWrapperReport(deps: Parameters<typeof ghWrapperDivergence>[0] & { run?: MintRun } = {}) {
  const host = deps.host ?? homeHostConfig();
  return {
    divergence: ghWrapperDivergence({ ...deps, host }),
    mints: appRolesOf(host).map((role) => ({ role, failure: mintFailure(role, { host, run: deps.run }) })),
  };
}

/**
 * THE INSTANCE'S START-UP (A11-84): the detector's reading, LOUDLY (an `ERROR` line), then a re-render of the whole wrapper through `writeGhWrapper` when it has
 * diverged, logged as a re-render. A refused re-render is logged and returned, and the instance stays up: it must never run silent, and it need not die for it.
 * Every declared role whose mint fails is logged with its reason, on every start.
 * @param {Parameters<typeof ghWrapperReport>[0] & { err?: (line: string) => void }} [deps]
 * @returns {{ divergence: string | null, rerendered: string | null, refused: string | null, mints: { role: string, failure: string | null }[] }}
 */
export function startupGhWrapper({ err = (l) => process.stderr.write(l), ...deps }: Parameters<typeof ghWrapperReport>[0] & { err?: (line: string) => void } = {}) {
  const host = deps.host ?? homeHostConfig();
  const divergence = ghWrapperDivergence({ ...deps, host });
  let rerendered: string | null = null;
  let refused: string | null = null;
  if (divergence !== null) {
    err(`ERROR gh wrapper: ${divergence}\n`);
    const { target, mode, expected } = ghWrapperFile({ ...deps, host });
    // A start never CREATES the wrapper: a missing file is what `host:install` is for, as the tick has always said (`rerenderGhWrapper`).
    if (textOf(target, deps.read ?? readFileSync) === null) {
      refused = `there is no wrapper at ${target}, and a start does not create the file every agent's PATH resolves`;
    } else {
      try {
        if (expected === null) throw new Error("the shipped copy could not be read");
        writeGhWrapper({ target, mode, text: expected, host, read: deps.read });
        rerendered = target;
        err(`re-rendered ${target} from host.json: ${divergence}\n`);
      } catch (cause) {
        refused = String((cause as Error)?.message ?? cause).split("\n")[0];
      }
    }
    if (refused !== null) err(`ERROR gh wrapper NOT re-rendered: ${refused}. The instance starts anyway, and no App token is minted until \`agent-org host:install\` is run.\n`);
  }
  const mints = appRolesOf(host).map((role) => ({ role, failure: mintFailure(role, { host, run: deps.run }) }));
  for (const { role, failure } of mints) {
    if (failure !== null) err(`ERROR app role ${role}: its token mint failed: ${failure}\n`);
  }
  return { divergence, rerendered, refused, mints };
}

// --- agent-org#790: A MERGED `github.identity` SWITCH TAKES EFFECT ON THE NEXT TICK, NOT WHEN SOMEBODY REMEMBERS `host:install` ---------------
//
// MEASURED 2026-10-10 (a11ign#4906): the switch merged at 22:18:30Z; the installed wrapper had been rendered at 22:05Z, so `app_declared()` was empty and every call kept
// going to the shared account until a session re-ran `host:install` at 22:20Z. `host:check` said `gh: DIVERGED` the whole time and nothing reads it after a merge. A declared
// app role that is not in effect is the one drift whose cost is silent and immediate (the workers' gate sees through the app's pool or it does not), so it is the one
// drift the tick mends itself, and ONLY that file: the unit files, the other owned files and every service are left alone, so a tick never restarts anything for this.

/** The two places the wrapper carries `github.identity`: the roles line and the `app_declared()` body (`host/gh`, rendered from `appRoles` and `appDeclared`). */
const WRAPPER_APP_ROLES = /^APP_ROLES=.*$/m;
const WRAPPER_APP_DECLARED = /^app_declared\(\) \{\n[\s\S]*?\n\}$/m;

/**
 * The identity a rendered wrapper carries, as the text of those two places, or `null` for a wrapper that has neither (a copy from before #4900). Compared as TEXT so the comparison and the
 * render cannot disagree: both are the one template filled by `appTokenValues`.
 * @param {string} text @returns {string | null}
 */
export function wrapperIdentity(text: string): string | null {
  const roles = WRAPPER_APP_ROLES.exec(text)?.[0];
  const declared = WRAPPER_APP_DECLARED.exec(text)?.[0];
  return roles === undefined || declared === undefined ? null : `${roles}\n${declared}`;
}

/**
 * Re-render `~/.local/bin/gh` when its identity block is not the one `host.json` declares, and say whether it did. The WHOLE wrapper is written, as `host:install` writes it (a half-patched
 * file is a wrapper nobody reviewed), but only when the identity block differs: any other divergence is still `host:check`'s to report and `host:install`'s to fix, so a release
 * that changed an unrelated line of the template does not have every tick racing to write it.
 *
 * NOT WRITTEN, each for its own reason: no wrapper installed (that is `NOT INSTALLED`, and a tick has no business creating the file every agent's PATH resolves); a shipped copy or a
 * template that cannot be rendered (`hostIdentityDrift` says `SHIPPED COPY UNREADABLE`, and an empty `gh` on every PATH is worse than a stale one); a wrapper with no identity block
 * on a host that declares no app (the two behave the same, so there is nothing to take effect).
 * @param {Parameters<typeof ownedIdentityFiles>[0] & { mkdir?: typeof mkdirSync, write?: typeof writeFileSync, chmod?: typeof chmodSync, rename?: typeof renameSync }} [deps]
 * @returns {string | null} the path it wrote, or `null` when it wrote nothing
 */
export function rerenderGhWrapper({ mkdir = mkdirSync, write = writeFileSync, chmod = chmodSync, rename = renameSync, ...where }:
    Parameters<typeof ownedIdentityFiles>[0] & { mkdir?: typeof mkdirSync; write?: typeof writeFileSync; chmod?: typeof chmodSync; rename?: typeof renameSync; } = {}): string | null {
  const { read = readFileSync } = where;
  const { target, mode, expected } = ghWrapperFile(where);
  if (expected === null) return null;
  const installed = textOf(target, read);
  if (installed === null) return null;
  const wanted = wrapperIdentity(expected);
  if (wanted === null) return null;
  const has = wrapperIdentity(installed);
  const host = where.host ?? homeHostConfig();
  if (has === wanted || (has === null && appRolesOf(host).length === 0)) return null;
  // A11-84: a refusal THROWS, and `tickRerenderGhWrapper` says it as a note; the tick never passes `allowNoApps`.
  writeGhWrapper({ target, mode, text: expected, host, mkdir, write, chmod, rename, read });
  return target;
}

/**
 * THE TICK'S TURN AT IT, as `host:check --json` notes: `[]` when nothing was written. A render that REFUSES (a `host.json` the tool cannot read, a template with a placeholder no value
 * fills) is said as a note and never thrown, because the gate reads this process and an exception here would make every tick report the host as unaskable.
 * @param {Parameters<typeof rerenderGhWrapper>[0] & { err?: (line: string) => void }} [deps] @returns {Finding[]}
 */
export function tickRerenderGhWrapper({ err = (l) => process.stderr.write(l), ...deps }: Parameters<typeof rerenderGhWrapper>[0] & { err?: (line: string) => void; } = {}): Finding[] {
  try {
    const target = rerenderGhWrapper(deps);
    if (target === null) return [];
    err(`re-rendered ${target}: its identity block was not the one host.json declares (agent-org#790)\n`);
    return [{ unit: target, problem: "RE-RENDERED -- ITS IDENTITY DID NOT MATCH host.json",
      detail: "the installed `gh` carried a `github.identity` block other than the declared one, so this tick wrote it again from the shipped template (the same render `host:install` does "
        + "for this file) and touched no other file. Not a failure: it is what lets a merged switch take effect without anybody re-running `host:install`." }];
  } catch (cause) {
    err(`could not re-render the gh wrapper: ${String((cause as Error)?.message ?? cause).split("\n")[0]}\n`);
    return [];
  }
}

// --- agent-org#1247: A NEW IDENTITY GOES LIVE ON THE CANARY REPOSITORY FIRST, AND WIDENS ONLY ON A PROOF READING ------------------------------
//
// A `github-apps` role the host declares is installed for the canary repository and no wider until a proof reading says its effect was there. A proof is ONE reading, written
// once and never rewritten: who, repository, PR, reviewDecision before and after the approval, and the time. It counts only when the approval MOVED the PR to APPROVED, by the
// role's own machine identity, on the canary repository. A reading that ends at REVIEW_REQUIRED does not count, and neither does a grant read from a permission field: the
// thing proven is the effect on the PR, not the permission.

/** One reading of a canary's effect. `reviewDecisionBefore` and `reviewDecisionAfter` are the PR's `reviewDecision` either side of the approval. */
export type IdentityProofReading = { who: string; repository: string; pr: number; reviewDecisionBefore: string | null;
  reviewDecisionAfter: string | null; at: string; };

/** Where the readings are kept on this host: one file, a map from role to its readings in the order they were written. */
export function identityProofFile(where: { host?: HostConfig; home?: string; env?: Record<string, string | undefined>; } = {}): string {
  return stateEntryPath("identity-canary-proofs.json", where);
}

/**
 * The readings on record. A file that is missing is an EMPTY record: nothing has been proven. A file that is present and does not parse is a REFUSAL, not an empty
 * record, because writing over it would lose every reading it holds.
 * @param {string} file @param {typeof readFileSync} [read] @returns {Partial<Record<GithubRole, IdentityProofReading[]>>}
 */
export function identityProofs(file: string, read: typeof readFileSync = readFileSync): Partial<Record<GithubRole, IdentityProofReading[]>> {
  const text = textOf(file, read);
  if (text === null) return {};
  const refusal = new HostConfigRefusal("identity-canary-proofs", "the proof file is present and does not parse as a map of role to readings, so it is refused rather than overwritten", file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refusal;
  }
  // A role's value must be an array of readings, and each reading must have the fields it is read by: any other shape is refused here, so nothing downstream reads a value it cannot use.
  const shaped = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.values(parsed).every((readings) => Array.isArray(readings) && readings.every(isIdentityProofReading));
  if (!shaped) throw refusal;
  return parsed as Partial<Record<GithubRole, IdentityProofReading[]>>;
}

/** Whether a parsed value has every field of an `IdentityProofReading`, each of its type. A `null` or a partial object is not a reading. */
function isIdentityProofReading(value: unknown): value is IdentityProofReading {
  if (value === null || typeof value !== "object") return false;
  const reading = value as Record<string, unknown>;
  const decision = (field: unknown) => field === null || typeof field === "string";
  return typeof reading.who === "string" && typeof reading.repository === "string" && typeof reading.pr === "number"
    && decision(reading.reviewDecisionBefore) && decision(reading.reviewDecisionAfter) && typeof reading.at === "string";
}

/**
 * Whether ONE reading proves the identity's effect on the canary: a real PR on the canary repository, `who` the role's own `[bot]` (its slug when the host names one),
 * and a move from not-APPROVED to APPROVED. Anything else is a reading of the record, not a proof.
 * @param {IdentityProofReading} reading @param {{ canary: string, identity: Readonly<AppIdentity> }} where @returns {boolean}
 */
export function countsAsProof(reading: IdentityProofReading, { canary, identity }: { canary: string; identity: Readonly<AppIdentity>; }): boolean {
  const bot = identity.slug === undefined ? /\[bot\]$/i.test(reading.who) : reading.who.toLowerCase() === `${identity.slug}[bot]`.toLowerCase();
  return reading.repository === canary && Number.isInteger(reading.pr) && reading.pr > 0 && bot
    && reading.reviewDecisionBefore !== "APPROVED" && reading.reviewDecisionAfter === "APPROVED";
}

/** Either the role may widen, or it stays on `scope` and `missing` names the proof it lacks. */
export type WideningDecision = { widen: true; } | { widen: false; scope: string; missing: string; };

/**
 * WHETHER A ROLE'S IDENTITY MAY WIDEN, and where it stays until it may. A `user-accounts` role is not a new identity and widens as it always has. A `github-apps` role stays
 * on the canary repository, and widens only when a reading on record for THAT role counts. The refusal names the proof it lacks, so the one who reads it knows what to produce.
 * @param {GithubRole} role @param {{ host: HostConfig, canary: string, file: string, read?: typeof readFileSync }} deps @returns {WideningDecision}
 */
export function widenIdentity(role: GithubRole, { host, canary, file, read = readFileSync }: { host: HostConfig; canary: string; file: string; read?: typeof readFileSync; }): WideningDecision {
  const identity = roleIdentity(host, role);
  if (identity.mode === "user-accounts") return { widen: true };
  const readings = identityProofs(file, read)[role] ?? [];
  if (readings.some((reading) => countsAsProof(reading, { canary, identity }))) return { widen: true };
  const why = readings.length === 0 ? `none is on record in ${file}`
    : `${readings.length} on record in ${file}, and none moved the PR from not-APPROVED to APPROVED by ${identity.slug ?? "the role's app"}[bot] on ${canary}`;
  return { widen: false, scope: canary, missing: `refused: github.identity.${role} stays on ${canary} until a proof reading counts for it; ${why}` };
}

/**
 * Write one reading for a role, ATOMICALLY, as the file's next entry. Written ONCE: the same reading (same PR, time and bot) already on record is refused rather than written
 * again. A reading that does not count is still recorded: it is the record of what happened, and it does not widen anything.
 * @param {GithubRole} role @param {IdentityProofReading} reading
 * @param {{ file: string, read?: typeof readFileSync, mkdir?: typeof mkdirSync, write?: typeof writeFileSync, chmod?: typeof chmodSync, rename?: typeof renameSync }} deps
 * @returns {string} the file written
 */
export function recordIdentityProof(role: GithubRole, reading: IdentityProofReading, { file, read = readFileSync, mkdir = mkdirSync, write = writeFileSync,
  chmod = chmodSync, rename = renameSync }: { file: string; read?: typeof readFileSync; mkdir?: typeof mkdirSync; write?: typeof writeFileSync;
  chmod?: typeof chmodSync; rename?: typeof renameSync; }): string {
  const proofs = identityProofs(file, read);
  const held = proofs[role] ?? [];
  if (held.some((on) => on.pr === reading.pr && on.at === reading.at && on.who === reading.who)) {
    throw new HostConfigRefusal(`github.identity.${role}`, `the reading for PR ${reading.pr} at ${reading.at} is already on record, and a proof is written once`, file);
  }
  const text = `${JSON.stringify({ ...proofs, [role]: [...held, reading] }, null, 2)}\n`;
  writeOwnedFile({ target: file, mode: 0o644, text, mkdir, write, chmod, rename });
  return file;
}

/** The mint's reason as the report names it: the failed mint's time, reason and exit status, or the reading that the ledger holds none (an absence, not a failure). */
const mintReport = (mint: MintFailure | null): string => mint === null ? "no app-token incident in the ledger"
  : `the mint failed at ${mint.at}: ${mint.reason}${mint.exit === null ? "" : ` (exit ${mint.exit})`}`;

/**
 * THE DETECTOR FOR THE CASE WHERE THE RE-RENDER DID NOT TAKE EFFECT (agent-org#790): a role `host.json` declares `github-apps` whose calls, for ten minutes, were none of them as its app
 * (a mint that fails falls back to the shared account by design, so the wrapper works and the app is silently not in use). Reads each account's call ledger, asks `appRoleSilent`, and
 * files each role through `recordFailures`, which skips an episode it already holds: a standing one is one line however many ticks see it. A host that declares no app reads nothing at all.
 *
 * AN UNREADABLE LEDGER IS SAID AND NOT COUNTED: no file is a role that made no call (`appRoleSilent` returns nothing for it), and a file that fails to read is reported on `err`, never a
 * silent role. Never throws: a recorder can only ever be missing an event, never stop the tick that called it.
 * @param {{ host?: HostConfig, now?: number, read?: typeof readFileSync, logPath?: string, record?: typeof recordFailures, err?: (line: string) => void }} [deps]
 * @returns {SilentRole[]} the roles it found silent, recorded or not
 */
export function tickAppRoleSilent({ host = homeHostConfig(), now = Date.now(), read = readFileSync, logPath, record = recordFailures,
  err = (line) => process.stderr.write(line) }: { host?: HostConfig; now?: number; read?: typeof readFileSync; logPath?: string;
    record?: typeof recordFailures; err?: (line: string) => void; } = {}): SilentRole[] {
  try {
    const declared = GITHUB_ROLES.filter((role: GithubRole) => roleIdentity(host, role).mode === "github-apps");
    if (declared.length === 0) return [];
    const sources: LedgerSource[] = ([["workers", host.gh.workers], ["managers", host.gh.leads]] as const).flatMap(([role, dir]) => {
      const path = join(dir, "gh", "gh-calls.tsv");
      try {
        return [{ role, lines: String(read(path, "utf8")).split("\n") }];
      } catch (cause) {
        if ((cause as { code?: string }).code !== "ENOENT") err(`app-role-silent: could not read ${path}: ${String((cause as Error)?.message ?? cause).split("\n")[0]}\n`);
        return [];
      }
    });
    const silent = appRoleSilent(sources, declared, now);
    for (const { role, calls, lastApp, mint } of silent) {
      err(`app-role-silent: ${role} is declared github-apps and made ${calls} call(s) in 10 minutes, none as app:${role} (its last app line: ${lastApp ?? "none in the ledger"}); ${mintReport(mint)}\n`);
    }
    if (silent.length > 0) record({ logPath: logPath ?? stateEntryPath(FAILURE_LEDGER_FILE, { host }), events: appRoleSilentEvents(silent), now });
    return silent;
  } catch (cause) {
    err(`app-role-silent: could not read the declaration: ${String((cause as Error)?.message ?? cause).split("\n")[0]}\n`);
    return [];
  }
}

// --- #3316: THE REVIEWERS' DOOR IS A COPY ON THE HOST, SO IT IS COMPARED AND INSTALLED LIKE THE WRAPPER ------
//
// MEASURED 2026-10-03 on #3311. `reviewer-3311` finished a review and could not post it: the installed
// `~/reviewer/bin/pr-review-verdict` was 7,227 bytes against a 15,704-byte source. It PREDATED #3030 (one write per
// verdict) and #3050/#3199 (refuse a second review at an equal patch), so the door the reviewers RAN was not the
// one that was reviewed and tested. `install-reviewer-bin.sh` (#2193) existed and nothing called it; #2972's
// cut-over moved the source out of the repository that carried the install and reopened the drift #2193 closed.

/** The door as the repository ships it, and the installer that puts it where it runs. */
export const REVIEWER_DOOR_SOURCE = fileURLToPath(new URL("../reviewer/pr-review-verdict.sh", import.meta.url));
const REVIEWER_DOOR_INSTALLER = fileURLToPath(new URL("../reviewer/install-reviewer-bin.sh", import.meta.url));

/**
 * Is the installed door the shipped one: `CURRENT`, `DRIFTED` (present and different), `NOT INSTALLED`, or `SOURCE UNREADABLE` --
 * which is NOT the same as drifted, because two unreadable files must not compare equal.
 * @param {Parameters<typeof reviewerDoorPath>[0] & { read?: typeof readFileSync, source?: string }} [deps]
 * @returns {{ state: "CURRENT" | "DRIFTED" | "NOT INSTALLED" | "SOURCE UNREADABLE", target: string, shippedBytes: number, installedBytes: number | null }}
 */
export function reviewerDoorState(deps: Parameters<typeof reviewerDoorPath>[0] & { read?: typeof readFileSync; source?: string; } = {}): { state: "CURRENT" | "DRIFTED" | "NOT INSTALLED" | "SOURCE UNREADABLE"; target: string; shippedBytes: number; installedBytes: number | null; } {
  const { read = readFileSync, source = REVIEWER_DOOR_SOURCE } = deps;
  const target = reviewerDoorPath(deps);
  const shipped = textOf(source, read);
  const installed = textOf(target, read);
  const bytes = (text: string | null) => (text === null ? null : Buffer.byteLength(text));
  const state = shipped === null ? "SOURCE UNREADABLE" : installed === null ? "NOT INSTALLED" : installed === shipped ? "CURRENT" : "DRIFTED";
  return { state, target, shippedBytes: bytes(shipped) ?? 0, installedBytes: bytes(installed) };
}

/**
 * The door against the repository's: nothing when CURRENT. `host:install` runs the installer, so its remedy line is honest here.
 * @param {Parameters<typeof reviewerDoorState>[0]} [deps]
 * @returns {Finding[]}
 */
export function reviewerDoorDrift(deps: Parameters<typeof reviewerDoorState>[0] = {}): Finding[] {
  const { state, target, shippedBytes, installedBytes } = reviewerDoorState(deps);
  if (state === "CURRENT") return [];
  const detail = {
    "SOURCE UNREADABLE": "the repository's pr-review-verdict.sh could not be read, so the installed door cannot be compared to it.",
    "NOT INSTALLED": `the repository ships the reviewers' door and this host has none at ${target}: a reviewer cannot post a verdict.`,
    DRIFTED: `the installed door is ${installedBytes} bytes and the shipped one ${shippedBytes}: reviewers run a door that was not the one `
      + "reviewed and tested (#3316). `host:install` runs install-reviewer-bin.sh, which keeps the previous copy beside it as `.bak-<stamp>`.",
  }[state];
  return [{ unit: target, problem: state, detail }];
}

/**
 * Install the door by running the installer the repository ships, with the destination THIS file decided so the check and the install
 * cannot name two places. The installer reads the copy back and fails unless it is byte-identical, which is why this does not reimplement it.
 * @param {Parameters<typeof reviewerDoorPath>[0] & { run?: (file: string, args: string[]) => string, out?: (line: string) => void }} [deps]
 * @returns {string} the path it installed
 */
export function reviewerDoorInstall(deps: Parameters<typeof reviewerDoorPath>[0] & { run?: (file: string, args: string[]) => string; out?: (line: string) => void; } = {}): string {
  const { run = (file, args) => execFileSync("bash", [file, ...args], { encoding: "utf8" }), out = (l) => process.stdout.write(l) } = deps;
  const target = reviewerDoorPath(deps);
  out(run(REVIEWER_DOOR_INSTALLER, [target]));
  return target;
}

// --- agent-org#1268: THE SKILL THE REVIEWER REVIEWS WITH ---------------------------------------------------------------------------------
//
// The reviewer is a Codex session, and Codex loads a skill from `~/.codex/skills/<name>/` and runs one when the prompt NAMES it. The skill is shipped in
// this repository (`src/skills/row-review/`) and `host:install` copies it there, so the order's sentence and the file it names cannot be two things: `host:check`
// reports a copy that is missing or differs from the shipped one, the way it reports the reviewers' door. The ORDER names it only behind `review.rowReviewSkill`
// (`pr-orders.ts`); installing it changes nothing a reviewer reads until that flag is on.

/** The skill as the repository ships it: a directory, copied whole. `LICENSE` is upstream's MIT text, which the adaptation must carry. */
export const ROW_REVIEW_SKILL_SOURCE = fileURLToPath(new URL("../skills/row-review/", import.meta.url));
/** The files of the skill, by name: a file there that is not listed is not the skill's and is neither compared nor written. */
export const ROW_REVIEW_SKILL_FILES: readonly string[] = Object.freeze(["SKILL.md", "LICENSE"]);

/**
 * The transcript directory Claude Code keeps for a working directory: every `/` and `.` becomes `-`.
 * @param {string} cwd
 */
const transcriptDir = (cwd: string) => cwd.replace(/[/.]/g, "-");

/** The tail of a transcript is enough to say what model answered last, and a transcript can run to megabytes. */
const TRANSCRIPT_TAIL_BYTES = 262_144;

/** @param {string} path @returns {string} the last {@link TRANSCRIPT_TAIL_BYTES} bytes */
function readTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The model a transcript's LAST assistant message names, or `null` when none can be read. `<synthetic>` is Claude
 * Code's own placeholder for a message no model produced, so it never counts as the model that is running.
 * @param {string} text the tail of a `.jsonl` transcript
 * @returns {string | null}
 */
export function lastModelIn(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const model = JSON.parse(lines[i])?.message?.model;
      if (typeof model === "string" && model !== "<synthetic>") return model;
    } catch {
      // The first line of a tail can start mid-record, and a line being written may be cut short: neither is a model.
    }
  }
  return null;
}

/**
 * Every live Claude session herdr knows, as `{ name, cwd, sessionId }`, or `null` when herdr could not be asked --
 * never `[]`, which would read as "nothing is running". Codex reviewers are a different product and are left out.
 * @param {(args: string[]) => string} [run]
 * @returns {{ name: string, cwd: string, sessionId: string }[] | null}
 */
export function liveClaudeSessions(run: (args: string[]) => string = (args) => herdrRun(args)): { name: string; cwd: string; sessionId: string; }[] | null {
  try {
    const agents = JSON.parse(run(["--session", "org", "agent", "list"]))?.result?.agents;
    if (!Array.isArray(agents)) return null;
    return agents.filter((a) => a.agent === "claude" && a.agent_session?.value)
      .map((a) => ({ name: String(a.name ?? a.pane_id), cwd: String(a.cwd ?? ""), sessionId: String(a.agent_session.value) }));
  } catch {
    return null;
  }
}

export type SessionModelDeps = { sessions?: ReturnType<typeof liveClaudeSessions>, projectsDir?: string, tail?: (path: string) => string, declared?: Record<string, { id: string }>, rowLabels?: (row: number) => readonly string[] | null, seatModels?: () => Readonly<Record<string, string>> | null,
  /** The keys of the trackers beyond the first that the project declares: the only keys a `worker-<key>-<n>` can carry. Defaults to the declaration's own, {@link readTrackerKeys}. */
  trackerKeys?: () => readonly string[] };
/**
 * A RESUMED SESSION KEEPS ITS SAVED MODEL (#2783). 2026-09-29: the chairman moved the org to Sonnet 5.5 and the three
 * standing sessions, restarted with `--resume`, came back on Sonnet 5 -- `settings.json`'s `model` is read for a FRESH
 * session and herdr resumes as a bare `claude --resume <uuid>`, so no launch flag can hold it (the wall `permissionModeDrift`
 * met). The org launches no resume of its own (`git grep -e --resume -- packages/agent-org` finds only comments and
 * the tmp pruner's read of one), so there is no `--model` to add.
 *
 * SO IT READS, AND SAYS SO: each live Claude session's transcript (`~/.claude/projects/<cwd>/<session id>.jsonl`) names
 * the model of its last answer. A session whose model is not one `DECLARED_CLAUDE_MODELS` names is a finding (a worker on a `tier:haiku`
 * row is expected on Haiku instead, {@link expectedModels}). THE REMEDY
 * IS `/model <alias>` IN THAT SESSION, which this cannot do.
 *
 * TWO LIMITS, STATED. A session switched with `/model` still reads as its old model until its next answer, so a finding
 * on a session that has just been switched clears itself on the next turn. A session with no assistant message yet (one
 * just cleared, as `product-manager` was when this was first run against the live host) is NOT a finding -- the gate wakes
 * a session on any finding, and "has not answered yet" is nothing to wake anybody for -- but it is reported as a NOTE
 * ({@link sessionModelNotes}), because absence of a reading is not a clean one.
 * @param {SessionModelDeps} [deps]
 * @returns {{ name: string, path: string, model: string | null }[]}
 */
export function readSessionModels({ sessions = liveClaudeSessions(), projectsDir = `${process.env.HOME ?? ""}/.claude/projects`,
  tail = readTail }: SessionModelDeps = {}): { name: string; path: string; model: string | null; }[] {
  return (sessions ?? []).map(({ name, cwd, sessionId }) => {
    const path = join(projectsDir, transcriptDir(cwd), `${sessionId}.jsonl`);
    try {
      return { name, path, model: lastModelIn(tail(path)) };
    } catch {
      return { name, path, model: null };  // no transcript yet: the same state as one with no answer in it
    }
  });
}

/** Sessions whose model could not be read: reported, never counted. @param {SessionModelDeps} [deps] @returns {Finding[]} */
export function sessionModelNotes(deps: SessionModelDeps = {}): Finding[] {
  return readSessionModels(deps).filter((r) => r.model === null).map(({ name, path }) => ({
    unit: `session ${name}`, problem: "MODEL UNKNOWN",
    detail: `no assistant message could be read from ${path}, so its model is unknown rather than correct.` }));
}

export type SeatDeps = { seats?: string[] | null, agents?: ReturnType<typeof readAgents> };
/**
 * A PERSISTENT SEAT THE ROSTER NAMES AND HERDR DOES NOT LIST (#3539). A roster entry is not a process: the routing sends the chairman's
 * messages to `liaison` the moment its entry exists, and on 2026-10-04 the seat was absent and his message was refused. The work tick
 * starts an absent seat ({@link startAbsentSeats}); this is the reading that says one is not running, and the gate offers a finding.
 *
 * `roster` and `agents` are what was read, or `null` for what could not be: THEY ARE NOTHING HERE, never `[]`, so a roster or a herdr that
 * could not be asked reads as unknown ({@link persistentSeatNotes}) and never as every seat present.
 * @param {SeatDeps} [deps]
 * @returns {{ seats: string[] | null, agents: ReturnType<typeof readAgents> }}
 */
export function readSeats({ seats, agents }: SeatDeps = {}): { seats: string[] | null; agents: ReturnType<typeof readAgents>; } {
  /** @returns {string[] | null} */
  const rosterSeats = (): string[] | null => { try { return persistentRoles(); } catch { return null; } };
  return { seats: seats === undefined ? rosterSeats() : seats, agents: agents === undefined ? readAgents() : agents };
}

/** What could not be read, named: an unknown is a note and never a clean reading. @param {SeatDeps} [deps] @returns {Finding[]} */
export function persistentSeatNotes(deps: SeatDeps = {}): Finding[] {
  const { seats, agents } = readSeats(deps);
  const unread = [...seats === null ? ["the roster (sessions.json)"] : [], ...agents === null ? ["herdr's workspace listing"] : []];
  return unread.length === 0 ? [] : [{ unit: "persistent seats", problem: "UNKNOWN",
    detail: `${unread.join(" and ")} could not be read, so whether every persistent seat is running is unknown rather than yes.` }];
}
