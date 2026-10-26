// @ts-check
// module: the After-merge checks' sweep (A11-277, A11-302) -- copy the runs' listed lines into records with what their plans say, prune the old closed ones, let the board pass or fail the ones it watches, give the rest to verifier runs, and post each close on its ticket once
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { diagnose, defaultDoctorDeps } from "../../install/doctor.ts";
import { log, messageOf } from "../pool-state.ts";
import { toolPinOf } from "../pool-pin.ts";
import { fileFollowUps, queueCheckRuns } from "../pool-check-runs.ts";
import type { BranchCiRun } from "../../plugins/contracts/code-host.ts";
import type { PoolContext } from "../pool-context.ts";
import { planTexts } from "../pool-ticket-text.ts";
import { DEPENDENCY_TICKETS_FILE } from "../dependency-updates/board.ts";
import { loadState } from "../dependency-updates/filed.ts";
import { reviewOnHead } from "../wait-on/wait-read.ts";
import { claimPost, closeComment, listedIds, markUnpostable, pruneChecks, releasePost, seedChecks, ticketsToSeed, unpostedChecks, type CheckRecord, type ChecksFile, type PlannedCheck } from "./checks.ts";
import { handOverdueToAgent, markOverdue, markShownToPerson } from "./dispatch.ts";
import { isInstalled, mergesIn, type InstalledReads } from "./installed.ts";
import { closeObserved, filedKeys, observedChecks, watchedSources, watchesSweep, watchWindows, withFiledBaselines, type DoctorLine, type ObserveFacts, type Sighting } from "./observe.ts";
import { plannedChecksLeniently } from "./plan-section.ts";
import { afterMergeChecksPath, changeChecks, loadChecks, saveChecks } from "./store.ts";

/**
 * One sweep, run at the end of each tracker refresh: every After-merge line a run listed (A11-173) that has no record yet becomes an open check, with what its ticket's plan says of it, so a check outlives its run's
 * dismissal; the closed checks no run lists any more are dropped after 30 days; each check the board watches is looked at (passed on the event it names, failed on the first breach of its window, passed when the window closes
 * clean, or handed to an agent when it cannot say); each Needs-you check is shown to the person; the checks that need a verifier run or the one-time migration are given to one (A11-302); the follow-up of a failed check of the org's
 * is filed; and each close not posted yet is posted on its ticket. A file that cannot be read changes nothing, and is logged.
 */
export async function syncAfterMergeChecks(ctx: PoolContext): Promise<void> {
  const { settings, store, now } = ctx;
  const path = afterMergeChecksPath(settings.stateDir);
  try {
    const runs = store.get().entries;
    const planned = plansOf(ctx, ticketsToSeed(loadChecks(path), runs));
    const seeded = changeChecks(path, (before) => pruneChecks(seedChecks(before, runs, now(), planned), now(), listedIds(runs)));
    await closeWhatTheBoardSaw(ctx, path, seeded);
    changeChecks(path, (before) => markOverdue(markShownToPerson(before, now()), now()));
    queueCheckRuns(ctx, installedReader(ctx));
    fileFollowUps(ctx, followUpsSaid);
    await postCloses(ctx, path, unpostedChecks(loadChecks(path)).map(({ id }) => id));
  } catch (err) {
    log(`the After-merge checks in ${path} could not be swept: ${messageOf(err)}`);
  }
}

/** The checks whose follow-up could not be filed, said once. */
const followUpsSaid = new Set<string>();

/** Whether ticket's change is in a release installed on this host, as the sweep reads it from the run log and the tool folder this instance runs from. */
function installedReader(ctx: PoolContext): (check: CheckRecord) => boolean {
  const reads: InstalledReads = { toolRoot: toolPinOf(ctx).toolRoot, now: ctx.now, merges: (key) => mergesIn(ctx.store.get().runLog?.[key]) };
  return (check) => isInstalled(reads, check.key);
}

/**
 * Pass each check the board watches and saw happen, with its evidence, after recording the dependency sweep's filed tickets on each `sweep-ticket` check that began to watch in this sweep, so only a ticket filed
 * later passes it. Then each windowed check is looked at once (A11-302): failed on the first breach, passed when its window closes clean, handed to an agent when the board cannot say; and an event the board waited a week for
 * and did not see hands its check to an agent.
 */
