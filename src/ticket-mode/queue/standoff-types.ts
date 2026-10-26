// @ts-check
// module: what a run records of a stand-off (A11-290) -- the types, apart from the entry that holds it

/** What the planner decided about a stand-off (A11-290): it `amended` the disputed decision in the plan, or `upheld` it, and why. */
export type PlannerDecision = Readonly<{ decision: "amended" | "upheld"; reason: string }>;

/**
 * A STAND-OFF (A11-290): a re-review of a pull request's head that stayed not convinced at an unchanged head, after the worker answered its block with no commit. It is recorded when the verdict door refuses the re-review (an equal patch),
 * and it goes to the planner first when the worker's reply disputes a decision of the plan or the ticket, then to the worker; a person sees it only after both routes have ended.
 * `review` is the reviewer's block the worker answered, as it wrote it (null when the host did not give its text); `reasons` is the re-reviewer's verdict file as it wrote it; `reply` is the worker's replies on the pull request since the block, or null when none was read. `stage` is where the stand-off stands: `open` (recorded, not routed), `planner` (the planner's round
 * is queued or running), `planned` (the planner has decided: `planner` says how), `worker` (the worker's round is queued or running) and `done` (both routes that apply have ended). `decidedAt` is when the planner's round ended.
 */
export type Standoff = Readonly<{
  url: string; head: string; review: string | null; reasons: string; reply: string | null;
  stage: "open" | "planner" | "planned" | "worker" | "done";
  planner?: PlannerDecision;
  decidedAt?: number;
}>;
