// @ts-check
// module: what the atomic reviewer holds a change to a CI workflow to (A11-261)
//
// THIS READER'S PROMPT IS WHERE THE FINDING LIVES: the atomic reviewer takes its rules from `prompt.ts` and does not read `tickets.review` (`config-schema.ts` says so).
// A workflow job that runs on every push costs the whole of the repository's CI each time a worker pushes, and a macOS minute costs ten times a Linux one.

/** What the reviewer is told about a change to a CI workflow that adds per-push cost (A11-261), unless the ticket's explicit decision says otherwise, as for `RATCHET_RULE` in `prompt.ts`. */
export const CI_COST_RULE = "A change to a CI workflow that adds a job run on every push or every pull-request update without a `paths:` filter, "
  + "without a `concurrency:` group that cancels a superseded pull-request run, or that runs heavy jobs (a macOS or Windows runner, a build or browser run of minutes) on draft pull requests, "
  + "is a finding to name, unless the ticket's explicit decision says otherwise.";
