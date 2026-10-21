// @ts-check
// module: the Slack plugin's doctor checks (A11-161) -- the publish run names {prs} and {dir}, and the connectors it may call are patterns anchored at ^mcp__
//
// The host-file reader refuses a run that does not name both placeholders (so the board never starts with one); these rows are what doctor and the Settings page say of the plugin when it is
// enabled, and each failure names the exact `agent-org plugin config slack …` command that fixes it.
import type { PluginCheck, PluginSettings } from "../../src/plugins/manifest.ts";

const ok = (name: string, detail: string): PluginCheck => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): PluginCheck => ({ name, ok: false, detail, fix });

/** The command that sets the publish run, with the placeholders named. */
export const RUN_FIX = "agent-org plugin config slack run='<the publish run\\'s instruction, naming {prs} and {dir}>'";

/** The command that sets the connectors the publish run may call. */
export const CONNECTORS_FIX = "agent-org plugin config slack connectors='[\"^mcp__<server>__<send tool>\"]'";

/** Whether a pattern is an anchored regular expression: it starts `^mcp__` and compiles. */
function isConnectorPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== "string" || !pattern.startsWith("^mcp__")) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** Whether the publish run's instruction names both places it is filled in. */
export const isRun = (run: unknown): run is string => typeof run === "string" && run.includes("{prs}") && run.includes("{dir}");

/** Whether the connectors are a non-empty list of anchored patterns. */
export const isConnectors = (connectors: unknown): connectors is readonly string[] => Array.isArray(connectors) && connectors.length > 0 && connectors.every(isConnectorPattern);

/** The rows of the Slack publisher for its block's settings. */
export function slackChecks(settings: PluginSettings): PluginCheck[] {
  const { run, connectors } = settings;
  return [
    isRun(run) ? ok("slack run", "the publish run's instruction names {prs} and {dir}")
      : failed("slack run", run === undefined ? "the publish block names no run" : "the publish run's instruction must name {prs}, filled in with the pull requests, and {dir}, filled in with its folder", RUN_FIX),
    isConnectors(connectors) ? ok("slack connectors", `the publish run may call ${connectors.length === 1 ? "one connector pattern" : `${connectors.length} connector patterns`}, ${connectors.join(", ")}`)
      : failed("slack connectors", connectors === undefined || (Array.isArray(connectors) && connectors.length === 0) ? "the publish block names no connector, so the publish run has no tool to post with"
        : "connectors must be a list of patterns anchored at \"^mcp__\", each a regular expression", CONNECTORS_FIX),
  ];
}
