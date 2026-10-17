// @ts-check
// module: the tickets' reviewer -- starts the gate's codex reviewer on a ready pull request, once per head, behind a port the pool holds
//
// THE PORT IS THE POOL'S ONLY SEAM: `start` a reviewer for one pull request at one head, and `live`, whether one is running for that head.
// It also `close`s a reviewer once its verdict is posted, `retire`s a pull request's reviewer and checkout once the pull request has merged or
// closed, and `held` lists the reviewer workspaces the session holds, for one a `ticket:review` start left that the pool does not remember.
// The atomic adapter starts the gate's own reviewer, `spawnReviewer` in `wake.ts` with its trust rules (`review-trust.ts`) and its verdict door,
// in the tickets' herdr session. Nothing here copies that code: it is imported, teardown included. The reviewer posts as `a11ign-reviewer`, and its
// verdict is what the pool reads back to decide whether the worker goes round again.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reviewerInstance, reviewerSeat } from "../review-attribution.ts";
import { ORG_SESSION, firstLine, readAgents, type ListedAgent } from "../herdr-agents.ts";
import { pullRequestFieldsOf } from "../ticket-port/pull-request-fields.ts";
import { headMatches, reviewVerdict as verdictOfText } from "../review-verdict.ts";
import type { DoorRun, ReviewTrust } from "../review-trust.ts";

/** The gate's modules: its reviewer, its trust rules, its verdict prompt, and the org's declaration. */
type GateModules = {
  wake: typeof import("../wake.ts"); trust: typeof import("../review-trust.ts"); config: typeof import("../project-config.ts");
  identity: typeof import("../project-identity.ts"); orders: typeof import("../work-gate/pr-orders.ts"); doorPath: typeof import("../reviewer-door-path.ts");
};

/** What `loadReviewerGate` found: the modules, or the refusal that keeps them from loading on this host. Null until it has run. */
let gate: { ok: true; modules: GateModules } | { ok: false; refusal: unknown } | null = null;

/**
 * Loads the gate's modules. Importing them names the declaration the org's `primary` makes, so a host with no `primary` cannot load them, and the
 * refusal is KEPT rather than thrown: `reviewerRefusal` says it. Nothing loads them at import, so a machine that starts no reviewer never does. The
 * instance calls this only when it starts reviewers (`startsReviewers`, in `pool.ts`), before it makes its pool.
 */
export async function loadReviewerGate(): Promise<void> {
  if (gate !== null) return;
  gate = await Promise.all([import("../wake.ts"), import("../review-trust.ts"), import("../project-config.ts"), import("../project-identity.ts"), import("../work-gate/pr-orders.ts"), import("../reviewer-door-path.ts")]).then(
    ([wake, trust, config, identity, orders, doorPath]) => ({ ok: true as const, modules: { wake, trust, config, identity, orders, doorPath } }),
    (refusal: unknown) => ({ ok: false as const, refusal }),
  );
}

type DeclaredIdentities = ReturnType<typeof import("../review-trust.ts").declaredIdentities>;

/** Why the gate does not load on this host, or null when it does. A machine that asks for reviewers starts none while this is set. Needs `loadReviewerGate` first. */
export function reviewerRefusal(): string | null {
  if (gate === null) throw new Error("the gate is not loaded: loadReviewerGate runs before a pool with reviewers is made");
  if (gate.ok) return null;
  const { refusal } = gate;
  return refusal instanceof Error ? refusal.message.split("\n")[0] : String(refusal);
}

/** The gate's modules, once `loadReviewerGate` has read them. Throws the refusal when they do not load on this host. */
function reviewerGate(): GateModules {
  if (gate === null) throw new Error("the gate is not loaded: loadReviewerGate runs first");
  if (!gate.ok) throw gate.refusal;
  return gate.modules;
}

/** The account the gate's reviewer posts as. Its reviews are the reviewer's, never the feedback a worker answers. */
export const REVIEWER_LOGIN = "a11ign-reviewer";

