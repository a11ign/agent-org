// module: what a ticket's pushes cost in CI -- one job's billable minutes and weight, and the jobs and minutes of a head, a run and a ticket (A11-261) -- PURE
//
// THE MEASURE IS GITHUB'S BILLING, not the invoice: a job's minutes are the time it ran rounded UP to a whole minute, and a minute on a macOS runner counts ten, on a Windows runner two, and on any other GitHub-hosted runner one. A job on
// a `self-hosted` runner is not billed, so it weighs nothing, but it still counts as a job. The figure is the same for a public repository (which GitHub does not bill) and a private one, because it measures the mass of work a push starts.
import type { BranchCiRun } from "../../plugins/contracts/code-host.ts";

/** The kinds of runner a job runs on, as the weights tell them apart: `linux` is every other GitHub-hosted runner. */
export type RunnerOs = "linux" | "windows" | "macos" | "self-hosted";

/** The runner kinds in the order a card lists them. */
export const RUNNER_OSES: readonly RunnerOs[] = ["linux", "windows", "macos", "self-hosted"];

/** What a minute on each runner kind counts as, in Linux-minute equivalents: as GitHub bills (macOS ×10, Windows ×2), and nothing for a runner GitHub does not bill. */
export const WEIGHT: Readonly<Record<RunnerOs, number>> = { linux: 1, windows: 2, macos: 10, "self-hosted": 0 };

/** The jobs, minutes and weighted minutes of some work. */
export type Spend = Readonly<{ jobs: number; minutes: number; weighted: number }>;

/** The work of a head, a run or a ticket: its pushes (distinct heads), its spend, and its spend by runner kind. */
export type CiTotals = Spend & Readonly<{ pushes: number; byOs: Readonly<Record<RunnerOs, Spend>> }>;

/** A head's work: the commit and its totals. A head is one push. */
export type HeadSpend = Readonly<{ head: string }> & Spend & Readonly<{ byOs: Readonly<Record<RunnerOs, Spend>> }>;

const NONE: Spend = { jobs: 0, minutes: 0, weighted: 0 };
const noneByOs = (): Record<RunnerOs, Spend> => ({ linux: NONE, windows: NONE, macos: NONE, "self-hosted": NONE });

/** The runner kind a job's labels name: `self-hosted` wins over every other label, then a label starting `macos` or `windows`, and anything else is a GitHub-hosted Linux runner. PURE. */
export function osOf(labels: readonly string[]): RunnerOs {
  const lowered = labels.map((label) => label.toLowerCase());
  if (lowered.includes("self-hosted")) return "self-hosted";
  if (lowered.some((label) => label.startsWith("macos"))) return "macos";
  if (lowered.some((label) => label.startsWith("windows"))) return "windows";
  return "linux";
}

/** The weight of a job whose runner has `labels`. PURE. */
export const weightOf = (labels: readonly string[]): number => WEIGHT[osOf(labels)];

const MINUTE_MS = 60_000;

/**
 * The minutes a job is billed for: how long it ran, rounded up to a whole minute. A job that has not completed has cost nothing yet, and so has one that never ran (a skipped job starts and completes at the same moment). A job whose times
 * run backwards, or that cannot be read, is nothing too. PURE.
 */
export function minutesOf(job: BranchCiRun["jobs"][number]): number {
  if (job.startedAt === null || job.completedAt === null) return 0;
  const ran = Date.parse(job.completedAt) - Date.parse(job.startedAt);
  return Number.isFinite(ran) && ran > 0 ? Math.ceil(ran / MINUTE_MS) : 0;
}

const add = (a: Spend, b: Spend): Spend => ({ jobs: a.jobs + b.jobs, minutes: a.minutes + b.minutes, weighted: a.weighted + b.weighted });

/** The spend of one run's jobs, in total and by runner kind. PURE. */
function spendOfJobs(jobs: BranchCiRun["jobs"]): Pick<HeadSpend, "byOs"> & Spend {
  const byOs = noneByOs();
  for (const job of jobs) {
    const os = osOf(job.labels);
    const minutes = minutesOf(job);
    byOs[os] = add(byOs[os], { jobs: 1, minutes, weighted: minutes * WEIGHT[os] });
  }
  return { ...RUNNER_OSES.reduce<Spend>((sum, os) => add(sum, byOs[os]), NONE), byOs };
}

/** `a` and `b` together, by runner kind. */
const addByOs = (a: Readonly<Record<RunnerOs, Spend>>, b: Readonly<Record<RunnerOs, Spend>>): Record<RunnerOs, Spend> =>
  Object.fromEntries(RUNNER_OSES.map((os) => [os, add(a[os], b[os])])) as Record<RunnerOs, Spend>;

/**
 * The work of each head that has at least one workflow run in `runs`, in the order the heads first appear: the jobs, minutes and weighted minutes of every run on it, by runner kind. A head with a re-run, or with several workflows,
 * is one head, and its runs add up. PURE.
 */
export function spendByHead(runs: readonly BranchCiRun[]): HeadSpend[] {
  const heads = new Map<string, HeadSpend>();
  for (const run of runs) {
    const spent = spendOfJobs(run.jobs);
    const before = heads.get(run.headSha);
    heads.set(run.headSha, before === undefined ? { head: run.headSha, ...spent } : { head: run.headSha, ...add(before, spent), byOs: addByOs(before.byOs, spent.byOs) });
  }
  return [...heads.values()];
}

/** The totals of `runs`: a push for each distinct head, and every head's work added up. PURE. */
export function totalsOf(runs: readonly BranchCiRun[]): CiTotals {
  const heads = spendByHead(runs);
  return { pushes: heads.length, ...heads.reduce<Spend>((sum, head) => add(sum, head), NONE), byOs: heads.reduce((sum, head) => addByOs(sum, head.byOs), noneByOs()) };
}

/** The runs created at or after `since` (epoch milliseconds): a run's own figures count from its first start. A run whose creation time cannot be read is left out. PURE. */
export const runsSince = (runs: readonly BranchCiRun[], since: number): BranchCiRun[] => runs.filter((run) => Date.parse(run.createdAt) >= since);
