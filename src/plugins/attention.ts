// @ts-check
// module: how many plugins need attention, the number the Settings sub-nav's Plugins badge shows (A11-201)
//
// PURE. It counts the plugins the Plugins page draws as red or as "not checked", one each: an agent-org plugin that failed to load or has a failing doctor check, a package the registry refused,
// and a Claude Code plugin (`tickets.plugins`) that a worker would not get, whose install cannot be read, or that has a contract row. A plugin that is whole, disabled or not installed is not
// counted, and neither is a required concern with no plugin: the count is of plugins, and the concern's own card says "the board cannot run".
import type { Contract, ContractRow } from "../ticket-mode/plugin-contract.ts";
import type { PluginInstall } from "../ticket-mode/plugins.ts";
import type { PluginHealth } from "./health.ts";

/**
 * A plugin of `tickets.plugins`, as the page draws it. `loads` is true when a worker gets it, false when it does not (`why` names the fix), and null when the install record cannot be read, so
 * its health is unknown. `contract` is what it declares, or null when it declares none (or one that is malformed, which `rows` says). `rows` are its contract mismatches.
 */
export type ClaudePlugin = Readonly<{
  entry: string;
  name: string;
  loads: boolean | null;
  why: string | null;
  installs: readonly PluginInstall[];
  contract: Contract | null;
  rows: readonly ContractRow[];
}>;

/** The Claude Code plugins the host file lists. `readable` is false when Claude Code's install record cannot be read, so every plugin's health is unknown. */
export type ClaudePlugins = Readonly<{ readable: boolean; plugins: readonly ClaudePlugin[] }>;

/** Whether a Claude plugin needs attention: a worker would not get it, nothing can tell whether it does, or its contract disagrees with the host. */
export const claudeNeedsAttention = ({ loads, rows }: ClaudePlugin): boolean => loads !== true || rows.length > 0;

/** The number of plugins that need attention, one each. */
export function attentionOf(health: Pick<PluginHealth, "concerns" | "refused">, claude: ClaudePlugins): number {
  const plugins = health.concerns.flatMap((concern) => concern.plugins);
  const ownFailing = plugins.filter(({ state, checks }) => state === "failed" || checks.some((check) => !check.ok)).length;
  return ownFailing + health.refused.length + claude.plugins.filter(claudeNeedsAttention).length;
}
