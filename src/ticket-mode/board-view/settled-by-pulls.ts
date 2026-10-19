import { CONCLUDED, HANDED_BACK, RESULT_KINDS, RUN_STATUSES, hasPlan, openPulls, type RunStatus, type ViewBlocker, type ViewEntry, type ViewTicket } from "./view-ticket.ts";

/**
 * A finished run's status from its pull requests alone, once each has merged or closed: completed when any merged, cancelled when every one
 * closed unmerged. `null` while one is still open, and for a run with none.
 */
export function settledByPulls(entry: ViewEntry): RunStatus | null {
  const states = (entry.outcome?.prs ?? []).map(({ url }) => entry.pullStates?.[url]);
  if (states.length === 0 || !states.every((state) => state === "merged" || state === "closed")) return null;
  return states.includes("merged") ? "completed" : "cancelled";
}

/**
 * The blockers still holding a queued run back, given every run on the queue. A blocker lets go once the tracker completes it, or, when it is on
 * the queue itself, once its run is completed, which its pull requests merging is enough for. A blocker the planner said to wait on to merge
 * (`waitMerged`) also lets go once its pull requests have merged ({@link pullsMerged}). A canceled or duplicate blocker never lets go: the
 * work it promised will not come, so a person decides. Waiting is not on order: an unblocked run queued later starts first. A blocker the run can
 * be stacked on ({@link stackedOn}) does not hold it back.
 */
export function waitsOn(entry: ViewEntry, entries: readonly ViewEntry[]): ViewBlocker[] {
  return (entry.blockers ?? []).filter((blocker) => !isDoneFor(entry, blocker, entries) && stackPullOf(entry, blocker) === null);
}

/** Whether the planner said the run waits for this blocker to merge, rather than stacking on it: its key is in the run's `waitMerged`. */
const waitsToMerge = (entry: ViewEntry, blocker: ViewBlocker): boolean => (entry.waitMerged ?? []).includes(blocker.key);

/** Whether a blocker is done: the tracker completed it, or its run on the queue is Completed. */
function isDone(blocker: ViewBlocker, entries: readonly ViewEntry[]): boolean {
  if (blocker.state === "completed") return true;
  const run = entries.find((e) => e.ticket.key === blocker.key);
  return run !== undefined && run.phase === "finished" && runStatus(run) === "completed";
}

/**
 * Whether a blocker's pull requests have merged: at least one has, and none is still open. Linear completes a ticket on a merge only where its
 * team's workflow says so, so a run the planner held until the merge must not wait on the tracker's word alone. A canceled or duplicate blocker
 * never lets go, whatever its pull requests did.
 */
function pullsMerged(blocker: ViewBlocker): boolean {
  if (blocker.state === "canceled" || blocker.state === "duplicate") return false;
  const states = Object.values(blocker.pulls ?? {});
  return states.includes("merged") && !states.includes("open");
}

/** Whether a blocker is done for a run: {@link isDone}, and, for one the run waits on to merge, once its pull requests have merged ({@link pullsMerged}). */
const isDoneFor = (entry: ViewEntry, blocker: ViewBlocker, entries: readonly ViewEntry[]): boolean =>
  isDone(blocker, entries) || (waitsToMerge(entry, blocker) && pullsMerged(blocker));

/** The repository and number of a GitHub pull request, from its URL's `/<owner>/<repo>/pull/<n>`, or null for any other URL. PURE. */
function parsePull(url: string): Readonly<{ repo: string; number: string }> | null {
  const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  return match === null ? null : { repo: match[1], number: match[2] };
}

/** The repository a GitHub pull request is in, or null for a URL that is not one. */
export const repoOfPull = (url: string): string | null => parsePull(url)?.repo ?? null;

/**
 * The URL of a blocker's open pull request (a draft is open) in `repo`, or null when it has none there, or no repository is named. A canceled or
 * duplicate blocker has none to stack on, because the work it promised will not come, and nor has one whose branch is unknown.
 */
function stackPull(blocker: ViewBlocker, repo: string | null | undefined): string | null {
  if (!blocker.branch || blocker.state === "canceled" || blocker.state === "duplicate") return null;
  return Object.entries(blocker.pulls ?? {}).find(([url, state]) => state === "open" && repoOfPull(url) === repo)?.[0] ?? null;
}

