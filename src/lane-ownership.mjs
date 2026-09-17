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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * @typedef {{lane: string, owner: string, branchPrefixes: string[], paths: string[], why: string,
 *   except?: string[], exceptWhy?: string}} Lane
 */

/**
 * The lanes, read from the file `ceo` owns.
 *
 * READ, NEVER INLINED, for `owned-path-signoff.mjs`'s reason: a copy here would be a second spelling of
 * the ruling, and the two would drift. Absent or malformed is CANNOT_ASK, never "nothing has a lane" --
 * a check that answers "clear" because it could not find its own rules is worse than no check.
 *
 * @returns {{lanes: Lane[]} | null}
 */
export function loadLanes(path = resolve(REPO, "docs/lane-ownership.json")) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed?.lanes) || parsed.lanes.length === 0) return null;
    const wellFormed = parsed.lanes.every((/** @type {Lane} */ l) =>
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
export function inLane(changed, paths) {
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
