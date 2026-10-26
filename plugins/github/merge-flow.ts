// module: whether a repository has a merge flow (contract 1.25, A11-291) -- auto-merge allowed, and the arm workflow on its default branch
//
// AN APPROVED PULL REQUEST IN A REPOSITORY WITH NEITHER SITS UNTIL A PERSON MERGES IT (a11ign/plugin#10: approved at 91cfe96d, green, a day). Both are what the arm bot needs: the repository must allow auto-merge for `gh pr merge --auto`
// to arm anything, and `.github/workflows/auto-arm.yml` is the bot that arms an approved pull request. The board reads this to say why an approved pull request is not merging, and doctor reads it for every repository of the host.
// Read through an injected `run` (the plugin's `gh`), so this file spawns nothing.
import type { ARM_WORKFLOW_PATH as CONTRACT_ARM_WORKFLOW_PATH, MergeFlow } from "../../src/plugins/contracts/code-host.ts";
import { GhFailure, type Gh } from "./gh.ts";

/** The arm workflow's path the contract names (`ARM_WORKFLOW_PATH`); a plugin imports core's types only, so the type holds it to the contract's spelling. */
export const ARM_WORKFLOW_PATH: typeof CONTRACT_ARM_WORKFLOW_PATH = ".github/workflows/auto-arm.yml";

/** Whether `repository` is written `owner/name`. */
const isRepository = (repository: string): boolean => /^[^/\s]+\/[^/\s]+$/.test(repository);

/**
 * Whether the repository allows auto-merge, from GitHub's `allow_auto_merge`: true or false, or null when the answer says neither. GitHub leaves the field out for an account that cannot administer the repository's merge settings, and an absent field
 * is "could not ask", never "off".
 */
function autoMergeOf(repository: string, run: Gh): boolean | null {
  const answer = run(["api", `repos/${repository}`, "--jq", ".allow_auto_merge"]).trim();
  return answer === "true" ? true : answer === "false" ? false : null;
}

/** Whether the default branch holds the arm workflow: GitHub's 404 for the file is "no", any other refusal is "could not ask" (it throws). */
function armWorkflowOf(repository: string, run: Gh): boolean {
  try {
    run(["api", `repos/${repository}/contents/${ARM_WORKFLOW_PATH}`, "--jq", ".type"]);
    return true;
  } catch (error) {
    if (error instanceof GhFailure && /HTTP 404/.test(error.stderr)) return false;
    throw error;
  }
}

/**
 * WHETHER `repository` CAN MERGE A PULL REQUEST BY ITSELF: it allows auto-merge, and its default branch holds the arm workflow. Null for "could not ask": a repository that is not `owner/name`, a refused read, and an answer that does not say whether auto-merge
 * is allowed. Null is never "it has no flow".
 */
export function readMergeFlow(repository: string, run: Gh): MergeFlow | null {
  if (!isRepository(repository)) return null;
  try {
    const autoMerge = autoMergeOf(repository, run);
    return autoMerge === null ? null : { autoMerge, armWorkflow: armWorkflowOf(repository, run) };
  } catch {
    return null;
  }
}
