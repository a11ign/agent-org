// module: what the Plugins page decides from the instance's answers -- each card's status in words, its checks, the controls it offers, the Claude plugins' health and needs, and the key changes they make -- with no React and no browser
//
// THE PAGE DRAWS WHAT THE SERVER RETURNS. A plugin's state, its checks, its fix, why a control is off and the sentence that confirms one are `pluginHealth`'s (`/api/plugins`); a Claude plugin's
// install, its contract and its mismatches are `pluginProblems`'. What is here is only the choosing between them, and the few words the boards fix (a concern's purpose, "Checks pass").
import type { Change, EditFile, PluginsAnswer, SettingsView } from "../api/types.ts";
import { CONCERNS, controlsOf, isProviderLine, ofAnotherPlugin, type ControlName } from "../../../src/ticket-mode/plugins-section.ts";
import type { Row } from "../../../src/ticket-mode/settings-view.ts";
import { isControlRow, visibleGroups, type RowGroup } from "../settings/settings-model.ts";

export type Concern = PluginsAnswer["concerns"][number];
export type Plugin = Concern["plugins"][number];
export type ClaudePlugin = PluginsAnswer["claude"]["plugins"][number];

/** How a status reads: whole, in need of attention, failed, or not known. A state is always said in words as well. */
export type Tone = "ok" | "warn" | "danger" | "unknown";

export type Status = Readonly<{ tone: Tone; text: string }>;

/** What each concern is for, as the boards word it under its name. */
const PURPOSE: Readonly<Record<Concern["concern"], string>> = {
  tracker: "Where tickets are kept and read",
  codeHost: "Pull requests, reviews and checks",
  publisher: "Announces the pull requests you choose",
  reviewer: "Starts the gate's reviewer for each ready pull request",
  exposure: "How the board and worker terminal are served",
  messaging: "Asks and announcements for the chairman",
};

export const purposeOf = (concern: Concern): string => PURPOSE[concern.concern];

/** What the page calls a concern: its card's name. */
export const titleOf = (concern: Concern): string => CONCERNS.find((entry) => entry.concern === concern.concern)?.title ?? concern.label;

/** The plugin a card shows in its header: the one that runs the concern, else the one a block names (a disabled one), else none. */
export const shownPlugin = (concern: Concern): Plugin | null => concern.plugins.find((plugin) => plugin.enabled) ?? concern.plugins.find((plugin) => plugin.installed) ?? null;

/** The name a check is listed under, as the boards write it: `tracker (linear)`, `code host (github)`. */
export const checkNameOf = (concern: Concern, plugin: Plugin): string => `${concern.label} (${plugin.name})`;

/** One line of a card's checks: what is checked, what it found, how it reads, and what to run to fix it (a Copy button each). */
export type CheckRow = Readonly<{ name: string; detail: string; tone: Tone; fixes: readonly string[] }>;

/** What the instance's unreachable state says of a check that could not run, in the Unknown board's words. */
export const notChecked = (instance: string): string => `Not checked: ${instance} can't be reached.`;

function rowsOfPlugin(concern: Concern, plugin: Plugin): CheckRow[] {
  const failure: CheckRow[] = plugin.failure === null ? [] : [{ name: checkNameOf(concern, plugin), detail: plugin.failure.why, tone: "danger", fixes: [plugin.failure.fix] }];
  const checks = plugin.checks.map((check): CheckRow => ({ name: check.name, detail: check.detail, tone: check.ok ? "ok" : "warn", fixes: check.ok || check.fix === null ? [] : [check.fix] }));
  if (failure.length + checks.length > 0) return [...failure, ...checks];
  const detail = plugin.enabled ? `${plugin.name} is enabled.` : `${plugin.name} is disabled. Its settings are kept.`;
  return [{ name: checkNameOf(concern, plugin), detail, tone: plugin.enabled ? "ok" : "unknown", fixes: [] }];
}

/** The checks a card lists: the plugin's own, or why none runs, or, for an instance that cannot be reached, that nothing was checked. */
export function checkRowsOf(concern: Concern, instance: string | null): CheckRow[] {
  const plugin = shownPlugin(concern);
  if (instance !== null) return [{ name: plugin === null ? concern.label : checkNameOf(concern, plugin), detail: notChecked(instance), tone: "unknown", fixes: [] }];
  if (plugin === null) {
    return [{ name: concern.label, detail: concern.empty?.text ?? "None", tone: concern.required ? "warn" : "unknown", fixes: concern.empty?.commands ?? [] }];
  }
  return rowsOfPlugin(concern, plugin);
}

