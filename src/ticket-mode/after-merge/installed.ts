// @ts-check
// module: whether a ticket's change is in a release installed on this host (A11-302) -- when a window begins, and when the board starts the verifier run of an `agent` check
//
// A CHECK ABOUT A CHANGE CANNOT BE RUN BEFORE THE CHANGE IS THERE. The board lists a ticket's After-merge checks when its pull requests merge, but "for a week, no X happens" is about the release that carries the change, and a verifier run
// sent at merge would look at the old build. So a change counts as installed when:
//   - every pull request of the ticket that merged into THIS tool's repository is in the release this instance runs: the tool folder holds the `.acceptance/<branch>.md` file that pull request carried (every pull request of the tool
//     carries one, named by its branch, and a release ships the files of everything merged into it); and
//   - every pull request that merged into another repository has had {@link OTHER_REPOSITORY_GRACE_MS} to be released and installed by that repository's own release process, which this host cannot read.
// A ticket whose merges the run log no longer holds reads as installed: the board cannot say the change is not there, and a check that waits for ever helps no one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "../queue/run-log.ts";

/** How long a change merged into a repository other than the tool's has to be released and installed before it reads as installed. */
export const OTHER_REPOSITORY_GRACE_MS = 60 * 60_000;

/** A pull request of a ticket that merged: its address and when. */
export type Merge = Readonly<{ url: string; at: number }>;

const PULL = /^https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/\d+$/;

/** The merges a ticket's run log records. PURE. */
export const mergesIn = (events: readonly RunEvent[] | undefined): Merge[] => (events ?? []).flatMap((event) => (event.kind === "merged" ? [{ url: event.url, at: event.at }] : []));

/** The repository (`owner/name`) the tool was installed from, read from the `repository` of its `package.json`, or null when it names none. */
export function ownRepositoryOf(toolRoot: string): string | null {
  try {
    const { repository } = JSON.parse(readFileSync(join(toolRoot, "package.json"), "utf8")) as { repository?: { url?: unknown } | string };
    const url = typeof repository === "string" ? repository : repository?.url;
    return typeof url === "string" ? /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(url)?.[1] ?? null : null;
  } catch {
    return null;
  }
}

/** Whether the tool folder holds the acceptance file of a pull request of ticket `key`: a file of `.acceptance/` named by a branch that starts with the ticket's key, in lower case. */
export function holdsChange(toolRoot: string, key: string): boolean {
  const dir = join(toolRoot, ".acceptance");
  if (!existsSync(dir)) return false;
  const wanted = key.toLowerCase();
  return readdirSync(dir).some((name) => name.toLowerCase().startsWith(`${wanted}-`) || name.toLowerCase().includes(`~${wanted}-`));
}

/** What the reader knows: the tool folder this instance runs from (undefined when it has none), the clock, and the merges of a ticket. */
export type InstalledReads = Readonly<{ toolRoot: string | undefined; now: () => number; merges: (key: string) => readonly Merge[] }>;

/** Whether ticket `key`'s change is in a release installed on this host. */
export function isInstalled(reads: InstalledReads, key: string): boolean {
  const merges = reads.merges(key);
  if (merges.length === 0) return true;
  const own = reads.toolRoot === undefined ? null : ownRepositoryOf(reads.toolRoot);
  return merges.every(({ url, at }) => {
    const repository = PULL.exec(url)?.[1];
    if (repository !== undefined && repository === own && reads.toolRoot !== undefined) return holdsChange(reads.toolRoot, key);
    return reads.now() - at >= OTHER_REPOSITORY_GRACE_MS;
  });
}
