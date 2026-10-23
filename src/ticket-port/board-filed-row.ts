// The board write of a row the gate files: the card, then its Status, then the labels last.
// The operation lives in the GitHub plugin (`plugins/github/rows/board-filed-row.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegate } from "../plugins/row-mode.ts";

export const boardFiledRow = delegate("boardFiledRow");
