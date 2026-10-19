#!/usr/bin/env node
// @ts-check
// command: outside-nightly -- run the project's nightly org jobs from this repository's own workflow, when the project's `outside.nightly` is on
// agent-org#1577 (epic a11ign/a11ign#5602, "agent-org stands alone"): THE OUTSIDE HOME OF THE NIGHTLY ORG JOBS, shipped OFF.
//
// The project's CI runs four org jobs: `ready-audit` (`ready:audit`), `gateSweep` (`trunk-sweep`), `closeRowsSweep` (`close-rows-sweep`) and `watch` (`org-watch`). That is the org's process acting ON the
// project, so it must run from outside the project before it can leave it. `.github/workflows/outside-nightly.yml` is the clock; this is what it runs, in a checkout of the project, so the tool
// reads the project's declaration the way any customer's is read (`resolveHomeCheckout`: the repository the command is run in).
//
// THE FLAG IS `outside.nightly` in the project's `.agent-org/decisions.json`, read by the reader every other switch there uses (`readSwitches`). Absent, unreadable or not `true` is OFF: nothing is run, nothing
// is written, and the exit is 0. ON means this acts beside the project's own job, and the pair is idempotent because the second actor finds the work done:
//   - `trunk-sweep` acts only on a tip with ZERO check runs, so after the first actor's dispatch it reads some and does nothing;
//   - `close-rows-sweep` closes only rows still open, and its common outcome is `ALREADY CLOSED`;
//   - `ready:audit` writes nothing (it reports);
//   - `org-watch` REPORTS, and the posting was in the project's workflow shell, not in the command: it is built here, and it does not post a finding that a comment on the report issue already
//     carries from the last {@link RECENT_MINUTES} minutes (`alreadyReported`), whoever wrote it. That is the one place the pair could say a thing twice.
// The workflow's clock sits after the project's (`:52` against `:37`, `06:47` against `06:17`), so the project's job is the first actor and this is the second.
//
// THE WINDOW OF `close-rows-sweep` is the project job's literal, 120, and the reason is the same as its own header: sized to survive a temporary loss of the trigger.
//
// Exit codes: 0 off, or every job's command exited 0 (the `watch` job's is the posting's: a finding is the report's business and not a failed job, as in the project's own step); otherwise the first non-zero a job
// returned. Every selected job runs even when an earlier one failed, because the four ask different questions.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decisionSwitchesPath, readSwitches } from "./decision-provider.ts";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.ts";
import { gh as runGh } from "./merge-guard/lookups.ts";
import { commentsSince } from "./ticket-port/comments-since.ts";
import { commentOnIssue } from "./ticket-port/issue-comment.ts";
import { printDiagnostic, processState } from "./triage-provider.ts";

export const OUTSIDE_NIGHTLY_FLAG = "outside.nightly";
/** A comment this young on the report issue, carrying the same finding, is the first actor's: the clocks are hourly, so an hour's worth is the whole of "already said". */
export const RECENT_MINUTES = 50;

/** One org job: the command it runs, and whether its output is a report to post when it is non-zero. */
export type Job = { argv: readonly string[]; report: boolean };
/** The jobs, named as the project's workflow names them so the canary's comparison reads one name on both sides. */
export const JOBS: Readonly<Record<string, Job>> = Object.freeze({
  "ready-audit": { argv: ["ready:audit"], report: false },
  gateSweep: { argv: ["trunk-sweep"], report: false },
  closeRowsSweep: { argv: ["close-rows-sweep", "--window=120"], report: false },
  watch: { argv: ["org-watch"], report: true },
});

/** @returns whether the project at `projectDir` has switched the outside home on; an unusable file is off, and says so once through `diagnostic`. */
export function outsideNightlyOn(projectDir: string, { diagnostic = printDiagnostic, state = processState, read = readFileSync }: { diagnostic?: (line: string) => void; state?: typeof processState; read?: typeof readFileSync } = {}): boolean {
  const switches = readSwitches(decisionSwitchesPath(projectDir), { diagnostic, state, read }) as Record<string, boolean | undefined>;
  return switches[OUTSIDE_NIGHTLY_FLAG] === true;
}

/** The finding a report states, without the clock it is read at: "for 3h" and "for 4h" are the same red main, which an hour's difference between the two actors must not make two comments. */
export function findingKey(report: string): string {
  return report.replace(/\bfor (at least )?\d+h\b/g, "for Nh").trim();
}

/** @returns whether any of `recentBodies` states the finding `report` does */
export function alreadyReported(report: string, recentBodies: readonly string[]): boolean {
  const key = findingKey(report);
  return recentBodies.some((body) => findingKey(body) === key);
}

export type Deps = {
  /** Runs one `agent-org` command with `env` over the process's own, returning its exit code and everything it printed. */
  run: (argv: readonly string[], env: Record<string, string>) => { code: number; output: string };
  /** `gh <args>`, returning stdout; throws on a non-zero exit. */
  gh: (args: string[]) => string;
  now: () => number;
  print: (line: string) => void;
};

/**
 * The comment bodies on `issue` written in the last {@link RECENT_MINUTES} minutes, or `null` when they could not be read: not-known is not none. The read is the repository's comments since then
 * (one paginated call, `commentsSince`), and the issue is picked out of them by the comment's own `issue_url`.
 */
