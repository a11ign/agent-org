// A CHECK THAT SAYS WHAT CLEARS IT (a11ign#5528, agent-org#1538). A check whose remedy is a review was routed as a code failure: the gate
// filed `pr-checks-failing` at the author and ordered no reviewer, so the pull request sat red for ten hours. A check now says so in the
// last line of its `output.summary`: `Cleared-by: review` (a reviewer's verdict clears it) or `Cleared-by: human` (a person's act does).
// THE MARKER IS THE CONTRACT. A check with no marker, or a marker naming some other act, is the code failure it always was.
//
// This file is the reading of the marker and nothing else: the decision lives in `reviewGateOf` (pr-orders.ts), the read in
// `withCheckMarkers` (causes/pr-reviews.ts), so the parser has no `gh` and no state directory.

/** The acts a check may name as its remedy. Anything else on the line (`edit`, a typo) names no act the gate knows, so it is no marker. */
export const CLEARED_BY = Object.freeze({ REVIEW: "review", HUMAN: "human" });

/** A whole line, so a marker quoted inside a sentence does not count: the check must put it on a line of its own. */
const MARKER_LINE = /^Cleared-by: (review|human)$/m;

/**
 * @param summary a check run's `output.summary`, as the REST API gives it (`null` for a run that wrote none)
 * @returns `review` or `human` when the summary carries the marker line, else `null`
 */
export function clearedByOf(summary: unknown): "review" | "human" | null {
  const found = MARKER_LINE.exec(String(summary ?? ""));
  return found === null ? null : found[1] as "review" | "human";
}

/**
 * The marker of each check NAME, read from its NEWEST run only: a re-run that dropped the marker clears it, as the newest run decides every other
 * question about a check (`newestPerName`). A name whose newest run carries no marker is absent from the answer, which is what makes it red.
 *
 * @param runs check runs as the REST API gives them: `id` (a larger one is newer), `name`, and `summary` (`output.summary`)
 * @returns name -> `review` | `human`, for the names that have one
 */
export function checkMarkersOf(runs: { id?: number; name?: string; summary?: unknown }[]): Record<string, "review" | "human"> {
  const newest = new Map<string, { id: number; summary?: unknown }>();
  for (const run of runs) {
    const name = String(run?.name ?? "");
    const id = Number(run?.id ?? 0);
    const seen = newest.get(name);
    if (seen === undefined || id > seen.id) newest.set(name, { id, summary: run?.summary });
  }
  const markers: Record<string, "review" | "human"> = {};
  for (const [name, run] of newest) {
    const by = clearedByOf(run.summary);
    if (by !== null) markers[name] = by;
  }
  return markers;
}