async function closeWhatTheBoardSaw(ctx: PoolContext, path: string, file: ChecksFile): Promise<void> {
  const facts = await observeFacts(ctx, file);
  const { dependencyTickets } = facts;
  const watched = dependencyTickets === null ? file : changeChecks(path, (before) => withFiledBaselines(before, filedKeys(dependencyTickets)));
  const passes = observedChecks(watched, facts);
  if (passes.length > 0) changeChecks(path, (before) => closeObserved(before, passes, ctx.now()));
  changeChecks(path, (before) => handOverdueToAgent(watchWindows(before, facts, ctx.now()), ctx.now()));
}

/**
 * What the plan of each ticket in `keys` names in its `## After-merge checks` section, by ticket. A bullet the board would refuse today (a plan attached before A11-302 may name the session) is left out and its line runs as an
 * agent's; a plan that cannot be read names nothing, and is logged. A check is never held back unlisted.
 */
function plansOf(ctx: PoolContext, keys: ReadonlySet<string>): Map<string, readonly PlannedCheck[]> {
  const planned = new Map<string, readonly PlannedCheck[]>();
  for (const key of keys) {
    try {
      planned.set(key, plannedChecksLeniently([...planTexts(ctx, key)]));
    } catch (err) {
      log(`${key}: ${messageOf(err)}, so its After-merge checks run as agent checks`);
    }
  }
  return planned;
}

/** The lines of this host's doctor are read at most this often: the doctor looks at services and the plugins, which a sweep each minute should not. */
const DOCTOR_EVERY_MS = 10 * 60_000;
/** The most recent runs of a branch whose conclusion the sweep reads for a `ci-history` watch. */
const CI_RUNS_READ = 20;

/** A completed run as the sweep read it once: its workflow's name, and the sighting of it when it failed. A completed run's conclusion does not change, so it is not read again. */
type ReadRun = Readonly<{ name: string; failure: Sighting | null }>;

/** What the sweep last read of this host's doctor, and the completed runs it has read. */
type SweepMemory = { doctor: { at: number; lines: readonly DoctorLine[] | null } | null; runs: Map<string, ReadRun>; branches: Map<string, { at: number; runs: readonly BranchCiRun[] }> };
const memory = new WeakMap<PoolContext, SweepMemory>();
const memoryOf = (ctx: PoolContext): SweepMemory => {
  const held = memory.get(ctx) ?? { doctor: null, runs: new Map(), branches: new Map() };
  memory.set(ctx, held);
  return held;
};

/** Whether `host` names the machine the board runs on, which is the one doctor it can read. */
const isThisHost = (host: string): boolean => ["here", "this", "localhost", hostname().toLowerCase()].includes(host.toLowerCase());

/** This host's doctor, read now and kept for {@link DOCTOR_EVERY_MS}: the board's own `diagnose`, as `agent-org doctor` prints it. Null when it could not run. */
async function hostDoctor(ctx: PoolContext): Promise<readonly DoctorLine[] | null> {
  const held = memoryOf(ctx);
  if (held.doctor !== null && ctx.now() - held.doctor.at < DOCTOR_EVERY_MS) return held.doctor.lines;
  let lines: readonly DoctorLine[] | null = null;
  try {
    lines = (await diagnose(defaultDoctorDeps())).map(({ name, ok, detail }) => ({ name, ok, detail }));
  } catch (err) {
    log(`the host's doctor could not be read for the After-merge checks that watch it: ${messageOf(err)}`);
  }
  held.doctor = { at: ctx.now(), lines };
  return lines;
}

/** A branch's workflow runs are listed at most this often: the listing is one call to the code host for each watch, each minute. */
const BRANCH_RUNS_EVERY_MS = 5 * 60_000;

/** The workflow runs of a branch, kept for {@link BRANCH_RUNS_EVERY_MS}; null when the host could not list them. */
function branchRuns(ctx: PoolContext, repository: string, branch: string): readonly BranchCiRun[] | null {
  const kept = memoryOf(ctx).branches;
  const key = `${repository}@${branch}`;
  const held = kept.get(key);
  if (held !== undefined && ctx.now() - held.at < BRANCH_RUNS_EVERY_MS) return held.runs;
  const runs = ctx.codeHost.readBranchCi?.(repository, branch, new Set()) ?? null;
  if (runs !== null) kept.set(key, { at: ctx.now(), runs });
  return runs;
}

