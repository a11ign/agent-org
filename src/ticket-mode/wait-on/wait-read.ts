// A leaf of ticket mode, run by no command: one read of each kind of event a worker may declare it waits on (A11-245). Every seam is handed in, so a test answers it and the board's pool supplies the real ones: the code host for CI runs
// and pull requests, the tracker for tickets, and the `fleet` program for fleet jobs. ONE CALL PER UNFINISHED ITEM; an item already read as finished or failed is not read again. A read that says nothing, throws or runs out of time is
// `unreadable`, never a verdict. Nothing here throws.
import { execFile } from "node:child_process";
import type { CodeHost } from "../../plugins/contracts/code-host.ts";
import type { TicketSource } from "../../plugins/contracts/tracker.ts";
import type { CiRunWait, FleetJobWait, JobFacts, Progress, PullRequestWait, Reading, TicketWait, Wait } from "./wait-types.ts";
import { waitKey } from "./wait-types.ts";

const MS_PER_SECOND = 1000;

/** How long one `fleet job status` may run before it is cut. */
export const FLEET_TIMEOUT_MS = 30 * MS_PER_SECOND;

/** What a read of events is given: the code host's reads, the tracker's, and the text `fleet job status <id> --json` prints (it THROWS when the program fails, cannot start or runs out of time). */
export type WaitSeams = Readonly<{
  codeHost: Pick<CodeHost, "readPullState" | "readReviewState" | "readCiRun">;
  source: Pick<TicketSource, "stateTypes">;
  fleetJobStatus: (id: string) => Promise<string>;
}>;

/** What running the program may be given besides the job: how long it may run, and the environment it runs in (a test puts a stub `fleet` on its `PATH`). */
export type FleetRun = Readonly<{ timeoutMs?: number; env?: NodeJS.ProcessEnv }>;

/** Runs `fleet job status <id> --json` (no shell) and answers what it printed. Rejects, saying so, when it exits non-zero, cannot start or outlives its timeout. */
export function fleetJobStatusVia({ timeoutMs = FLEET_TIMEOUT_MS, env = process.env }: FleetRun = {}): (id: string) => Promise<string> {
  return (id) => new Promise((resolve, reject) => {
    execFile("fleet", ["job", "status", id, "--json"], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", env }, (error, stdout, stderr) => {
      if (error === null) return resolve(stdout);
      const cut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
      reject(new Error(cut ? `fleet job status ${id} did not answer in ${timeoutMs / MS_PER_SECOND} s` : `fleet job status ${id} failed: ${firstLine(stderr) || firstLine(error.message)}`));
    });
  });
}

const firstLine = (text: unknown): string => String(text ?? "").split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";

const unreadable = (wait: Wait, why: string): Reading => ({ wait, status: "unreadable", why });
const whyOf = (error: unknown): string => firstLine((error as Error)?.message ?? error) || "it gave no reason";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is Progress => isObject(value) && Number.isFinite(value.done) && Number.isFinite(value.total) && (value.done as number) >= 0 && (value.total as number) >= 0;

/** A job's progress: `{ done, total }`, or the sum of per-box `{ done, total }` given as a list or as an object by box name. Null when the answer holds neither. */
function progressOf(answer: Record<string, unknown>): Progress | null {
  for (const field of [answer.progress, answer.boxes]) {
    if (isCount(field)) return { done: field.done, total: field.total };
    const parts = Array.isArray(field) ? field : isObject(field) ? Object.values(field) : [];
    if (parts.length > 0 && parts.every(isCount)) return { done: parts.reduce((sum, part) => sum + part.done, 0), total: parts.reduce((sum, part) => sum + part.total, 0) };
  }
  return null;
}

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** The job service's status, read as far as it is understood: fields it does not know are ignored (A11-243 had not fixed their names when this was written). Null when the text is not a status with a state. */
function jobFactsOf(text: string): JobFacts | null {
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(answer) || textOf(answer.state) === null) return null;
  const finish = typeof answer.estimatedFinish === "string" ? Date.parse(answer.estimatedFinish) : Number.NaN;
  return { state: textOf(answer.state)!, reason: textOf(answer.reason), results: textOf(answer.results) ?? textOf(answer.resultsPath), progress: progressOf(answer), estimatedFinish: Number.isFinite(finish) ? finish : null };
}

