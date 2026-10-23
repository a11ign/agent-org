// A11-145: the argument lists onboard and the conventions plugin's install give the GitHub CLI for one repository.
// The operation lives in the GitHub plugin (`plugins/github/rows/repo-args.ts`, A11-160) behind the code host's `rows`; this file is core's delegate, so a caller's import does not change (`src/plugins/rows.ts`).
import { delegates } from "../plugins/rows.ts";

export const { repoViewArgs, repoCloneArgs } = delegates("repoViewArgs", "repoCloneArgs");
