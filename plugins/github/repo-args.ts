// module: the argument lists onboard and the conventions plugin's install give the GitHub CLI for one repository (A11-145)
//
// NO IMPORTS, on purpose: the install commands load this, and they must not load the project declaration that the github adapter reads (a host with no primary
// would refuse). The lists name no program: the caller runs them through its own `gh` seam, so this file spawns and imports nothing from GitHub.

/** The arguments of `gh repo view <repo>`, which the person's own login runs to read a repository (A11-145): it exits 0 when the login can read it. */
export const repoViewArgs = (repo: string): string[] => ["repo", "view", repo];

/** The arguments of `gh repo clone <remote> <path>`, run as the person's own login when a profile's checkout is missing (A11-145). */
export const repoCloneArgs = (remote: string, path: string): string[] => ["repo", "clone", remote, path];
