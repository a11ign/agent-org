// @ts-check
// module: a plugin's declared agent-org contract, read from its install, and the rows that say where it and the host's keys disagree
//
// THE CONTRACT IS DATA AND THE CHECK IS PURE. `readPluginContract` reads the `metadata.agentOrg` object of a plugin's `.claude-plugin/plugin.json` and
// nothing else. `contractRows` compares it with the host's keys and returns one row per mismatch, each naming its fix in one sentence. Neither reads
// the host file, Claude Code's install record or the machine: a test passes the text, the commands and the version it wants.
//
// A PLUGIN WITH NO CONTRACT HAS NO ROWS. Only a contract that is present and wrong is a row, so a plugin that declares nothing starts as it always did.
// A contract that is present and cannot be read is a row too, because silently ignoring a half-written contract would hide the mistake it exists to show.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveToolVersion } from "../lib/tool-version.ts";
import type { TicketSettings } from "./settings.ts";

/** The contract majors this agent-org reads. A plugin declaring any other major gets one row, and nothing else is checked. */
export const READ_CONTRACT_MAJORS: readonly number[] = [1];

/** The extension points a contract may provide a skill for, each with the host key that names its skill. */
export type Point = "planner" | "writer" | "prReview";

/** What a plugin declares, as `readPluginContract` read it: the fields this reader checks, and nothing it does not understand. */
export type Contract = Readonly<{
  /** `<major>.<minor>`. */
  contract: string;
  /** A version range of agent-org, bounded above, such as `>=0.258.0 <1.0.0`. */
  agentOrg: string;
  provides: Readonly<Partial<Record<Point, Readonly<{ skill: string; planFile?: string }>>>>;
  needs: Readonly<{ connectors: readonly string[]; commands: readonly string[] }>;
}>;

/** No contract, a contract this reads (with the plugin's own name, which its skills are namespaced by), or one that is present and wrong, with why. */
export type ContractRead = Readonly<{ kind: "none" }> | Readonly<{ kind: "found"; name: string; contract: Contract }> | Readonly<{ kind: "malformed"; why: string }>;

/** A row of the check: which plugin it is about, what kind of mismatch, and the one sentence that names the fix. */
export type RowKind = "contract-malformed" | "contract-major" | "agent-org-range" | "connector-need" | "command-need" | "skill-not-provided" | "plugin-not-enabled" | "plan-file";
export type ContractRow = Readonly<{ plugin: string; kind: RowKind; why: string }>;

/** The host's keys the check compares with a contract, as plain text: `null` for a key the host file does not set. */
export type HostFacts = Readonly<{ plugins: readonly string[]; connectors: readonly string[]; plan: string | null; prReview: string | null; planner: string | null; writer: string | null }>;

/** Where a host key names a skill: `plugin` is null for a bare name, which only `prReview` may be. */
type SkillRef = Readonly<{ key: Point; plugin: string | null; skill: string }>;

const NONE: ContractRead = { kind: "none" };
const KEY_OF: Readonly<Record<Point, string>> = { prReview: "tickets.prReview", planner: "tickets.planner.run", writer: "tickets.writer.run" };
/**
 * A `plugin:skill` a run's text names. Both names start with a letter, so a colon before a port or a step number (`localhost:8080`, `step:1`) names
 * none, as does a colon that ends a word (`request: `) or a URL's `https:`.
 */
const SKILL_IN_TEXT = /(?<![\w.:-])[A-Za-z][\w-]*:[A-Za-z][\w-]*/g;
const COMPARATOR = /^(>=|<=|=|>|<)(\d+)\.(\d+)\.(\d+)$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const readText = (path: string): string => readFileSync(path, "utf8");
const malformed = (why: string): ContractRead => ({ kind: "malformed", why });

/** The host's keys the check reads, from the settings the host file was parsed into. */
export function hostFactsOf(settings: Pick<TicketSettings, "plugins" | "connectors" | "plan" | "prReview" | "planner" | "writer">): HostFacts {
  return { plugins: settings.plugins, connectors: settings.connectors, plan: settings.plan, prReview: settings.prReview, planner: settings.planner?.run ?? null, writer: settings.writer?.run ?? null };
}

/** The plugin's name in `name@marketplace`, which is how `tickets.plugins` lists it. */
export const pluginName = (entry: string): string => entry.split("@")[0];

