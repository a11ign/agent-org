// agent-org#992: THE CODE HOST'S CI, read through an injected `run` (the caller's own runner). This file spawns nothing: `index.test.ts`
// holds this folder to that. Each read THROWS when it could not be made or its answer is not the shape asked for, so a caller that turns a throw into
// "could not ask" can never read a refused call as an empty one (#1286).
//
// WHY HERE AND NOT IN `cross-repo-red.ts`: the committed call baseline (`gh-call-ratchet.test.ts`, #826) does not let a file outside the plugin gain a
// call to the tracker's CLI, and a new file has no entry. The decision stays in `cross-repo-red.ts`; the calls are these.
import type { CiJob, RedRun, RowsRun as Run } from "../../../src/plugins/contracts/code-host-rows.ts";

const parse = (text: string, what: string): any => {
  const body = JSON.parse(text);
  if (body === null || typeof body !== "object") throw new Error(`the API returned no ${what}`);
  return body;
};

/** The head commit of one change. Throws on an empty answer. */
export function headOfChange(repo: string, number: string | number, run: Run): string {
  const head = run(["pr", "view", String(number), "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"]).trim();
  if (head === "") throw new Error("the change head was empty");
  return head;
}

/** The newest check run of each name on `head`, and how many exist (`total`, which is more than `checks.length` when a page was not read). */
export function checkRunsOfHead(repo: string, head: string, run: Run): { checks: CiJob[]; total: number } {
  const body = parse(run(["api", `repos/${repo}/commits/${head}/check-runs?per_page=100`]), "check-run list");
  if (!Array.isArray(body.check_runs)) throw new Error("the API returned no check-run list");
  return { checks: body.check_runs, total: typeof body.total_count === "number" ? body.total_count : body.check_runs.length };
}

/** The runs of `workflow` on `main` for one `event=<name>` filter, as the REST body carries them. */
export function workflowRunsOf(repo: string, workflow: string, eventFilter: string, run: Run): any[] {
  const body = parse(run(["api", "--method", "GET", `repos/${repo}/actions/workflows/${workflow}/runs`, "-f", "branch=main", "-f", eventFilter, "-f", "per_page=10"]), "run list");
  return Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
}

/** The jobs of one workflow run. Throws when the answer carries no job list. */
export function jobsOfRun(repo: string, runId: string | number, run: Run): CiJob[] {
  const body = parse(run(["api", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]), "job list");
  if (!Array.isArray(body.jobs)) throw new Error("the API returned no job list");
  return body.jobs;
}

/** The failed steps' log of one workflow run: `job\tstep\tline` for every failed job. */
export function failedLogOfRun(repo: string, runId: string | number, run: Run): string {
  return run(["run", "view", String(runId), "--repo", repo, "--log-failed"]);
}

/** `OPEN` or `CLOSED` (upper-cased), or `""` for an answer that carries no state. Throws when the row could not be read, naming why in the runner's own message. */
export function stateOfRow(repo: string, number: string | number, run: Run): string {
  return String(parse(run(["issue", "view", String(number), "--repo", repo, "--json", "state"]), "row")?.state ?? "").toUpperCase();
}

// The two patterns below are `ci-failure-class.ts`'s own (`RED_CONCLUSIONS`, `ROLL_UP_CHECK`, `RUN_AND_JOB`): `redRunOfHead` must pick the SAME check `readCiFailure` classified, so the run
// it reruns is the run whose log was read. `wake-ci-rerun-on-5xx.test.ts` runs both against one fake host and fails when they pick differently.
const RED_CONCLUSIONS = new Set(["failure", "timed_out"]);
const ROLL_UP_CHECK = /(^|[\s/])gate$/i;
const RUN_AND_JOB = /\/actions\/runs\/(\d+)\/job\/(\d+)/;

/**
 * THE RUN A RED PULL REQUEST'S CLASSIFIED CHECK BELONGS TO: the first failing check that is not the roll-up `gate`, else the first failing one, as `readCiFailure` picks it.
 * `null` when the head is no longer the one named (`head8`), when nothing is red, or when the red check is not an Actions job. Reads only, and throws on an unreadable answer.
 */
export function redRunOfHead(repo: string, number: string | number, head8: string, run: Run): RedRun | null {
  const sha = String(parse(run(["api", `repos/${repo}/pulls/${number}`]), "change")?.head?.sha ?? "");
  if (!sha.startsWith(head8)) return null;
  const reds = checkRunsOfHead(repo, sha, run).checks.filter((check) => RED_CONCLUSIONS.has(String(check.conclusion)));
  const red = reds.find((check) => !ROLL_UP_CHECK.test(String(check.name ?? ""))) ?? reds[0];
  const ids = RUN_AND_JOB.exec(String(red?.details_url ?? ""));
  return red === undefined || ids === null ? null : { runId: Number(ids[1]), conclusion: red.conclusion ?? null };
}

/** THE WRITE (agent-org#1217): rerun the failed jobs of one workflow run. A refused rerun THROWS, so a caller cannot read it as done. */
export function rerunFailedJobsOf(repo: string, runId: string | number, run: Run): void {
  run(["run", "rerun", String(runId), "--failed", "-R", repo]);
}
