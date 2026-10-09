// @ts-check
// (not a command) the ONE reader of `docs/lane-ownership.json` -- imported, never retyped.
//
// EXTRACTED FROM `workflow-lane-check.mjs`, WHICH WAS DELETED. That merge guard refused any PR touching a
// lane-owned path unless it came from the lane's own branch or carried a `Lane-exception:` line naming an
// assigner. `docs/lane-ownership.json` set its own end date -- "The check STAYS until #916 retires it with
// CODEOWNERS on 2026-09-15" -- and that date passed with no CODEOWNERS file in the tree. It was also the
// only guard inside `gate`'s `needs` that an outside contributor could not satisfy: they cannot be `ceo`,
// cannot push a `ceo/` branch, and "file the row and it gets built from that" is an instruction to an
// agent org.
//
// THE LANE DATA OUTLIVES THE CHECK. `row-file.mjs` derives a row's `lane:<owner>` label through these two
// functions, and `row-claim/runner-rule.mjs` reasons about the same file -- so the reader stays and the
// refusal goes. A lane is still a recorded fact about who owns a path; it is no longer a wall in CI.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOME_CHECKOUT } from "./project-config.ts";
import { LANES_FILE_PATH } from "./project-vocabulary.ts";

const REPO = HOME_CHECKOUT;

/**
 * `reviewOnly` is `ceo`'s 2026-09-18 ruling (`_claimVsAuthorRuling`) as data: the lane protects REVIEW, not AUTHORSHIP, so a Region that touches only this lane is anybody's row (#3254) -- and the owner's own login is the one that may not author the PR.
 */
export type Lane = {lane: string, owner: string, branchPrefixes: string[], paths: string[], why: string, except?: string[], exceptWhy?: string, reviewOnly?: boolean};

/**
 * A lane's role-name owner, spelled as the GitHub login that authors that role's pull requests.
 * `docs/lane-ownership.json` names the ROLE and never the account, so the mapping lives here; `work-gate.mjs` and
 * `codeowners-lane-sync.test.ts` each re-assert their own copy (#3254 files the work-gate one).
 */
export const ROLE_LOGIN = Object.freeze({ ceo: "a11ign-ai-leads" });

/**
 * The lanes, read from the file `ceo` owns.
 *
 * READ, NEVER INLINED, for `owned-path-signoff.mjs`'s reason: a copy here would be a second spelling of
 * the ruling, and the two would drift. Absent or malformed is CANNOT_ASK, never "nothing has a lane" --
 * a check that answers "clear" because it could not find its own rules is worse than no check.
 *
 * @returns {{lanes: Lane[]} | null}
 */
export function loadLanes(path = resolve(REPO, LANES_FILE_PATH)): { lanes: Lane[]; } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed?.lanes) || parsed.lanes.length === 0) return null;
    const wellFormed = parsed.lanes.every((l: Lane) =>
      typeof l?.lane === "string" && typeof l?.owner === "string"
      && Array.isArray(l?.branchPrefixes) && Array.isArray(l?.paths));
    return wellFormed ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Does this changed path fall under one of the lane's prefixes?
 *
 * Prefix matching on a directory boundary, so `.github/workflows-notes/x` does not match
 * `.github/workflows/`. A bare file path in the list matches exactly. Same predicate as
 * `owned-path-signoff.mjs`'s `isOwned`, deliberately duplicated rather than shared: the two files answer
 * different questions from different owners' data, and importing one into the other would make a change
 * to either owner's rule reach the other's check.
 *
 * @param {string} changed @param {string[]} paths
 */
export function inLane(changed: string, paths: string[]) {
  return paths.some((prefix) => (prefix.endsWith("/")
    ? changed.startsWith(prefix)
    : changed === prefix || changed.startsWith(`${prefix}/`)));
}

/**
 * The exception line, if the body carries a well-formed one for this lane.
 *
 * ALL THREE PARTS REQUIRED: the lane's name, an assigner, and a reason. The reason is what makes the line
 * worth writing -- a crossing recorded as "assigned by ceo" and nothing else tells the next reader
 * nothing about whether it should have been.
 *
 * @param {string} body @param {string} lane
 * @returns {string | null} the line, verbatim, so the caller can echo it
 */

/**
 * The paths among `files` that sit in a review-only lane and outside its `except` -- what a pull request must touch
 * for `laneAuthorshipRefusal` to have anything to say, so a caller can ask it BEFORE it spends a call on the author.
 * @param {readonly string[]} files @param {{lanes: Lane[]} | null} lanes
 */
export function reviewOnlyPathsIn(files: readonly string[], lanes: { lanes: Lane[]; } | null) {
  const owned = (lanes?.lanes ?? []).filter((lane) => lane.reviewOnly === true);
  return files.filter((f) => owned.some((lane) => inLane(f, lane.paths) && !inLane(f, lane.except ?? [])));
}

