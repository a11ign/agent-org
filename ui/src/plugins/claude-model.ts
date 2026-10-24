// module: what the Claude plugins tab decides from the instance's answer -- each plugin's health in words, its needs from the machine, the skills it provides for each job, and the key changes that add, remove or change them -- with no React and no browser
//
// KEPT APART FROM THE AGENT-ORG PLUGINS (`plugins-model.ts`): a Claude plugin is what `tickets.plugins` lists, read by `pluginProblems`, and it is changed only as keys of the host file. Nothing here
// names a concern, a control or a plugin of agent-org.
import type { Change, PluginsAnswer, SettingsView } from "../api/types.ts";
import { notChecked, type Status, type Tone } from "./plugins-model.ts";

export type ClaudePlugin = PluginsAnswer["claude"]["plugins"][number];

/** The health of a Claude plugin in one word, the way a card's header says it. */
export function claudeStatusOf(plugin: ClaudePlugin, instance: string | null): Status {
  if (instance !== null || plugin.loads === null) return { tone: "unknown", text: "Unknown" };
  if (!plugin.loads) return { tone: "warn", text: "Does not load" };
  if (plugin.rows.length > 0) return { tone: "warn", text: `${plugin.rows.length} ${plugin.rows.length === 1 ? "need" : "needs"} not met` };
  return { tone: "ok", text: "Loads" };
}

/** One line of a Claude plugin's health: what is found, how it reads, and, when a fix is to be run, the sentence that names it. */
export type HealthLine = Readonly<{ tone: Tone; text: string; fix: string | null }>;

const installWords = (plugin: ClaudePlugin): string => plugin.installs.map((install) => (install.scope === "user" ? "user scope" : `project ${install.projectPath ?? ""}`.trim())).join(", ");

/** The health of a Claude plugin in words: whether workers get it, then each mismatch of its contract with this machine. */
export function healthLinesOf(plugin: ClaudePlugin, instance: string | null, record: Readonly<{ readable: boolean }>): HealthLine[] {
  if (instance !== null) return [{ tone: "unknown", text: `${notChecked(instance)} Whether the plugin loads is unknown.`, fix: null }];
  if (plugin.loads === null) {
    const why = record.readable ? "Whether the plugin loads cannot be told from Claude Code's install record." : "Claude Code's install record cannot be read, so whether the plugin loads is unknown.";
    return [{ tone: "unknown", text: `Not checked: ${why}`, fix: null }];
  }
  const loads: HealthLine = plugin.loads
    ? { tone: "ok", text: `Installed for workers (${installWords(plugin)}).`, fix: null }
    : { tone: "warn", text: "Workers do not get this plugin.", fix: plugin.why };
  return [loads, ...plugin.rows.map((row): HealthLine => ({ tone: "warn", text: row.why, fix: null }))];
}

/** A need of a Claude plugin's contract, and whether this machine meets it. */
export type Need = Readonly<{ label: string; value: string; tone: Tone; text: string }>;

/** The connectors and commands the plugin's contract needs from this machine, each with its state from the contract's mismatch rows. */
export function needsOf(plugin: ClaudePlugin, instance: string | null): Need[] {
  const needs = plugin.contract?.needs;
  if (needs === undefined) return [];
  const unmet = (kind: ClaudePlugin["rows"][number]["kind"], mention: string): boolean => plugin.rows.some((row) => row.kind === kind && row.why.includes(mention));
  const connectors = needs.connectors.map((pattern): Need => {
    if (instance !== null) return { label: "Connector tool", value: pattern, tone: "unknown", text: "Not checked" };
    return unmet("connector-need", pattern) ? { label: "Connector tool", value: pattern, tone: "warn", text: "Not allowed in tickets.connectors" } : { label: "Connector tool", value: pattern, tone: "ok", text: "Allowed in tickets.connectors" };
  });
  const commands = needs.commands.map((command): Need => {
    if (instance !== null) return { label: "Command on the path", value: command, tone: "unknown", text: "Not checked" };
    return unmet("command-need", `needs ${command} on the path`) ? { label: "Command on the path", value: command, tone: "warn", text: "Not found" } : { label: "Command on the path", value: command, tone: "ok", text: "Found" };
  });
  return [...connectors, ...commands];
}

