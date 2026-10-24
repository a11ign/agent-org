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
export type Choice = Readonly<{ action: "install" | "enable"; reason: string | null }> | Readonly<{ action: null; reason: string }>;

export function pickOf(plugin: Plugin): Choice | null {
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