/**
 * Is this login the owner of a review-only lane -- the only population `laneAuthorshipRefusal` can refuse, so a caller
 * asks it BEFORE paying for a file list.
 * @param {string | null | undefined} author @param {{lanes: Lane[]} | null} lanes
 */
export function ownsReviewOnlyLane(author: string | null | undefined, lanes: { lanes: Lane[]; } | null) {
  return Boolean(author) && Boolean(lanes?.lanes.some(
    (lane) => lane.reviewOnly === true && (ROLE_LOGIN as Record<string, string>)[lane.owner] === author));
}

/**
 * #3254, #1756 RULING ITEM 7: THE OWNER OF A REVIEW-ONLY LANE DOES NOT AUTHOR A PULL REQUEST INTO IT. Four PRs
 * from `a11ign-ai-leads` touched `.github/workflows/` in about a day (#3238, #3196, #3109, #3066), and a practice
 * breached four times in a day needs a refusal rather than a reminder. Pure: the caller looks up the author and
 * the changed files, so a test drives real shapes.
 *
 * THERE IS NO OVERRIDE, AND THE ARGUMENT LIST SAYS SO: nothing here reads a PR body, a label or a flag, so a
 * `Lane-exception:` line cannot reach it. `main-review-requirement.md`'s reason -- a mechanism that lets the
 * account whose PRs the check gates skip it is decorative for exactly that population. The way out is the
 * chairman's admin edit, which is logged.
 *
 * `except` is subtracted, so a PR touching only `consumer-gate.yml` is not this lane's. `lanes` null (the project
 * declares no lanes file, as an outside contributor's checkout does not) answers `null`: there is no lane to refuse for.
 *
 * @param {{ author: string | null | undefined, files: readonly string[], lanes: {lanes: Lane[]} | null }} pr
 * @returns {string | null} the refusal, naming the row and the ruling, or null when the PR may proceed
 */
export function laneAuthorshipRefusal({ author, files, lanes }: { author: string | null | undefined; files: readonly string[]; lanes: { lanes: Lane[]; } | null; }): string | null {
  if (!author || !lanes) return null;
  for (const lane of lanes.lanes) {
    if (!ownsReviewOnlyLane(author, { lanes: [lane] })) continue;
    const touched = files.filter((f) => inLane(f, lane.paths) && !inLane(f, lane.except ?? []));
    if (touched.length === 0) continue;
    return `\`${author}\` is \`${lane.owner}\`'s login, and the \`${lane.lane}\` lane is review-only: #1756 Ruling item 7 `
      + `says \`${lane.owner}\` does not author a pull request touching it, and #3254 made that a refusal. `
      + `It touches ${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ` and ${touched.length - 3} more` : ""}. `
      + "There is no override and no `Lane-exception:` form: the row is open to any engineer, so an engineer builds this change. "
      + "A pipeline PR that must land while no engineer can author it needs the chairman's logged admin edit.";
  }
  return null;
}

/**
 * #3254: THE AUTHORSHIP REFUSAL FOR ONE PR, WITH THE FILE LIST READ ONLY WHEN THE AUTHOR IS A LANE OWNER'S LOGIN --
 * every other PR pays nothing. Shared by `arm-pr` and `auto-arm-sweep`, the two unattended doors that arm, so neither can arm what the other refuses; `run` is the caller's own `gh`.
 * The list is paged (`gh pr view --json files` stops at 100, and a refusal that read a
 * partial list could miss the path that mattered). A list that cannot be read answers `cannot-ask`, never "clear".
 * @param {{ number: string, repo: string, author: string | null | undefined, run: (ghArgs: string[]) => string,
 *   lanes?: {lanes: Lane[]} | null }} pr
 * @returns {{ kind: "clear" } | { kind: "refused" | "cannot-ask", why: string }}
 */
export function authorshipVerdict({ number, repo, author, run, lanes = loadLanes() }: {
        number: string; repo: string; author: string | null | undefined; run: (ghArgs: string[]) => string;
        lanes?: { lanes: Lane[]; } | null;
    }): { kind: "clear"; } | { kind: "refused" | "cannot-ask"; why: string; } {
  if (!ownsReviewOnlyLane(author, lanes)) return { kind: "clear" };
  try {
    const files = run(["api", "--paginate", `repos/${repo}/pulls/${number}/files`, "--jq", ".[].filename"])
      .split("\n").filter(Boolean);
    const why = laneAuthorshipRefusal({ author, files, lanes });
    return why === null ? { kind: "clear" } : { kind: "refused", why };
  } catch (cause) {
    return { kind: "cannot-ask", why: `could not read #${number}'s changed files: ${(cause as Error).message}` };
  }
}
