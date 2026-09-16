#!/usr/bin/env node
// @ts-check
// command: check a PR changing a lane-owned path was opened from that lane's branch, or names its exception
/**
 * A LANE IS WHO MAY CHANGE A PATH -- ceo's ruling, 2026-09-08.
 *
 *   node packages/agent-org/src/workflow-lane-check.mjs --diff=<file of changed paths> --branch=<head ref> --body=<file>
 *
 * ## The incident
 *
 * `.github/workflows/ready-label-audit.yml` gained a `pull_request: [closed]` trigger from a session that
 * does not watch the merge queue. A workflow triggered by `pull_request` attaches its check-run to that
 * PR's head commit, so the audit's verdict appeared on every merged PR as a check named `audit` -- and it
 * failed, on a board-membership call whose PAT cannot read Projects v2. Seven merged PRs carried a red
 * mark for ninety minutes, and the person who found it was the chairman, reading the PR list.
 *
 * Nobody was careless. The trigger was added for a real reason and the reasoning was sound; what was
 * missing is that the consequence -- a red check on every merged PR -- is visible from the queue and from
 * nowhere else. **The author could not see the cost of their own correct change.** That is a property of
 * the boundary, not of the author, which is why the remedy is a check and not a reminder.
 *
 * ## THIS IS NOT THE SAME QUESTION AS `owned-path-signoff.mjs`
 *
 * That check asks what a change to a path must DECLARE, and it lets anyone make the change. This asks who
 * may make it at all. They are deliberately separate files with separate owners and separate data: a path
 * can be lane-owned and fact-free, or fact-heavy and open to everyone, and collapsing them would make one
 * owner's edit silently move the other's rule.
 *
 * ## A LANE IS NOT A WALL, and the exception is PRINTED
 *
 * ceo assigns across lanes deliberately -- the very incident above was ceo's own assignment, in ceo's
 * words, to a session that asked before building. A rule that could not express that would be refused
 * about once a day and then bypassed, which is this repository's own recorded history of guards people
 * stop reading (`A11Y_SKIP_VERIFY=1`, six times in one evening).
 *
 * So the exception is a line in the PR body:
 *
 *     Lane-exception: the pipeline -- assigned by ceo -- <why, in the assigner's words>
 *
 * and it must carry all three parts. A line naming the lane with no reason is "I was told to" with extra
 * steps, and this repository has measured what an agreement that exists only as a sentence is worth: #197,
 * three double-dispatches, each caught by a worker's caution and never by the tool. The check ECHOES the
 * line it accepted, so a crossing is in the run log rather than in somebody's memory.
 *
 * ## It reports what it could not ask, and never treats that as a pass
 *
 * A missing diff file and an empty diff are different answers, and only one of them means nothing
 * lane-owned was touched. Exit 2 is CANNOT_ASK throughout -- including a lane file that is absent or
 * malformed, which must never read as "no path has a lane".
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";

const EXIT = { CLEAR: 0, REFUSED: 1, CANNOT_ASK: 2 };
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
export function exceptionFor(body, lane) {
  for (const line of body.split("\n")) {
    const match = /^\s*Lane-exception:\s*(.+)$/i.exec(line);
    if (!match) continue;
    const [claimedLane, assigner, ...rest] = match[1].split(/\s+--\s+|\s+—\s+/);
    const why = rest.join(" -- ").trim();
    if (claimedLane?.trim().toLowerCase() !== lane.toLowerCase()) continue;
    if (!/assigned by \S/i.test(assigner ?? "") || why.length === 0) continue;
    return line.trim();
  }
  return null;
}

/**
 * THE PURE VERDICT, so every state is exercisable without a PR.
 *
 * @param {{changed: string[] | null, branch: string | null, body: string | null,
 *          lanes: {lanes: Lane[]} | null}} input
 * @returns {{code: number, reasons: string[]}}
 */