/** The open pull request a run of `entry` can stack on for `blocker`: none when the planner said to wait for the blocker to merge. */
const stackPullOf = (entry: ViewEntry, blocker: ViewBlocker): string | null =>
  waitsToMerge(entry, blocker) ? null : stackPull(blocker, entry.plannedRepo);

/** A blocker a run starts on top of: its key, its open pull request, the repository that is in, which is the run's, and its branch. */
export type StackBase = Readonly<{ key: string; url: string; repo: string; branch: string }>;

/**
 * The blockers a run starts on top of rather than waits for. A blocker not yet done is one when the run's planner placed its work in a
 * repository where the blocker has an open pull request: the run branches from the blocker's branch, and its pull request is stacked on the
 * blocker's. A blocker the planner said to wait on to merge is never one. A run with no planned repository stacks on nothing, and a finished run
 * is stacked on nothing any more.
 */
export function stackedOn(entry: ViewEntry, entries: readonly ViewEntry[]): StackBase[] {
  const repo = entry.plannedRepo;
  if (entry.phase === "finished" || !repo) return [];
  return (entry.blockers ?? []).flatMap((blocker) => {
    const url = isDoneFor(entry, blocker, entries) ? null : stackPullOf(entry, blocker);
    return url === null || !blocker.branch ? [] : [{ key: blocker.key, url, repo, branch: blocker.branch }];
  });
}

/** What the board says about a run stacked on its blockers, such as "Stacked on NBF-1 #12". */
export const stackNote = (bases: readonly StackBase[]): string => `Stacked on ${bases.map(({ key, url }) => `${key} #${parsePull(url)?.number ?? url}`).join(", ")}`;

/**
 * What the board says about a queued run held back, or null when none holds it: until its blockers merge, such as "Waits for NBF-1 to merge", or
 * for a path another run holds, such as "Waits on NBF-1 #12: both touch pool.ts".
 */
export function waitNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  const keys = waitsOn(entry, entries).filter((blocker) => waitsToMerge(entry, blocker)).map(({ key }) => key);
  if (keys.length > 0) return `Waits for ${keys.join(", ")} to merge`;
  const overlap = overlapWait(entry, entries);
  return overlap === null ? null : `Waits on ${overlap.key}${overlap.pull === null ? "" : ` #${overlap.pull}`}: both touch ${overlap.path}`;
}

/** Split a repository-prefixed path, `<repo>:<path>`, into its repository and its path within it. PURE. */
const repoPath = (path: string): [string, string] => {
  const cut = path.indexOf(":");
  return [path.slice(0, cut), path.slice(cut + 1)];
};

/**
 * Whether two repository-prefixed paths touch the same files: they are in one repository, and are equal, or one is a directory (its path ends in
 * `/`) that holds the other. Sibling directories, and a file and a directory it is not in, do not overlap. An empty path is the whole repository:
 * what a pull request holds when the list of its files is cut short, so that what is not listed is not taken for untouched. PURE.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const [repoA, pathA] = repoPath(a);
  const [repoB, pathB] = repoPath(b);
  if (repoA !== repoB) return false;
  if (pathA === "" || pathB === "") return true;
  return pathA === pathB || (pathA.endsWith("/") && pathB.startsWith(pathA)) || (pathB.endsWith("/") && pathA.startsWith(pathB));
}

/**
 * A run's footprint: the paths its plan says its work touches, and the files each of its open pull requests changes, each in the repository that
 * pull request is in. PURE.
 */
export function footprintOf(entry: ViewEntry): string[] {
  const changed = openPulls(entry).flatMap(({ url, repo }) => (repo === undefined ? [] : (entry.pullFiles?.[url] ?? []).map((file) => `${repo}:${file}`)));
  return [...(entry.paths ?? []), ...changed];
}

/** The tracker's states that end a ticket's work: a run on such a ticket is done, or was dropped, and holds nothing once it is not live. */
const ENDED_TICKETS: ReadonlySet<string> = new Set(["completed", "canceled", "duplicate"]);

/**
 * Whether a run holds its footprint against the runs queued behind it: it is live, or it has a pull request still open and its ticket has not
 * ended. That is a finished run, a draft too, or a queued review round, which keeps the pull requests it continues.
 */
