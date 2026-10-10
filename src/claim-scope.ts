// @ts-check
// WHAT A ROW PROMISED WHEN IT WAS CLAIMED, AS A LEAF -- a11ign#4759 (class `row-not-finishable`, #4627).
//
// `row-claim.ts` WRITES the `Claimed-scope:` line of the claim record (#4739) and the gate's tick has to COMPARE it with the live row (`work-gate/scope-added-orders.ts`).
// The tick cannot import `row-claim.ts`: `claim-labels.ts`'s header gives the reason (its rule-set graph, a board snapshot and a `gh` graph in a tick whose property is that
// it is two reads and no model), and #2110 moved `CLAIM_RECORD_MARKER` out for the same one. So the hash, the two sections it covers and the reader of the line live here,
// and `row-claim.ts` re-exports `scopeHash` so its call sites and `row-claim.test.ts` are unchanged.
//
// IMPORTS `region-paths.ts` AND `claim-labels.ts` AND NOTHING ELSE, as `claim-stall.ts` reads the claim record from the same two: anything heavier is a cycle through the
// module this one was split out of.
import { createHash } from "node:crypto";
import { CLAIM_RECORD_MARKER } from "./claim-labels.ts";
import { extractLabeledSection } from "./region-paths.ts"; // the section reader `templateFieldsReason` uses, so the hash and the template check read one Region

/** The claim record's line that names the scope the holder agreed to (#4739). */
export const CLAIM_RECORD_SCOPE = "Claimed-scope:";
/** The two sections that ARE a row's scope. Prose, Done-when and Open-check around them are not. */
export const SCOPE_SECTIONS = ["Region", "Acceptance"] as const;
export const SCOPE_HASH_LENGTH = 12;

/**
 * Pure: a short hash of the row's `## Region` and `## Acceptance` sections and of nothing else, whitespace-normalised.
 *
 * Both sections are read by `extractLabeledSection`, the reader the template-fields check runs over this same body, so the hash cannot disagree
 * with the claim about what the Region is. Prose outside the two sections gives the same hash; a path added to, removed from or changed in either gives
 * another. A SECTION THAT IS ABSENT hashes as absent (`null`), which is not the empty string, so a row that gains a Region section reads as a change.
 *
 * It reports a change and does not say which way it went: a narrowing hashes differently from the original exactly as a widening does, and
 * what to do about each is the comparing row's decision.
 * @param {string} body the row's issue body
 * @returns {string} hex, `SCOPE_HASH_LENGTH` characters
 */
export function scopeHash(body: string): string {
  const sections = SCOPE_SECTIONS.map((field) => extractLabeledSection(body, field)?.replace(/\s+/g, " ").trim() ?? null);
  return createHash("sha256").update(JSON.stringify(sections)).digest("hex").slice(0, SCOPE_HASH_LENGTH);
}

/**
 * Pure: the `Claimed-scope:` hash the NEWEST claim-record comment carries, or `null`.
 *
 * `null` is "nothing to compare" and never a hash of an empty row: it is the answer for no record, for a RELEASE (which writes the marker with no field lines, so a
 * released row remembers no scope), and for every claim written before #4739 existed. Newest wins, exactly as `claimRecordFrom` reads the other fields, so a row
 * claimed again after a release is compared with what its CURRENT holder agreed to.
 * @param {string[]} comments comment bodies, oldest first
 * @returns {string | null}
 */
export function claimedScopeOf(comments: string[]): string | null {
  const newest = comments.filter((c) => c.includes(CLAIM_RECORD_MARKER)).at(-1);
  if (newest === undefined) return null;
  const match = new RegExp(`^${CLAIM_RECORD_SCOPE}\\s*(.+)$`, "m").exec(newest);
  return match ? match[1].trim() : null;
}
