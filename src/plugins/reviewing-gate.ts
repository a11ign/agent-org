// @ts-check
// module: what core hands a reviewer plugin in a process that is not a board (A11-161): the gate's loader, and nothing of the board
//
// DOCTOR, ONBOARD AND THE SETTINGS PAGE'S CHECKS BUILD A REVIEWER PLUGIN WITHOUT STARTING ONE: its doctor rows ask whether the gate loads, and its onboard step asks nothing of the board. So they are given the gate
// alone, which is cheap (`reviewer-port.ts` imports no gate module until `loadGate` is asked), and a reviewer that asks for the board's collaborators is refused by name. A board is given `reviewingHelpers`
// (`reviewing-helpers.ts`), which adds them. Kept apart from it so that every process that loads a plugin does not also load what the board's reviewer calls.
import { loadReviewerGate, reviewerGate, reviewerRefusal } from "../ticket-mode/reviewer-port.ts";
import type { ReviewerHelpers } from "./manifest.ts";

/** What a process that is not a board says when a reviewer asks for the board's collaborators. */
const NOT_A_BOARD = (): never => {
  throw new Error("the reviewer asked for the board's herdr session, code host and heads, and this process is not a board");
};

/** The helpers of a process that is not a board: the gate's loader, its refusal and its modules. */
export const gateHelpers = (): ReviewerHelpers => ({ loadGate: loadReviewerGate, gateRefusal: reviewerRefusal, gate: reviewerGate, board: NOT_A_BOARD });
