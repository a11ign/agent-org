import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { localImports, stripComments } from "../lib/local-import-closure.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { agreement, agreementReport, memoFile, readFacts } from "../lib/tool-version-agreement.ts";
import { SPAWNS_GH } from "../acceptance-commands/command-classes-and-declarations.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { homeHostConfig, stateEntryPath } from "../host-config.ts";
import { activeCodeHost } from "../plugins/active.ts";
import type { CodeHostWrapper } from "../plugins/contracts/code-host.ts";
import { wrapperInputsOf } from "../plugins/host-place.ts";
import { INSTALLED_DIR, PLUGIN_HOST_DIR, REPO_ROOT, RUNS_PACKAGE_SCRIPT, SHIPPED_DIR, binDirectory, entriesFromCommand, environmentDeclarations, execCommands, identityDeclarations, leadsDirectory, leadsListText, opaqueCommands, packageScripts, shellSpawnsGh, shippedContext, shippedHostScripts, shippedScriptDir, shippedScriptText, shippedUnitNames, shippedUnitText, startedByEnable, textOf, type HostConfig, type ShippedDeps, unitEntryPoints, unitPrefix, workersDirectory } from "./shipped-unit-texts-and-declarations.ts";

/**
 * A FILE THAT ASKS THE CODE HOST FOR ITS ROWS SPAWNS `gh` IN EFFECT (A11-160, step 9). No file outside `plugins/github` holds a `gh` spawn any more (`gh-call-ratchet.test.ts`), so the spawn a unit reaches is the code
 * host's: the process the plugin starts for a caller that imports `rows()` runs under the unit's own `GH_CONFIG_DIR`, and a unit that does not declare one gets the person's account all the same.
 */
const ASKS_CODE_HOST = /\bfrom\s+["'][^"']*plugins\/rows\.ts["']/;

/**
 * DOES STARTING THIS FILE REACH A `gh` SPAWN (OR THE CODE HOST'S, which is where it is)? Two edge kinds, because the repository uses both: local
 * imports, and an `pnpm run` of another script. `SPAWNS_GH` is IMPORTED rather than retyped -- it is the
 * one copy `acceptance-commands.ts` and `gh-token-jobs.test.ts` already share, so the spawns that make
 * a CI job need a token and the spawns that make a unit need an identity cannot drift apart.
 *
 * A `GH_TOKEN` read is deliberately NOT this question. A token is a credential; `GH_CONFIG_DIR` picks
 * which stored credential `gh` loads, so only an actual `gh` spawn can get the account wrong.
 *
 * A THIRD EDGE KIND SINCE #1998: an `ExecStart` that starts a shipped `.sh`. `SPAWNS_GH` cannot answer
 * for one -- it matches `execFileSync("gh", ...)`, and a shell script writes the word -- so a `.sh`
 * entry is read by `shellSpawnsGh` instead.
 * @param {string} entry
 * @param {{ read?: typeof readFileSync, exists?: typeof existsSync, imports?: typeof localImports,
 *           repoRoot?: string, scripts?: Record<string, string> }} [deps]
 * @returns {string | null} the file whose `gh` spawn it reaches, or null
 */
export function ghSpawnReachedFrom(entry: string, { read = readFileSync, exists = existsSync,
  imports = localImports, repoRoot = REPO_ROOT, scripts = packageScripts(repoRoot) }: {
        read?: typeof readFileSync; exists?: typeof existsSync; imports?: typeof localImports;
        repoRoot?: string; scripts?: Record<string, string>;
    } = {}): string | null {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = (pending.pop() as string);
    if (seen.has(file) || !exists(file)) continue;
    seen.add(file);
    const text = String(read(file));
    // A SHELL SCRIPT IS A LEAF. It spawns `gh` as a word rather than as a call, and this repository's
    // shell scripts import nothing -- so reading it is the whole walk, and handing its text to the
    // JavaScript comment stripper and the JavaScript spawn pattern would answer a question it is not.
    if (file.endsWith(".sh")) {
      if (shellSpawnsGh(text)) return file;
      continue;
    }
    const code = stripComments(text);
    if (SPAWNS_GH.test(code) || ASKS_CODE_HOST.test(code)) return file;
    pending.push(...imports(file));
    for (const [, name] of code.matchAll(RUNS_PACKAGE_SCRIPT)) {
      pending.push(...entriesFromCommand(`pnpm run ${name}`, { repoRoot, scripts, exists }));
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
 * @param {ShippedDeps & { shippedDir?: string, readDir?: typeof readdirSync, read?: typeof readFileSync,
 *           exists?: typeof existsSync, imports?: typeof localImports, repoRoot?: string,
 *           scripts?: Record<string, string> }} [deps]
 * TWO WAYS IN, and the second is #1993's: `opaque` says whether the `gh` spawn was READ or merely
 * NOT RULED OUT. A unit whose `ExecStart` this repository cannot follow is charged for an identity on
 * the second footing, which is the only reading that does not score "we did not look" as "it is fine".
 * @returns {{unit: string, via: string, opaque: boolean, declared: boolean}[]}
 */
export function unitsSpendingGh(deps: ShippedDeps & {
    shippedDir?: string; readDir?: typeof readdirSync; read?: typeof readFileSync;
    exists?: typeof existsSync; imports?: typeof localImports; repoRoot?: string;
    scripts?: Record<string, string>;
} = {}): { unit: string; via: string; opaque: boolean; declared: boolean; }[] {
  const { read = readFileSync, ...rest } = deps;
  return shippedUnitNames(deps)
    .filter((unit) => unit.endsWith(".service"))
    .flatMap((unit) => {
      const text = String(shippedUnitText(unit, deps));
      const declared = identityDeclarations(text).length > 0;
      const reached = unitEntryPoints(text, rest)
        .map((entry) => ghSpawnReachedFrom(entry, { read, ...rest }))
        .find((hit) => hit !== null);
      // READ FIRST, AND ONLY THEN NOT-RULED-OUT: a unit this repository can follow is reported by what
      // it actually reaches, and the opaque command is the fallback rather than a second finding.
      const via = reached ?? opaqueCommands(text, rest)[0];
      if (!via) return [];
      return [{ unit, via, opaque: !reached, declared }];
    });
}

/**
 * The person's own `gh` config, however a unit spells the home directory -- or an EMPTY value, which
 * declares nothing (`GH_CONFIG_DIR=` reads as unset to the wrapper, so it routes as a shell with no
 * workspace id: the person). The home is the HOST's (`host.json`), never a literal.
 * @param {string} home
 */
function humanConfigDir(home: string) {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:|(?:${escaped}|%h|\\$HOME|~)/\\.config/gh/?)$`);
}

/**
 * UNITS THAT MAY ACT AS THE HUMAN ACCOUNT, each with the reason. EMPTY, and that is the point (chairman,
 * #1950, #2332): the one entry there was, the corpus release, moved to `a11ign-ai-leads` once that account
 * had write on `a11ign/corpus-backups`. An entry needs `ceo`'s ruling, so it is a line in a reviewed file
 * rather than an `Environment=` line nobody reads.
 * @type {Record<string, string>}
 */
export const HUMAN_ACCOUNT_ALLOWED: Record<string, string> = {};

/**
 * The account a unit DECLARES: the LAST `GH_CONFIG_DIR` its `Environment=` lines leave in force (systemd
 * applies them in order), or `null` when it declares none.
 * @param {string} unitText @returns {string | null}
 */
function declaredConfigDir(unitText: string): string | null {
  const declared = identityDeclarations(unitText);
  return declared.length === 0 ? null : declared[declared.length - 1].value;
}

/**
 * The findings: a unit that never says as whom (so it gets the fallback account), spawning `gh` or not (#3643), and a
 * unit that says the answer is the PERSON, which no unit may since #2332 unless a named entry says why.
 * @param {Parameters<typeof unitsSpendingGh>[0] & { humanAllowed?: Record<string, string> }} [deps]
 * @returns {Finding[]}
 */
export function identityDrift(deps: Parameters<typeof unitsSpendingGh>[0] & { humanAllowed?: Record<string, string>; } = {}): Finding[] {
  return [...undeclaredIdentity(deps), ...humanAccountDeclared(deps)];
}

/**
 * EVERY SHIPPED `.service` THAT DECLARES NO `GH_CONFIG_DIR` (#3643), whether or not a `gh` spawn is reachable from it. Reach analysis
 * answers "does it spend a rate limit TODAY"; it cannot answer "is it one `pnpm run` from doing so", and a unit that spawns nothing
 * it can see still acts as the person the moment a script it starts grows a `gh` call. `a11ign-corpus-snapshot.service` read clean
 * on exactly that footing while it acted as the chairman with admin.
 * @param {Parameters<typeof unitsSpendingGh>[0]} deps @returns {Finding[]}
 */
function undeclaredIdentity(deps: Parameters<typeof unitsSpendingGh>[0]): Finding[] {
  const spending = new Map(unitsSpendingGh(deps).map((u) => [u.unit, u]));
  return shippedUnitNames(deps)
    .filter((unit) => unit.endsWith(".service") && declaredConfigDir(String(shippedUnitText(unit, deps))) === null)
    .map((unit) => ({ unit, problem: "NO IDENTITY DECLARED",
      detail: `${undeclaredReach(spending.get(unit))} A systemd unit has no \`HERDR_WORKSPACE_ID\`, so the \`gh\` wrapper `
        + "falls back to `~/.config/gh` -- a person's account -- and the unit spends a human's rate limit (or acts with "
        + `a human's admin) and refuses silently when it runs out (#1974). Add \`Environment=GH_CONFIG_DIR=${workersDirectory(deps)}/gh\` `
        + `to the unit, or \`${leadsDirectory(deps)}/gh\` where the job needs the write access the workers account lacks `
        + "(the corpus backup's own comment is the worked example), then run `pnpm run host:install`." }));
}

