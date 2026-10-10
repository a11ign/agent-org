// A LEAF, `node:` IMPORTS ONLY, as `host-pnpm.ts` is: `host-units.ts` resolves the project it serves when it is imported, so a check that
// needs only a binary's output and a config file lives where it can be asked without one.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Finding = import("./host-units.ts").Finding;

/** The finding's problem when the client and the daemon are two builds that disagree on a version or a default no config declares. */
export const CLIENT_DAEMON_DISAGREE = "CODEX CLIENT AND DAEMON DISAGREE";

/** How long one read of `codex` may take: the check runs under the tick, and a wedged daemon must not hold it. */
const CODEX_READ_TIMEOUT_MS = 10_000;

/**
 * THE FEATURE DEFAULTS A `codex features list` PRINTS: `<name>  <stage>  <default>`, the stage being one or two words
 * (`stable`, `under development`), so the name is the first token and the default the LAST. A line whose last token is
 * not `true` or `false` is not a feature and is skipped.
 * @param {string} text @returns {Map<string, boolean>}
 */
export function codexFeatureDefaults(text: string): Map<string, boolean> {
  const defaults = new Map<string, boolean>();
  for (const line of text.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    const value = tokens[tokens.length - 1];
    if (tokens.length >= 2 && /^[A-Za-z0-9_.-]+$/.test(tokens[0]) && (value === "true" || value === "false")) {
      defaults.set(tokens[0], value === "true");
    }
  }
  return defaults;
}

/**
 * THE FEATURES A CODEX CONFIG DECLARES, read from the `[features]` table: a `name = true|false` key, a dotted `a.b = ...` key, and a
 * `[features.a]` sub-table's `b = ...` (which is feature `a.b`). A line scan and not a TOML parser, as `codexTrustedProjects` is: a
 * spelling it does not find reads as undeclared, which is the safe way to be wrong. A key whose value is not a boolean is not a
 * declaration of a feature.
 * @param {string} text @returns {Set<string>}
 */
