// module: where the reviewers' verdict door RUNS from (a11ign/agent-org#1311). A LEAF: it imports the host declaration and nothing
// that reads git history, so the gate's import closure (`review-trust.ts`, `work-gate/pr-orders.ts`, `wake.ts`) can name the door
// without `host-units.ts`, which reads history (`git log --all`) and is refused on that closure by the history ratchet (#2174).
import { join } from "node:path";
import { homeHostConfig, type HostConfig } from "./host-config.ts";

/**
 * Where the door RUNS from: `$A11Y_REVIEWER_BIN` else `<home>/reviewer/bin`, the installer's own default, which a test reads out of
 * the script. The directory the reviewers' execpolicy names. `host-units.ts` re-exports this, so its callers are unchanged.
 * @param {{ host?: HostConfig, reviewerBin?: string }} [deps]
 */
export function reviewerDoorPath(deps: { host?: HostConfig; reviewerBin?: string; } = {}) {
  const bin = deps.reviewerBin ?? process.env.A11Y_REVIEWER_BIN ?? join((deps.host ?? homeHostConfig()).home, "reviewer", "bin");
  return join(bin, "pr-review-verdict");
}