/**
 * Why an undeclared unit is a finding, from what `unitsSpendingGh` read of it: a spawn found, a command it could not follow, or
 * NOTHING -- which is still a finding, because declaring is cheap and "no spawn reached" is a reading at a moment (#3643).
 * @param {ReturnType<typeof unitsSpendingGh>[number] | undefined} spends @returns {string}
 */
function undeclaredReach(spends: ReturnType<typeof unitsSpendingGh>[number] | undefined): string {
  if (spends === undefined) {
    return "It reaches no `gh` spawn this repository can read, and it carries no `Environment=GH_CONFIG_DIR=...` line anyway.";
  }
  const { via, opaque } = spends;
  return `${opaque
    ? `It starts \`${via}\`, which this repository does not ship and cannot read, so whether it `
      + "spawns `gh` is UNKNOWN rather than no (#1993)"
    : `It reaches a \`gh\` spawn (via ${via.replace(`${REPO_ROOT}/`, "")})`} and carries no \`Environment=GH_CONFIG_DIR=...\` line.`;
}

/** The problem a login for a person in `~/.config/gh` is reported under (#3643). */
export const HUMAN_LOGIN_ON_HOST = "HUMAN LOGIN ON THE HOST";

/**
 * The logins a `gh` `hosts.yml` holds: the active `user:` of each host and the keys under a multi-account `users:` block. A line
 * scanner and not a YAML parser, because `yaml` is a devDependency and this file runs from the tool's checkout without one.
 * @param {string} text @returns {Set<string>}
 */
