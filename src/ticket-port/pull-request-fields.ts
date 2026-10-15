// agent-org#1396: one pull request's named fields, read through an injected `run` (`gh`, as the caller hands it in). This file names no `gh` and spawns nothing:
// `ticket-port.test.ts` (#484) holds the port to that, and the spawn stays with whoever owns the runner. It is here, and not inline in `pr-hold.ts`, because that file
// is baselined by `gh-call-ratchet.test.ts` (agent-org#826) and a new call shape goes through the port (ADR 0046), never into a file that holds a baseline.

/**
 * A pull request's `fields` (a `--json` list), read in `repo`, or `null` when they could not be had: a refused `run`, or an answer that does not parse. Absence is not
 * proof, so the caller notes it and reads no further edge from that pull request.
 */
export function pullRequestFieldsOf({ repo, number, fields, run }: {
  repo: string; number: number; fields: string; run: (args: string[]) => string;
}): Record<string, any> | null {
  try {
    return JSON.parse(run(["pr", "view", String(number), "--repo", repo, "--json", fields]));
  } catch (error) {
    void error; // no answer is "cannot say", which the caller notes
    return null;
  }
}