const holds = (entry: ViewEntry): boolean => {
  if (entry.phase === "starting" || entry.phase === "running") return true;
  const pullsOpen = entry.phase === "finished" || entry.review !== undefined;
  return pullsOpen && openPulls(entry).length > 0 && !ENDED_TICKETS.has(entry.trackerState ?? "");
};

/**
 * Whether a holder is exempt from a queued run: one of its own blockers, or a run that is blocked by it. Those are sequenced on purpose
 * (`waitsOn`, `stackedOn`), so they are never held against each other.
 */
const exempt = (entry: ViewEntry, other: ViewEntry): boolean =>
  (entry.blockers ?? []).some(({ key }) => key === other.ticket.key) || (other.blockers ?? []).some(({ key }) => key === entry.ticket.key);

/** The run a queued run waits on for a shared path: its key, the number of its first open pull request when it has one, and the path both touch. */
export type OverlapWait = Readonly<{ key: string; pull: string | null; path: string }>;

/**
 * Why a queued run waits, for a path it shares with a run already held in its repository (see {@link holds}), or null when it waits on none. A
 * run is not held by one of whose blockers it is or that is one of its blockers, since those are sequenced on purpose (`waitsOn`, `stackedOn`).
 * Tickets planned together are worked as separate runs, and are held against each other like any others. A review round, a conflict round and a
 * planning run are never held, and nor is a run with no paths declared. `entries` is the whole queue, or the queue with the runs a pass has just
 * chosen counted as starting, so a batch of starts keeps to one another. PURE.
 */
export function overlapWait(entry: ViewEntry, entries: readonly ViewEntry[]): OverlapWait | null {
  const mine = entry.paths ?? [];
  if (entry.phase !== "queued" || entry.plan !== undefined || entry.review !== undefined || mine.length === 0) return null;
  for (const other of entries) {
    if (other.ticket.key === entry.ticket.key || !holds(other) || exempt(entry, other)) continue;
    const held = footprintOf(other);
    const path = mine.find((own) => held.some((theirs) => pathsOverlap(own, theirs)));
    if (path !== undefined) return { key: other.ticket.key, pull: parsePull(openPulls(other)[0]?.url ?? "")?.number ?? null, path: repoPath(path)[1] };
  }
  return null;
}

/**
 * A run's status. A queued run is blocked while a ticket that blocks it is not done, and cannot be stacked on (`entries` is the whole queue, for {@link waitsOn}),
 * or while it waits on a path another run holds ({@link overlapWait}). The
 * tracker's word wins once the run has finished: a ticket it completed is done and one it canceled is cancelled, whatever the run ended in. Then
 * its pull requests: Linear completes a ticket on a merge only where its team's workflow says so, so a run whose pull requests merged is done
 * even while its ticket is still in progress. Before either, the outcome decides. It never answers Publishing: that is {@link shownStatus}'s.
 */
export function runStatus(entry: ViewEntry, entries: readonly ViewEntry[] = []): RunStatus {
  if (entry.phase === "queued") return waitsOn(entry, entries).length > 0 || overlapWait(entry, entries) !== null ? "blocked" : "queued";
  if (entry.phase !== "finished") return entry.waiting ? "needs-you" : entry.plan ? "planning" : entry.review ? "reviewing" : "working";
  if (entry.trackerState === "completed") return "completed";
  if (entry.trackerState === "canceled" || entry.trackerState === "duplicate") return "cancelled";
  const kind = entry.outcome?.kind ?? "";
  if (kind === "draft-pr" || kind === "ready-pr") return settledByPulls(entry) ?? "awaiting-review";
  if (kind === "reviewed") return settledByPulls(entry) ?? (entry.handedBack !== undefined ? "needs-you" : entry.published ? "published" : "ready-to-merge");
  if (HANDED_BACK.has(kind)) return "needs-you";
  if (kind === "checked") return "checked";
  if (kind === "done") return "completed";
  return kind === "stopped" ? "cancelled" : "failed";
}

/**
 * The note a running run shows from its worker's `working` outcome: its reason, which says what of its own is still running, or, once its agent
 * has sat idle with no newer outcome for `tickets.stallMinutes`, that it has stalled, with that reason. Null for any other run. The run's status
 * stays In progress either way: nothing is asked of a person, and a stalled run is only flagged so it is not forgotten.
 */