async function readFleetJob(wait: FleetJobWait, seams: WaitSeams): Promise<Reading> {
  let text: string;
  try {
    text = await seams.fleetJobStatus(wait.id);
  } catch (error) {
    return unreadable(wait, whyOf(error));
  }
  const job = jobFactsOf(text);
  if (job === null) return unreadable(wait, "the job service's status is not JSON with a state");
  switch (job.state) {
    case "done": return { wait, status: "finished", job };
    case "failed":
    case "cancelled": return { wait, status: "failed", job: { ...job, reason: job.reason ?? `the job was ${job.state}` } };
    case "queued":
    case "running": return { wait, status: "pending", job };
    default: return unreadable(wait, `the job service gave a state this board does not know: ${job.state}`);
  }
}

/** A CI conclusion that is a pass. */
const PASSING = new Set(["success", "skipped", "neutral"]);

function readCiRun(wait: CiRunWait, seams: WaitSeams): Reading {
  if (seams.codeHost.readCiRun === undefined) return unreadable(wait, "the code host cannot read a CI run (it is older than contract 1.17)");
  let run;
  try {
    run = seams.codeHost.readCiRun(wait.repository, wait.runId);
  } catch (error) {
    return unreadable(wait, whyOf(error));
  }
  if (run === null) return unreadable(wait, "the code host could not read the run");
  if (run.status !== "completed") return { wait, status: "pending", run };
  return { wait, status: run.conclusion !== null && PASSING.has(run.conclusion) ? "finished" : "failed", run };
}

/** An open pull request's review on its current head: the newest approving or change-requesting review there. Throws what the code host throws; null when the host does not say. */
function reviewOnHead(wait: PullRequestWait, seams: WaitSeams): "APPROVED" | "CHANGES_REQUESTED" | null | undefined {
  const state = seams.codeHost.readReviewState(wait.url);
  if (state === null) return undefined;
  const onHead = state.reviews.filter((review) => review.commit === state.head && (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")).sort((a, b) => b.at - a.at);
  return (onHead[0]?.state as "APPROVED" | "CHANGES_REQUESTED" | undefined) ?? null;
}

function readPullRequest(wait: PullRequestWait, seams: WaitSeams): Reading {
  let state: string | null;
  try {
    state = seams.codeHost.readPullState(wait.url);
  } catch (error) {
    return unreadable(wait, whyOf(error));
  }
  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") return unreadable(wait, "the code host could not read the pull request");
  if (state === "MERGED") return { wait, status: "finished", pull: { state, review: null } };
  if (state === "CLOSED") return { wait, status: "failed", pull: { state, review: null } };
  if (wait.until === "merged") return { wait, status: "pending", pull: { state, review: null } };
  try {
    const review = reviewOnHead(wait, seams);
    if (review === undefined) return unreadable(wait, "the code host does not say what reviews the pull request has");
    return { wait, status: review === null ? "pending" : "finished", pull: { state, review } };
  } catch (error) {
    return unreadable(wait, whyOf(error));
  }
}

async function readTicket(wait: TicketWait, seams: WaitSeams): Promise<Reading> {
  if (seams.source.stateTypes === undefined) return unreadable(wait, "the tracker cannot say where a ticket stands");
  try {
    const stateType = (await seams.source.stateTypes([wait.key])).get(wait.key);
    if (stateType === undefined) return unreadable(wait, "the tracker did not know the ticket");
    return { wait, status: stateType === "completed" ? "finished" : stateType === "canceled" ? "failed" : "pending", stateType };
  } catch (error) {
    return unreadable(wait, whyOf(error));
  }
}

/** One item, read once. Never throws. */
export async function readWait(wait: Wait, seams: WaitSeams): Promise<Reading> {
  switch (wait.kind) {
    case "fleetJob": return readFleetJob(wait, seams);
    case "ciRun": return readCiRun(wait, seams);
    case "pullRequest": return readPullRequest(wait, seams);
    case "ticket": return readTicket(wait, seams);
  }
}

/**
 * Every item, in the order declared: one read for each that has not finished, and the earlier reading kept for each that has. A failed item is kept too, since the wait it fails is over. The items are read together, so a slow one does not
 * hold the others, and none throws.
 */
export function readWaits(waits: readonly Wait[], earlier: ReadonlyMap<string, Reading>, seams: WaitSeams): Promise<Reading[]> {
  return Promise.all(waits.map((wait) => {
    const kept = earlier.get(waitKey(wait));
    return kept !== undefined && (kept.status === "finished" || kept.status === "failed") ? Promise.resolve(kept) : readWait(wait, seams);
  }));
}
