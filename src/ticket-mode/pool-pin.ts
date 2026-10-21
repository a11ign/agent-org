// @ts-check
// module: the copy of agent-org a run is started with, and the plugin installs its session got (A11-169)
//
// A RUN'S HOOKS AND BRIEF COMMANDS NAME THE VERSION FOLDER THE INSTANCE RUNS FROM (`ctx.hook.bin`, which `server.ts` takes from its own real path, so an instance started through `<tool>/current` names
// `versions/<tag>`). Recording that folder on the entry at each start and each round is what lets an update leave a live run on the copy it began with, and prune keep the folder while it is used.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { toolVersionAt } from "../install/tool-versions.ts";
import { type PluginCopy, type ToolPin } from "./queue/queue-pins.ts";
import { type PoolContext } from "./pool-context.ts";

/** The tool folder a hook command runs: `<root>/src/bin.ts`'s root, and the version that folder is (its name under `versions/`, else its package's). */
export function toolPinOf(ctx: Pick<PoolContext, "hook">): ToolPin {
  const toolRoot = dirname(dirname(ctx.hook.bin));
  const toolVersion = toolVersionAt(toolRoot);
  return { toolRoot, ...(toolVersion === null ? {} : { toolVersion }) };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where each of `wanted` plugins is installed for a session in `folder`, and at which commit, from Claude Code's install record. A plugin with no user or folder install whose files exist is left out, and a record
 * that cannot be read gives none: the pin is a note for `doctor`, never a reason to refuse a start.
 */
export function pluginCopiesOf(wanted: readonly string[], folder: string, record: string = join(homedir(), ".claude", "plugins", "installed_plugins.json")): PluginCopy[] {
  if (wanted.length === 0) return [];
  let plugins: unknown;
  try {
    plugins = (JSON.parse(readFileSync(record, "utf8")) as { plugins?: unknown }).plugins;
  } catch {
    return [];
  }
  if (!isObject(plugins)) return [];
  return wanted.flatMap((plugin): PluginCopy[] => {
    const installs = plugins[plugin];
    if (!Array.isArray(installs)) return [];
    const found = installs.filter(isObject).find((install) => (install.scope === "user" || install.projectPath === folder) && typeof install.installPath === "string" && existsSync(install.installPath));
    if (found === undefined) return [];
    return [{ plugin, path: String(found.installPath), commit: typeof found.gitCommitSha === "string" ? found.gitCommitSha : null }];
  });
}