export function workingNote(entry: ViewEntry): Readonly<{ text: string; stalled: boolean }> | null {
  const note = entry.working;
  if (entry.phase !== "running" || note === undefined) return null;
  if (note.stalled !== true) return { text: note.reason, stalled: false };
  // `stallReason` is queue.ts's BACKGROUND_GONE when the pane showed no background work; this module imports nothing, so it reads the reason as text.
  return { text: `Stalled: ${note.stallReason ?? "idle with no newer outcome"} since it said: ${note.reason}`, stalled: true };
}

/**
 * The line the board shows for a finished run whose reviewer's verdict is not on one of its pull requests (A11-83), or null when every verdict is.
 * The run's status does not change for it: a person reads the reason and decides, as the pool does not retry past its attempts.
 */
export function verdictNote(entry: ViewEntry): string | null {
  return entry.phase === "finished" && entry.verdictNotPosted !== undefined ? entry.verdictNotPosted : null;
}

/**
 * The line the board shows for a finished run with a stacked pull request whose base needs saying (A11-106), one per pull request, or null when none does.
 * The run's status does not change for it: a person reads what is needed, and the sweep clears it once the base is current.
 */
export function retargetNote(entry: ViewEntry): string | null {
  const notes = entry.phase === "finished" ? Object.values(entry.retargets ?? {}) : [];
  return notes.length > 0 ? notes.join("; ") : null;
}

/**
 * The status the board shows for a run: its {@link runStatus}, except that a run Ready to merge is Publishing while the board's `publish` run is
 * posting it. The pool, and what a run offers or is watched for, go by `runStatus`, which still calls that run Ready to merge.
 */
export function shownStatus(entry: ViewEntry, publish: ViewPublish | undefined, entries: readonly ViewEntry[] = []): RunStatus {
  const status = runStatus(entry, entries);
  return status === "ready-to-merge" && isBeingPublished(entry, publish) ? "publishing" : status;
}

/** How many runs have each status, as the board shows them. */
export function statusCounts(entries: readonly ViewEntry[], publish?: ViewPublish): Map<RunStatus, number> {
  const counts = new Map<RunStatus, number>(RUN_STATUSES.map(({ status }) => [status, 0]));
  for (const status of entries.map((entry) => shownStatus(entry, publish, entries))) counts.set(status, (counts.get(status) ?? 0) + 1);
  return counts;
}

/** The runs a filter shows (every run for `null`), the most recently active first, as GitHub lists its runs. */
export function runsShown<T extends ViewEntry>(entries: readonly T[], filter: RunStatus | null, publish?: ViewPublish): T[] {
  const latest = (entry: ViewEntry) => entry.finishedAt ?? entry.startedAt ?? entry.queuedAt ?? 0;
  return entries.filter((entry) => filter === null || shownStatus(entry, publish, entries) === filter).sort((a, b) => latest(b) - latest(a));
}

/** A parked run: a finished one that kept its herdr workspace, so a person can still answer its agent there. It holds no slot. */
export const isParked = (entry: ViewEntry): boolean => entry.phase === "finished" && entry.workspace !== undefined;

/** What a person can do to a run from the board. */
export type RunAction = "remove" | "stop" | "retry" | "close" | "approve" | "respond" | "dismiss" | "apply-edit" | "discard-edit";

/** Why a person presses Approve, shown as its tooltip: the drafts are reviewed. */
export const APPROVE_TITLE = "Drafts reviewed and approved: mark the pull requests ready, then see them through their checks and review";

/** Why a person presses Respond to review, shown as its tooltip: the pull requests are ready, and have feedback to answer. */
export const RESPOND_TITLE = "Answer the feedback on these ready pull requests now: their reviews, comments and failing checks";

/** Why a person presses Dismiss, shown as its tooltip: only the board's record goes. */
export const DISMISS_TITLE = "Take this run off the board, closing its workspace if it is open. The ticket, its branch and its pull requests are left as they are";

/** Why a person presses Dismiss on a run with a proposed edit, shown as its tooltip: the proposal goes with the run (A11-91). */
export const DISMISS_EDIT_TITLE = `${DISMISS_TITLE}. Its proposed edit to the ticket's text is dropped too`;

/** Why a person presses Apply edit, shown as its tooltip: the worker's proposed title and description are written to the ticket. */
export const APPLY_EDIT_TITLE = "Write the worker's proposed title and description to the ticket. Refused when the ticket has changed since the worker proposed them";