function ghLogins(text: string): Set<string> {
  const logins = new Set<string>();
  let usersIndent = -1;
  let childIndent = -1;
  for (const line of text.split("\n")) {
    const match = /^( *)([^\s#:][^:]*?):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, pad, key, value] = match;
    if (pad.length <= usersIndent) usersIndent = -1;
    if (key === "users" && value === "") {
      usersIndent = pad.length;
      childIndent = -1;
    } else if (usersIndent >= 0) {
      if (childIndent < 0) childIndent = pad.length;
      if (pad.length === childIndent) logins.add(key);
    } else if (key === "user" && value !== "") {
      logins.add(value.replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  return logins;
}

/**
 * ONE `gh` config directory's logins, in three states that never share a value: `absent` (no `hosts.yml`, which is an answer),
 * `unreadable` (it is there and could not be read or is not a file, which is NOT "clean"), or the logins read.
 * @param {string} dir @param {typeof readFileSync} read
 * @returns {{ state: "absent" } | { state: "unreadable", cause: string } | { state: "read", logins: Set<string> }}
 */
function readGhLogins(dir: string, read: typeof readFileSync): { state: "absent"; } | { state: "unreadable"; cause: string; } | { state: "read"; logins: Set<string>; } {
  try {
    return { state: "read", logins: ghLogins(String(read(join(dir, "hosts.yml"), "utf8"))) };
  } catch (cause) {
    const { code, message } = (cause as NodeJS.ErrnoException);
    return code === "ENOENT" ? { state: "absent" } : { state: "unreadable", cause: message };
  }
}

/**
 * IS THE PERSON LOGGED IN ON THE AGENTS HOST (#3643)? `~/.config/gh` is where the wrapper's rule 5 sends any shell with no workspace id
 * and no `GH_CONFIG_DIR`, so a human login there means every plain ssh shell and every undeclared unit acts as them, with their admin.
 * THE HUMAN IS "A LOGIN THAT IS NOT ONE OF THE TWO BOT ACCOUNTS'", read from `workers/gh` and `leads/gh`, never a literal name, so a
 * renamed person is still caught. A missing `~/.config/gh` is a pass; an unreadable one is a finding that says it does not know.
 * @param {{ host?: HostConfig, readGhHosts?: typeof readFileSync }} [deps] @returns {Finding[]}
 */
export function humanLoginOnHost(deps: { host?: HostConfig; readGhHosts?: typeof readFileSync; } = {}): Finding[] {
  const { readGhHosts = readFileSync } = deps;
  const host = deps.host ?? homeHostConfig();
  const personal = join(host.home, ".config", "gh");
  const found = readGhLogins(personal, readGhHosts);
  if (found.state === "absent") return [];
  const remedy = `Log it out with \`gh auth logout\` (\`GH_CONFIG_DIR\` unset) as that person; \`host:install\` does not touch it. The org's accounts are \`${host.gh.workers}/gh\` and \`${host.gh.leads}/gh\`.`;
  if (found.state === "unreadable") {
    return [{ unit: personal, problem: "HOST GH LOGIN UNREADABLE", manualFix: true,
      detail: `\`${join(personal, "hosts.yml")}\` could not be read (${found.cause}), so whether a person is logged in is UNKNOWN rather than no. ${remedy}` }];
  }
  const bots = [host.gh.workers, host.gh.leads].map((dir) => ({ dir, ...readGhLogins(join(dir, "gh"), readGhHosts) }));
  const botLogins = new Set(bots.flatMap((bot) => (bot.state === "read" ? [...bot.logins] : [])));
  const humans = [...found.logins].filter((login) => !botLogins.has(login));
  if (humans.length === 0) return [];
  const unknown = bots.filter((bot) => bot.state !== "read").map((bot) => `${bot.dir}/gh`);
  return [{ unit: personal, problem: HUMAN_LOGIN_ON_HOST, manualFix: true,
    detail: `it is logged in as ${humans.map((l) => `\`${l}\``).join(", ")}, which is not an org account${unknown.length === 0 ? ""
      : ` (${unknown.join(" and ")} could not be read, so the bot logins are incomplete)`}. The \`gh\` wrapper sends every shell with no `
      + "`HERDR_WORKSPACE_ID` and no `GH_CONFIG_DIR` here, so each plain ssh shell and each unit that declares none acts as that person "
      + `with their admin (#3643). ${remedy}` }];
}

/**
 * THE PATHS A CODEX CONFIG TRUSTS, read from `[projects."<path>"]` tables whose `trust_level` is `"trusted"` (#3702). A line scan and not
 * a TOML parser: the tool has none, and the only shape Codex writes for a project is that table header. A path in another spelling
 * (an inline table, a dotted key) is simply not found, which reads as untrusted and is the safe way to be wrong.
 * @param {string} text @returns {Set<string>}
 */
export function codexTrustedProjects(text: string): Set<string> {
  const trusted = new Set<string>();
  let current = null;
  for (const line of text.split("\n")) {
    const header = /^\s*\[(.*)\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      const project = /^projects\.(?:"([^"]*)"|'([^']*)')$/.exec(header[1].trim());
      current = project === null ? null : (project[1] ?? project[2]);
    } else if (current !== null && /^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/.test(line)) {
      trusted.add(current);
    }
  }
  return trusted;
}

/**
 * DOES THE REVIEWER'S CODEX TRUST EVERY CLONE `host.json` DECLARES (#3702)? A keyed reviewer starts in `clones.<key>`, and a Codex that
 * does not trust that directory blocks at startup (`agent_not_ready`), so the pull request behind it has no reviewer and the tick repeats
 * the line. `~/.codex/config.toml` is outside every repository and each entry was added by hand: `toolchain`'s clone was declared by
 * #3578 and sat untrusted for over an hour.
 *
 * READS AND NEVER WRITES, and says so in its remedy: a `trust_level = "trusted"` entry lets Codex load that repository's project
 * configuration for a reviewer running with `approval_policy = "never"`, so it is a grant a ruling makes per repository, not a tool's
 * act (`product-manager`, #3702). A host with no `clones` has nothing to check; an absent or unreadable config is a finding that
 * says which, because absent is not "trusts everything" and unreadable is not "trusts nothing".
 * @param {{ host?: HostConfig, readCodexConfig?: (path: string) => string }} [deps] @returns {Finding[]}
 */
export function codexTrustDrift(deps: { host?: HostConfig; readCodexConfig?: (path: string) => string; } = {}): Finding[] {
  const host = deps.host ?? homeHostConfig();
  const { readCodexConfig = (path: string) => readFileSync(path, "utf8") } = deps;
  const clones = Object.entries(host.clones ?? {});
  if (clones.length === 0) return [];
  const config = join(host.home, ".codex", "config.toml");
  let trusted: Set<string>;
  let unknown: string | null = null;
  try {
    trusted = codexTrustedProjects(readCodexConfig(config));
  } catch (cause) {
    trusted = new Set();
    unknown = (cause as NodeJS.ErrnoException).code === "ENOENT" ? "it does not exist" : `it could not be read (${(cause as Error).message})`;
  }
  return clones.filter(([, clone]) => !trusted.has(clone)).map(([key, clone]) => ({ unit: clone, problem: "CLONE NOT TRUSTED BY CODEX", manualFix: true,
    detail: `\`clones.${key}\` is declared in host.json and \`${config}\` ${unknown === null ? "has no `trust_level = \"trusted\"` table for it"
      : `could not vouch for it: ${unknown}`}, so a Codex reviewer for \`${key}\` is blocked at startup and its pull request has no reviewer (#3702). `
      + `This check edits nothing: trusting a repository is a ruling per repository. Once ruled, add \`[projects."${clone}"]\` with `
      + "`trust_level = \"trusted\"` for that exact path and nothing wider." }));
}

/**
 * EVERY SHIPPED `.service`, not only the ones that reach `gh`: a unit that declares the person's config and
 * spawns nothing today is one `pnpm run` away from spending it. The chairman's rule (#1950) is that no agent
 * acts as them unless something explicitly asks, and a unit is an agent.
 * @param {Parameters<typeof unitsSpendingGh>[0] & { humanAllowed?: Record<string, string> }} deps
 * @returns {Finding[]}
 */
function humanAccountDeclared(deps: Parameters<typeof unitsSpendingGh>[0] & { humanAllowed?: Record<string, string>; } = {}): Finding[] {
  const { humanAllowed = HUMAN_ACCOUNT_ALLOWED } = deps;
  const humanConfig = humanConfigDir((deps.host ?? homeHostConfig()).home);
  return shippedUnitNames(deps)
    .filter((unit) => unit.endsWith(".service") && !Object.hasOwn(humanAllowed, unit))
    .flatMap((unit) => {
      const dir = declaredConfigDir(String(shippedUnitText(unit, deps)));
      if (dir === null || !humanConfig.test(dir)) return [];
      return [{ unit, problem: "DECLARES THE HUMAN ACCOUNT",
        detail: `it sets \`GH_CONFIG_DIR=${dir}\`, the person's own login (which has ADMIN). No agent acts as `
          + `the chairman unless something explicitly asks (#1950): use \`${workersDirectory(deps)}/gh\` `
          + `(a11ign-ai-workers) or \`${leadsDirectory(deps)}/gh\` (a11ign-ai-leads, write on ${homeProjectDeclaration().repo} and `
          + "a11ign/corpus-backups), or add the unit to HUMAN_ACCOUNT_ALLOWED in host-units.ts with the "
          + "ruling that says why." }];
    });
}

/**
 * WHERE A UNIT'S NODE PROCESSES KEEP V8'S COMPILE CACHE (#2458). `tsc`, `eslint`, `rstest` and `changeset`
 * each call `module.enableCompileCache()` with no directory, and with `NODE_COMPILE_CACHE` unset Node then
 * writes `<os.tmpdir()>/node-compile-cache`. The entry is keyed by source text AND path, so the same file in
 * two worktrees is two entries: measured 895 files from one `pnpm run lint`, and 141,353 inodes in the
 * 2026-09-25 outage. A unit that runs any of them via `pnpm run` inherits its cache from the unit, never from
 * `~/.zshenv`, which only a login shell reads.
 */
const COMPILE_CACHE_VARIABLE = "NODE_COMPILE_CACHE";

/** A directory under a home's `.cache`: the `%h` specifier, or an absolute `/home/<user>` (a unit cannot expand `~`). */
const HOME_CACHE_DIRECTORY = /^(?:%h|\/home\/[A-Za-z0-9._-]+)\/\.cache\/[^/\s]+/;

/**
 * The compile-cache directory a unit's `Environment=` lines leave in force, or `null` when it declares none.
 * @param {string | null} unitText @returns {string | null}
 */
export function declaredCompileCache(unitText: string | null): string | null {
  const declared = environmentDeclarations(unitText, COMPILE_CACHE_VARIABLE);
  return declared.length === 0 ? null : declared[declared.length - 1].value;
}

/**
 * EVERY SHIPPED `.service` whose compile cache is not under a home's `.cache`, the unit that says nothing
 * included: it gets the default, which is the system temp directory.
 * @param {ShippedDeps & { shippedDir?: string, readDir?: typeof readdirSync, read?: typeof readFileSync }} [deps]
 * @returns {Finding[]}
 */
export function compileCacheDrift(deps: ShippedDeps & { shippedDir?: string; readDir?: typeof readdirSync; read?: typeof readFileSync; } = {}): Finding[] {
  return shippedUnitNames(deps)
    .filter((unit) => unit.endsWith(".service"))
    .flatMap((unit) => {
      const directory = declaredCompileCache(String(shippedUnitText(unit, deps)));
      if (directory !== null && HOME_CACHE_DIRECTORY.test(directory)) return [];
      return [{ unit, problem: "COMPILE CACHE NOT UNDER THE HOME'S .cache",
        detail: directory === null
          ? "it declares no `Environment=NODE_COMPILE_CACHE=...` line, so `tsc`/`eslint`/`rstest` write "
            + "the compile cache under the system temp directory, one entry per file per checkout path"
          : `it sets \`NODE_COMPILE_CACHE=${directory}\`, which is not under a home's \`.cache\``
        + ". Add `Environment=NODE_COMPILE_CACHE=%h/.cache/node-compile-cache` (#2458)." }];
    });
}

export type Finding = {unit: string, problem: string, detail: string, revertsIdentity?: boolean, runnerVersions?: boolean, manualFix?: boolean, hostProgram?: boolean, seatAbsent?: boolean, removesUnit?: boolean, noProjectUnits?: boolean, unitsUnreadable?: boolean, shippedOnRef?: string, supersededScript?: string, missingProgram?: string, installedCopy?: InstalledCopyState};

/**
 * HOW THE INSTALLED UNIT STANDS AGAINST THE REPOSITORY, carried on a `missingProgram` finding as the MEASURED FACT rather than as an assumption baked into its prose. It decides both the sentence the finding prints and whether `uncovered` says the shared remedy cannot fix it.
 */
export type InstalledCopyState = "current" | "stale" | "unshipped";

/**
 * ONE UNIT'S THREE ANSWERS, as data rather than as a sentence.
 *
 * `enabled` and `active` are SEPARATE FIELDS and not one boolean, because that is precisely the
 * distinction `a11ign-corpus-snapshot.timer` fell through: `is-enabled` said `enabled` and `is-active`
 * said `inactive`, and a single "is it on?" flag would have had to pick one and would have picked wrong.
 *
 * @param {string} unit
 * @param {ShippedDeps & { shippedDir?: string, installedDir?: string,
 *           read?: typeof readFileSync, exists?: typeof existsSync,
 *           systemctl?: (args: string[]) => string }} [deps]
 * @returns {{ unit: string, present: boolean, current: boolean | null, identityRevert: string[],
 *             enabled: string | null, active: string | null, windowEnded?: WindowEnd | null }}
 */
export function unitState(unit: string, deps: ShippedDeps & {
    shippedDir?: string; installedDir?: string;
    read?: typeof readFileSync; exists?: typeof existsSync;
    systemctl?: (args: string[]) => string;
} = {}): {
    unit: string; present: boolean; current: boolean | null; identityRevert: string[];
    enabled: string | null; active: string | null; windowEnded?: WindowEnd | null;
} {
  const { installedDir = INSTALLED_DIR, read = readFileSync, exists = existsSync, systemctl = defaultSystemctl } = deps;
  const installedPath = join(installedDir, unit);
  const present = exists(installedPath);
  const shippedText = shippedUnitText(unit, deps);
  const installedText = present ? textOf(installedPath, read) : null;
  // NULL, NOT FALSE, when it is not installed. "the copy differs" and "there is no copy" are different
  // findings with different remedies, and collapsing them would report the missing unit twice.
  const current = present ? shippedText !== null && shippedText === installedText : null;
  const identityRevert = installedOnlyIdentity(shippedText, installedText);
  if (!startedByEnable(unit, unitPrefix(deps))) {
    return { unit, present, current, identityRevert, enabled: null, active: null };
  }
  const asked = { enabled: ask(systemctl, "is-enabled", unit), active: ask(systemctl, "is-active", unit) };
  // Only a TIMER can end itself on purpose (#2971); a listener that is off is off by accident or by deleting the key.
  if (!unit.endsWith(".timer")) return { unit, present, current, identityRevert, ...asked };
  return { unit, present, current, identityRevert, ...asked, windowEnded: windowEnd(unit, deps) };
}

export type WindowEnd = { cause: string, ticks: number, at: string };

/**
 * THE END A TIMER WAS DESIGNED TO COME TO (#2971), read from the window's own record rather than from the timer's name.
 *
 * `a11ign-shadow-window.timer` disables ITSELF (`shadow-window.ts`'s `endWindow`) after appending a `stop` row to the diff record its
 * service names with `--record=`, and `disable --now` is also how it is kept stopped on purpose. Reading that as `NOT ENABLED` woke
 * `orchestrator` every tick and offered `host:install` (`enable --now`) as the remedy for a timer somebody stopped.
 *
 * NO FALLBACK AND NO NAME (chairman, 2026-09-24): the record is found through the timer's `Requires=` service and that service's
 * `ExecStart`, so a timer that names no record is never excused, and a window that is armed again is seen again -- a marker whose T0 is
 * LATER than the stop means the stop is history. `null` is "not ended", and also "could not tell": an unreadable or unparsable record or
 * marker keeps the finding, because excusing a timer on a reading nobody could make is the substitution this file warns about.
 * @param {string} unit @param {ShippedDeps & { read?: typeof readFileSync, markerPath?: string }} deps @returns {WindowEnd | null}
 */
export function windowEnd(unit: string, deps: ShippedDeps & { read?: typeof readFileSync; markerPath?: string; } = {}): WindowEnd | null {
  const { read = readFileSync, markerPath = stateEntryPath(SHADOW_WINDOW_MARKER_NAME) } = deps;
  const recordPath = windowRecordPath(unit, deps);
  const recordText = recordPath === null ? null : textOf(recordPath, read);
  const stop = recordText === null ? null : lastStopRow(recordText);
  if (stop === null) return null;
  const markerText = textOf(markerPath, read);
  if (markerText === null) return stop;
  const t0 = Date.parse(parsedOrNull(markerText)?.t0);
  return Number.isNaN(t0) || t0 > Date.parse(stop.at) ? null : stop;
}

/** The `--record=` of the service a timer `Requires=`, or null when the unit is no timer or names none. @param {string} unit @param {ShippedDeps} deps @returns {string | null} */
function windowRecordPath(unit: string, deps: ShippedDeps): string | null {
  if (!unit.endsWith(".timer")) return null;
  const service = /^Requires\s*=\s*(\S+\.service)\s*$/m.exec(String(shippedUnitText(unit, deps) ?? ""))?.[1];
  if (service === undefined) return null;
  return /--record=(\S+)/.exec(execCommands(String(shippedUnitText(service, deps) ?? "")).join("\n"))?.[1] ?? null;
}

/** The marker `shadow-window.ts --arm` creates, by name; `shadow-reads.ts` owns the constant and this file does not import it (its closure is the candidate's). */
const SHADOW_WINDOW_MARKER_NAME = "shadow-window-open";

/** @param {string} text @returns {any} the parsed JSON, or null when it is not JSON */
function parsedOrNull(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The LAST `stop` row of a JSONL record, or null when there is none or a line is not JSON (a record that cannot be counted is not read). @param {string} text @returns {WindowEnd | null} */
function lastStopRow(text: string): WindowEnd | null {
  const rows = text.split("\n").filter((line) => line.trim() !== "").map(parsedOrNull);
  if (rows.includes(null)) return null;
  const stop = rows.filter((row) => row?.kind === "stop").pop();
  return stop === undefined || Number.isNaN(Date.parse(stop.at)) ? null
    : { cause: String(stop.cause), ticks: Number(stop.ticks), at: String(stop.at) };
}

/** A timer systemd reports `disabled` whose window record says it ended itself: expected, so not a finding (#2971). @param {{ enabled: string | null, windowEnded?: WindowEnd | null }} state */
export const endedOnPurpose = (state: { enabled: string | null; windowEnded?: WindowEnd | null; }) => state.enabled === "disabled" && Boolean(state.windowEnded);

/**
 * `systemctl` answers on stdout AND exits non-zero for the interesting answers -- `is-active` exits 3 for
 * `inactive`, `is-enabled` exits 1 for `disabled`. Reading only the exit code loses the word, and letting
 * the throw escape would turn "this timer is off", the finding, into a crash.
 * @param {(args: string[]) => string} systemctl @param {string} verb @param {string} unit
 * @returns {string | null} the word systemd used, or null when systemd could not be asked at all
 */
function ask(systemctl: (args: string[]) => string, verb: string, unit: string): string | null {
  try {
    return systemctl([verb, unit]).trim() || null;
  } catch (error) {
    const out = String((error as { stdout?: unknown })?.stdout ?? "").trim();
    return out === "" ? null : out;
  }
}

/**
 * THE `GH_CONFIG_DIR` LINES `host:install` WOULD DELETE -- installed on the host, absent from the
 * repository. This direction and not the other: the reverse (shipped, not installed) is a drift the
 * remedy FIXES, and only this one is a drift the remedy CAUSES.
 *
 * ONLY WHEN THE REPOSITORY DECLARES NO ACCOUNT AT ALL (#2332). A shipped unit that names a DIFFERENT one
 * is a reviewed decision the install carries out, not an identity the host holds and the repository forgot:
 * the corpus release moving from the person's config to `a11ign-ai-leads` is exactly that, and shouting
 * "DO NOT RUN THE REMEDY" at the one command that lands it would train a reader to ignore the shout.
 * @param {string | null} shippedText @param {string | null} installedText @returns {string[]}
 */
function installedOnlyIdentity(shippedText: string | null, installedText: string | null): string[] {
  const shipped = new Set(identityLines(shippedText));
  if (shipped.size > 0) return [];
  return identityLines(installedText);
}

/** @param {string | null} text @returns {string[]} */
function identityLines(text: string | null): string[] {
  return [...new Set(identityDeclarations(text).map(({ line }) => line))];
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
export function unitDrift(states: ReturnType<typeof unitState>[]): Finding[] {
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
            + "does not, so `pnpm run host:install` would DELETE that line. The unit would then inherit "
            + "whatever account `gh` falls back to -- on this host a person's -- and spend a human's "
            + "rate limit until it ran out, then refuse silently (#1974). Land the line in "
            + "packages/agent-org/host/ FIRST, then reinstall." }];
      }
      return [{ unit: s.unit, problem: "STALE",
        detail: "the installed copy differs from the one in the repository -- these are copies, not "
          + "symlinks, so a merged edit does NOT reach the host until it is reinstalled." }];
    }
    if (s.enabled === null && s.active === null) return [];
    if (endedOnPurpose(s)) return [];
    if (!s.unit.endsWith(".timer")) return longRunningDrift(s);
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
 * A LONG-RUNNING SERVICE THAT IS NOT RUNNING (#3025), in words that say what it MEANS: no firing is missed when it is off, a conversation is.
 * The two states a timer reports apart stay apart (`enabled` and `active` are different questions), and `activating` is NOT read as running:
 * for a `Restart=on-failure` service it is the wait between a crash and the next start, which is a crash loop and not a listener.
 * @param {ReturnType<typeof unitState>} s @returns {Finding[]}
 */
function longRunningDrift(s: ReturnType<typeof unitState>): Finding[] {
  if (s.enabled !== "enabled") {
    return [{ unit: s.unit, problem: "LISTENER NOT ENABLED",
      detail: `systemd says \`${s.enabled}\` -- no clock starts this service, so nothing will start it after a reboot, `
        + "and `host:install` is what runs `enable --now` on it." }];
  }
  if (s.active === "active") return [];
  return [{ unit: s.unit, problem: "LISTENER ENABLED BUT NOT RUNNING",
    detail: `systemd says \`${s.active}\` -- messages sent to the bot are not being read. \`activating\` is a crash-restart loop and \`failed\` after `
      + "exit 2 is a refusal (config, secrets, nobody paired, lock held, a second poller): `journalctl --user -u " + s.unit + "` says which, and "
      + "`host:install` will not fix a refusal." }];
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
export function systemdUserAvailable(systemctl: (args: string[]) => string = defaultSystemctl) {
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
 * became `work-gate.ts`'s `fleet-batch-due` cause, and the unit files were DELETED from
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
 * @param {ShippedDeps & { shippedDir?: string, installedDir?: string, readDir?: typeof readdirSync,
 *           git?: (args: string[]) => string }} [deps]
 * @returns {Finding[]}
 */
export function orphanedUnits(deps: ShippedDeps & {
    shippedDir?: string; installedDir?: string; readDir?: typeof readdirSync;
    git?: (args: string[]) => string;
} = {}): Finding[] {
  const { shippedDir = SHIPPED_DIR, installedDir = INSTALLED_DIR, readDir = readdirSync, git = defaultGit } = deps;
  const shipped = new Set(shippedUnitNames(deps));
  let installed: string[];
  try {
    installed = readDir(installedDir).map(String);
  } catch {
    // NO DIRECTORY IS NOT AN EMPTY DIRECTORY, but for this question they coincide: nothing is installed,
    // so nothing is orphaned. The missing-unit half of the check already reports the absence.
    return [];
  }
  return installed
    .filter((n) => n.startsWith(unitPrefix(deps)))
    .filter((n) => n.endsWith(".service") || n.endsWith(".timer"))
    .filter((n) => !shipped.has(n))
    .sort()
    .map((unit) => orphanFinding(unit, orphanOrigin(unit, { shippedDir, git })));
}

/**
 * A HAND-PLACED COPY OF A SCRIPT THIS REPOSITORY NOW SHIPS -- #1998.
 *
 * THE UNITS ARE COPIED AND THE SCRIPTS ARE NOT, and that asymmetry is a decision rather than an
 * oversight. systemd will not read a unit out of the tree, so `~/.config/systemd/user` holds a copy and
 * `unitState`'s CURRENT question exists to report its drift. Nothing makes that demand of a program:
 * `a11ign-board-report.service` runs `packages/agent-org/host/board-report-dispatch.sh` where it sits,
 * exactly as `a11ign-work-tick.service` runs `work-tick.ts` where it sits. So there is no CURRENT
 * question to ask about a script -- there is only one copy, and a merged edit is live at the next
 * firing rather than at the next `host:install`, which is #1858's whole finding pointing the other way.
 *
 * WHAT THAT LEAVES, AND IT IS THIS CHECK. The copy at `~/.local/bin/board-report-dispatch.sh` that the
 * unit used to start is still on disk, inert, with nothing pointing at it and nothing watching it. A
 * reader who finds it will reasonably believe it is what runs; an editor of it will change nothing and
 * be told nothing. So the answer to "can `host:check` tell whether the installed script matches the
 * shipped one" is yes, and it also says the more useful thing: that there should not be an installed
 * one at all.
 *
 * NOT REMOVED BY THE REMEDY, deliberately. `host:install` deletes orphaned UNITS because this
 * repository owns `~/.config/systemd/user`'s `a11ign-*`; it owns nothing in `~/.local/bin`, which also
 * holds `gh`, `gh-real` and `herdr`. A remedy that reached in there would be this file's own
 * conservative doctrine pointed the wrong way, so the report says to read it and remove it by hand.
 * @param {ShippedDeps & { shippedDir?: string, scriptDir?: string, readDir?: typeof readdirSync,
 *           read?: typeof readFileSync, exists?: typeof existsSync }} [deps]
 * @returns {Finding[]}
 */
export function supersededHostScripts(deps: ShippedDeps & {
    shippedDir?: string; scriptDir?: string; readDir?: typeof readdirSync;
    read?: typeof readFileSync; exists?: typeof existsSync;
} = {}): Finding[] {
  const { shippedDir = SHIPPED_DIR, scriptDir = binDirectory(deps), readDir = readdirSync, read = readFileSync,
    exists = existsSync } = deps;
  return shippedHostScripts(shippedDir, { read: readDir })
    .filter((name) => exists(join(scriptDir, name)))
    .map((name) => supersededFinding(name, scriptDir,
      { same: textOf(join(shippedScriptDir(shippedDir, name), name), read) === textOf(join(scriptDir, name), read), shipped: shippedScriptDir(shippedDir, name) === PLUGIN_HOST_DIR ? "plugins/github/host" : "host" }));
}

/**
 * IDENTICAL AND DIVERGED ARE DIFFERENT FINDINGS, because only one of them can be removed without
 * reading it. An identical leftover is a second copy with no check on it; a diverged one means somebody
 * edited one of the two, and which one holds the change is a question this file cannot answer.
 * @param {string} name @param {string} scriptDir @param {{ same: boolean, shipped: string }} where `shipped` is the tool's directory that holds the script @returns {Finding}
 */
function supersededFinding(name: string, scriptDir: string, { same, shipped }: { same: boolean; shipped: string; }): Finding {
  const path = `${scriptDir}/${name}`;
  return { unit: path, supersededScript: path,
    problem: same ? "SUPERSEDED COPY -- IDENTICAL FOR NOW" : "SUPERSEDED COPY -- ALREADY DIVERGED",
    detail: `packages/agent-org/${shipped}/${name} is the copy the unit starts; this one is left over from `
      + `before this repository shipped it, and nothing starts it. ${same
        ? "It matches the shipped file TODAY, which is the only day anything guarantees -- it is a "
        + "second copy with no check on it, and an edit to it would look like it was doing something."
        : "It ALREADY DIFFERS from the shipped file, so one of the two has been edited since. Read the "
        + "diff before removing it: the change may be one the shipped copy still needs."}` };
}

// --- #2332: THE IDENTITY POLICY LIVES ON THE HOST, SO IT IS SHIPPED AND CHECKED ----------------------
//
// MEASURED 2026-09-24 (chairman's ruling, #1950: *no agent acts as me unless something explicitly asks*).
// `~/.local/bin/gh` was an allow-list for the workers account, so every workspace it did not list FELL
// THROUGH to the chairman's own login -- which has ADMIN -- and worker-4 and worker-5 acted as the chairman
// for hours. Nobody could review the rule: it existed only on the host. `git push` was a second, unwrapped
// door, because the global gitconfig pointed its credential helper at the real `/usr/bin/gh`.
//
// THERE IS NO EXCEPTION LEFT (#2333). The decision-holders (w6 ceo, w2 product-manager, w5 orchestrator) were
// first a named human-account exception because the workers pool could not carry them; the chairman then
// created `a11ign-ai-leads` (write, not admin, its own GraphQL pool) and the wrapper routes them there.
//
// A COPY WITH A DRIFT CHECK, NOT A SYMLINK (`ceo`'s ruling on the shape). `gh` is on EVERY agent's PATH, so a
// link into a working tree that may be mid-rebase would break `gh` for the whole org. `hostIdentityInstall`
// copies; `hostIdentityDrift` compares the installed bytes to the shipped ones. That makes
// `~/.local/bin/gh` the ONE file this repository owns in a directory `supersededFinding` and `uncovered` say
// it owns nothing in -- `gh-real` and `herdr` stay unowned.

/** `git config --global`'s file: where the credential helper and a person's `user.*` would be set. */
export const GLOBAL_GITCONFIG = `${process.env.HOME ?? ""}/.gitconfig`;

/** The file every interactive agent shell reads first, and so the one place its `NODE_COMPILE_CACHE` can come from (#2552). */
export const GLOBAL_ZSHENV = `${process.env.HOME ?? ""}/.zshenv`;

/**
 * What `~/workers/README.md` says. Generated here and not shipped as a file because the host is the only
 * place it is read, and the old text ("everything else uses the default (human) config") became the OPPOSITE
 * of the rule the day #1950 was ruled -- a description of a policy that must change when the policy does.
 */
export const WORKERS_README = `# workers — the a11ign-ai-workers GitHub identity for agent sessions

Owned by the repository (packages/agent-org/src/host-units.ts): \`pnpm run host:install\` writes this file and
\`pnpm run host:check\` reports it DIVERGED. Edit it there.

The \`gh\` wrapper is written only by \`writeGhWrapper\` (A11-84): it refuses a wrapper that names no App while host.json declares one, and a wrapper that would drop the Apps the installed copy names. \`pnpm run host:install --allow-no-apps\` is the one way past that, for a host that really dropped its Apps. \`doctor\` and the instance's start-up say when the installed wrapper is not the one host.json declares.

- \`gh/\` — GH_CONFIG_DIR for the machine account \`a11ign-ai-workers\` (device-flow login; token lives only in gh/hosts.yml, mode 600).
- \`~/leads/\` — the same for \`a11ign-ai-leads\` (write, not admin; its own GraphQL pool). \`~/leads/workspaces.txt\` lists the herdr workspace ids that use it (w6 ceo, w2 product-manager, w5 orchestrator).
- The routing is \`~/.local/bin/gh\` (shipped as packages/agent-org/host/gh, a wrapper over \`gh-real\`): an explicit GH_CONFIG_DIR always wins; an agent workspace (HERDR_WORKSPACE_ID set) routes to \`~/leads/gh\` when it is on that list and here otherwise; an agent workspace whose config is missing REFUSES; NO agent acts as the human account. A call with neither a workspace id nor GH_CONFIG_DIR is REFUSED too (#3642), so a shell outside a workspace must export GH_CONFIG_DIR first.
- \`git push\` goes through the same wrapper: the global gitconfig's credential helper is \`!~/.local/bin/gh auth git-credential\`, and \`host:check\` reports it when it is not.
- \`~/workers/workspaces.txt\`, if it is still there, is the retired allow-list and nothing reads it any more.
`;

/**
 * The `agent-org` command in `binDir` (#3532): the launcher that runs the tool's checkout, so a workspace can say `agent-org <cmd>` from any
 * directory with the project holding no copy of the tool. Owned only on a host that names a `tool`; one that does not has no checkout to launch.
 * @param {string} scriptDir @param {ShippedDeps} deps @returns {{ label: string, target: string, mode: number, expected: string | null }[]}
 */
function agentOrgLauncher(scriptDir: string, deps: ShippedDeps): { label: string; target: string; mode: number; expected: string | null; }[] {
  const { host } = shippedContext(deps);
  if (host().tool === undefined) return [];
  return [{ label: "agent-org launcher", target: join(scriptDir, "agent-org"), mode: 0o755, expected: shippedScriptText("agent-org", deps) }];
}

/**
 * Where the `claude` seat wrapper is installed: the first directory on a pane's PATH, which is `~/.opencode/bin` (`~/.zshenv` puts it ahead of
 * `~/.local/bin`). NOT `binDir`: `~/.local/bin/claude` is a symlink into `~/.local/share/claude/versions/<v>` and the CLI's self-update rewrites
 * it, so a wrapper installed there is replaced by the next update, and the wrapper execs that symlink to follow one.
 * @param {ShippedDeps} deps @returns {string}
 */
function seatWrapperDirectory(deps: ShippedDeps): string {
  return join((deps.host ?? homeHostConfig()).home, ".opencode", "bin");
}

/**
 * The seat wrapper as an owned file. OWNED ONLY WHERE THE CALLER MEANT THE REAL HOST: a caller that moved `scriptDir` (a fixture) and named no
 * `seatDir` is not asking about the real home's `~/.opencode/bin`, and owning it would let a test overwrite the wrapper every pane runs.
 * @param {ShippedDeps & { scriptDir?: string, seatDir?: string }} deps
 * @returns {{ label: string, target: string, mode: number, expected: string | null }[]}
 */
function seatWrapperFiles(deps: ShippedDeps & { scriptDir?: string; seatDir?: string; }): { label: string; target: string; mode: number; expected: string | null; }[] {
  if (deps.seatDir === undefined && deps.scriptDir !== undefined) return [];
  const dir = deps.seatDir ?? seatWrapperDirectory(deps);
  return [{ label: "claude seat wrapper", target: join(dir, "claude"), mode: 0o755, expected: shippedScriptText("claude", deps) }];
}

/**
 * THE ROUTING WRAPPER IS THE CODE HOST PLUGIN'S (A11-160): the text, the install target and the rules about writing it are asked of the wrapper of the code host this process activated, or of `deps.wrapper`
 * (a test's). `null` is a code host that installs none, which this host then owns no `gh` file for.
 * @param {{ wrapper?: CodeHostWrapper }} deps
 */
export function wrapperOf({ wrapper }: { wrapper?: CodeHostWrapper } = {}): CodeHostWrapper | null {
  return wrapper ?? activeCodeHost().wrapper ?? null;
}

/** The wrapper of the activated code host, for a caller that cannot go on without one: refused by name when the code host installs none. */
export function requiredWrapper(): CodeHostWrapper {
  const wrapper = wrapperOf();
  if (wrapper === null) throw new Error("the code host installs no routing wrapper, so there is none to write");
  return wrapper;
}

/**
 * The routing wrapper as an owned file: where it is installed (`scriptDir`, the host's bin directory unless a caller moved it) and the text the plugin renders for this host. `expected` is `null` when the
 * plugin's shipped copy cannot be read. THROWS what the render refuses (a placeholder no value fills).
 * @param {CodeHostWrapper} wrapper @param {Parameters<typeof ownedIdentityFiles>[0]} [deps]
 */
export function wrapperFile(wrapper: CodeHostWrapper, deps: Parameters<typeof ownedIdentityFiles>[0] = {}): { label: string; target: string; mode: number; expected: string | null; } {
  const { scriptDir = binDirectory(deps) } = deps;
  const { mode, expected } = wrapper.file(wrapperInputsOf(deps.host ?? homeHostConfig()));
  return { label: "gh", target: join(scriptDir, "gh"), mode, expected };
}

/**
 * The files this repository owns on the host for the identity policy, each with the text it must hold.
 * `expected` is `null` when the shipped source cannot be read, which is NOT the empty string.
 * @param {ShippedDeps & { shippedDir?: string, scriptDir?: string, workersDir?: string, leadsDir?: string,
 *           read?: typeof readFileSync }} [deps]
 * @returns {{ label: string, target: string, mode: number, expected: string | null }[]}
 */
export function ownedIdentityFiles(deps: ShippedDeps & {
    shippedDir?: string; scriptDir?: string; workersDir?: string; leadsDir?: string; seatDir?: string;
    read?: typeof readFileSync; wrapper?: CodeHostWrapper;
} = {}): { label: string; target: string; mode: number; expected: string | null; }[] {
  const { scriptDir = binDirectory(deps), workersDir = workersDirectory(deps), leadsDir = leadsDirectory(deps) } = deps;
  const wrapper = wrapperOf(deps);
  return [
    ...(wrapper === null ? [] : [wrapperFile(wrapper, deps)]),
    ...agentOrgLauncher(scriptDir, deps),
    ...seatWrapperFiles(deps),
    { label: "gh-leads-workspaces.txt", target: join(leadsDir, "workspaces.txt"),
      mode: 0o644, expected: leadsListText(deps) },
    { label: "workers README", target: join(workersDir, "README.md"), mode: 0o644, expected: WORKERS_README },
  ];
}

/**
 * The host's identity files against the repository's: NOT INSTALLED, DIVERGED, or the credential helper
 * pointing somewhere other than the wrapper.
 *
 * **ONE FINDING PER FILE, AND `host:install` FIXES EVERY ONE.** Unlike `supersededHostScripts`, these are
 * files the remedy writes, so the shared remedy line is honest for them.
 * @param {Parameters<typeof ownedIdentityFiles>[0] & { gitConfigPath?: string,
 *           gitConfig?: typeof defaultGitConfig }} [deps]
 * @returns {Finding[]}
 */
export function hostIdentityDrift(deps: Parameters<typeof ownedIdentityFiles>[0] & {
    gitConfigPath?: string;
    gitConfig?: typeof defaultGitConfig;
} = {}): Finding[] {
  const { read = readFileSync } = deps;
  const files = ownedIdentityFiles(deps).flatMap(({ label, target, expected }) => {
    if (expected === null) {
      return [{ unit: target, problem: "SHIPPED COPY UNREADABLE",
        detail: `the repository's ${label} could not be read, so this host cannot be compared to it.` }];
    }
    const installed = textOf(target, read);
    if (installed === expected) return [];
    return [{ unit: target, problem: installed === null ? "NOT INSTALLED" : "DIVERGED",
      detail: installed === null
        ? `the repository ships ${label} and this host has no copy at ${target}.`
        : `the installed ${label} is not byte-identical to the one this repository ships. The shipped copy `
          + "is the reviewed one (#2332); `host:install` overwrites the installed one with it, so read the "
          + "diff first if somebody edited the host copy by hand and the change is one to keep." }];
  });
  return [...files, ...credentialHelperDrift(deps)];
}

/**
 * `git config --file <path> --get-all <key>`, or `null` when git could not read it. Exit 1 is git's "no such
 * key", which is an answer (an empty list) and not a failure.
 * @param {string} path @param {string} key @returns {string[] | null}
 */
function defaultGitConfig(path: string, key: string): string[] | null {
  try {
    const lines = execFileSync("git", ["config", "--file", path, "--get-all", key],
      { encoding: "utf8", env: sandboxGitEnv() }).split("\n");
    lines.pop(); // the newline after the last value; an EMPTY value is a real line and must survive
    return lines;
  } catch (cause) {
    return (cause as { status?: number }).status === 1 ? [] : null;
  }
}

/** The helper a push to github.com must use: the wrapper, so the push is routed like every other call. */
const wrapperHelper = (scriptDir: string) => `!${scriptDir}/gh auth git-credential`;

/**
 * THE SECOND DOOR. `git push` does not run `gh` as the caller types it: it runs whatever
 * `credential.https://github.com.helper` names, and this host's said `!/usr/bin/gh auth git-credential` --
 * the real binary, no wrapper -- so every push by every agent authenticated as the chairman whenever
 * `GH_CONFIG_DIR` was unset (measured: `username=DanBeckDev` with it unset, `a11ign-ai-workers` with it set).
 *
 * THE EFFECTIVE LIST, NOT THE FILE'S LINES. git treats an empty `helper =` as "forget every helper so far",
 * so the helpers that run are those AFTER the last empty value -- and they must be EXACTLY the wrapper, since
 * a second helper (`cache`, `store`) could answer with a credential the wrapper would never have chosen.
 * READS THE GLOBAL FILE ONLY: a repository's own `.git/config` or `/etc/gitconfig` can still add a helper,
 * and this cannot see them.
 * @param {{ scriptDir?: string, gitConfigPath?: string, gitConfig?: typeof defaultGitConfig, host?: HostConfig }} [deps]
 * @returns {Finding[]}
 */
function credentialHelperDrift(deps: { scriptDir?: string; gitConfigPath?: string; gitConfig?: typeof defaultGitConfig; host?: HostConfig; } = {}): Finding[] {
  const { scriptDir = binDirectory(deps), gitConfigPath = GLOBAL_GITCONFIG, gitConfig = defaultGitConfig } = deps;
  const values = gitConfig(gitConfigPath, "credential.https://github.com.helper");
  const remedy = `The helper must be exactly \`${wrapperHelper(scriptDir)}\`; \`git config --global --unset-all `
    + `credential.https://github.com.helper\` and then add that one. This is NOT fixed by \`host:install\`, `
    + "which owns no line of a person's dotfile.";
  if (values === null) {
    return [{ unit: gitConfigPath, problem: "UNREADABLE", manualFix: true,
      detail: `git could not read it, so which account \`git push\` authenticates as is UNKNOWN rather than wrong. ${remedy}` }];
  }
  const effective = values.slice(values.lastIndexOf("") + 1);
  if (effective.length === 1 && effective[0] === wrapperHelper(scriptDir)) return [];
  return [{ unit: gitConfigPath, problem: "DIVERGED", manualFix: true,
    detail: `the github.com credential helper is ${effective.length === 0 ? "unset" : effective.map((h) => `\`${h}\``).join(" then ")}, `
      + "so `git push` may authenticate as an account the `gh` wrapper would not have chosen -- the chairman's, "
      + `when the real binary is named and \`GH_CONFIG_DIR\` is unset (#1950). ${remedy}` }];
}

/** An identity that is a machine's: a GitHub App (`[bot]`) or the workers account. Everything else is a person. */
const MACHINE_IDENTITY = /\[bot\]|ai-workers/i;

/**
 * THE GLOBAL `user.name` / `user.email`, reported and NEVER a failure (#2332 point 3). A repository's own
 * `.git/config` overrides them (this one sets `github-actions[bot]`), so commits HERE are not authored as
 * the chairman -- but any repository, or worktree of one, without the override is. Not a failure because the
 * remedy is a choice about a person's dotfile that `host:install` must not make.
 * @param {{ gitConfigPath?: string, gitConfig?: typeof defaultGitConfig }} [deps]
 * @returns {Finding[]}
 */
export function hostIdentityNotes({ gitConfigPath = GLOBAL_GITCONFIG, gitConfig = defaultGitConfig }: { gitConfigPath?: string; gitConfig?: typeof defaultGitConfig; } = {}): Finding[] {
  const set = ["user.name", "user.email"].flatMap((key) => {
    const value = (gitConfig(gitConfigPath, key) ?? []).at(-1);
    return value && !MACHINE_IDENTITY.test(value) ? [`${key} = ${value}`] : [];
  });
  if (set.length === 0) return [];
  return [{ unit: gitConfigPath, problem: "GLOBAL GIT IDENTITY IS A PERSON'S",
    detail: `${set.join(", ")}. A commit in any repository WITHOUT its own \`user.*\` override is authored as `
      + "them. Not a failure, and `host:install` will not change it: set an identity in each repository, or "
      + "unset the global one." }];
}

/**
 * The value of the LAST `export NODE_COMPILE_CACHE=` line in a `.zshenv` (the one zsh leaves in force), or
 * `null` when there is none. Comments are skipped, and one surrounding pair of quotes is dropped.
 * @param {string} text @returns {string | null}
 */
function zshenvCompileCache(text: string): string | null {
  const values = text.split("\n").flatMap((line) => {
    const declared = /^\s*export\s+NODE_COMPILE_CACHE=(.*?)\s*$/.exec(line);
    return declared ? [declared[1].replace(/^(["'])(.*)\1$/, "$2")] : [];
  });
  return values.at(-1) ?? null;
}

/**
 * WHETHER `~/.zshenv` EXPORTS A COMPILE CACHE UNDER THE HOME'S `.cache`, reported and NEVER a failure (#2552).
 * `compileCacheDrift` reads the shipped `.service` files; an interactive agent session reads no unit, only
 * this file, so a fresh host or a re-created account regresses to the system temp directory (`/tmp`, a
 * RAM-backed tmpfs: 895 files from one `pnpm run lint`) and nothing said so. Not a failure for
 * `hostIdentityNotes`'s reason: the remedy is an edit to a person's dotfile that `host:install` must not make.
 * A file that cannot be read is a finding here too, since its absence is exactly the regression.
 * @param {{ zshenvPath?: string, home?: string, read?: typeof readFileSync }} [deps]
 * @returns {Finding[]}
 */
export function compileCacheNotes({ zshenvPath = GLOBAL_ZSHENV, home = process.env.HOME ?? "",
  read = readFileSync }: { zshenvPath?: string; home?: string; read?: typeof readFileSync; } = {}): Finding[] {
  let text;
  try { text = String(read(zshenvPath, "utf8")); } catch (cause) {
    return [zshenvNote(zshenvPath, `it could not be read (${cause instanceof Error ? cause.message : cause})`)];
  }
  const value = zshenvCompileCache(text);
  const spellings = ["$HOME/.cache/", "${HOME}/.cache/", ...(home === "" ? [] : [`${home}/.cache/`])];
  const underHomeCache = value !== null && spellings.some((prefix) => value.startsWith(prefix));
  if (underHomeCache) return [];
  return [zshenvNote(zshenvPath, value === null
    ? "it has no `export NODE_COMPILE_CACHE=` line"
    : `it exports \`NODE_COMPILE_CACHE=${value}\`, which is not under \`$HOME/.cache\``)];
}

/** @param {string} unit @param {string} why @returns {Finding} */
function zshenvNote(unit: string, why: string): Finding {
  return { unit, problem: "INTERACTIVE SHELLS GET NO COMPILE CACHE UNDER THE HOME",
    detail: `${why}, so \`tsc\`/\`eslint\`/\`rstest\` in an agent session write the compile cache under /tmp, one `
      + "entry per file per checkout path. Not a failure, and `host:install` will not change it: add "
      + "`export NODE_COMPILE_CACHE=\"$HOME/.cache/node-compile-cache\"` to it (#2458, docs/known-gaps.md §50)." };
}

/** What a pane's shell resolves `claude` to: `zsh -c` reads `~/.zshenv`, where the PATH is set. `null` when it could not be asked. @returns {string | null} */
function zshResolvesClaude(): string | null {
  try {
    return execFileSync("zsh", ["-c", "command -v claude"], { encoding: "utf8", timeout: 10_000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * WHETHER A PANE'S SHELL REACHES THE SEAT WRAPPER (a11ign#4823), reported and NEVER a failure, for `compileCacheNotes`'s reason: the remedy is
 * the PATH in a person's dotfile, which `host:install` must not edit. A wrapper that is installed and shadowed is the vacuous form of this
 * guard (every comparison of its bytes is clean and no seat is switched), so the resolution itself is read. `resolve` is `null` for "could not
 * be asked", which is its own reading and never "resolved to something else".
 * @param {{ host?: HostConfig, seatDir?: string, resolve?: () => string | null }} [deps] @returns {Finding[]}
 */
export function seatWrapperNotes({ host, seatDir, resolve = zshResolvesClaude }: { host?: HostConfig; seatDir?: string; resolve?: () => string | null; } = {}): Finding[] {
  const target = join(seatDir ?? seatWrapperDirectory({ host }), "claude");
  const found = resolve();
  if (found === target) return [];
  const reading = found === null ? "could not be asked what `claude` resolves to" : `resolves \`claude\` to ${found}`;
  return [{ unit: target, problem: "A PANE'S SHELL MAY NOT RUN THE claude SEAT WRAPPER",
    detail: `\`zsh -c 'command -v claude'\` ${reading}, not the wrapper, so a restored standing seat starts without \`--settings\` and keeps its `
      + "auto-memory. Not a failure, and `host:install` will not change it: the directory must come before `~/.local/bin` in the PATH `~/.zshenv` sets." }];
}

/**
 * #3533: WHICH `agent-org` RELEASE EVERY RUNNER RUNS, read from the machine: the tool checkout, each worktree's resolved copy and the last `ci.yml` run, against the newest release tag of the
 * tool's remote. `null` is a host that declares no tool (nothing to compare). It is NOT part of `--json`: that is the gate's instrument and the org-health tick reads the same comparison itself
 * (`readToolAgreement`), so a finding here would wake a session twice for one fact. Both call `lib/tool-version-agreement.ts`, so the two print one reading.
 * @param {{ host?: HostConfig, now?: number, facts?: ReturnType<typeof readFacts> }} [deps] @returns {{ now: number, result: ReturnType<typeof agreement> } | null}
 */
export function readToolVersionAgreement({ host = homeHostConfig(), now = Date.now(), facts }: { host?: HostConfig; now?: number; facts?: ReturnType<typeof readFacts>; } = {}): { now: number; result: ReturnType<typeof agreement>; } | null {
  if (host.tool === undefined) return null;
  const memo = memoFile(stateEntryPath("tool-version-ci-logs.json", { host }));
  return { now, result: agreement(facts ?? readFacts({ tool: host.tool, primary: host.primary, projects: host.projects }, { now, memo })) };
}

/** The finding when some runner is behind, which is the signal. @param {ReturnType<typeof readToolVersionAgreement>} reading @returns {Finding[]} */
export function toolVersionFindings(reading: ReturnType<typeof readToolVersionAgreement>): Finding[] {
  if (reading === null || reading.result.signals.length === 0) return [];
  return [{ unit: "agent-org versions", problem: "RUNNERS NOT ON THE NEWEST RELEASE", runnerVersions: true, detail: agreementReport(reading.result, reading.now) }];
}

export type OrphanOrigin = { state: "retired" | "never" | "unreadable" } | { state: "unmerged", sha: string };

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
export function orphanOrigin(unit: string, { shippedDir = SHIPPED_DIR, git = defaultGit }: { shippedDir?: string; git?: (args: string[]) => string; } = {}): OrphanOrigin {
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
export function addedOnSomeRef(unit: string, { shippedDir = SHIPPED_DIR, git = defaultGit }: { shippedDir?: string; git?: (args: string[]) => string; } = {}): string | null {
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
export function retiredHere(unit: string, { shippedDir = SHIPPED_DIR, git = defaultGit }: { shippedDir?: string; git?: (args: string[]) => string; } = {}): boolean | null {
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
function orphanFinding(unit: string, origin: OrphanOrigin): Finding {
  if (origin.state === "retired") return retiredFinding(unit);
  if (origin.state === "unmerged") return unmergedRefFinding(unit, origin.sha);
  return unknownOriginFinding(unit, { never: origin.state === "never" });
}

/**
 * THE ONE ORPHAN WHOSE REMEDY IS THE PLAIN REMEDY. A commit here deleted the unit file, so removing it
 * from the host is what somebody already decided -- and this is the branch that must stay off both
 * do-not-run lists, or the warning fires on every report and therefore on none.
 * @param {string} unit @returns {Finding}
 */
function retiredFinding(unit: string): Finding {
  return { unit, problem: "ORPHANED -- RETIRED HERE",
    detail: `installed on this host and NO LONGER SHIPPED by this repository: a commit deleted its `
      + `unit file, so retiring it was the intent. ${STILL_RUNNING} \`pnpm run host:install\` removes it.` };
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
function unmergedRefFinding(unit: string, sha: string): Finding {
  const short = sha.slice(0, SHORT_SHA_LENGTH);
  return { unit, shippedOnRef: short,
    problem: `ORPHANED -- SHIPPED ON AN UNMERGED REF ${short}`,
    detail: `installed on this host and NOT in THIS checkout's tree -- but commit ${short} ADDS its unit `
      + "file on a ref this checkout has not merged, so this is not a hand-installed mystery: it is "
      + `about to be ours. ${STILL_RUNNING} DO NOT reach for \`pnpm run host:install\` yet: that command `
      + "copies this tree over the host, and the unit is not in this tree, so it would DELETE a unit "
      + `whose own pull request is open. \`git branch -a --contains ${short}\` names the ref carrying it; `
      + "merge that and THEN run `pnpm run host:install`. The remedy here is to MERGE, not to read a "
      + "journal and work out whether it is dead (#2013)." };
}

/**
 * THE TWO ORPHANS THIS REPOSITORY CAN SAY NOTHING ABOUT -- no ref adds the file, or the history could not
 * be read at all. Since #2013 the `never` half is EARNED rather than inferred: it is the answer to
 * `git log --all --diff-filter=A`, an addition question, where it used to be read off a deletion one.
 * @param {string} unit @param {boolean} never @returns {Finding}
 */
function unknownOriginFinding(unit: string, { never }: { never: boolean; }): Finding {
  return { unit, removesUnit: true,
    problem: never ? "ORPHANED -- NEVER SHIPPED HERE" : "ORPHANED -- HISTORY UNREADABLE",
    detail: `installed on this host and NOT SHIPPED by this repository -- and ${never
      ? "NO COMMIT ON ANY REF HERE EVER SHIPPED IT, so it was installed by hand and this tree has never "
        + "been able to see what it does"
      : "this checkout's history could not be read, so whether it was ever ours is UNKNOWN"}. `
      + `${STILL_RUNNING} DO NOT reach for \`pnpm run host:install\`: that command DELETES it, and a unit `
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
export const defaultGit = (args: string[]) =>
  execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", env: sandboxGitEnv() });

/** @param {string[]} args */
export const defaultSystemctl = (args: string[]) =>
  execFileSync("systemctl", ["--user", ...args], { encoding: "utf8" });

/**
 * THE FINDINGS THE SHARED REMEDY DOES NOT FIX, said BEFORE the line that offers it (#1998).
 *
 * Every other finding here ends at `pnpm run host:install`, which is what makes the report actionable --
 * and a reader who has been told that four times will read it the fifth time too. A superseded script
 * survives the remedy untouched, so the report has to say so in the same place the remedy is offered
 * rather than only in a `detail` line the reader already scrolled past.
 * @param {Finding[]} drift @returns {string}
 */
function uncovered(drift: Finding[]): string {
  return drift.filter((d) => d.runnerVersions)
    .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below -- it reports which \`agent-org\` release each runner runs, and\n`
      + "     `host:install` moves none of them. The finding names the runners and what moves each kind.\n").join("")
    + drift.filter((d) => d.supersededScript)
    .map((d) => `  !! ${d.supersededScript} is NOT fixed by the remedy below. This repository owns the\n`
      + "     a11ign-* units in ~/.config/systemd/user and nothing in ~/.local/bin, which also holds\n"
      + "     `gh`, `gh-real` and `herdr` -- so read it against packages/agent-org/host/ and `rm` it\n"
      + "     by hand.\n").join("")
    // #2174: THE SECOND FAULT THE SHARED REMEDY CANNOT TOUCH, and it is worse than the first because the
    // remedy LOOKS like it should work. `host:install` copies the unit; this unit is already correct, so
    // re-running it changes nothing and the reader is left believing it did.
    //
    // `installedCopy === "current"` AND NOT MERELY `missingProgram`, found in review of #2184: on a unit
    // that is STALE the remedy overwrites the very text this path was read off, so printing "not fixed
    // by the remedy" there would talk a reader out of the one command that might fix it. The finding's
    // own sentence says the opposite in that case, and these two must not disagree.
    // #2332: THE THIRD, and the only one that is a person's file. `host:install` owns three files on this
    // host and none of them is the global gitconfig, so a diverged credential helper survives the remedy.
    + drift.filter((d) => d.manualFix)
      .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below -- it is a person's dotfile and\n`
        + "     `host:install` writes no line of it. Change it by hand, as the finding says.\n").join("")
    // #2896: A PROGRAM, NOT A FILE THIS REPOSITORY OWNS. `host:install` writes units and the identity files and installs no program.
    // #3539: A SEAT IS STARTED BY THE WORK TICK, NOT BY A UNIT FILE, so `host:install` has nothing to copy for it.
    + drift.filter((d) => d.seatAbsent)
      .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below -- it is a process, and \`host:install\` starts none.\n`
        + "     The work tick starts it; read that tick's `SEAT NOT STARTED` line if it stays absent.\n").join("")
    + drift.filter((d) => d.hostProgram)
      .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below -- it is a program the host must have, and\n`
        + "     `host:install` installs none. Install it as the finding says.\n").join("")
    + drift.filter((d) => d.missingProgram && d.installedCopy === "current")
      .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below either -- it is already identical to\n`
        + `     the repository. The file it starts, ${d.missingProgram}, is what is missing, and\n`
        + "     re-installing an already-correct unit will not create it. Update the checkout its\n"
        + "     `WorkingDirectory=` names, or fix the path in the unit and ship that.\n").join("");
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
export function remedy(drift: Finding[]): string {
  // An unreadable directory's contents are unknown, so no install is named as the fix: `host:install` acts on exactly those contents.
  const unreadable = drift.filter((d) => d.unitsUnreadable);
  if (unreadable.length > 0) {
    return `${uncovered(drift)}  No remedy is named: ${unreadable.map((d) => d.unit).join(", ")} cannot be read, so `
      + "`host:install` cannot be judged safe. Make it readable, then run `pnpm run host:check` again.\n";
  }
  const line = `${uncovered(drift)}  Remedy for all of them: pnpm run host:install\n`;
  const reverts = drift.filter((d) => d.revertsIdentity);
  const removes = drift.filter((d) => d.removesUnit);
  const pending = drift.filter((d) => d.shippedOnRef);
  const emptied = drift.filter((d) => d.noProjectUnits);
  const isUnchanged = reverts.length === 0 && removes.length === 0 && pending.length === 0 && emptied.length === 0;
  if (isUnchanged) return line;
  return "  !! DO NOT RUN THE REMEDY YET -- it would change this host in a way nothing here would\n"
    + "     report afterwards.\n"
    + reverts.map((d) => `     ${d.unit} is installed with a \`GH_CONFIG_DIR\` the repository does not `
      + "ship,\n     and `host:install` copies the repository over the host. Land that line in\n"
      + "     packages/agent-org/host/ first.\n").join("")
    + (emptied.length === 0 ? "" : "     the project's units directory holds none of its units, so `host:install` would\n"
      + "     REMOVE every installed unit it does not ship (each listed as ORPHAN). Settle which\n"
      + "     checkout this host serves (AGENT_ORG_HOST) first.\n")
    + removes.map((d) => `     ${d.unit} would be DELETED, and this repository has no record of ever\n`
      + "     shipping it -- so nothing here knows what stops when it goes. Read it and its journal\n"
      + "     first, then ship it under packages/agent-org/host/ or confirm it is dead.\n").join("")
    + pending.map((d) => `     ${d.unit} would be DELETED, and commit ${d.shippedOnRef} ships it on a ref\n`
      + "     this checkout has not merged -- so the remedy would undo work that is already done.\n"
      + "     Merge that ref first; this command is then the right one.\n").join("")
    + "     Once the lines above are settled this command is safe and fixes everything above.\n"
    + line;
}