/** Whether a command is on the path of the instance that runs the check. */
export const onPathDefault = (command: string): boolean => {
  try {
    execFileSync("sh", ["-c", "command -v \"$1\"", "sh", command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** The release this agent-org is running, as `X.Y.Z`, or null when HEAD is no release or the version cannot be read. Never throws. */
export const agentOrgVersionDefault = (): string | null => {
  try {
    return liveToolVersion()?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
};

const isMatch = (match: RegExpExecArray | null): match is RegExpExecArray => match !== null;

/** A range's comparators, each an operator and an `X.Y.Z`, with an upper bound. Null for any other text. */
function rangeOf(text: string): { op: string; want: number[] }[] | null {
  const matches = text.trim().split(/\s+/).map((part) => COMPARATOR.exec(part));
  if (!matches.every(isMatch)) return null;
  const comparators = matches.map(([, op, ...parts]) => ({ op, want: parts.map(Number) }));
  return comparators.some(({ op }) => op === "<" || op === "<=") ? comparators : null;
}

/** Whether `version` (`X.Y.Z`) is inside `range`, every comparator holding. A range that does not parse holds for nothing. */
function satisfies(version: string, range: string): boolean {
  const comparators = rangeOf(range);
  if (comparators === null) return false;
  const have = version.split(".").map(Number);
  const compare = (want: readonly number[]): number => want.map((part, i) => Math.sign(have[i] - part)).find((sign) => sign !== 0) ?? 0;
  const holds: Readonly<Record<string, (sign: number) => boolean>> = { ">=": (sign) => sign >= 0, ">": (sign) => sign > 0, "<=": (sign) => sign <= 0, "<": (sign) => sign < 0, "=": (sign) => sign === 0 };
  return comparators.every(({ op, want }) => holds[op](compare(want)));
}

/** The skill a plugin provides at an extension point, as its name without the plugin's prefix. */
const skillPart = (skill: string): string => skill.slice(skill.indexOf(":") + 1);

/** The skill names the host's keys hold: `prReview` as a bare name or `plugin:skill`, and every `plugin:skill` a run text names. PURE. */
export function skillRefs(host: HostFacts): SkillRef[] {
  const prReview = host.prReview === null ? [] : [refOf("prReview", host.prReview)];
  const runs = (["planner", "writer"] as const).flatMap((key) => (host[key] === null ? [] : [...host[key].matchAll(SKILL_IN_TEXT)].map(([token]) => refOf(key, token))));
  return [...prReview, ...runs];
}

function refOf(key: Point, text: string): SkillRef {
  const at = text.indexOf(":");
  return at === -1 ? { key, plugin: null, skill: text } : { key, plugin: text.slice(0, at), skill: text.slice(at + 1) };
}

/**
 * The plugin's declared contract, read from `<installPath>/.claude-plugin/plugin.json`. A file that cannot be read or parsed, or has no
 * `metadata.agentOrg`, is no contract. One that has it and gets a field wrong is malformed, and the reason names the field.
 */
export function readPluginContract(installPath: string, { read = readText }: { read?: (path: string) => string } = {}): ContractRead {
  let manifest: unknown;
  try {
    manifest = JSON.parse(read(join(installPath, ".claude-plugin", "plugin.json")));
  } catch {
    return NONE;
  }
  const declared = isObject(manifest) && isObject(manifest.metadata) ? manifest.metadata.agentOrg : undefined;
  if (declared === undefined) return NONE;
  if (!isObject(manifest) || typeof manifest.name !== "string") return malformed("the plugin's manifest has no name, so its skills cannot be told apart");
  return parseContract(manifest.name, declared);
}

/** A declared contract, field by field: each rule names the field it checks. PURE. */
function parseContract(name: string, declared: unknown): ContractRead {
  if (!isObject(declared)) return malformed("metadata.agentOrg must be an object");
  const { contract, agentOrg, provides = {}, needs = {} } = declared;
  if (typeof contract !== "string" || !/^\d+\.\d+$/.test(contract)) return malformed("metadata.agentOrg.contract must be \"<major>.<minor>\", such as \"1.0\"");
  if (typeof agentOrg !== "string" || rangeOf(agentOrg) === null) return malformed("metadata.agentOrg.agentOrg must be a version range with an upper bound, such as \">=0.258.0 <1.0.0\"");
  if (!isObject(provides)) return malformed("metadata.agentOrg.provides must be an object");
  const skills = providesOf(name, provides);
  if (typeof skills === "string") return malformed(skills);
  if (!isObject(needs)) return malformed("metadata.agentOrg.needs must be an object");
  const needed = needsOf(needs);
  if (typeof needed === "string") return malformed(needed);
  return { kind: "found", name, contract: { contract, agentOrg, provides: skills, needs: needed } };
}

/** The extension points a contract provides, each with its skill namespaced by the plugin's name; the reason it is wrong, else. Unknown points are ignored. */
function providesOf(name: string, provides: Record<string, unknown>): Contract["provides"] | string {
  const out: Partial<Record<Point, { skill: string; planFile?: string }>> = {};
  for (const key of ["planner", "writer", "prReview"] as const) {
    const point = provides[key];
    if (point === undefined) continue;
    if (!isObject(point) || typeof point.skill !== "string") return `metadata.agentOrg.provides.${key}.skill must be a skill's name, namespaced \`${name}:<skill>\``;
    if (!point.skill.startsWith(`${name}:`) || !/^[\w.-]+$/.test(skillPart(point.skill))) return `metadata.agentOrg.provides.${key}.skill must be \`${name}:<skill>\`, not ${JSON.stringify(point.skill)}`;
    if (key === "planner" && point.planFile !== undefined && typeof point.planFile !== "string") return "metadata.agentOrg.provides.planner.planFile must be the plan file's name, such as \"<issue-id>-0001-plan-<slug>.md\"";
    out[key] = { skill: point.skill, ...(typeof point.planFile === "string" ? { planFile: point.planFile } : {}) };
  }
  return out;
}

/** What a contract needs: connector patterns anchored at `^mcp__`, and command names. Unknown needs are ignored. */
function needsOf(needs: Record<string, unknown>): Contract["needs"] | string {
  const { connectors = [], commands = [] } = needs;
  if (!Array.isArray(connectors) || !connectors.every((pattern) => typeof pattern === "string" && pattern.startsWith("^mcp__"))) return "metadata.agentOrg.needs.connectors must be a list of patterns anchored at \"^mcp__\"";
  if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string")) return "metadata.agentOrg.needs.commands must be a list of command names";
  return { connectors: [...connectors], commands: [...commands] };
}

/**
 * The mismatch rows of one plugin with a contract, against the host's keys. A major the code does not read is the only row, since the rest of the object
 * is not understood. A null `agentOrgVersion` (no release at HEAD, or none readable) is no range mismatch, since this cannot tell what it is running.
 */
export function contractRows({ entry, name, contract, host, agentOrgVersion = agentOrgVersionDefault, onPath = onPathDefault }: Readonly<{
  entry: string; name: string; contract: Contract; host: HostFacts; agentOrgVersion?: () => string | null; onPath?: (command: string) => boolean;
}>): ContractRow[] {
  const major = Number(contract.contract.split(".")[0]);
  const row = (kind: RowKind, why: string): ContractRow => ({ plugin: entry, kind, why });
  if (!READ_CONTRACT_MAJORS.includes(major)) return [row("contract-major", `${entry} declares contract ${contract.contract}, a major this agent-org does not read: update agent-org, or the plugin to a major agent-org reads.`)];
  const version = agentOrgVersion();
  const rangeRows = version === null || satisfies(version, contract.agentOrg) ? [] : [row("agent-org-range", `This agent-org is ${version}, outside the ${contract.agentOrg} that ${entry} works with: update agent-org, or the plugin.`)];
  const connectorRows = contract.needs.connectors.filter((pattern) => !host.connectors.includes(pattern))
    .map((pattern) => row("connector-need", `${entry} needs the connector tools matched by ${pattern}, which tickets.connectors does not allow: add the pattern to tickets.connectors.`));
  const commandRows = contract.needs.commands.filter((command) => !onPath(command)).map((command) => row("command-need", `${entry} needs ${command} on the path, and it is not there: install it.`));
  return [...rangeRows, ...connectorRows, ...commandRows, ...skillRowsOf({ entry, name }, contract, host), ...planFileRows(entry, contract, host), ...notEnabledRows(host)];
}

/**
 * The host's skill names this contract does not provide at their extension point. A bare `prReview` name is no plugin's, so it is compared with every
 * contract's; a `plugin:skill` name is compared with its own plugin's contract only.
 */
function skillRowsOf({ entry, name }: Readonly<{ entry: string; name: string }>, contract: Contract, host: HostFacts): ContractRow[] {
  return skillRefs(host).filter(({ plugin, key }) => plugin === name || (plugin === null && key === "prReview"))
    .filter(({ key, skill }) => skill !== skillPart(contract.provides[key]?.skill ?? ""))
    .map(({ key, plugin, skill }): ContractRow => ({ plugin: entry, kind: "skill-not-provided",
      why: `${KEY_OF[key]} names ${plugin === null ? skill : `${plugin}:${skill}`}, which ${entry} does not provide as its ${key} skill: name a skill it provides, or remove the key.` }));
}

/** The plan file the planner writes, with a sample ticket's id and slug, must match `tickets.plan`. No row when the host names no plan pattern. */
function planFileRows(entry: string, contract: Contract, host: HostFacts): ContractRow[] {
  const planFile = contract.provides.planner?.planFile;
  if (host.plan === null || planFile === undefined) return [];
  const sample = planFile.replaceAll("<issue-id>", "A11-1").replaceAll("<slug>", "sample");
  if (new RegExp(host.plan).test(sample)) return [];
  return [{ plugin: entry, kind: "plan-file", why: `tickets.plan does not match the plan file ${entry}'s planner writes, such as ${sample}: set tickets.plan to match it.` }];
}

/**
 * A host key that names a plugin `tickets.plugins` does not enable. It is a row only where a plugin declares a contract, so a machine whose plugins
 * declare none is checked as it always was. The row is about the named plugin, and the caller de-duplicates it across contracts. PURE.
 */
function notEnabledRows(host: HostFacts): ContractRow[] {
  const enabled = host.plugins.map(pluginName);
  return skillRefs(host).flatMap(({ key, plugin, skill }): ContractRow[] => (plugin === null || enabled.includes(plugin) ? [] : [{ plugin, kind: "plugin-not-enabled",
    why: `${KEY_OF[key]} names ${plugin}:${skill}, but tickets.plugins does not enable ${plugin}: add that plugin to tickets.plugins.` }]));
}
