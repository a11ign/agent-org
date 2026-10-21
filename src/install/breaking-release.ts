// @ts-check
// module: whether a move between releases is BREAKING -- a changeset whose first line starts `Breaking: ` (A11-169)
//
// A RELEASE MARKS ITSELF BREAKING IN ITS CHANGESET, not in its bump level: the repository is 0.x, where `minor` is already the level a pinned project must read before it takes (`.changeset/README.md`),
// so a `major` never comes and a `minor` is not a signal. The summary's first line is what changesets writes into the tagged `CHANGELOG.md` as `- <sha>: <first line>`, under the release's
// `## x.y.z` heading, and `update` reads that file from the target tag. A move is breaking when any release in (installed, target] has such a line: a run that started before it may not be resumable
// on it, so it drains instead of applying while runs are live.
import { compareReleaseTags, isReleaseTag } from "../lib/release-tag.ts";

/** One breaking line the changelog holds: the release it is under, and the summary. */
export type BreakingLine = Readonly<{ release: string; summary: string }>;

const HEADING = /^## (\d+\.\d+\.\d+)\s*$/;
/** A changesets entry whose summary starts `Breaking:`: `- 1a2b3c4: Breaking: …`, or the same with no commit hash (an entry written by hand). */
const BREAKING_ENTRY = /^- (?:[0-9a-f]{7,40}: )?(Breaking: .*)$/;

/**
 * The breaking lines of the releases after `installed` up to and including `target`, from the changelog text at `target`. `installed` may be no release (a main build, or unknown): then only
 * `target`'s own section is read, since nothing says where the range starts.
 */
export function breakingLines(changelog: string, installed: string | null, target: string): BreakingLine[] {
  const found: BreakingLine[] = [];
  let release: string | null = null;
  for (const line of changelog.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      release = `v${heading[1]}`;
      continue;
    }
    const entry = BREAKING_ENTRY.exec(line);
    if (entry !== null && release !== null && inRange(release, installed, target)) found.push({ release, summary: entry[1] });
  }
  return found;
}

function inRange(release: string, installed: string | null, target: string): boolean {
  if (!isReleaseTag(release) || !isReleaseTag(target) || compareReleaseTags(release, target) > 0) return false;
  return installed !== null && isReleaseTag(installed) ? compareReleaseTags(release, installed) > 0 : release === target;
}