/** The failed runs of the workflow `workflow` of `repository`'s branch, as sightings, through the code host's two optional reads of a run; null when the host reads neither. A completed run is read once. */
function ciFailures(ctx: PoolContext, repository: string, workflow: string, branch: string | undefined): readonly Sighting[] | null {
  const { codeHost } = ctx;
  if (codeHost.readBranchCi === undefined || codeHost.readCiRun === undefined) return null;
  const runs = branchRuns(ctx, repository, branch ?? "main");
  if (runs === null) return null;
  const known = memoryOf(ctx).runs;
  const sightings: Sighting[] = [];
  for (const run of runs.filter((each) => each.status === "completed").slice(0, CI_RUNS_READ)) {
    const key = `${repository}#${run.id}`;
    let read = known.get(key);
    if (read === undefined) {
      const ci = codeHost.readCiRun(repository, run.id);
      if (ci === null) return null;
      read = { name: ci.name, failure: ci.conclusion === "failure" ? { id: key, at: Date.parse(run.createdAt), text: `${ci.name} run ${ci.url} failed on ${branch ?? "main"}` } : null };
      known.set(key, read);
    }
    if (read.failure !== null && read.name.toLowerCase().includes(workflow.toLowerCase())) sightings.push(read.failure);
  }
  return sightings;
}

/**
 * What the board reads to pass or fail a watched check: the dependency sweep's file, read only while a check watches it (null when none does, or it cannot be read), the queue, a pull request's review through the code host, and, for the
 * windowed specs (A11-302) and only while one watches them, the code host's failed runs, this host's doctor and whether a ticket's change is installed. The releases of a repository have no reader on this host: a `release-assets` window the
 * board cannot read is handed to an agent when it closes.
 */
async function observeFacts(ctx: PoolContext, file: ChecksFile): Promise<ObserveFacts> {
  const { codeHost, settings, store } = ctx;
  const sources = watchedSources(file);
  const doctor = sources.has("doctor") ? await hostDoctor(ctx) : null;
  return {
    dependencyTickets: watchesSweep(file) ? dependencyTickets(join(dirname(afterMergeChecksPath(settings.stateDir)), DEPENDENCY_TICKETS_FILE)) : null,
    queue: store.get(),
    reviewOn: (url) => {
      try {
        const state = codeHost.readReviewState(url);
        return state === null ? null : reviewOnHead(state);
      } catch {
        return null;
      }
    },
    ciFailures: (repository, workflow, branch) => {
      try {
        return ciFailures(ctx, repository, workflow, branch);
      } catch (err) {
        log(`the code host's runs of ${repository} could not be read for the After-merge checks that watch them: ${messageOf(err)}`);
        return null;
      }
    },
    doctor: (host) => (isThisHost(host) ? doctor : null),
    installed: installedReader(ctx),
  };
}

/** The dependency sweep's requests by key, or null when its file cannot be read, which is logged: no check is passed or begins to watch on a file the board could not read. */
function dependencyTickets(path: string): ObserveFacts["dependencyTickets"] {
  try {
    return loadState(path).tickets;
  } catch (err) {
    log(`the dependency sweep's ${path} could not be read for the After-merge checks that watch it: ${messageOf(err)}`);
    return null;
  }
}

/**
 * Post each of the closes `ids` names on its ticket. A post is claimed on the file as it is now before it is sent, so a sweep beside this one never posts it too, and released when it fails, so the next sweep
 * tries again. A tracker that cannot comment keeps the close on the board alone, and the log says so once.
 */
async function postCloses({ source }: PoolContext, path: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    if (source.comment === undefined) {
      const check = changeChecks(path, (before) => markUnpostable(before, id)).checks[id];
      log(`${check.key}: its After-merge check ${id} closed ${check.state} on the board; this tracker cannot post it as a comment`);
      continue;
    }
    const current = loadChecks(path);
    const claimed = claimPost(current, id);
    if (claimed === current) continue;
    saveChecks(path, claimed);
    const check = claimed.checks[id];
    try {
      await source.comment(check.key, closeComment(check));
    } catch (err) {
      changeChecks(path, (file) => releasePost(file, id));
      log(`${check.key}: its After-merge check ${id} could not be posted as a comment, and is tried again at the next refresh: ${messageOf(err)}`);
    }
  }
}
