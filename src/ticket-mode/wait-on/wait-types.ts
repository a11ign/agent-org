// A leaf of ticket mode, run by no command: what a worker's `working` outcome may declare it waits on, and what the board reads of each item (A11-245). Types, and the two words every other file of this folder
// spells an item with. It imports a type or two and nothing else, so the outcome file's check, the board's watcher and the card all share one vocabulary.
import type { CiRun } from "../../plugins/contracts/code-host.ts";

/** A fleet job, by the ID the job service gave it. */
export type FleetJobWait = Readonly<{ kind: "fleetJob"; id: string }>;
/** A workflow run, by its repository (`owner/name`) and run ID. */
export type CiRunWait = Readonly<{ kind: "ciRun"; repository: string; runId: number }>;
/** A pull request, by its address, until it has merged or until a review has landed on its current head. */
export type PullRequestWait = Readonly<{ kind: "pullRequest"; url: string; until: "merged" | "reviewed" }>;
/** A ticket, by its key, until the tracker has it done. */
export type TicketWait = Readonly<{ kind: "ticket"; key: string; until: "done" }>;

/** One event a worker declared it waits on. */
export type Wait = FleetJobWait | CiRunWait | PullRequestWait | TicketWait;

/** How much of a job's or a run's work is done: pages of a fleet job, jobs of a CI run. */
export type Progress = Readonly<{ done: number; total: number }>;

/** What the job service says of a fleet job. `estimatedFinish` is epoch milliseconds; `reason` is why it failed or was cancelled, and `results` where its results are. */
export type JobFacts = Readonly<{ state: string; reason: string | null; results: string | null; progress: Progress | null; estimatedFinish: number | null }>;

/** What the code host says of a pull request: its state, and the review on its current head (only read for a `reviewed` wait on an open one). */
export type PullFacts = Readonly<{ state: "OPEN" | "MERGED" | "CLOSED"; review: "APPROVED" | "CHANGES_REQUESTED" | null }>;

/** Where an item that could be read stands: not yet over, over well, or over badly. */
export type Settled = "pending" | "finished" | "failed";

/**
 * One item as the board last read it. An item that could not be read (the read said nothing, threw or timed out) is `unreadable`: it is neither finished nor failed, so a flaky read never wakes a worker with a
 * false alarm, and the card says why it could not be read.
 */
export type Reading =
  | Readonly<{ wait: Wait; status: "unreadable"; why: string }>
  | Readonly<{ wait: FleetJobWait; status: Settled; job: JobFacts }>
  | Readonly<{ wait: CiRunWait; status: Settled; run: CiRun }>
  | Readonly<{ wait: PullRequestWait; status: Settled; pull: PullFacts }>
  | Readonly<{ wait: TicketWait; status: Settled; stateType: string }>;

/** An item's identity, the same for the same event however it was spelt: what a reading is remembered by, and what a repeated declaration is compared on. PURE. */
export function waitKey(wait: Wait): string {
  switch (wait.kind) {
    case "fleetJob": return `fleetJob:${wait.id}`;
    case "ciRun": return `ciRun:${wait.repository}#${wait.runId}`;
    case "pullRequest": return `pullRequest:${wait.url}:${wait.until}`;
    case "ticket": return `ticket:${wait.key}:${wait.until}`;
  }
}

/** What an item is, in the words the card and the wake prompt use for it: `fleet job fj-1`, `CI run owner/repo#9`, `pull request <address>`, `ticket A11-1`. PURE. */
export function subjectOf(wait: Wait): string {
  switch (wait.kind) {
    case "fleetJob": return `fleet job ${wait.id}`;
    case "ciRun": return `CI run ${wait.repository}#${wait.runId}`;
    case "pullRequest": return `pull request ${wait.url}`;
    case "ticket": return `ticket ${wait.key}`;
  }
}