/** Why a person presses Discard edit, shown as its tooltip: the proposal is dropped and the ticket is left as it is. */
export const DISCARD_EDIT_TITLE = "Drop the worker's proposed edit. The ticket is left as it is";

/** Whether a finished run holds a worker's proposed edit to its ticket's text, which a person has not applied or discarded (A11-91). */
export const hasEdit = (entry: ViewEntry): boolean => entry.outcome?.edit !== undefined;

/**
 * The actions a run offers. A queued run can be removed and a live one stopped. A finished run that kept its workspace (parked) can be closed,
 * and only once it is closed can it be retried. Pull requests are results, and are not retried, and nor is a run that concluded with nothing more
 * to do ({@link CONCLUDED}). Drafts awaiting review offer Approve, which marks them ready. Ready ones (Ready to merge, Published, or handed back
 * after the board's own rounds) offer Respond to review, which answers their feedback now. EVERY FINISHED RUN OFFERS DISMISS, last, a parked one
 * too, so no run stays on the board for ever: it takes the run off the board and closes its workspace if one is open. A run the publish run under
 * way is posting is the exception: `queue.ts`'s `dismiss` keeps it until it has posted, so it is not offered there either.
 */
export function runActions(entry: ViewEntry, publish?: ViewPublish): RunAction[] {
  if (entry.phase === "queued") return ["remove"];
  if (entry.phase !== "finished") return ["stop"];
  const dismiss: RunAction[] = isBeingPublished(entry, publish) ? [] : ["dismiss"];
  const edit: RunAction[] = hasEdit(entry) ? ["apply-edit", "discard-edit"] : [];
  if (isParked(entry)) return ["close", ...edit, ...dismiss];
  const status = runStatus(entry);
  if (status === "awaiting-review" && entry.outcome?.kind === "draft-pr") return ["approve", ...edit, ...dismiss];
  if (status === "ready-to-merge" || status === "published" || (status === "needs-you" && entry.handedBack !== undefined)) return ["respond", ...edit, ...dismiss];
  const kind = entry.outcome?.kind;
  const done = kind === undefined || RESULT_KINDS.has(kind) || CONCLUDED.has(kind) || status === "completed";
  return [...(done ? [] : ["retry" as const]), ...edit, ...dismiss];
}

/**
 * Whether the board watches a run's pull requests for new feedback: it is Ready to merge or Published, or a ready-pr run waiting for review
 * (opened ready on a machine with `tickets.drafts: false`, with no Approve to come). It holds no workspace, and has a pull request still open.
 * Merged or closed pull requests are never watched.
 */
export function isWatched(entry: ViewEntry): boolean {
  const status = runStatus(entry);
  const waitingReady = status === "awaiting-review" && entry.outcome?.kind === "ready-pr";
  return (status === "ready-to-merge" || status === "published" || waitingReady) && !isParked(entry) && openPulls(entry).length > 0;
}

/**
 * Whether the board resumes a run's worker when one of its pull requests conflicts with its base (A11-89): a run {@link isWatched} is, and so is a
 * finished run with a pull request still open that is not a result, concluded or stopped. That is a run parked on a question (`needs-human`), one
 * that ended with no outcome or crashed, or one that handed its ticket back: the worker can clear a conflict itself, so the board does not wait on a
 * person. A run the tracker completed or canceled is left alone, and so is one whose pull requests all merged or closed.
 */
export function resumesOnConflict(entry: ViewEntry): boolean {
  if (isWatched(entry)) return true;
  const kind = entry.outcome?.kind ?? "";
  const status = runStatus(entry);
  return entry.phase === "finished" && openPulls(entry).length > 0 && !RESULT_KINDS.has(kind) && !CONCLUDED.has(kind) && kind !== "stopped"
    && status !== "completed" && status !== "cancelled";
}

/** The fields of the board's publish run that the page reads: its workspace and pane are set once it runs, and dropped when it ends. */
export type ViewPublish = Readonly<{ keys: readonly string[]; phase: string; failure?: string; workspace?: string; pane?: string }>;

/** Whether the publish run is still to finish: queued, starting or running. */
export const isPublishing = (publish: ViewPublish | undefined): boolean => publish !== undefined && publish.phase !== "finished";

