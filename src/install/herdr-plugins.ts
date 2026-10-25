// @ts-check
// module: read a herdr plugin out of herdr's `plugins.json` BY ITS SOURCE REPOSITORY, never by its manifest id (A11-287)
//
// herdr keys an install by the `id` in the plugin's own manifest. At v0.4.16 `devswha/herdr-web-ui` changed that id from `devswha.herdr-web-ui` to `devswha.ovis`, so `herdr plugin install` did not
// replace the old entry: it ADDED a second one with the same `source`. agent-org installs by `owner/repo`, so that is the stable key; the id is whatever the release says. Every reader of
// `plugins.json` (upkeep's read-back, doctor, the terminal service's `plugin_root`) goes through here, so they all pick the same entry.
//
// PURE over the text of the file.
import { isAbsolute } from "node:path";
import { compareReleaseTags, isReleaseTag } from "../lib/release-tag.ts";

/** What herdr's `plugins.json` says of one installed copy of a plugin. */
export type InstalledPlugin = Readonly<{
  /** The manifest id herdr keys the copy by; the argument of `herdr plugin uninstall`. */
  pluginId: string;
  /** The ref it was asked for (null for none, or the default branch). */
  ref: string | null;
  /** The commit it resolved to. */
  commit: string | null;
  /** Where it is installed (`plugin_root`), when that is an absolute path. */
  root: string | null;
}>;

/** Every copy of one repository: the one that counts, and the superseded ones a release's id rename left behind. */
export type PluginEntries = Readonly<{ current: InstalledPlugin; stale: readonly InstalledPlugin[] }>;

type Candidate = Readonly<{ plugin: InstalledPlugin; installedAt: number; index: number }>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const sourceRepo = (source: unknown): string | null => (isObject(source) && typeof source.owner === "string" && typeof source.repo === "string" ? `${source.owner}/${source.repo}`.toLowerCase() : null);

/** The plugins `plugins.json` lists, or null when the text is not a list of them. */
function listed(pluginsJson: string | null): unknown[] | null {
  if (pluginsJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(pluginsJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function candidateOf(entry: unknown, index: number, wanted: string): Candidate | null {
  if (!isObject(entry) || typeof entry.plugin_id !== "string") return null;
  // An entry with no `source` (linked by hand, or an old fixture) still matches on its id being `owner.repo`.
  if (sourceRepo(entry.source) !== wanted && entry.plugin_id.toLowerCase() !== wanted.replace("/", ".")) return null;
  const source = isObject(entry.source) ? entry.source : {};
  const root = entry.plugin_root;
  const plugin: InstalledPlugin = {
    pluginId: entry.plugin_id,
    ref: typeof source.requested_ref === "string" && source.requested_ref !== "" ? source.requested_ref : null,
    commit: typeof source.resolved_commit === "string" ? source.resolved_commit : null,
    root: typeof root === "string" && isAbsolute(root) ? root : null,
  };
  return { plugin, installedAt: typeof source.installed_unix_ms === "number" ? source.installed_unix_ms : 0, index };
}

const tagOf = (candidate: Candidate): string | null => (candidate.plugin.ref !== null && isReleaseTag(candidate.plugin.ref) ? candidate.plugin.ref : null);

/** Orders copies so the CURRENT one sorts last: the highest release tag, then the latest install, then the last in the file. A copy on no release tag sorts below any copy on one. */
function compareCandidates(a: Candidate, b: Candidate): number {
  const [left, right] = [tagOf(a), tagOf(b)];
  if (left !== null && right !== null && compareReleaseTags(left, right) !== 0) return compareReleaseTags(left, right);
  if ((left === null) !== (right === null)) return left === null ? -1 : 1;
  return a.installedAt - b.installedAt || a.index - b.index;
}

/** The copies of `repo` (`owner/repo`, any case) in the text of herdr's `plugins.json`, or null when it is not installed or the file is not herdr's. */
export function pluginEntries(pluginsJson: string | null, repo: string): PluginEntries | null {
  const plugins = listed(pluginsJson);
  if (plugins === null) return null;
  const wanted = repo.toLowerCase();
  const found = plugins.flatMap((entry, index) => candidateOf(entry, index, wanted) ?? []).toSorted(compareCandidates);
  const current = found.at(-1);
  return current === undefined ? null : { current: current.plugin, stale: found.slice(0, -1).map(({ plugin }) => plugin) };
}

/** The copy of `repo` that counts, or null when it is not installed or the file is not herdr's. */
export const installedPlugin = (pluginsJson: string | null, repo: string): InstalledPlugin | null => pluginEntries(pluginsJson, repo)?.current ?? null;
