// agent-org#943: a repository's open incident issues, read through an injected `run` (`gh`, as the caller hands it in). This file spawns nothing:
// the spawn stays with whoever owns the runner, as `open-pulls.ts` leaves it.

import type { OpenIncidentRead, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/**
 * THE OPEN INCIDENT ISSUES OF `repo`, pull requests dropped, or `null` for "could not ask": a refused `run`, and an answer that does not parse.
 * `null` is never "no incident": a caller that reads a failed read as an empty list would call a stopped fleet clear.
 */
export function openIncidentsOf(repo: string, run: RowsRun): OpenIncidentRead[] | null {
  try {
    const issues: OpenIncidentRead[] = JSON.parse(run(["api", "--method", "GET", `repos/${repo}/issues`, "-f", "state=open", "-f", "labels=incident", "-f", "per_page=100",
      "--jq", "[.[] | select(.pull_request | not) | {number, title, createdAt: .created_at, body}]"]));
    return Array.isArray(issues) ? issues : null;
  } catch (error) {
    void error; // no list is "cannot say", which the reading calls unknown
    return null;
  }
}