export function codexDeclaredFeatures(text: string): Set<string> {
  const declared = new Set<string>();
  let prefix: string | null = null;
  for (const line of text.split("\n")) {
    const header = /^\s*\[(.*)\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      const table = header[1].trim();
      if (table === "features") prefix = "";
      else if (table.startsWith("features.")) prefix = `${table.slice("features.".length).replace(/["']/g, "")}.`;
      else prefix = null;
      continue;
    }
    if (prefix === null) continue;
    const key = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(?:true|false)\s*(?:#.*)?$/.exec(line);
    if (key !== null) declared.add(`${prefix}${key[1] ?? key[2] ?? key[3]}`);
  }
  return declared;
}

/** What a failed read said: the errno code when there is one, else the message's first line. @param {unknown} cause @returns {string} */
const causeOf = (cause: unknown): string => {
  const { code, message, stderr } = cause as { code?: unknown, message?: string, stderr?: unknown };
  const said = String(stderr ?? "").trim() || String(message ?? cause).split("\n")[0];
  return typeof code === "string" ? `${code}: ${said}` : said;
};

/**
 * DO THE CODEX CLI AND THE CODEX DAEMON AGREE (#4437)? They are two programs on two release schedules: the daemon updates itself
 * (`~/.codex/app-server-daemon`, trigger `scheduled`) while the CLI stays at whatever was installed, and builds a few releases apart
 * disagree on feature defaults. The first session that met the disagreement stopped on a dialog (`reviewer-lab-45`), and nothing
 * on the host said the two had drifted. Raised when (a) `codex app-server daemon version` reports a `cliVersion` different from the
 * `appServerVersion`, or (b) a feature whose default differs between the two builds' `features list` is not declared in the
 * config's `[features]` table, which is the one thing that decides it.
 *
 * A HOST WITH NO CODEX, A DAEMON THAT IS NOT RUNNING AND A CONFIG THAT CANNOT BE READ EACH RAISE A FINDING THAT SAYS WHICH: none of
 * the three is "the two agree". An absent config declares nothing, so (b) still fires on it and says the file does not exist.
 *
 * READS AND NEVER WRITES, as `codexTrustDrift` does (#3702): declaring a flag is a ruling, so the remedy names the line to add and
 * the value the client already runs with, and `host:check --install` does not apply it.
 *
 * The daemon's build is the `managedCodexPath` its own `version` output names, so a daemon updated to a release this check has
 * never heard of is still asked. `codex` is found on the PATH this process holds and then in `<home>/.local/bin`, because the tick
 * runs the check under a unit's PATH and a person runs `host:check` under theirs.
 * @param {{ home: string, run?: (program: string, args: string[]) => string, readCodexConfig?: (path: string) => string }} deps
 *   `home` is REQUIRED: the host's home, which this leaf does not resolve itself. `run` returns a program's stdout and throws as
 *   `execFileSync` does (`code: "ENOENT"` for a program that is not there).
 * @returns {Finding[]}
 */
export function codexClientDaemonDrift({ home, run = runProgram, readCodexConfig = (path: string) => readFileSync(path, "utf8") }: {
  home: string; run?: (program: string, args: string[]) => string; readCodexConfig?: (path: string) => string;
}): Finding[] {
  const config = join(home, ".codex", "config.toml");
  const unit = "codex";
  const asked = (program: string, args: string[]): { text: string } | { absent: true } | { failure: string } => {
    for (const candidate of program === "codex" ? ["codex", join(home, ".local", "bin", "codex")] : [program]) {
      try {
        return { text: run(candidate, args) };
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { failure: causeOf(cause) };
      }
    }
    return { absent: true };
  };

  const version = asked("codex", ["app-server", "daemon", "version"]);
  if ("absent" in version) {
    return [{ unit, problem: "CODEX NOT FOUND", manualFix: true, hostProgram: true,
      detail: `there is no \`codex\` on PATH=${process.env.PATH ?? ""} or in \`${join(home, ".local", "bin")}\`, so whether the CLI and the app-server `
        + "daemon agree is UNKNOWN rather than yes. A host that runs Codex reviewers needs it where the units' PATH finds it." }];
  }
  const notRunning = (why: string): Finding[] => [{ unit, problem: "CODEX DAEMON NOT RUNNING", manualFix: true,
    detail: `\`codex app-server daemon version\` ${why}, so the daemon's version and feature defaults were not read and whether it agrees with `
      + "the CLI is UNKNOWN rather than yes. Start it with `codex app-server daemon start` (this check starts nothing)." }];
  if ("failure" in version) return notRunning(`failed (${version.failure})`);
  let facts: { status?: unknown, cliVersion?: unknown, appServerVersion?: unknown, managedCodexPath?: unknown };
  try {
    facts = JSON.parse(version.text);
  } catch {
    return notRunning(`printed something that is not JSON (${JSON.stringify(version.text.slice(0, 80))})`);
  }
  if (facts === null || typeof facts !== "object" || facts.status !== "running") {
    return notRunning(`reports the daemon as ${JSON.stringify(facts?.status ?? null)}, not "running"`);
  }
  const { cliVersion, appServerVersion } = facts;
  if (typeof cliVersion !== "string" || typeof appServerVersion !== "string") {
    return notRunning("did not report both `cliVersion` and `appServerVersion`");
  }

  const findings: Finding[] = [];
  const daemonProgram = typeof facts.managedCodexPath === "string" && facts.managedCodexPath !== ""
    ? facts.managedCodexPath : join(home, ".codex", "packages", "app-server-daemon", "current", "bin", "codex");
  const listed = (who: string, read: ReturnType<typeof asked>): Map<string, boolean> | Finding => {
    if ("text" in read) return codexFeatureDefaults(read.text);
    return { unit, problem: "CODEX FEATURES UNREADABLE", manualFix: true,
      detail: `\`features list\` of the ${who} build ${"absent" in read ? "is not there" : `failed (${read.failure})`}, so its feature `
        + "defaults were not read and whether they agree is UNKNOWN rather than yes." };
  };
  const client = listed("CLI", asked("codex", ["features", "list"]));
  const daemon = listed("daemon", asked(daemonProgram, ["features", "list"]));
  const unreadable = [client, daemon].filter((one): one is Finding => !(one instanceof Map));
  findings.push(...unreadable);

  let declared: Set<string> = new Set();
  let configNote = "";
  let configFinding: Finding | null = null;
  try {
    declared = codexDeclaredFeatures(readCodexConfig(config));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") configNote = ` (\`${config}\` does not exist, so nothing is declared)`;
    else configFinding = { unit: config, problem: "CODEX CONFIG UNREADABLE", manualFix: true,
      detail: `\`${config}\` could not be read (${causeOf(cause)}), so which feature defaults it declares is UNKNOWN rather than all of them.` };
  }

  const differing: { flag: string, client: boolean, daemon: boolean }[] = [];
  if (client instanceof Map && daemon instanceof Map) {
    for (const [flag, clientDefault] of [...client].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const daemonDefault = daemon.get(flag);
      if (daemonDefault !== undefined && daemonDefault !== clientDefault) differing.push({ flag, client: clientDefault, daemon: daemonDefault });
    }
  }
  const undeclared = differing.filter(({ flag }) => !declared.has(flag));
  const skew = cliVersion !== appServerVersion;
  if (configFinding !== null) findings.push(configFinding);
  if (skew || (configFinding === null && undeclared.length > 0)) {
    const parts: string[] = [];
    if (skew) parts.push(`the CLI is ${cliVersion} and the daemon it talks to is ${appServerVersion}`);
    if (configFinding === null && undeclared.length > 0) {
      parts.push(`${undeclared.length} feature${undeclared.length === 1 ? "" : "s"} default${undeclared.length === 1 ? "s" : ""} differently and `
        + `${undeclared.length === 1 ? "is" : "are"} not declared in \`[features]\`${configNote}: `
        + undeclared.map(({ flag, client: c, daemon: d }) => `\`${flag}\` (CLI ${c}, daemon ${d})`).join(", "));
    }
    const lines = undeclared.map(({ flag, client: c }) => `\`${flag} = ${c}\``);
    findings.unshift({ unit, problem: CLIENT_DAEMON_DISAGREE, manualFix: true,
      detail: `${parts.join("; ")}. A session that meets a default the other build does not has stopped on a dialog before (#4437). `
        + `This check edits nothing: declaring a flag is a ruling. ${lines.length === 0 ? "Update the CLI to the daemon's release (or the daemon to the CLI's)."
          : `Once ruled, add ${lines.join(", ")} under \`[features]\` in \`${config}\`, the value the client already runs with.`}` });
  }
  return findings;
}

/** @param {string} program @param {string[]} args @returns {string} */
function runProgram(program: string, args: string[]): string {
  return execFileSync(program, args, { encoding: "utf8", timeout: CODEX_READ_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
}