export function laneVerdict({ changed, branch, body, lanes }) {
  const missing = [
    changed === null && "the list of changed paths",
    branch === null && "the head branch name",
    body === null && "the pull request body",
    lanes === null && "docs/lane-ownership.json (absent, empty or malformed)",
  ].filter(Boolean);
  if (missing.length > 0) {
    return { code: EXIT.CANNOT_ASK, reasons: [
      `CANNOT SAY whether this change is in its lane: could not read ${missing.join("; ")}.\n`
      + "  INCONCLUSIVE, never clear -- a check that cannot ask must not report a pass.",
    ] };
  }
  const known = /** @type {{lanes: Lane[]}} */ (lanes);
  const head = /** @type {string} */ (branch);
  const text = /** @type {string} */ (body);
  const reasons = [];
  for (const lane of known.lanes) {
    // `except` first: a GENERATED file whose source lives outside the lane is not the lane's to own, so
    // it is subtracted before anything else is asked. Filtered rather than special-cased in the branch
    // check, because the question "is this path in the lane at all" must have one answer -- a path that
    // is excepted must not appear in the refusal's own list of touched paths either.
    const touched = /** @type {string[]} */ (changed)
      .filter((p) => inLane(p, lane.paths) && !inLane(p, lane.except ?? []));
    if (touched.length === 0) continue;
    if (lane.branchPrefixes.some((prefix) => head.startsWith(prefix))) continue;
    const exception = exceptionFor(text, lane.lane);
    if (exception) {
      reasons.push(`LANE CROSSED DELIBERATELY, and recorded: ${exception}`);
      continue;
    }
    reasons.push(`This PR changes ${touched.length} path(s) in ${lane.lane}, which ${lane.owner} owns --\n`
      + `    ${touched.slice(0, 4).join(", ")}${touched.length > 4 ? ", ..." : ""}\n`
      + `  and it is on \`${head}\`, which is not ${lane.branchPrefixes.join(" or ")}.\n\n`
      + `  ${lane.why}\n\n`
      + "  This is not a claim that the change is wrong. It is that the cost of a change here is visible\n"
      + `  from ${lane.owner}'s seat and from nowhere else, so ${lane.owner} builds it: file the row with\n`
      + "  your reasoning in your own words and it gets built from that.\n\n"
      + "  If this WAS assigned across the lane, say so in the body and it passes:\n"
      + `    Lane-exception: ${lane.lane} -- assigned by <who> -- <why>\n`
      + "  All three parts are required, and the line is echoed into the run log rather than merely\n"
      + "  accepted, so the crossing is on the record instead of in somebody's memory.");
    return { code: EXIT.REFUSED, reasons };
  }
  return { code: EXIT.CLEAR, reasons };
}

/** @param {string | undefined} path @returns {string | null} */
const readOrNull = (path) => {
  if (!path) return null;
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

function main() {
  refuseUnknownFlags(["--diff=", "--branch=", "--body=", "--lanes="],
    { entry: import.meta.url, command: "node packages/agent-org/src/workflow-lane-check.mjs" });
  const diff = readOrNull(flagValue(process.argv, "diff"));
  const body = readOrNull(flagValue(process.argv, "body"));
  const branch = flagValue(process.argv, "branch") ?? null;
  const lanesPath = flagValue(process.argv, "lanes");
  const verdict = laneVerdict({
    // A path list is split on newlines and EMPTIED of blanks, so a trailing newline does not become a
    // changed path called "". An unreadable file stays null: absent and empty are different answers.
    changed: diff === null ? null : diff.split("\n").map((l) => l.trim()).filter(Boolean),
    branch: branch && branch.length > 0 ? branch : null,
    body,
    lanes: lanesPath ? loadLanes(lanesPath) : loadLanes(),
  });
  for (const reason of verdict.reasons) console.error(`LANE: ${reason}`);
  if (verdict.code === EXIT.CLEAR && verdict.reasons.length === 0) console.log("LANE: clear");
  process.exit(verdict.code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
