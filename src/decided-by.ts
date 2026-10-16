// @ts-check
// THE SEAT A COMMENT SAYS POSTED IT, IN ONE PLACE. A pure leaf: it imports nothing, so `claim-stall.ts` (which loads the project's declaration and the rest of the
// claim machinery) and `pr-hold-state.ts` (which every project's wake loads) can both import it without importing each other.

/**
 * The seat a comment says posted it: the role in the LAST `<!-- decided-by: <role> run: <id> -->` line `host/gh` appends to a comment
 * (agent-org#486; the role alphabet is the one it accepts), or `null` for a body that carries none. The last line is the wrapper's own, appended
 * after whatever the author wrote, so a marker quoted earlier in the body does not speak for the comment.
 *
 * @param {unknown} body @returns {string | null}
 */
export function decidedBy(body: unknown): string | null {
  const marks = [...String(body ?? "").matchAll(/<!--\s*decided-by:\s*([A-Za-z0-9._-]+)(?:\s+run:\s*\S+)?\s*-->/g)];
  return marks.at(-1)?.[1] ?? null;
}

/** Who is asked when a worker declares `blocked` and names nobody, and who closes a row a claimant read as done: the first reader for rows and process (`engineer.md`, "Nobody is at the terminal"). One name, so the gate's readers cannot drift from the worker's. */
export const DEFAULT_ANSWERER = "product-manager";

/** The seats that decide for the org. Their comments are told apart by the `decided-by` marker, because one App serves all three (`lane-ownership.ts`). */
export const MANAGER_SEATS: readonly string[] = Object.freeze(["orchestrator", "product-manager", "ceo"]);
