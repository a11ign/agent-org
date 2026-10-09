// THE RELEASE SOURCE (a11ign/a11ign#3413, chairman point 2 of #3409): a declared package cut a release, and the chairman is told in ONE line --
// package, version, what changed -- with the release page last. `release:<repo>@<tag>` is the key, so a release is told once however many
// ticks see it, and the core's ledger is the memory that says it was.
//
// A LEAF and INJECTED, as `stall.ts` is: it imports nothing from the tool but that file's own helpers, and it reads GitHub only through `listReleases`.
//
// **THE FIRST RUN ANNOUNCES NO HISTORY (done-when 4).** A repository this source has never read has releases from before anyone asked, and telling
// the chairman five of them at once is the burst this row exists to avoid. So the first successful read of a repository records every release it
// finds as SEEN, sends nothing, and records a baseline marker for the repository. **The marker is what says "not the first run", and a count of
// recorded releases could not:** a repository with no release yet records no release, and its first real one would then look like history.
// Both are ledger lines the watcher already knows how to write (`source-note`, once per distinct reason), so there is no second state file.
// **A READ THAT FAILED RECORDS NOTHING** (`cannot-ask`): the next tick reads that repository as the first run, which is the safe way to be wrong.
//
// **A DRAFT AND A PRE-RELEASE ARE NOT TOLD**, and are not recorded either: one promoted later is a release then, and is told then.
//
// **WHAT CHANGED IS THE RELEASE NOTES' FIRST SENTENCE, NEVER AN INVENTED ONE.** Notes are the changesets' markdown (`### Patch Changes`, a bullet
// that opens with the commit's hash). Empty notes say so in words (`no summary was written`), because a guess would be told to the chairman as fact.

import { instant, observe } from "./stall.ts";

export const RELEASE_KIND = "release";
const KEY_PREFIX = "release:";
const BASELINE_PREFIX = "release-baseline:";
const SUMMARY_LIMIT = 240;
const ELLIPSIS = "…";
const NO_SUMMARY = "(no summary was written)";
/** A changeset's bullet opens with the short hash of the commit that added it: `- 7105923: The isolation gate's copy …`. */
const COMMIT_PREFIX = /^[0-9a-f]{7,40}:\s+/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const SENTENCE_END = /(?<=[.!?])\s/;

export function releaseKey(repo: string, tag: string): string {
  return `${KEY_PREFIX}${repo}@${tag}`;
}

/** The marker that says this repository has been read once. */
export function baselineKey(repo: string): string {
  return `${BASELINE_PREFIX}${repo}`;
}

/**
 * What the ledger holds from earlier runs: every `release:` and `release-baseline:` key a `source-note` line recorded. A release that was TOLD is not
 * here and does not need to be: the core's own ledger refuses it as a duplicate.
 */
export function seenKeys(history: Record<string, any>[]): Set<string> {
  return new Set(history
    .filter((line) => line.kind === "source-note" && typeof line.key === "string" && (line.key.startsWith(KEY_PREFIX) || line.key.startsWith(BASELINE_PREFIX)))
    .map((line) => line.key));
}