function recentComments(repo: string, issue: number, { gh, now }: Pick<Deps, "gh" | "now">): string[] | null {
  const read = (args: string[]): unknown[] | null => {
    try {
      const pages: unknown = JSON.parse(gh(args));
      return Array.isArray(pages) ? pages : null;
    } catch {
      return null;
    }
  };
  const comments = commentsSince({ repo, since: now() - RECENT_MINUTES * 60_000, run: read });
  // A list of lists is the shape `commentsSince` checks; what is IN the lists is checked here, and a record that is not a comment makes the whole read not-known rather than a crash that posts nothing.
  const isMalformedComments = comments === null || !comments.every((comment) => typeof comment === "object" && comment !== null && typeof comment.issue_url === "string" && typeof comment.body === "string");
  if (isMalformedComments) return null;
  return comments.filter((comment) => comment.issue_url.endsWith(`/issues/${issue}`)).map((comment) => comment.body);
}

/**
 * THE `watch` JOB'S POSTING, which the project kept in its workflow shell: a non-zero `org-watch` is a report, and it is posted unless the issue already carries it. A read that fails posts anyway, and says so: a
 * duplicate comment is a smaller fault than a red main nobody was told of.
 * @returns 0 when posted or already said, 1 when the post failed
 */
function postReport(report: string, repo: string, issue: number, deps: Deps): number {
  const recent = recentComments(repo, issue, deps);
  if (recent !== null && alreadyReported(report, recent)) {
    deps.print(`OUTSIDE-NIGHTLY: watch: #${issue} already carries this finding from the last ${RECENT_MINUTES} minutes -- not posting it again.`);
    return 0;
  }
  if (recent === null) deps.print(`OUTSIDE-NIGHTLY: watch: could not read #${issue}'s recent comments, so whether this is already said is unknown -- posting it.`);
  try {
    commentOnIssue({ repo, issue, body: report, run: deps.gh });
    deps.print(`OUTSIDE-NIGHTLY: watch: posted the finding on #${issue}.`);
    return 0;
  } catch (cause) {
    deps.print(`OUTSIDE-NIGHTLY: watch: could not post on #${issue} -- ${cause instanceof Error ? cause.message : cause}`);
    return 1;
  }
}

/** @returns the exit code: 0, or the first non-zero a selected job returned; every selected job runs */
export function runJobs(names: readonly string[], { repo, reportIssue, jobs = JOBS }: { repo: string; reportIssue: number; jobs?: Readonly<Record<string, Job>> }, deps: Deps): number {
  let exit = 0;
  for (const name of names) {
    const job = jobs[name];
    deps.print(`OUTSIDE-NIGHTLY: ${name}: agent-org ${job.argv.join(" ")} against ${repo}`);
    // The tool reads the repository it serves from `GITHUB_REPOSITORY`, which in this repository's workflow is this repository.
    const { code, output } = deps.run(job.argv, { GITHUB_REPOSITORY: repo });
    if (output !== "") deps.print(output.trimEnd());
    const result = job.report ? (code === 0 ? 0 : postReport(output, repo, reportIssue, deps)) : code;
    if (result !== 0) deps.print(`OUTSIDE-NIGHTLY: ${name}: exited ${result}`);
    if (exit === 0) exit = result;
  }
  return exit;
}

const BIN = join(dirname(fileURLToPath(import.meta.url)), "bin.ts");
const liveDeps: Deps = {
  run: (argv, env) => {
    const done = spawnSync(process.execPath, [BIN, ...argv], { env: { ...process.env, ...env }, encoding: "utf8" });
    return { code: done.status ?? 1, output: `${done.stdout ?? ""}${done.stderr ?? ""}` };
  },
  gh: runGh,
  now: () => Date.now(),
  print: (line) => console.log(line),
};

function main() {
  refuseUnknownFlags(["--repo", "--only", "--report-issue", "--read-flag"], { entry: import.meta.url, command: "agent-org outside-nightly" });
  const on = outsideNightlyOn(process.cwd());
  if (process.argv.includes("--read-flag")) {
    // GITHUB_OUTPUT form: the workflow mints its token only when this says `true`.
    console.log(`on=${on}`);
    return;
  }
  const repo = flagValue(process.argv, "repo");
  const only = flagValue(process.argv, "only");
  const reportIssue = Number(flagValue(process.argv, "report-issue"));
  const names = (only ?? "").split(",").filter((name) => name !== "");
  const unknown = names.filter((name) => !Object.hasOwn(JOBS, name));
  const isMalformedRequest = repo === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repo) || names.length === 0 || unknown.length > 0 || !Number.isInteger(reportIssue) || reportIssue <= 0;
  if (isMalformedRequest) {
    console.error(`outside-nightly: needs --repo=<owner/name> --only=<${Object.keys(JOBS).join(",")}> --report-issue=<n>${unknown.length > 0 ? `; not jobs: ${unknown.join(", ")}` : ""}`);
    process.exitCode = 2;
    return;
  }
  if (!on) {
    console.log(`OUTSIDE-NIGHTLY: off -- ${OUTSIDE_NIGHTLY_FLAG} is not true in ${decisionSwitchesPath(process.cwd())}; nothing was run.`);
    return;
  }
  process.exitCode = runJobs(names, { repo, reportIssue }, liveDeps);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
