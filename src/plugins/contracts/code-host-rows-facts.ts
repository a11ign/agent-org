// @ts-check
// module: the facts the code host's rows answer for wake, the claim and the filing of rows (A11-160, step 7)
//
// A TYPE FILE: it imports nothing at run time. These are the shapes of what the operations of `code-host-rows.ts` read, declared apart so that file stays within its public API.

// --- wake (A11-160, step 7) ------------------------------------------------------------------------------------------------------------

/** A comment of a row as the wake's marker reads see it: who wrote it, when (ms), and whether its body carries the marker asked for. */
export type MarkedComment = { id: number; login: string; at: number; marked: boolean };

/** The last time a label was put on a row or taken off it: the event's name (`labeled`, `unlabeled`), when (ms) and who. */
export type LabelEvent = { event: string; at: number; by: string };

/** The title, labels and body of a row, as the tier check reads them. */
export type TierFacts = { labels: string[]; body: string; title: string };

// --- the claim (A11-160, step 7) -------------------------------------------------------------------------------------------------------

/** A row as REST states it: its number, its title, the names of its labels, and its state upper-cased (absent when REST gave neither `open` nor `closed`). */
export type RestRow = { number: number; title: string; labels: string[]; state?: "OPEN" | "CLOSED" };
/** A REST read of a row: the row, or `unreadable` with the words the caller refuses in when the answer is not one (it is neither a refusal, which throws, nor a row). */
export type RestRowRead = { row: RestRow } | { unreadable: string };
/** A REST read of a row's comments: their bodies, oldest first, or `unreadable` as {@link RestRowRead}. */
export type RestCommentsRead = { comments: string[] } | { unreadable: string };

// --- the filing of rows and the top-level claim and row files (A11-160, step 7) --------------------------------------------------------

/** A runner that takes the program with its arguments, as `row-file`'s callers are handed one (`defaultRun`, or a test's stub): {@link CodeHostRows.argumentsRunOf} makes the arguments-only runner the operations take of it. */
export type CommandRun = (command: string, args: string[]) => string;

/** A row another row is blocked by, as the filing reads it: its state (GitHub's own word) and its body. */
export type BlockerRead = { state: string; body: string };

/** A milestone as the filing reads it: its title and the description it is judged primary by. */
export type MilestoneRead = { title?: string; description?: string | null };

/** One project item of a row with its value of a single-select field, as the filing reads it. */
export type RoadmapItemRead = { id: string; number: number; owner: string; value: string | null };

/** A single-select field of a board with the ids a write needs and the options the project holds now. */
export type RoadmapFieldRead = { projectId: string; fieldId: string; options: { id: string; name: string }[] };

// --- the claim's rules (A11-160, step 7) ----------------------------------------------------------------------------------------------
/** A row's body, labels and `blockedBy` edge, and the count of its sub-issues, as B2 reads a held row; `body`, `labels` and `blockedBy` are GitHub's own, absent where the answer carried none. */
export type RowShapeFacts = { body?: string; labels?: { name: string }[]; blockedBy?: { nodes?: { number?: number; state?: string }[] }; subIssues: number };

/** An open pull request with its reviews, as the review-health read decides on them (`commits` are read apart, per pull request). */
export type OpenPullReview = {
  number: number; headRefOid?: string; reviewDecision?: string | null;
  reviews?: { state?: string; body?: string; submittedAt?: string; commit?: { oid?: string } }[];
  author?: { login?: string };
};

/** A commit of a pull request, as the answerer check reads it. */
export type PullCommit = { messageHeadline?: string; committedDate?: string; authors?: { login?: string }[] };

/** An open pull request with the files it changes: `files` is the listing's first page (at most a hundred), `changedFiles` how many it changes. */
export type OpenPullFiles = { number: number; changedFiles: number; files: { path: string }[]; body?: string; labels?: { name: string }[]; headRefName?: string };

/** A pull request GitHub resolves as closing a row. */
export type ClosingPullRead = { number: number; state: "OPEN" | "MERGED" | "CLOSED"; headRefOid: string };

/** An item that cross-references a row: a pull request carries `number`, `state` and `body`, and any other source arrives as `{}`. */
export type CrossReferencingPull = { number?: number; state?: string; body?: string };

// --- the other claim and row files (A11-160, step 7) ----------------------------------------------------------------------------------
/** A label event of a row as the stall clock reads it: `labeled` or `unlabeled`, which label, and when (ISO). */
export type LabelEventRead = { event: "labeled" | "unlabeled"; label: string; at: string };

/** What `row-reachability` reads of a row: GitHub's own fields, any of which an answer may leave out. */
export type RowFacts = { body?: string | null; labels?: { name?: string }[]; state?: string; closedAt?: string | null };

/** A pull request's number and state, as GitHub words it (`OPEN`, `MERGED`, `CLOSED`). */
export type PullState = { number: number; state: string };

/** A pull request's state and the branch it was opened from. */
export type BranchedPullState = PullState & { headRefName: string };

// --- runners for a caller that keeps its own policy (A11-160, step 8) ----------------------------------------------------------------

/** {@link RowsRun}, answered as a promise: a program that fails rejects with the same error. */
export type AsyncRowsRun = (args: readonly string[]) => Promise<string>;

/**
 * How a caller that keeps its own policy asks for a runner of the code host's program (contract 1.11). Every member is optional and names only what the caller wants different from a plain call: `cwd` is where it runs, `timeoutMs`
 * how long it may take (ten minutes when absent), `maxBuffer` the most it may print, `withoutGitEnv` takes the variables a hook sets off each call's environment, `echo: false` keeps what the program prints on stderr to the failure's
 * message (it is let through to this process's own otherwise), and `guard` refuses an argument list before it is run by throwing: it is core's rule (the leak guard, the chairman's read-only allowlist), applied to the calls the operations build.
 */
export type RunnerRequest = Readonly<{
  cwd?: string; timeoutMs?: number; maxBuffer?: number; withoutGitEnv?: boolean; echo?: boolean;
  /** Variables laid over this process's environment for each call (a reviewer's role, a config directory), A11-160 step 9. */
  env?: Readonly<Record<string, string>>;
  /** The program is given this process's terminal for its standard streams and is not bounded in time or in what it prints (`pr-open`'s create, which shows the author what `gh` says): its failure carries the status and no output. A11-160 step 9. */
  inherit?: boolean;
  guard?: (args: readonly string[]) => void;
}>;

/** How a program ended: its status (`null` when it could not start or was cut), what it printed, and the spawn error where there was one. */
export type RunAnswer = Readonly<{ status: number | null; stdout: string; stderr: string; error?: string }>;

/** A runner that never throws, for a caller that reads how the program ended; `options.input` is written to its standard input. */
export type AnsweringRun = (args: readonly string[], options?: Readonly<{ input?: string }>) => RunAnswer;
