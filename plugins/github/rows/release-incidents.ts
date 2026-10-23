// agent-org#887: THE GITHUB CALLS BEHIND A FAILED RELEASE'S INCIDENT, read and written through an injected `run` (`gh`, as the caller hands it in). This file spawns nothing: the spawn stays
// with whoever owns the runner, as `open-incidents.ts` leaves it. They sit here and not in `src/org-health.ts` because `gh-call-ratchet.test.ts` allows that file no further call site, and says new
// tracker calls go through the plugin. The reading, the key an incident is found by and the decision to file or close it stay in `src/org-health.ts`: nothing here knows what a release is.

import type { ClosedIncidentRead, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/**
 * THE LOG OF ONE JOB of `repo`'s Actions, as text. THROWS when the read is refused: the caller says why no line is quoted.
 * `--allow-escape-sequences`: a job's log carries the runner's colour codes and `gh api` refuses to print a response with any (measured against a real agent-org release log, 2026-10-12).
 */
export function jobLogOf(repo: string, jobId: number, run: RowsRun): string {
  return run(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${jobId}/logs`]);
}

/**
 * THE CLOSED INCIDENT ISSUES OF `repo` (the newest 100), pull requests dropped, or `null` for "could not ask": a refused `run` and an answer that does not parse.
 * `null` is never "none": a caller that read it as an empty list would file again what a person closed.
 */
export function closedIncidentsOf(repo: string, run: RowsRun): ClosedIncidentRead[] | null {
  try {
    const issues: ClosedIncidentRead[] = JSON.parse(run(["api", "--method", "GET", `repos/${repo}/issues`, "-f", "state=closed", "-f", "labels=incident", "-f", "per_page=100",
      "--jq", "[.[] | select(.pull_request | not) | {number, body}]"]));
    return Array.isArray(issues) ? issues : null;
  } catch (error) {
    void error; // no list is "cannot say", which the caller says and files nothing for
    return null;
  }
}

/** FILE an incident item in `tracker`, labelled `incident`. THROWS when the write is refused. */
export function createIncident(tracker: string, { title, body }: { title: string; body: string; }, run: RowsRun): void {
  run(["issue", "create", "--repo", tracker, "--title", title, "--label", "incident", "--body", body]);
}

/**
 * COMMENT ON, then CLOSE, an incident item of `tracker`. THROWS when a write is refused.
 * The close is the REST one, not the CLI's: this closes the gate's own incident item and no row from a merge, and `close-rows-sweep.test.ts` reads every CLI close in a source file as the latter.
 */
export function closeIncident(tracker: string, number: number, comment: string, run: RowsRun): void {
  run(["issue", "comment", String(number), "--repo", tracker, "--body", comment]);
  run(["api", "--method", "PATCH", `repos/${tracker}/issues/${number}`, "-f", "state=closed", "-f", "state_reason=completed"]);
}
