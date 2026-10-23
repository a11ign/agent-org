// A11-145: the argument lists onboard and the conventions plugin's install give the GitHub CLI for one repository.
// They are the code host's own (`repoViewArgs`, `repoCloneArgs`, contract 1.7), and not row mode's: a code host with no `rows` has them, and these two install paths run on a host that needs none. This file is core's delegate, so a
// caller's import does not change; it asks for the code host without asking for `rows`, and so loads nothing of row mode.
import { loadedCodeHost } from "../plugins/code-host-slot.ts";

export const repoViewArgs = (repo: string): string[] => loadedCodeHost().repoViewArgs(repo);
export const repoCloneArgs = (remote: string, path: string): string[] => loadedCodeHost().repoCloneArgs(remote, path);
