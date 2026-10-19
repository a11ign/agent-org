// @ts-check
// #4078 (row 1 of #4056): WHICH TRACKER A ROW IS FILED IN, decided by where its WORK sits and not by where its pull request opens.
//
// `row-file` filed every row into the repository the project's first `code` entry names. The chairman's direction on #4056 is that
// agent-org work has its own tracker and board, so product and org time can be read apart. The classification is `ceo`'s rule on
// #4056, which reuses #3820 unchanged: a PRODUCT row has a Region entry under a `releasablePaths` entry of a `dora` repository other
// than the tool's; every other row, an empty or unreadable Region included, is an ORG row. `rowKind` already answers that, so this
// file CALLS it rather than restating it, and adds the one thing missing: the answer as a tracker of the declared `tracker` list.
//
// PURE: nothing here reads a file or runs a command. The declaration is an argument, so a test states its own trackers.
import { productRegionsOf, rowKind } from "./work-gate/causes/rows-offer.ts";
import { splitRegionEntry } from "./region-paths.ts";

/**
 * The tracker an ORG row is filed in. `work-gate.ts` keeps the same fact as an unexported `TOOL_REPO` (that file is not this row's
 * Region), and `row-tracker.test.ts` reads it from there and pins the two equal.
 */
export const ORG_TRACKER_REPO = "a11ign/agent-org";

export type Tracker = import("./project-config.ts").Tracker;

/**
 * The tracker `entries` (a row's Region, as `declaredRegionFiles` reads it) belong in.
 *
 * The FIRST declared tracker is the project's own (`project-config.ts`), so a product row goes there. An org row goes to the tracker of
 * `ORG_TRACKER_REPO` when one is declared, else to the first: a project that has not declared the second tracker files everything where
 * it always did, which is why this row can merge before that declaration exists. With ONE tracker the Region cannot matter.
 * A row is ALSO the home tracker's when it is not product by `rowKind` but EVERY Region entry carries the key of a declared `code` repository
 * other than the tool's (`control:ansible/...`, the lab): `rowKind` calls it org because those repositories are `adopterFacing: false`, which is
 * the share's question and stays `ceo`'s (#3820, #4399), but the work is not the tool's and its pull request opens in that repository, so the
 * org tracker is the wrong place for it (agent-org#771 and #772 were filed there and refiled). A bare entry is not counted: it belongs to the
 * project's first repository by position, and a row written from inside the tool's own tree carries bare paths, so reading them as the home
 * repository's would send the tool's own rows away. An entry under the tool's key, an unknown key, an empty Region and a mix all file as above.
 * `unreadable` is `rowKind`'s own word for a Region it found no entries in, said back so the caller can SAY the row went to the org
 * tracker by default rather than by reading.
 * @param {string[] | null} entries
 * @param {Parameters<typeof productRegionsOf>[0]} dora what `productRegionsOf` reads: the declaration's `code` and `dora` lists
 * @param {readonly Tracker[]} trackers the declaration's `tracker` list, home first
 * @returns {{ tracker: Tracker, unreadable: boolean }}
 */
export function rowTracker(entries: string[] | null, dora: Parameters<typeof productRegionsOf>[0], trackers: readonly Tracker[]): { tracker: Tracker; unreadable: boolean; } {
  const [home] = trackers;
  if (home === undefined) throw new Error("rowTracker: the declaration names no tracker, so there is nowhere to file a row.");
  const { kind, unreadable } = rowKind(entries, productRegionsOf(dora));
  const elsewhere = kind === "org" && entries !== null && entries.length > 0 && entries.every((entry) => namesOtherCodeRepository(entry, dora.code));
  const org = kind === "org" && !elsewhere ? trackers.find((tracker) => tracker.repo === ORG_TRACKER_REPO) : undefined;
  return { tracker: org ?? home, unreadable };
}

/** Whether a Region entry is prefixed with the key of a declared `code` repository that is not the tool's. @param {string} entry @param {{ key: string; repo: string; }[]} code */
function namesOtherCodeRepository(entry: string, code: { key: string; repo: string; }[]): boolean {
  const { key } = splitRegionEntry(entry);
  return key !== "" && code.some((repository) => repository.key === key && repository.repo !== ORG_TRACKER_REPO);
}

/**
 * `--tracker=<key>`: the declared tracker with that key, or the refusal naming every key that IS declared. The home tracker's key is
 * the empty string, which is why the keys are printed quoted: `--tracker=` alone names it.
 * @param {readonly Tracker[]} trackers @param {string} key
 * @returns {{ tracker: Tracker } | { refusal: string }}
 */
export function trackerNamed(trackers: readonly Tracker[], key: string): { tracker: Tracker; } | { refusal: string; } {
  const tracker = trackers.find((candidate) => candidate.key === key);
  if (tracker !== undefined) return { tracker };
  const declared = trackers.map((candidate) => `${JSON.stringify(candidate.key)} (${candidate.repo})`).join(", ");
  return { refusal: `row-file: \`--tracker=${key}\` names no declared tracker. Declared keys: ${declared}. Nothing was filed.` };
}