/** The cause the reviewer is started for: the gate's `draft-awaiting-verdict`, the one a ready pull request is reviewed under. */
export const REVIEW_CAUSE = "draft-awaiting-verdict";

/** A pull request at one head: its url, and the commit the reviewer reads and the verdict is on. */
export type ReviewerRef = Readonly<{ pr: string; head: string }>;

/**
 * The port: start a reviewer for a ready pull request at its head, or refuse naming why; say whether one is live for that head; close it once its
 * verdict is posted; retire a pull request's reviewer once it has merged or closed; and list the pull requests whose reviewer workspaces the session holds.
 */
export type ReviewerPort = Readonly<{
  start(ref: ReviewerRef): Readonly<{ label: string }> | Readonly<{ refusal: string }>;
  live(ref: ReviewerRef): boolean;
  close(ref: ReviewerRef): CloseAnswer;
  retire(pr: string): RetireAnswer;
  listedPulls(): readonly string[];
  /** Whether the reviewer for `ref` is still working, has ended its turn, or is not there (A11-83). */
  settled(ref: ReviewerRef): ReviewerSettled;
  /** The verdict file the reviewer wrote for `ref` in its checkout, or null when it wrote none (A11-83). */
  verdictFileOf(ref: ReviewerRef): string | null;
  /** Posts a verdict file through the verdict door for `ref`, minting the reviewer's token first (A11-83). */
  repostVerdict(ref: ReviewerRef, file: string): RepostAnswer;
  /** Sends the reviewer its verdict prompt again, for a reviewer that ended without writing a verdict file (A11-83). */
  reprompt(ref: ReviewerRef): PromptAnswer;
}>;

/** Where a reviewer stands: `working` while its turn runs, `ended` when it has finished its turn (or its agent has exited), `gone` when herdr lists none for its head. */
export type ReviewerSettled = "working" | "ended" | "gone";

/**
 * What `repostVerdict` answers: `posted`, or a refusal naming why the verdict is not on the pull request. `final` is set where a later attempt would
 * only be refused the same way (the door's exits for a malformed call, a second review at an equal patch, and a moved head); the pool stops there.
 */
export type RepostAnswer = Readonly<{ posted: true }> | Readonly<{ refusal: string; final: boolean }>;
/** What `reprompt` answers: `prompted`, or a refusal naming why the prompt was not sent. */
export type PromptAnswer = Readonly<{ prompted: true }> | Readonly<{ refusal: string }>;

/** The statuses herdr shows for a reviewer whose turn is over: idle or done, or no agent at all (its process exited). */
const ENDED_STATUSES: readonly string[] = ["idle", "done", "unknown"];

/** The door's exits a repost cannot cure: 2 (a malformed call), 3 (a second review at an equal patch) and 5 (the head moved). */
const FINAL_DOOR_EXITS: readonly number[] = [2, 3, 5];

/**
 * What `close` answers: `closed` (the workspace under the seat's label is closed), `gone` (herdr lists none: nothing to close), or `busy` (one is still
 * working: asked again), or a refusal naming why.
 */
export type CloseAnswer = Readonly<{ state: "closed" | "gone" | "busy" }> | Readonly<{ refusal: string }>;
/**
 * What `retire` answers: `retired`, with the report of the uncommitted changes its checkout is removed with (null when it had none, or none could be
 * seen), or a refusal naming the step that did not happen. A refusal leaves whatever is not yet removed in place for the next sweep.
 */
export type RetireAnswer = Readonly<{ retired: true; report: string | null }> | Readonly<{ refusal: string }>;

/** How many changed paths a discard report names before it says how many more there were. */
const REPORTED_PATHS = 20;

/**
 * The log line a retire writes for the uncommitted changes its checkout is removed with: the first {@link REPORTED_PATHS} paths, then how many
 * more there were. Null when there were none.
 */