/** The two jobs a Claude plugin's contract can provide a skill for on this page, each with the host key that names its skill. */
export const SKILL_JOBS = [
  { point: "writer", key: "tickets.writer.run", label: "Writing a new ticket", words: "The ticket writer runs this skill." },
  { point: "prReview", key: "tickets.prReview", label: "Review before a pull request", words: "A push is refused until a worker has run it." },
] as const;

export type SkillJob = (typeof SKILL_JOBS)[number];

/** A `plugin:skill` a run's text names. The backend reads the same pattern (`SKILL_IN_TEXT` in `plugin-contract.ts`): both names start with a letter, so a colon before a port or a step names none. */
const SKILL_IN_TEXT = /(?<![\w.:-])[A-Za-z][\w-]*:[A-Za-z][\w-]*/g;

/** The skills of `plugin` that a run's text names, each once. */
export const skillsNamedIn = (text: string, plugin: string): string[] => [...new Set(text.match(SKILL_IN_TEXT) ?? [])].filter((token) => token.startsWith(`${plugin}:`));

/** What a job's host key holds, as text, or null when it is not set. */
export function heldText(view: SettingsView | null, key: string): string | null {
  const row = view?.groups.flatMap((group) => group.rows).find((candidate) => candidate.key === key && candidate.file === "host.json");
  return row?.raw === undefined || row.raw === "" ? null : row.raw;
}

/** The skill a job names now, when it names exactly one of this plugin's: the writer's instruction names it inside its text, the review key is the skill. Null when the key is not set or names none or several. */
export function chosenSkill(job: SkillJob, text: string | null, plugin: ClaudePlugin): string | null {
  if (text === null) return null;
  if (job.point === "prReview") return text;
  const named = skillsNamedIn(text, plugin.name);
  return named.length === 1 ? named[0] : null;
}

/** The change that makes a job use `skill`: the review key is set to it, and the writer's instruction has the skill it names replaced, so its `{request}` and `{dir}` stay. */
export function skillChange(job: SkillJob, text: string | null, plugin: ClaudePlugin, skill: string): Change {
  if (job.point === "prReview") return { key: job.key, value: skill };
  const current = chosenSkill(job, text, plugin);
  return { key: job.key, value: current === null || text === null ? skill : text.replaceAll(current, skill) };
}

/** The skills a plugin's contract provides for a job, which are the choices of its select. */
export function skillOptions(job: SkillJob, plugin: ClaudePlugin): string[] {
  const provided = plugin.contract?.provides[job.point]?.skill;
  return provided === undefined ? [] : [provided];
}

/** The entries `tickets.plugins` lists now. */
export const listedPlugins = (claude: PluginsAnswer["claude"]): string[] => claude.plugins.map((plugin) => plugin.entry);

export const addPluginChange = (listed: readonly string[], entry: string): Change => ({ key: "tickets.plugins", value: [...listed, entry] });
export const removePluginChange = (listed: readonly string[], entry: string): Change => ({ key: "tickets.plugins", value: listed.filter((listedEntry) => listedEntry !== entry) });

/** Whether text reads as a plugin to add: a name and a marketplace with an `@` between, no space. */
export const isPluginEntry = (text: string): boolean => /^[^@\s]+@[^@\s]+$/.test(text);

/** The sentence a banner leads with after a key change on the Claude tab. */
export const claudeSaid = {
  added: (entry: string): string => `Added ${entry} to tickets.plugins.`,
  removed: (entry: string): string => `Removed ${entry} from tickets.plugins.`,
  skill: (job: SkillJob, skill: string): string => `${job.label} now uses ${skill}.`,
};

