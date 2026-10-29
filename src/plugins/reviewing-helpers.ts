// @ts-check
// module: what core hands a reviewer plugin on a board (A11-161)
//
// A PLUGIN IMPORTS CORE'S TYPES ONLY (ADR 0001), so the gate the reviewer drives reaches it through `deps.reviewing`: THE GATE STAYS CORE'S, shared with the org's own reviewer (`wake/*`, `review-trust.ts`,
// `work-gate/pr-orders.ts`, `project-config.ts`, the door path and `host-config.ts`), and `reviewing-gate.ts` hands its loader over. A board adds its collaborators and the functions the atomic reviewer called directly
// before it moved (the seat names, the herdr listing, the claim protocol, the verdict reader), as the modules' own. They are held to `ReviewerBoard`'s signatures where they are assigned below.
import { readAgents, readAgentsAsync, herdrRunAsync, ORG_SESSION, firstLine, herdrAgentName } from "../herdr-agents.ts";
import { readDialogLines } from "../pane-dialog-read.ts";
import { cloneKeys } from "../derived-name.ts";
import { reviewerInstance, reviewerSeat } from "../review-attribution.ts";
import { headMatches, reviewVerdict } from "../review-verdict.ts";
import { REVIEW_LEASE_MS, claimHead, othersSeenIn, releasedDescriptionOf } from "../ticket-port/review-claim.ts";
import type { Active } from "./active.ts";
import type { ReviewerBoard, ReviewerHelpers } from "./manifest.ts";
import { gateHelpers } from "./reviewing-gate.ts";

/** What a board names of itself: the rest of a {@link ReviewerBoard} is core's own functions. */
export type BoardCollaborators = Pick<ReviewerBoard, "session" | "run" | "codeHost" | "clones" | "instance" | "heads"> & Partial<Pick<ReviewerBoard, "seen" | "tmpBase" | "runAsync">>;

/** The helpers a reviewer plugin is given on a board: the gate's, and the board's collaborators with the functions the reviewer calls. */
export const reviewingHelpers = (collaborators: BoardCollaborators): ReviewerHelpers => {
  // The instances seen, one record for the board's life: a caller that keeps none (a test) gets its own.
  const seen = collaborators.seen ?? new Map<string, number>();
  return {
    ...gateHelpers(),
    board: () => ({
      ...collaborators,
      // `runAsync` is core's own `herdr` unless a board gives one (a test does): `server.ts` and `review-command.ts` name `run` alone.
      runAsync: collaborators.runAsync ?? ((args) => herdrRunAsync(args)),
      seen,
      attribution: { reviewerInstance, reviewerSeat, cloneKeys },
      herdr: { ORG_SESSION, firstLine, agentName: herdrAgentName, readAgents, readAgentsAsync, readDialogLines },
      claims: { REVIEW_LEASE_MS, claimHead, othersSeenIn, releasedDescriptionOf },
      verdict: { headMatches, reviewVerdict },
    }),
  };
};

/**
 * The helpers of a board whose code host is not activated yet: the reviewer plugin is built DURING activation, with these helpers, and reads every pull request through the code host that same activation
 * makes. So the code host is asked when it is used, and `activated` is how the board hands the activation over once it exists.
 */
export function reviewingBeforeActivation(collaborators: Omit<BoardCollaborators, "codeHost">): Readonly<{ reviewing: ReviewerHelpers; activated: (active: Pick<Active, "codeHost">) => void }> {
  let activation: Pick<Active, "codeHost"> | undefined;
  const codeHost = () => {
    if (activation === undefined) throw new Error("the reviewer asked for the code host before the plugins were activated");
    return activation.codeHost();
  };
  return { reviewing: reviewingHelpers({ ...collaborators, codeHost }), activated: (active) => { activation = active; } };
}