function discardReport({ label, pr, head, path, paths }: { label: string; pr: string; head: string; path: string; paths: readonly string[] }): string | null {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, REPORTED_PATHS).join(", ");
  const more = paths.length > REPORTED_PATHS ? ` and ${paths.length - REPORTED_PATHS} more` : "";
  return `reviewer teardown: ${label} for ${pr} at ${head} had ${paths.length} uncommitted change(s) in ${path}, discarded with the checkout: ${shown}${more}`;
}

/**
 * What the pool reads of a pull request's reviewer: its head, whether the org's own, the reviews on it, whether its checks have settled green, and
 * the pull request as the gate's verdict prompt reads it (`view`).
 */
export type ReviewState = Readonly<{ head: string; trust: ReviewTrust; reviews: readonly Review[]; settled: boolean; view: Readonly<Record<string, any>> }>;
type Review = Readonly<{ author: string; state: string; commit: string; at: number }>;

/** The pull request's repository (`owner/name`) and number, or null for a url that is none. */
function pullOf(url: string): { repository: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(url);
  return match === null ? null : { repository: match[1], number: Number(match[2]) };
}

/** The key of a repository the project declares: `""` for the primary's, `null` for one it does not declare, which is no seat at all. */
function repoKeyOf(repository: string): string | null {
  const { config, identity } = reviewerGate();
  if (repository === identity.REPO) return "";
  return config.homeProjectDeclaration().code.find((code) => code.repo === repository)?.key ?? null;
}

/** The repository a key names: the reverse of {@link repoKeyOf}, and `null` for a key the project does not declare. */
function repositoryOfKey(key: string): string | null {
  const { config, identity } = reviewerGate();
  return key === "" ? identity.REPO : config.homeProjectDeclaration().code.find((code) => code.key === key)?.repo ?? null;
}

/** The reviewer's seat for a pull request: `reviewer-<n>` in the primary, `reviewer-<key>-<n>` elsewhere, or a refusal naming why it has none. */
function seatOf(url: string): { label: string; number: number; key: string } | { refusal: string } {
  const pull = pullOf(url);
  if (pull === null) return { refusal: `no reviewer for ${url}: it is not a pull request url` };
  const key = repoKeyOf(pull.repository);
  if (key === null) return { refusal: `no reviewer for ${url}: ${pull.repository} is not a repository the project declares` };
  return { label: reviewerSeat({ repoKey: key, number: pull.number }), number: pull.number, key };
}

/**
 * The pull request's state as the reviewer sees it: its head, whether its author is the org's own (`INSIDE`), and its reviews. Null when GitHub
 * does not say, which the caller reads as no reading rather than as a verdict. It throws the gate's refusal when the gate does not load (`reviewerRefusal`).
 */
export function readReviewState(url: string, gh: (args: string[]) => string, declared: DeclaredIdentities = reviewerGate().trust.declaredIdentities()): ReviewState | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  const { trust, orders } = reviewerGate();
  const pr = pullRequestFieldsOf({ repo: pull.repository, number: pull.number, fields: orders.REVIEW_PULL_FIELDS, run: gh });
  try {
    if (typeof pr?.headRefOid !== "string") return null;
    const reviews: Review[] = (pr.reviews ?? []).map((r: { author?: { login?: string }; state?: string; commit?: { oid?: string }; submittedAt?: string }) => ({
      author: String(r.author?.login ?? ""), state: String(r.state ?? ""), commit: String(r.commit?.oid ?? ""),
      at: Date.parse(String(r.submittedAt ?? "")) || 0,
    }));
    const settled = orders.settledGreenOf(pr);
    return { head: pr.headRefOid, trust: trust.reviewTrustOf(pr, declared), reviews, settled, view: { ...pr, number: pull.number } };
  } catch {
    return null;
  }
}

/**
 * The pull request's state as GitHub names it, `OPEN`, `MERGED` or `CLOSED`, or null when it does not say. A merged or closed pull request is the one
 * `retire` is for; an unreadable one is nothing to act on.
 */