/** Whether the publish run still to finish is the one posting this run's pull requests. */
export const isBeingPublished = (entry: ViewEntry, publish: ViewPublish | undefined): boolean =>
  isPublishing(publish) && publish?.keys.includes(entry.ticket.key) === true;

/**
 * A run can be ticked for Publish only once it is Ready to merge: a person approved its pull requests and they passed their review and checks.
 * A published run, a parked one, and one the publish run in progress holds are not.
 */
export const publishable = (entry: ViewEntry, publish?: ViewPublish): boolean =>
  runStatus(entry) === "ready-to-merge" && !isParked(entry) && !isBeingPublished(entry, publish);

/** The Publish button's words for `count` ticked runs. */
export const publishLabel = (count: number): string => `Publish selected (${count})`;

/** What the Board says about the last publish run: that it is under way, or why it failed. Null once it published, and when there is none. */
export function publishNote(publish: ViewPublish | undefined): string | null {
  if (publish === undefined) return null;
  const runs = `${publish.keys.length} run${publish.keys.length === 1 ? "" : "s"}`;
  if (isPublishing(publish)) return `Publishing ${runs}`;
  return publish.failure === undefined ? null : `Publishing ${runs} failed: ${publish.failure}`;
}

/**
 * The web address of a run's live terminal: `template` (the host file's `tickets.terminal`) with the run's `{workspace}`, `{pane}` and `{key}`
 * filled in, each encoded for a URL. Null when the machine serves no terminal or the run holds no pane.
 */
export function terminalLink(template: string | null, entry: ViewEntry): string | null {
  if (template === null || entry.workspace === undefined || entry.pane === undefined) return null;
  const values: Readonly<Record<string, string>> = { workspace: entry.workspace, pane: entry.pane, key: entry.ticket.key };
  return template.replace(/\{(workspace|pane|key)\}/g, (_, name: string) => encodeURIComponent(values[name]));
}

/**
 * The web address of the publish run's terminal, which every run that shows Publishing links on its own row: `terminalLink` with the publish
 * run's workspace and pane in place of the run's own. Null for any other run, and while the publish run has no pane yet.
 */
export const publishTerminalLink = (template: string | null, entry: ViewEntry, publish: ViewPublish | undefined): string | null =>
  shownStatus(entry, publish) === "publishing" ? terminalLink(template, { ...entry, workspace: publish?.workspace, pane: publish?.pane }) : null;

type Choice = Readonly<{ model: string; effort: string }>;

/** The model and effort the tickets queued next run with: the default, with the parts chosen for this batch in its place. */
export const batchChoice = (defaults: Choice, batch: Partial<Choice>): Choice => ({ ...defaults, ...batch });

/**
 * The parts of `chosen` that differ from the default, which is all a batch keeps. A part chosen equal to the default is dropped, so the batch
 * follows the default there when the default changes.
 */
export const batchOverride = (defaults: Choice, chosen: Choice): Partial<Choice> => ({
  ...(chosen.model === defaults.model ? {} : { model: chosen.model }),
  ...(chosen.effort === defaults.effort ? {} : { effort: chosen.effort }),
});

/** Whether a batch runs on the default, having chosen nothing of its own. */
export const isDefaultBatch = (batch: Partial<Choice>): boolean => Object.keys(batch).length === 0;

/** What the Pick footer says beside the batch's model and effort. */
export const batchNote = (defaults: Choice, batch: Partial<Choice>): string =>
  isDefaultBatch(batch) ? "The default" : `These tickets only. The default is ${defaults.model} at ${defaults.effort} effort`;

/** What the Board says about how many workers run at once. */
export const workersLabel = (max: number): string => `Up to ${max} worker${max === 1 ? "" : "s"} at once`;

/** The Queue button's words for `count` selected tickets, `planning` of which are planned first. */
export function queueLabel(count: number, planning = 0): string {
  if (count === 0) return "Select tickets to queue";
  const queue = `Queue ${count} ticket${count === 1 ? "" : "s"}`;
  if (planning === 0) return queue;
  const which = planning < count ? String(planning) : count === 1 ? "it" : "all";
  return `${queue}, planning ${which} first`;
}

/** How many of `tickets` have no plan of their own, so would be planned first. */
export const unplannedCount = (tickets: readonly ViewTicket[], plan: RegExp): number => tickets.filter((t) => !hasPlan(t, plan)).length;
