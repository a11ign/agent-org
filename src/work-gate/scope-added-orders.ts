// SCOPE ADDED TO A ROW AFTER IT WAS CLAIMED IS A NEW ROW, NEVER PART OF THE CLAIMED ONE (a11ign#4759; chairman, #4627 comment 6095044053, 2026-10-10; class `row-not-finishable`).
//
// A holder agrees to a Region and an Acceptance. When either grows under them the row they hold is no longer the row they agreed to, and a claim that cannot be finished
// through is the class's whole definition (a11ign#4737 was folded into a claimed row and the worker compacted mid-edit). #4739 made the claim record remember a hash of the
// two sections as they stood (`Claimed-scope:`); THIS reads it against the live row each tick and tells `product-manager`, who owns rows, to file the amendment as its own row.
//
// WHAT IS FLAGGED, AND WHAT NEVER IS: a claimed row whose live `scopeHash` differs from a RECORDED one. A row never claimed has no record; a claim written before #4739 has
// none either (`null`, "nothing to compare", never "the scope was empty"); a row whose body or comments were not read is not judged. Prose outside the two sections is not
// scope (`scopeHash` ignores it), so a Done-when or a comment-only amendment is never reported. The hash does not say which way the change went, and so neither does the order.
//
// A LEAF OF THE GATE: it imports `claim-scope.ts` and `claim-labels.ts` and nothing from `work-gate.ts` (`org-health.ts` does, and is a cycle), so the order cap and the
// holder reader arrive as arguments. It reads rows the tick already holds (the open rows' bodies, the claimed rows' comments): no call of its own, no model.
import { CLAIM_LABEL } from "../claim-labels.ts";
import { claimedScopeOf, scopeHash } from "../claim-scope.ts";

/** Who hears about a row amended under its holder: `product-manager`, the first reader for rows (routing, chairman 2026-09-14), and not `ceo`. */
const REPORTED_TO = "product-manager";
/** The reading's name AND its `org-health` class (declared in `org-health-suppression.ts`'s table): one word, so a grep for it finds both. The test pins that the causeKey's literal agrees. */
const CLASS = "scope-added-mid-row";

/** One claimed row: the scope its claim record holds (`null` for none) beside the hash of the live row. */
export type ClaimedScope = { number: number; holder: string | null; scope: string | null; live: string };

/** A claimed row whose Region or Acceptance reads differently from what was claimed. */
export type ScopeAddedReading = { kind: typeof CLASS; number: number; holder: string | null; claimed: string; live: string };

type OpenRow = { number: number; body?: unknown; labels?: (string | { name?: string })[]; repoKey?: string };
type RowComments = { number?: number; comments?: { body?: unknown }[] };

const namesOf = (row: OpenRow): string[] => (row.labels ?? []).map((label) => (typeof label === "string" ? label : String(label?.name)));

/**
 * THE CLAIMED ROWS THIS TICK CAN JUDGE, each with the scope its record holds and the hash of its live body.
 *
 * `claimedComments` is `readClaimedRowComments`'s page and `null`/`undefined` when it was refused or not asked: nothing is judged then, which can go quiet and never
 * invents (ABSENCE IS NOT PROOF). A claimed row the page does not carry has no comments here and reads `scope: null`, so it is not flagged either. A row of another
 * tracker (`repoKey`) is skipped: its comments are not on this page and a number would collide. `holderOf` reads the `session:` label, passed in because that reader
 * lives in `work-gate.ts`.
 */
export function claimedScopesOf({ openRows, claimedComments, holderOf }: { openRows: OpenRow[] | null | undefined; claimedComments: RowComments[] | null | undefined; holderOf: (row: OpenRow) => string | null; }): ClaimedScope[] {
  if (!Array.isArray(openRows) || !Array.isArray(claimedComments)) return [];
  const bodiesOf = new Map(claimedComments.map((row) => [Number(row?.number), (row?.comments ?? []).map((c) => String(c?.body ?? ""))]));
  return openRows.flatMap((row) => {
    if (row.repoKey !== undefined || !namesOf(row).includes(CLAIM_LABEL) || typeof row.body !== "string") return [];
    return [{ number: Number(row.number), holder: holderOf(row), scope: claimedScopeOf(bodiesOf.get(Number(row.number)) ?? []), live: scopeHash(row.body) }];
  });
}

/** THE READINGS: a recorded scope that is not the live one. Never-claimed, unrecorded and unchanged rows are not here. */
export function scopeAddedReadings({ claimed }: { claimed: ClaimedScope[]; }): ScopeAddedReading[] {
  return claimed.flatMap(({ number, holder, scope, live }) => (scope !== null && scope !== live ? [{ kind: CLASS, number, holder, claimed: scope, live }] : []));
}

/**
 * ONE ORDER PER ROW AND LIVE HASH, to `product-manager`: a digest line, not a page. The key names the live hash, so an unchanged amended row mints the identical key on every tick
 * and the waker's ledger drops it, while a row amended AGAIN is a second question. The prompt says what to do and where the claimed text is, and does not quote the amendment: the
 * hash is all the record holds, and the row's own edit history holds the text.
 */
export function scopeAddedOrders(readings: ScopeAddedReading[], { limit }: { limit: number; }): any[] {
  const seen = new Set<string>();
  return readings.flatMap(({ number, holder, claimed, live }) => {
    const discriminator = `${number}:${live}`;
    if (seen.has(discriminator)) return [];
    seen.add(discriminator);
    return [{ session: REPORTED_TO, cause: "org-health", subject: `${CLASS}-${number}`, discriminator,
      prompt: `SCOPE ADDED UNDER A HOLDER. #${number}${holder === null ? "" : `, held by \`${holder}\`,`} has a Region or Acceptance that no longer reads as it did when it was claimed `
        + `(\`Claimed-scope: ${claimed}\`, now \`${live}\`). An amendment to a claimed row is a NEW row: FILE the added scope as its own row (a new number, \`blocked-by\` #${number} `
        + `if it needs that row's files) and RETURN #${number}'s Region and Acceptance to what was claimed -- its edit history holds the text.`,
      causeKey: `${REPORTED_TO}/org-health/scope-added-mid-row@${discriminator}` }]; // SPELLED OUT: `org-health-suppression.test.ts` discovers classes by this literal
  }).slice(0, limit);
}