export function readPullState(url: string, gh: (args: string[]) => string): string | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  const state = pullRequestFieldsOf({ repo: pull.repository, number: pull.number, fields: "state", run: gh })?.state;
  return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
}

/**
 * The reviewer's verdict on `head`: the newest review it posted on that commit, `convinced` for an approval and `not-convinced` for requested
 * changes; null while it has not posted one. A review on an earlier head says nothing about this one.
 */
export function reviewVerdict(reviews: readonly Review[], head: string): "convinced" | "not-convinced" | null {
  const newest = reviews.filter((r) => r.author === REVIEWER_LOGIN && r.commit === head).sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) return null;
  return newest.state === "APPROVED" ? "convinced" : newest.state === "CHANGES_REQUESTED" ? "not-convinced" : null;
}

/**
 * Whether the reviewer has a review on `head` that was posted, in any state the door posts, including one a person dismissed (A11-83). A dismissed
 * review is one the reviewer posted: re-posting its verdict would undo the dismissal, so the verdict is not unposted. A review on an earlier head says
 * nothing about this one.
 */
export function reviewPostedAt(reviews: readonly Review[], head: string): boolean {
  return reviews.some((r) => r.author === REVIEWER_LOGIN && r.commit === head && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED"));
}

/**
 * `gh`, answering a feedback read without the reviewer's own reviews, comments and review-thread comments. They are not feedback a worker
 * answers, and `feedbackOf` would otherwise take their times into `feedbackAt`. Everything else in the answer passes through unchanged.
 */
export function withoutReviewerReviews(gh: (args: string[]) => string): (args: string[]) => string {
  return (args) => {
    const answer = gh(args);
    let data: any;
    try {
      data = JSON.parse(answer);
    } catch {
      return answer;
    }
    const pull = data?.data?.repository?.pullRequest;
    if (pull === null || typeof pull !== "object") return answer;
    const keep = (connection: any) => Array.isArray(connection?.nodes) ? { ...connection, nodes: connection.nodes.filter((node: any) => node?.author?.login !== REVIEWER_LOGIN) } : connection;
    pull.reviews = keep(pull.reviews);
    pull.comments = keep(pull.comments);
    if (Array.isArray(pull.reviewThreads?.nodes)) {
      pull.reviewThreads = { ...pull.reviewThreads, nodes: pull.reviewThreads.nodes.map((thread: any) => thread?.comments ? { ...thread, comments: keep(thread.comments) } : thread) };
    }
    return JSON.stringify(data);
  };
}

/** Where a pool keeps what it remembers of its reviewers: `tickets/reviewers.json` under the state directory. */
export function reviewerMemoryPath(stateDir: string): string {
  return join(stateDir, "tickets", "reviewers.json");
}

/**
 * What a re-post of a reviewer's verdict has done for one `url@head` (A11-83): how many attempts were made, and the reason the last one was refused.
 * Kept on disk, so a restart does not reset the count.
 */
export type Repost = { attempts: number; reason?: string };

/**
 * What a pool remembers of its reviewers across a restart: the head each seat's reviewer was started for (`heads`, by seat label), the reviewers
 * started (`started`, `url@head`), the verdicts a worker was asked to answer (`resumed`, `url@head`), and the re-posts of a verdict not on its pull request
 * (`reposts`, `url@head`). The pool holds it and the port reads `heads`.
 */
export type ReviewerMemory = { heads: Map<string, string>; started: Set<string>; resumed: Set<string>; reposts: Map<string, Repost> };

/**
 * The memory on disk. A file that is not there is nothing remembered yet; one that is there and is not what `writeReviewerMemory` writes is
 * `unreadable`, and is also nothing remembered. Neither throws.
 */
export function readReviewerMemory(path: string): { memory: ReviewerMemory; unreadable: boolean } {
  const nothing = (unreadable: boolean) => ({ memory: { heads: new Map<string, string>(), started: new Set<string>(), resumed: new Set<string>(), reposts: new Map<string, Repost>() }, unreadable });
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return nothing((error as NodeJS.ErrnoException).code !== "ENOENT");
  }
  try {
    const data = JSON.parse(text);
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
    // `reposts` is absent in a file written before A11-83: nothing was re-posted then.
    const reposts: Record<string, unknown> = data?.reposts ?? {};
    const repost = (value: any) => value !== null && typeof value === "object" && Number.isInteger(value.attempts) && value.attempts >= 0
      && (value.reason === undefined || typeof value.reason === "string");
    if (data === null || typeof data !== "object" || data.heads === null || typeof data.heads !== "object"
      || !Object.values(data.heads).every((head) => typeof head === "string") || !strings(data.started) || !strings(data.resumed)
      || reposts === null || typeof reposts !== "object" || !Object.values(reposts).every(repost)) {
      throw new Error("not a reviewer memory");
    }
    return { memory: { heads: new Map(Object.entries(data.heads) as [string, string][]), started: new Set(data.started), resumed: new Set(data.resumed),
      reposts: new Map(Object.entries(reposts) as [string, Repost][]) }, unreadable: false };
  } catch {
    return nothing(true);
  }
}

