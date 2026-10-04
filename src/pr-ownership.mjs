/**
 * IS THIS PULL REQUEST THE CLAIMANT'S? One answer, for the open lookup and the merged lookup alike (#3445).
 *
 * `claimFactsFrom` asked it twice and answered twice: the open lookup took a head equal to the claimed branch OR ending `-<row>`, the merged one only
 * the branch itself. #3390's work went to `a11ign/agent-org` as #134 on `agent/chairman-answered-3390`, merged at 11:19:39Z, and the claim named
 * `agent/a-needs-chairman-row-3390`: the merged release never fired, and the holder was nudged as idle 46 minutes later, a wake that re-reads a whole context to
 * say nothing.
 *
 * A LEAF, like `claim-stall.mjs`, which calls it: it imports nothing from the gate.
 *
 * NOT A RUNG: the body's prose. #134's body names the row in a sentence after `Closes: none`, and a sentence is not a field.
 */
import { SESSION_PREFIX } from "./project-vocabulary.mjs";

/** The rungs, in the order they are tried; `ownsPr` returns the first that matched. */
export const RUNGS = Object.freeze(["branch", "row-suffix", "title", "session-label"]);

/**
 * @typedef {{ row: number, branch: string | null, session: string, trackerRepo?: string, soleHolder?: boolean }} Claim `trackerRepo` is the home repository (`owner/repo`) the
 *   row lives in, which the title rung's reference names; without it that rung cannot match, and a rung that cannot be read is no match, never a guess. `soleHolder` is
 *   whether the session holds no other claimed row: only then does its label say WHICH row a pull request is for
 * @typedef {{ headRefName?: string, title?: string, labels?: ({ name?: string } | string)[] }} OwnablePr a `gh pr list --json` object, open or merged
 */

/** A character that can sit inside a repository reference, so `x/a11ign#3390` is not read as `a11ign#3390`. */
const REFERENCE_CHAR = /[\w./-]/;

/**
 * Whether a title ENDS with `reference` (`owner/repo#n`), bare or in the parentheses both agent-org titles carry it in. The character before it must not
 * extend it (`x/a11ign/a11ign#3390` is another repository's), and "ends with" already refuses `#13390` for row 3390 because the reference carries its `#`.
 * @param {string} title @param {string} reference @returns {boolean}
 */
function titleEndsWithReference(title, reference) {
  const bare = title.trimEnd().replace(/\)$/, "");
  if (!bare.endsWith(reference)) return false;
  const before = bare.slice(0, bare.length - reference.length).slice(-1);
  return before === "" || !REFERENCE_CHAR.test(before);
}

/** @param {OwnablePr} pr @param {string} session @returns {boolean} */
function carriesSessionLabel(pr, session) {
  return (pr.labels ?? []).some((label) => String(typeof label === "string" ? label : label?.name) === `${SESSION_PREFIX}${session}`);
}

/**
 * The rung that says `pr` is the claimant's, or `null`. The property is "if and only if one rung says so", in either repository and in either lane.
 * What it does NOT decide: a merge dated before the claim is another instance's work, which is a question about TIME and stays with the caller.
 * @param {Claim} claim @param {OwnablePr} pr @returns {typeof RUNGS[number] | null}
 */
export function ownsPr(claim, pr) {
  const head = pr.headRefName;
  if (head !== undefined && claim.branch !== null && head === claim.branch) return "branch";
  if (head !== undefined && head.endsWith(`-${claim.row}`)) return "row-suffix";
  if (claim.trackerRepo !== undefined && pr.title !== undefined && titleEndsWithReference(pr.title, `${claim.trackerRepo}#${claim.row}`)) return "title";
  // MEASURED LIVE (#3445, Done-when 3): a standing seat holds several rows, and `session:orchestrator` on #3460 (row #3397's) read as the work of
  // #3443 and #2913 beside it, and `session:ceo` on three dependabot pull requests suppressed #1756's idle nudge. The label names a session, not a row.
  if (claim.soleHolder === true && carriesSessionLabel(pr, claim.session)) return "session-label";
  return null;
}
