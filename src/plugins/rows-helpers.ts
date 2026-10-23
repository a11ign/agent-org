// @ts-check
// module: the part of what core owns of row mode that reads the project's declaration, handed to the code host's `rows` (A11-160, step 4)
//
// A code host plugin imports core's types only (ADR 0001), and the GitHub adapter of the ticket port reads the project's vocabulary and board and how a row's body declares the waits it is in, which are
// core's, since other parts of core decide the same things. These modules evaluate the project's declaration when they load, and a host with no project refuses that, so `row-mode.ts` registers this and
// only the delegates whose operations read the project import it. The part that reads nothing of the project is `rows-light-helpers.ts`.
import { PROJECT_NUMBER, PROJECT_OWNER } from "../board-snapshot-scope.ts";
import { CLAIM_LABEL, READY_LABEL } from "../claim-labels.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { ANSWER_PREFIX, BACKLOG_LABEL, LANE_PREFIX, OUT_OF_RELEASE_LABEL } from "../project-vocabulary.ts";
import { parseWaits } from "../wait-condition.ts";
import { notBeforeDate } from "../waiting-condition.ts";
import type { RowsHelpers, RowsProjectHelpers } from "./contracts/code-host-rows.ts";
import { rowsReadHelpers } from "./rows-light-helpers.ts";

/** Core's side of row mode that reads the project, as the code host's `rows` read it. */
export const rowsProjectHelpers = (): RowsProjectHelpers => ({
  labels: { claim: CLAIM_LABEL, ready: READY_LABEL, backlog: BACKLOG_LABEL, outOfRelease: OUT_OF_RELEASE_LABEL, answerPrefix: ANSWER_PREFIX, lanePrefix: LANE_PREFIX },
  board: { number: PROJECT_NUMBER, owner: PROJECT_OWNER },
  homeTracker: () => homeProjectDeclaration().tracker[0],
  waits: { parse: parseWaits, notBeforeDate },
});

/** Both parts, for a caller (a test) that builds the code host's `rows` directly and not through the registrations. */
export const rowsHelpers = (): RowsHelpers => ({ ...rowsReadHelpers(), ...rowsProjectHelpers() });