/** Writes the memory whole, through a temporary file renamed over the last one, so a write that stops midway leaves that last one. */
export function writeReviewerMemory(path: string, memory: ReviewerMemory): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify({ heads: Object.fromEntries(memory.heads), started: [...memory.started], resumed: [...memory.resumed],
    // Written only when there is one, so a file for a pool that re-posted nothing reads as it always did.
    ...(memory.reposts.size > 0 ? { reposts: Object.fromEntries(memory.reposts) } : {}) }));
  renameSync(`${path}.tmp`, path);
}

/** The first line of a file, read from its first 512 bytes, or null when it cannot be read. */
function firstLineOfFile(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(512);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8").split("\n", 1)[0];
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The files directly in `dir`, by path, and none when it cannot be listed. */
function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/** The folders directly in `dir` a reviewer's files may be in: not dot-folders, and not `node_modules`. */
function foldersIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * THE VERDICT FILE A REVIEWER WROTE FOR `head` (A11-83). The role file asks the reviewer to write its verdict to a file and post it through the door,
 * and names no path, so the file is found by what it says: the newest file, at the checkout's top or one folder down, whose first line is the verdict
 * line for pull request `number` at `head` (`headMatches`, a prefix either way). Null when there is none.
 */
export function verdictFileIn(tree: string, number: number, head: string): string | null {
  let found: { path: string; at: number } | null = null;
  for (const path of [...filesIn(tree), ...foldersIn(tree).flatMap(filesIn)]) {
    const line = firstLineOfFile(path);
    if (line === null || !line.startsWith(`**Review of #${number} at `)) continue;
    const verdict = verdictOfText(line);
    if ((verdict.verdict !== "convinced" && verdict.verdict !== "not-convinced") || !headMatches(verdict.head, head)) continue;
    let at: number;
    try {
      at = statSync(path).mtimeMs;
    } catch {
      continue;  // removed since it was listed: not a file to post
    }
    if (found === null || at > found.at) found = { path, at };
  }
  return found?.path ?? null;
}

/**
 * The atomic adapter: the gate's codex reviewer, started in the tickets' herdr `session`. The gate's functions name the org's session, so the calls
 * they make are retargeted to `session` here, and nothing else about them changes. It refuses a pull request whose author is not the org's own
 * (`review-trust.ts`): the gate's verdict door and pane reader run only in the org's session, so an outside reviewer has no place to post from.
 * The head each reviewer was started for is in `heads` (by seat label), which the pool keeps across a restart, so a restart starts a reviewer again only for a
 * head it has not reviewed. It refuses a head whose checks have not settled green: the gate's verdict is asked only of settled checks.
 */
export function atomicReviewerPort({ session, run, gh, declared = reviewerGate().trust.declaredIdentities(), spawn = reviewerGate().wake.spawnReviewer, checkout = reviewerGate().wake.prepareReviewCheckout, heads = new Map<string, string>(),
  removeCheckout = reviewerGate().wake.removeReviewCheckout, uncommittedPaths = reviewerGate().wake.uncommittedPathsOf, exists = existsSync,
  checkoutOf = reviewerGate().wake.reviewCheckoutPath, mint = reviewerTokenMintOf, door = reviewerGate().trust.runDoor }: {
  session: string; run: (args: string[]) => string; gh: (args: string[]) => string; declared?: DeclaredIdentities;
  spawn?: typeof import("../wake.ts").spawnReviewer; checkout?: typeof import("../wake.ts").prepareReviewCheckout; heads?: Map<string, string>;
  removeCheckout?: typeof import("../wake.ts").removeReviewCheckout; uncommittedPaths?: (path: string) => string[]; exists?: (path: string) => boolean;
  /** Where a seat's reviewer keeps its checkout, which holds the verdict file it wrote. */
  checkoutOf?: (label: string) => string;
  /** Mints the reviewer's token in a checkout: the reason it could not, or null when it has one. */
  mint?: (tree: string) => string | null;
  /** Runs the verdict door with the reviewer's environment: throws on a non-zero exit, with the door's stderr. */
  door?: DoorRun;
}): ReviewerPort {
  const herdr = (args: string[]) => run(args[0] === "--session" && args[1] === ORG_SESSION ? ["--session", session, ...args.slice(2)] : args);
  const listed = (): ListedAgent[] | null => readAgents(run, { session });

  /** The gate's own verdict prompt, for a seat's repository, sent to the seat's agent: the same words the gate sends a reviewer for a ready pull request. */
  const sendPrompt = (seat: { label: string; key: string }, state: ReviewState, head: string): { sent: true } | { refusal: string } => {
    const words = reviewerGate().orders.awaitingVerdictPrompt({ ...state.view, repoKey: seat.key }, reviewerGate().orders.reviewHeadsOf(state.view, head, "settled"));
    try {
      run(["--session", session, "agent", "prompt", seat.label, words]);
      return { sent: true };
    } catch (err) {
      return { refusal: err instanceof Error ? err.message.split("\n")[0] : String(err) };
    }
  };

  /** Closes every workspace under a seat's label, as the gate's teardown does; a refusal names what would not close. */
  const closeAll = (pr: string, label: string): Readonly<{ state: "closed" }> | Readonly<{ refusal: string }> => {
    const problems: string[] = [];
    const closed = reviewerGate().wake.closeReviewer(label, { run: herdr, warn: (line) => problems.push(line) });
    return closed ? { state: "closed" } : { refusal: `no close for ${pr}: ${problems.join(" ") || `${label} would not close`}` };
  };

  /**
   * The uncommitted paths in a checkout, none when it is gone. A `status` that fails is a refusal: a tree that could not be read is kept, never removed.
   */
  const uncommittedOf = (path: string): { paths: string[] } | { refusal: string } => {
    if (!exists(path)) return { paths: [] };
    try {
      return { paths: uncommittedPaths(path) };
    } catch (err) {
      return { refusal: `the changes in ${path} could not be read, so it is kept (${firstLine(err)})` };
    }
  };

  return {
    live({ pr, head }) {
      const seat = seatOf(pr);
      return !("refusal" in seat) && heads.get(seat.label) === head && (listed()?.some((agent) => agent.label === seat.label) ?? false);
    },
    start({ pr, head }) {
      const seat = seatOf(pr);
      if ("refusal" in seat) return seat;
      const { trust } = reviewerGate();
      const state = readReviewState(pr, gh, declared);
      if (state === null) return { refusal: `no reviewer for ${pr}: the pull request could not be read` };
      if (state.trust !== trust.INSIDE) return { refusal: `no reviewer for ${pr}: its author is outside the org, and the tickets' reviewer starts for the org's own pull requests only` };
      if (state.head !== head) return { refusal: `no reviewer for ${pr}: its head moved to ${state.head}, so ${head} is no longer to be reviewed` };
      if (!state.settled) return { refusal: `no reviewer for ${pr}: its checks at ${head} have not settled green` };
      const agents = listed();
      if (agents === null) return { refusal: `no reviewer for ${pr}: herdr did not list the ${session} session` };
      // A reviewer still holding the label is one for an earlier head: its workspace is closed before the next one starts under the same label.
      const stale = agents.some((agent) => agent.label === seat.label);
      if (stale) closeWorkspace(run, session, seat.label);
      const tree = checkout({ pr: seat.number, session: seat.label, trust: trust.INSIDE });
      if ("refusal" in tree) return tree;
      const started = spawn({ session: seat.label, cause: REVIEW_CAUSE, causeKey: `${pr}@${head}`, trust: trust.INSIDE },
        agents.filter((agent) => agent.label !== seat.label), { run: herdr, cwd: tree.path });
      if ("refusal" in started) return started;
      const prompted = sendPrompt(seat, state, head);
      if ("refusal" in prompted) return { refusal: `no reviewer for ${pr}: ${prompted.refusal}` };
      heads.set(seat.label, head);
      return { label: seat.label };
    },
    settled({ pr, head }) {
      const seat = seatOf(pr);
      if ("refusal" in seat || heads.get(seat.label) !== head) return "gone";
      const agents = listed();
      // herdr did not say what is running, so the reviewer is working as far as anyone can tell: nothing is said of it on a guess.
      if (agents === null) return "working";
      const holders = agents.filter((agent) => agent.label === seat.label);
      if (holders.length === 0) return "gone";
      return holders.every((agent) => ENDED_STATUSES.includes(agent.status)) ? "ended" : "working";
    },
    verdictFileOf({ pr, head }) {
      const seat = seatOf(pr);
      return "refusal" in seat ? null : verdictFileIn(checkoutOf(seat.label), seat.number, head);
    },
    repostVerdict({ pr, head }, file) {
      const seat = seatOf(pr);
      if ("refusal" in seat) return { refusal: seat.refusal, final: true };
      const word = verdictWordOf(file, head);
      if (word === null) return { refusal: `the verdict file ${file} does not open with a verdict for ${head.slice(0, 8)}`, final: true };
      const tree = checkoutOf(seat.label);
      // The token first: the door posts as the reviewer App, and a token that is stale or missing is the failure this repost is for.
      const minted = mint(tree);
      if (minted !== null) return { refusal: minted, final: false };
      try {
        door(reviewerGate().doorPath.reviewerDoorPath(), [String(seat.number), word, file], reviewerGate().wake.reviewerEnvironment(seat.label, {}, tree));
        return { posted: true };
      } catch (err) {
        const status = (err as { status?: number | null }).status ?? null;
        return { refusal: doorReason(err, status), final: status !== null && FINAL_DOOR_EXITS.includes(status) };
      }
    },
    reprompt({ pr, head }) {
      const seat = seatOf(pr);
      if ("refusal" in seat) return seat;
      const state = readReviewState(pr, gh, declared);
      if (state === null) return { refusal: `no reprompt for ${pr}: the pull request could not be read` };
      const sent = sendPrompt(seat, state, head);
      return "refusal" in sent ? { refusal: `no reprompt for ${pr}: ${sent.refusal}` } : { prompted: true };
    },
    close({ pr, head }) {
      const seat = seatOf(pr);
      if ("refusal" in seat) return seat;
      if (heads.get(seat.label) !== head) return { refusal: `no close for ${pr}: ${seat.label} was not started for ${head}` };
      const agents = listed();
      if (agents === null) return { refusal: `no close for ${pr}: herdr did not list the ${session} session` };
      const holders = agents.filter((agent) => agent.label === seat.label);
      if (holders.length === 0) return { state: "gone" };
      // A reviewer posts its verdict and then finishes its turn: closing it mid-turn would cut that turn off, so it waits for the next look.
      if (holders.some((agent) => agent.status === "working")) return { state: "busy" };
      // The checkout is kept: a head that moves re-points it, and the next reviewer for this seat uses it.
      return closeAll(pr, seat.label);
    },
    retire(pr) {
      const seat = seatOf(pr);
      if ("refusal" in seat) return seat;
      const { wake } = reviewerGate();
      const agents = listed();
      if (agents === null) return { refusal: `no retire for ${pr}: herdr did not list the ${session} session` };
      const holders = agents.filter((agent) => agent.label === seat.label);
      if (holders.some((agent) => agent.status === "working")) return { refusal: `no retire for ${pr}: ${seat.label} is still working, and is retired once it is not` };
      // The workspaces first, since nothing may be reading the tree when it goes; the checkout only once every workspace under the label has closed.
      if (holders.length > 0) {
        const closed = closeAll(pr, seat.label);
        if ("refusal" in closed) return closed;
      }
      const path = wake.reviewCheckoutPath(seat.label);
      const uncommitted = uncommittedOf(path);
      if ("refusal" in uncommitted) return { refusal: `no retire for ${pr}: ${uncommitted.refusal}` };
      const head = heads.get(seat.label) ?? "an unrecorded head";
      const left = removeCheckout({ pr: seat.number, session: seat.label, key: seat.key });
      if (left !== null) return { refusal: `no retire for ${pr}: ${left}` };
      heads.delete(seat.label);
      // The discard is reported only once it has happened: a removal that fails keeps the tree and says nothing was discarded.
      return { retired: true, report: discardReport({ label: seat.label, pr, head, path, paths: uncommitted.paths }) };
    },
    listedPulls() {
      return (listed() ?? []).flatMap((agent) => {
        const instance = reviewerInstance(agent.label);
        const repository = instance === null ? null : repositoryOfKey(instance.key);
        return instance === null || repository === null ? [] : [`https://github.com/${repository}/pull/${instance.number}`];
      });
    },
  };
}

/** The reviewer's token mint in a checkout, as the gate's own refresh makes it (A11-83): the reason it cannot, or null when the reviewer has a token. */
function reviewerTokenMintOf(tree: string): string | null {
  const { wake } = reviewerGate();
  return wake.reviewerTokenMinter(wake.reviewerAppOf())(tree);
}

/** The verdict word of a verdict file whose opener is a verdict for `head`, and null for any other file (A11-83). */
function verdictWordOf(file: string, head: string): "convinced" | "not-convinced" | null {
  const line = firstLineOfFile(file);
  if (line === null) return null;
  const verdict = verdictOfText(line);
  if (verdict.verdict !== "convinced" && verdict.verdict !== "not-convinced") return null;
  return headMatches(verdict.head, head) ? verdict.verdict : null;
}

/** The door's last line for a failed post, without its prefix: the reason the verdict is not on the pull request (A11-83). */
function doorReason(err: unknown, status: number | null): string {
  const lines = String((err as { stderr?: unknown }).stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  return last === undefined ? `the verdict door exited ${status ?? "without a status"}` : last.replace(/^pr-review-verdict: (NOT POSTED\. )?/, "");
}

/** Closes the workspace a label holds in the session, if herdr lists it. */
function closeWorkspace(run: (args: string[]) => string, session: string, label: string): void {
  const workspaces = JSON.parse(run(["--session", session, "workspace", "list"]))?.result?.workspaces ?? [];
  const id = workspaces.find((w: { label?: unknown }) => w?.label === label)?.workspace_id;
  if (typeof id === "string") run(["--session", session, "workspace", "close", id]);
}
