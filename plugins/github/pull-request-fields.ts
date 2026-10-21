// module: one pull request's named fields, as the code host reads them (A11-160)
//
// Read through the plugin's `gh` runner, so this file spawns nothing. Row mode's own copy (`src/ticket-port/pull-request-fields.ts`) stays in core until row mode's calls move into this
// plugin, so the two are written apart on purpose.
import type { Gh } from "./gh.ts";

/**
 * A pull request's `fields` (a `--json` list), read in `repo`, or `null` when they could not be had: a refused `gh`, or an answer that does not parse. Absence is not proof, so the
 * caller notes it and reads no further edge from that pull request.
 */
export function pullRequestFieldsOf({ repo, number, fields, gh }: { repo: string; number: number; fields: string; gh: Gh }): Record<string, any> | null {
  try {
    return JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", fields]));
  } catch (error) {
    void error; // no answer is "cannot say", which the caller notes
    return null;
  }
}
