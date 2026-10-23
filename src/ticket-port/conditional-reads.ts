// a11ign#5169: the two calls the gate's conditional reads add, as arguments.
// The operation lives in the GitHub plugin (`plugins/github/rows/conditional-reads.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";

export const { conditionalGetArgs, pullViewArgs } = delegates("conditionalGetArgs", "pullViewArgs");