/** `a11ign/agent-org` is the package `agent-org`. */
function packageOf(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

/** `v0.7.8` is version `0.7.8`: the `v` is the tag's convention and not part of the number. */
function versionOf(tag: string): string {
  return tag.replace(/^v(?=\d)/, "");
}

/**
 * Drops the markdown a plain-text message would show as noise: a code span's backticks, a bold pair, and a link's address.
 * A lone `*` or `_` stays: `@a11ign/*` and `snake_case` are the words, not emphasis.
 */
function plain(line: string): string {
  return line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`/g, "").replace(/\*\*/g, "");
}

/**
 * The first paragraph or bullet that is not a heading, its wrapped lines joined: a changeset's bullet continues onto the next line when it is long.
 */
function firstBlock(notes: string): string {
  const lines = notes.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (start === -1) return "";
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || LIST_MARKER.test(line) || line.trim().startsWith("#")) break;
    block.push(line);
  }
  return block.map((line) => line.trim()).join(" ");
}

/** At most `SUMMARY_LIMIT` characters, cut at a word and marked. */
function fit(text: string): string {
  if (text.length <= SUMMARY_LIMIT) return text;
  const cut = text.slice(0, SUMMARY_LIMIT - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd()}${ELLIPSIS}`;
}

/**
 * The first sentence of `notes`, or "" when there is none. `notes` is the release's body, as GitHub returns it (null when empty).
 */
export function firstSentence(notes: unknown): string {
  if (typeof notes !== "string") return "";
  const block = plain(firstBlock(notes).replace(LIST_MARKER, "").replace(COMMIT_PREFIX, "")).trim();
  return fit(block.split(SENTENCE_END)[0] ?? "");
}

/** A published, final release: the only kind the chairman is told about. */
function isTold(release: Record<string, any>): boolean {
  return release.draft !== true && release.prerelease !== true;
}

/** The told releases, the oldest first. */
function toldOldestFirst(releases: unknown): Record<string, any>[] {
  if (!Array.isArray(releases)) throw new TypeError("releases: an array was expected");
  return releases.filter(isTold)
    .map((release) => ({ release, at: instant(release.published_at ?? release.created_at, `${release.tag_name}.published_at`) }))
    .sort((a, b) => a.at - b.at)
    .map(({ release }) => release);
}

function eventOf(repo: string, release: Record<string, any>): Record<string, unknown> {
  const sentence = firstSentence(release.body);
  const named = `${packageOf(repo)} ${versionOf(release.tag_name)} is out`;
  return {
    key: releaseKey(repo, release.tag_name), kind: RELEASE_KIND, severity: "info",
    firstSeenAt: instant(release.published_at ?? release.created_at, `${release.tag_name}.published_at`),
    text: sentence === "" ? `${named} ${NO_SUMMARY}` : `${named}: ${sentence}`,
    links: typeof release.html_url === "string" ? [release.html_url] : [], resolved: false,
  };
}

type Note = { reason: string; key: string };

/**
 * The first read of a repository: every release recorded as seen, then the marker last, so a run that stops half way reads the repository as new again.
 */
function baselineNotes(repo: string, releases: Record<string, any>[]): Note[] {
  const existing = releases.map((release) => ({ key: releaseKey(repo, release.tag_name), reason: "existed before the releases source was enabled: recorded as seen, not told" }));
  const count = existing.length === 1 ? "1 release" : `${existing.length} releases`;
  return [...existing, { key: baselineKey(repo), reason: `first read of ${repo}: ${count} recorded as seen and none told` }];
}

function readRepository({ repo, releases, seen }: { repo: string; releases: Record<string, any>[]; seen: Set<string>; }): { events: Record<string, unknown>[]; notes: Note[]; } {
  if (!seen.has(baselineKey(repo))) return { events: [], notes: baselineNotes(repo, releases) };
  const fresh = releases.filter((release) => !seen.has(releaseKey(repo, release.tag_name)));
  return { events: fresh.map((release) => eventOf(repo, release)), notes: [] };
}

/**
 * One event per release not yet seen, the oldest first. A repository whose read fails yields no event and is named in `cannotAsk`, never read as "nothing new".
 * `notes` are the ledger lines to write (see the head of this file); the watcher records each once.
 */
export async function observeReleases({ repos, listReleases, seen, log = () => {} }: { repos: readonly string[]; listReleases: (repo: string) => Promise<unknown> | unknown; seen: Set<string>; log?: (line: string) => void; }): Promise<{ events: Record<string, unknown>[]; notes: Note[]; cannotAsk: { source: string; reason: string; }[]; }> {
  const parts = await Promise.all(repos.map((repo) => observe(
    `release:${repo}`,
    async () => [readRepository({ repo, releases: toldOldestFirst(await listReleases(repo)), seen })],
    log,
  )));
  const readings = parts.flatMap((part) => part.events as unknown as { events: Record<string, unknown>[]; notes: Note[] }[]);
  return {
    events: readings.flatMap((reading) => reading.events),
    notes: readings.flatMap((reading) => reading.notes),
    cannotAsk: parts.flatMap((part) => part.cannotAsk),
  };
}