const failingCount = (plugin: Plugin): number => plugin.checks.filter((check) => !check.ok).length;

/** The status a card's header says, in words: whether the plugin that runs the concern is whole. */
export function statusOf(concern: Concern, instance: string | null): Status {
  if (instance !== null) return { tone: "unknown", text: "Unknown" };
  const plugin = shownPlugin(concern);
  if (plugin === null) return concern.required ? { tone: "warn", text: "Not running" } : { tone: "unknown", text: "None" };
  if (plugin.state === "failed") return { tone: "danger", text: "Failed" };
  const failing = failingCount(plugin);
  if (failing > 0) return { tone: "warn", text: `${failing} ${failing === 1 ? "check" : "checks"} failing` };
  return plugin.enabled ? { tone: "ok", text: "Checks pass" } : { tone: "unknown", text: "Disabled" };
}

/** The controls a plugin draws as buttons, in order. Configure is not one: its settings are drawn in the card. */
export const buttonsOf = (plugin: Plugin): readonly ButtonName[] => controlsOf(plugin.controls.offered).filter((name): name is ButtonName => name !== "configure");

export type ButtonName = Exclude<ControlName, "configure">;

/** Why the buttons that are off are off, in the plan's own sentences, each once. */
export const lockReasons = (plugin: Plugin): string[] => [...new Set(buttonsOf(plugin).flatMap((name) => plugin.controls.refused[name] ?? []))];

/** What picking a plugin in the card's "Active plugin" choice does: the action it takes, or why it cannot be picked. Null for the plugin that is active already. */
export type Pick = Readonly<{ action: "install" | "enable"; reason: string | null }> | Readonly<{ action: null; reason: string }>;

export function pickOf(plugin: Plugin): Pick | null {
  if (plugin.enabled) return null;
  for (const action of ["enable", "install"] as const) {
    if (plugin.controls.offered.includes(action)) return { action, reason: plugin.controls.refused[action] ?? null };
  }
  return { action: null, reason: plugin.installCommand };
}

/** A concern with more than one plugin in its catalog offers the choice of which is active. */
export const hasChoice = (concern: Concern): boolean => concern.plugins.length > 1;

/**
 * The rows of a concern's own settings, in the host file's order: the ones this page changes in place, from its group of the Settings view, without the plugin and enabled lines and without a
 * setting only another plugin of the concern declares. A row the page cannot change (an object, a key's Keychain service) is the Machine page's to show, so the cards draw the boards' inputs only.
 */
export function concernRows(view: SettingsView | null, concern: Concern): RowGroup[] {
  const group = CONCERNS.find((entry) => entry.concern === concern.concern)?.group ?? null;
  if (view === null || group === null) return [];
  const rows = (view.groups.find((entry) => entry.group === group)?.rows ?? []).filter((row) => row.editable && row.input !== null && !isProviderLine(row.key) && !isControlRow(row))
    .map((row): Row => ({ ...row, inUse: row.inUse && !ofAnotherPlugin(concern.plugins, row.key) }));
  return visibleGroups([{ group, rows }], { query: "", showDefaults: true });
}

// ---- The Claude plugins ----

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

// ---- The page's words ----

/** Whether the page draws no control for a connection: a remote instance's files are changed on that machine. */
export const isLocal = (connection: Readonly<{ kind: string }> | null): boolean => connection === null || connection.kind === "local";

/** The heading of the dialog that asks before an uninstall. */
export const uninstallHeading = (plugin: Plugin): string => `Uninstall ${plugin.name}?`;

/** The heading of the dialog that asks before a switch: "Switch the publisher to another plugin?". */
export const switchHeading = (concern: Concern): string => `Switch the ${concern.label} to another plugin?`;

/** What a file is called in a sentence: "host file", or "project file". */
export const fileWords = (file: EditFile): string => (file === "project.json" ? "project file" : "host file");

/** The line both dialogs end with: where the previous file is kept. */
export const backupLine = (file: EditFile): string => `The previous ${fileWords(file)} is kept as ${file}.bak.`;

/** The restart note both dialogs carry. */
export const RESTART_NOTE = "Takes effect after the board restarts.";
