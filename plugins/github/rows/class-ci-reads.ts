// module: the GitHub plugin's reads and writes for a red check's failure class and the incident row of a failure shared by pull requests (A11-160, step 9; moved from `src/ci-failure-class.ts`)
//
// Each operation builds the argument list the caller built and reads GitHub's answer as the caller did, on the `run` the caller hands it. A refused call THROWS: what a caller makes of it ("could not determine",
// "not touched", "the next tick retries") stays in core. A job's log is read WITH `--allow-escape-sequences`: an Actions log carries colour codes, and `gh api` exits 1 on any terminal escape sequence unless told to
// allow it, so without the flag the read never returned and no class was ever asked (#767).
import type { LabelledRead, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { RecentRunRead, RecentRunsKind, RedCheckRead, SharedFailureRowRead } from "../../../src/plugins/contracts/code-host-rows-classes.ts";
import { ensureLabel, fileLabelledRow } from "./gate-row-writes.ts";

const RED_CONCLUSIONS = new Set(["failure", "timed_out"]);
/** The roll-up job (`gate`) reports OTHER jobs' results, so it names no cause. */
const ROLL_UP_CHECK = /(^|[\s/])gate$/i;
const RUN_AND_JOB = /\/actions\/runs\/(\d+)\/job\/(\d+)/;
const REPOSITORY_OF_ADDRESS = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//;
const NEW_ROW_NUMBER = /\/issues\/(\d+)/;

type CheckRun = { name?: string; conclusion?: string | null; details_url?: string | null };

const json = (run: RowsRun, path: string): any => JSON.parse(run(["api", path]));

/** The log of job `jobId`, colour codes among it. */
export function jobLogTextOf({ repo, jobId, run }: { repo: string; jobId: string | number; run: RowsRun }): string {
  return run(["api", `repos/${repo}/actions/jobs/${jobId}/logs`, "--allow-escape-sequences"]);
}

/** The red check of a head that is classified: the first failing check that is not the roll-up, else the first failing one. */
function redCheckOfHead(checks: readonly CheckRun[]): CheckRun | undefined {
  const reds = checks.filter((check) => RED_CONCLUSIONS.has(String(check.conclusion)));
  const causes = reds.filter((check) => !ROLL_UP_CHECK.test(String(check.name ?? "")));
  return causes[0] ?? reds[0];
}

export function redCheckOf({ repo, number, head8, run }: { repo: string; number: number; head8: string; run: RowsRun }): RedCheckRead | null {
  const pull = json(run, `repos/${repo}/pulls/${number}`);
  const sha = String(pull?.head?.sha ?? "");
  if (!sha.startsWith(head8)) return null;
  const checks: CheckRun[] = json(run, `repos/${repo}/commits/${sha}/check-runs?per_page=100`)?.check_runs ?? [];
  const red = redCheckOfHead(checks);
  const ids = RUN_AND_JOB.exec(String(red?.details_url ?? ""));
  if (red === undefined || ids === null) return null;
  const workflowRun = json(run, `repos/${repo}/actions/runs/${ids[1]}`);
  const log = jobLogTextOf({ repo, jobId: ids[2], run });
  return { branch: String(pull?.head?.ref ?? ""), workflow: String(workflowRun.name ?? ""), runAttempt: Number(workflowRun.run_attempt ?? 1), log };
}

/** The path of the workflow runs a kind lists: the newest on `main`, or the newest that failed for a pull request. */
const runsPathOf = (repo: string, kind: RecentRunsKind, limit: number): string => (kind === "on-main"
  ? `repos/${repo}/actions/runs?branch=main&per_page=${limit}`
  : `repos/${repo}/actions/runs?status=failure&event=pull_request&per_page=${limit}`);

export function recentRunsOf({ repo, kind, limit, run }: { repo: string; kind: RecentRunsKind; limit: number; run: RowsRun }): RecentRunRead[] {
  const runs: any[] = json(run, runsPathOf(repo, kind, limit))?.workflow_runs ?? [];
  return runs.map((entry) => ({ name: entry.name, conclusion: entry.conclusion, headBranch: entry.head_branch, updatedAt: entry.updated_at }));
}

export function jobOfCheckUrl(detailsUrl: string): { repo: string; jobId: string } | null {
  const ids = RUN_AND_JOB.exec(detailsUrl);
  const repo = REPOSITORY_OF_ADDRESS.exec(detailsUrl)?.[1];
  return ids === null || repo === undefined ? null : { repo, jobId: ids[2] };
}

export function jobFailedStepOf({ repo, jobId, run }: { repo: string; jobId: string | number; run: RowsRun }): string | null {
  const job = json(run, `repos/${repo}/actions/jobs/${jobId}`);
  const step = (job?.steps ?? []).find((candidate: { conclusion?: string }) => candidate.conclusion === "failure");
  return step === undefined ? null : String(step.name);
}

export function changedFilesPageOf({ repo, number, perPage, run }: { repo: string; number: number; perPage: number; run: RowsRun }): string[] | null {
  const files = json(run, `repos/${repo}/pulls/${number}/files?per_page=${perPage}`);
  return Array.isArray(files) ? files.map((file: { filename?: unknown }) => String(file.filename)) : null;
}

export function pullMergedAtOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string | null {
  const pull = json(run, `repos/${repo}/pulls/${number}`);
  return pull?.merged_at ? String(pull.merged_at) : null;
}

export function openPullBehindBy({ repo, number, run }: { repo: string; number: number; run: RowsRun }): number | null {
  const pull = json(run, `repos/${repo}/pulls/${number}`);
  if (pull?.state !== "open") return null;
  const comparison = json(run, `repos/${repo}/compare/${pull.base?.ref ?? "main"}...${pull.head?.sha}`);
  return Number(comparison?.behind_by ?? 0);
}

export function updatePullBranch({ repo, number, run }: { repo: string; number: number; run: RowsRun }): void {
  run(["api", "-X", "PUT", `repos/${repo}/pulls/${number}/update-branch`]);
}

/** The fields the refresh of a merged fix reads of an incident row, asked of the connection. */
const SHARED_FAILURE_ROW_SELECT = "number body createdAt closedAt labels(first:20){nodes{name}} closedByPullRequestsReferences(first:10){nodes{number repository{nameWithOwner}}}";

/** Files the incident row: its label first (created, or its description updated), then the row. The number is read off the address `gh` prints, `null` when it names none. */
export function fileSharedFailureRow({ label, description, title, body, run }: { label: string; description: string; title: string; body: string; run: RowsRun }): number | null {
  ensureLabel({ name: label, description, run });
  const printed = fileLabelledRow({ title, label, body, run });
  return Number(NEW_ROW_NUMBER.exec(printed)?.[1] ?? NaN) || null;
}

/** The incident rows in the shape the refresh reads: `readRowsByLabel` is the plugin's, so a read that is not a list THROWS here as it does there. */
export function sharedFailureRowsOf(read: (ask: LabelledRead) => any[], { label, state, newest, run }: { label: string; state: "open" | "closed"; newest: number; run: RowsRun }): SharedFailureRowRead[] {
  return read({ label, state: state === "open" ? "OPEN" : "CLOSED", newest, run, select: SHARED_FAILURE_ROW_SELECT })
    .map((row) => ({
      number: Number(row.number), body: String(row.body ?? ""), createdAt: row.createdAt, closedAt: row.closedAt,
      labels: (row.labels?.nodes ?? []).map((node: { name: string }) => String(node.name)),
      closedBy: (row.closedByPullRequestsReferences?.nodes ?? []).map((pull: { number: number; repository?: { nameWithOwner?: string } }) => ({ number: pull.number, repo: pull.repository?.nameWithOwner })),
    }));
}
