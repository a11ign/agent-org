// @ts-check
// module: the atomic reviewer's port -- starts the gate's codex reviewer on a ready pull request, once per head, behind the reviewer contract (A11-161)
//
// MOVED OUT OF `ticket-mode/reviewer-port.ts`, with nothing changed in what it does. THE PORT IS THE POOL'S ONLY SEAM: `start` a reviewer for one pull request at one head, and `live`, whether
// one is running for that head. It also `close`s a reviewer once its verdict is posted, `retire`s a pull request's reviewer and checkout once the pull request has merged or closed, and lists
// (`listedPulls`) the reviewer workspaces the session holds, for one a `ticket:review` start left that the pool does not remember. The adapter starts the gate's own reviewer, `spawnReviewer` in
// `wake.ts`, with its trust rules (`review-trust.ts`) and its verdict door, in the tickets' herdr session. Nothing here copies that code: THE GATE STAYS CORE'S, shared with the org's own
// reviewer, and reaches this plugin through `deps.reviewing` (a plugin imports core's types only, ADR 0001). The reviewer posts as `a11ign-reviewer`.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ListedAgent } from "../../src/herdr-agents.ts";
import type { DoorRun } from "../../src/review-trust.ts";
import type { CodeHost, ReviewState } from "../../src/plugins/contracts/code-host.ts";
import type { CloseAnswer, PromptAnswer, RepostAnswer, RetireAnswer, ReviewBrief, ReviewerPort, ReviewerRef, ReviewerSettled } from "../../src/plugins/contracts/reviewer.ts";
import type { ReviewerBoard, ReviewerGate, ReviewerHelpers } from "../../src/plugins/manifest.ts";
import type { Ensured } from "./codex-trust.ts";
import { reviewWords, rereviewWords } from "./prompt.ts";

/** The cause the reviewer is started for: the gate's `draft-awaiting-verdict`, the one a ready pull request is reviewed under. */
export const REVIEW_CAUSE = "draft-awaiting-verdict";

/** The statuses herdr shows for a reviewer whose turn is over: idle or done, or no agent at all (its process exited). */
const ENDED_STATUSES: readonly string[] = ["idle", "done", "unknown"];

/** The door's exits a repost cannot cure: 2 (a malformed call), 3 (a second review at an equal patch) and 5 (the head moved). */
const FINAL_DOOR_EXITS: readonly number[] = [2, 3, 5];

/** How many changed paths a discard report names before it says how many more there were. */
const REPORTED_PATHS = 20;

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
 * THE VERDICT FILE A REVIEWER WROTE FOR `head` (A11-83). The role file asks the reviewer to write its verdict to a file and post it through the door, and names no path, so the file is found by
 * what it says: the newest file, at the checkout's top or one folder down, whose first line is the verdict line for pull request `number` at `head` (`headMatches`, a prefix either way). Null
 * when there is none.
 */
export function verdictFileIn(tree: string, number: number, head: string, verdict: ReviewerBoard["verdict"]): string | null {
  let found: { path: string; at: number } | null = null;
  for (const path of [...filesIn(tree), ...foldersIn(tree).flatMap(filesIn)]) {
    const line = firstLineOfFile(path);
    if (line === null || !line.startsWith(`**Review of #${number} at `)) continue;
    const read = verdict.reviewVerdict(line);
    if ((read.verdict !== "convinced" && read.verdict !== "not-convinced") || !verdict.headMatches(read.head, head)) continue;
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
 * The log line a retire writes for the uncommitted changes its checkout is removed with: the first {@link REPORTED_PATHS} paths, then how many more there were. Null when there were none.
 */
function discardReport({ label, pr, head, path, paths }: { label: string; pr: string; head: string; path: string; paths: readonly string[] }): string | null {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, REPORTED_PATHS).join(", ");
  const more = paths.length > REPORTED_PATHS ? ` and ${paths.length - REPORTED_PATHS} more` : "";
  return `reviewer teardown: ${label} for ${pr} at ${head} had ${paths.length} uncommitted change(s) in ${path}, discarded with the checkout: ${shown}${more}`;
}

/** The pull request's repository (`owner/name`) and number, or null for a url that is none. */
function pullOf(url: string): { repository: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(url);
  return match === null ? null : { repository: match[1], number: Number(match[2]) };
}

/** The host's checkouts by repository name (`host.json`'s `clones`), which carry no owner: a name is one of this org's repositories. */
type Clones = Readonly<Record<string, string>>;

/**
 * The seat key and checkout of a repository the host clones and the project does not declare (PURE). Its key is its clone's name, which must be a reviewer key (`reviewerInstance`'s grammar)
 * and no declared key of another repository; its owner must be `owner`, the primary's, since `clones` carries names only. Null for a repository that is none of these; a refusal names why a
 * clone of it cannot be a seat.
 */
export function clonedSeatOf(repository: string, { owner, clones, codes }: { owner: string; clones: Clones; codes: readonly { key: string; repo: string }[] }): { key: string; clone: string } | { refusal: string } | null {
  const [repoOwner, name] = repository.split("/");
  if (repoOwner !== owner || !Object.hasOwn(clones, name)) return null;
  if (!/^[a-z0-9-]+$/.test(name) || /-[0-9]+$/.test(name)) return { refusal: `its name \`${name}\` cannot be a reviewer key (lowercase letters, digits and hyphens, not ending in a number)` };
  const clash = codes.find((code) => code.key === name);
  if (clash !== undefined) return { refusal: `the project declares \`${name}\` as the key of ${clash.repo}, so the host's clone \`${name}\` would take the same reviewer seat` };
  return { key: name, clone: clones[name] };
}

/**
 * A reviewer's seat for a pull request: its label, number and repository key. A repository the host clones and the project does not declare also names its `repository` and its `clone`, which the
 * gate's calls would otherwise take from the declaration; a declared or primary seat names neither.
 */
type Seat = { label: string; number: number; key: string; repository?: string; clone?: string };

/** What the port reads of the board and the gate, as one record: `board` is the board's collaborators, and `gate` the gate's modules, each asked when it is used. */
type Context = Readonly<{ helpers: ReviewerHelpers; seams: Seams }>;

const boardOf = ({ helpers }: Context) => helpers.board();
const gateOf = ({ helpers }: Context): ReviewerGate => helpers.gate();

/** The key of a repository the project declares: `""` for the primary's, `null` for one it does not declare. */
function repoKeyOf(context: Context, repository: string): string | null {
  const { config, identity } = gateOf(context);
  if (repository === identity.REPO) return "";
  return config.homeProjectDeclaration().code.find((code) => code.repo === repository)?.key ?? null;
}

/** The repository a key names: the reverse of {@link repoKeyOf} and {@link clonedSeatOf}, and `null` for a key neither the project declares nor the host clones. */
function repositoryOfKey(context: Context, key: string): string | null {
  const { config, identity } = gateOf(context);
  if (key === "") return identity.REPO;
  const declared = config.homeProjectDeclaration().code.find((code) => code.key === key)?.repo;
  if (declared !== undefined) return declared;
  return Object.hasOwn(boardOf(context).clones, key) ? `${identity.REPO.split("/")[0]}/${key}` : null;
}

/** The reviewer's seat for a pull request: `reviewer-<n>` in the primary, `reviewer-<key>-<n>` elsewhere, or a refusal naming why it has none. */
function seatOf(context: Context, url: string): Seat | { refusal: string } {
  const pull = pullOf(url);
  if (pull === null) return { refusal: `no reviewer for ${url}: it is not a pull request url` };
  const key = repoKeyOf(context, pull.repository);
  const { attribution } = boardOf(context);
  if (key !== null) return { label: attribution.reviewerSeat({ repoKey: key, number: pull.number }), number: pull.number, key };
  const { config, identity } = gateOf(context);
  const cloned = clonedSeatOf(pull.repository, { owner: identity.REPO.split("/")[0], clones: boardOf(context).clones, codes: config.homeProjectDeclaration().code });
  if (cloned === null) return { refusal: `no reviewer for ${url}: ${pull.repository} is not a repository the project declares (\`code\` in .agent-org/project.json) and the host does not clone it (\`clones\` in host.json)` };
  if ("refusal" in cloned) return { refusal: `no reviewer for ${url}: ${cloned.refusal}` };
  return { label: attribution.reviewerSeat({ repoKey: cloned.key, number: pull.number }), number: pull.number, key: cloned.key, repository: pull.repository, clone: cloned.clone };
}

/** What a cloned-only seat's checkout is made in: its clone, which the gate would otherwise take from the declaration. Nothing for any other seat. */
function rootOf(seat: Seat): { repoRoot?: string } {
  return seat.clone === undefined ? {} : { repoRoot: seat.clone };
}

/** The environment a cloned-only seat's reviewer runs with: the repository its verdict door posts to, which the declaration would otherwise name. Nothing for any other seat. */
function repositoryEnvOf(context: Context, seat: Seat): Record<string, string> {
  const { host } = gateOf(context);
  return seat.repository === undefined ? {} : { GH_REPO: seat.repository, [host.HOST_CONFIG_ENV]: host.hostConfigPath() };
}

/**
 * The environment a reviewer runs with, laid over the reviewer role's (`reviewerEnvironment`): its seat's repository, and the instance's name, which the verdict door writes its finished claim with
 * (A11-149). A door run without it writes no claim.
 */
function reviewerEnvOf(context: Context, seat: Seat): Record<string, string> {
  return { ...repositoryEnvOf(context, seat), AGENT_ORG_INSTANCE: boardOf(context).instance };
}

/**
 * The seams the port runs through, each defaulting to the gate's own function. A default is resolved WHEN IT IS USED, not when the port is made: the plugin is built at activation, before the
 * reviewer's `load()` has read the gate, and a gate that does not load on this host must refuse a start, not the construction.
 */
export type Seams = Readonly<{
  spawn?: ReviewerGate["wake"]["spawnReviewer"];
  checkout?: ReviewerGate["wake"]["prepareReviewCheckout"];
  removeCheckout?: ReviewerGate["wake"]["removeReviewCheckout"];
  uncommittedPaths?: (path: string) => string[];
  exists?: (path: string) => boolean;
  /** Where a seat's reviewer keeps its checkout, which holds the verdict file it wrote. */
  checkoutOf?: (label: string) => string;
  /** Mints the reviewer's token in a checkout: the reason it could not, or null when it has one. */
  mint?: (tree: string) => string | null;
  /** Runs the verdict door with the reviewer's environment: throws on a non-zero exit, with the door's stderr. */
  door?: DoorRun;
  now?: () => number;
  /**
   * Makes Codex trust the repository a review checkout belongs to, before the reviewer starts (A11-221): `rootOf` finds the checkout's clone root (the one Codex resolves a worktree's trust to),
   * `ensure` trusts it when the host file names it, and `log` says what was added. Absent, the port trusts nothing.
   */
  codexTrust?: Readonly<{ rootOf: (tree: string) => string | null; ensure: (root: string) => Ensured; log: (line: string) => void }>;
}>;

const spawnOf = (context: Context) => context.seams.spawn ?? gateOf(context).wake.spawnReviewer;
const checkoutSeam = (context: Context) => context.seams.checkout ?? gateOf(context).wake.prepareReviewCheckout;
const removeCheckoutOf = (context: Context) => context.seams.removeCheckout ?? gateOf(context).wake.removeReviewCheckout;
const uncommittedPathsOf = (context: Context) => context.seams.uncommittedPaths ?? gateOf(context).wake.uncommittedPathsOf;
const existsOf = (context: Context) => context.seams.exists ?? existsSync;
const checkoutPathOf = (context: Context, label: string): string => (context.seams.checkoutOf ?? gateOf(context).wake.reviewCheckoutPath)(label);
const mintOf = (context: Context, tree: string): string | null => (context.seams.mint ?? reviewerTokenMintOf(context))(tree);
const doorOf = (context: Context): DoorRun => context.seams.door ?? gateOf(context).trust.runDoor;
const nowOf = (context: Context): number => (context.seams.now ?? Date.now)();

/**
 * The atomic adapter: the gate's codex reviewer, started in the tickets' herdr session. The gate's functions name the org's session, so the calls they make are retargeted to the board's session
 * here, and nothing else about them changes. It refuses a pull request whose author is not the org's own (`review-trust.ts`): the gate's verdict door and pane reader run only in the org's
 * session, so an outside reviewer has no place to post from. The head each reviewer was started for is in the board's `heads` (by seat label), which the pool keeps across a restart, so a restart
 * starts a reviewer again only for a head it has not reviewed. It refuses a head whose checks have not settled green: the gate's verdict is asked only of settled checks.
 */
export function atomicReviewerPort(helpers: ReviewerHelpers, seams: Seams = {}): ReviewerPort {
  const context: Context = { helpers, seams };
  return {
    live: (ref) => liveReviewer(context, ref),
    start: (ref, brief) => startReviewer(context, ref, brief),
    settled: (ref) => settledReviewer(context, ref),
    verdictFileOf: ({ pr, head }) => {
      const seat = seatOf(context, pr);
      return "refusal" in seat ? null : verdictFileIn(checkoutPathOf(context, seat.label), seat.number, head, boardOf(context).verdict);
    },
    repostVerdict: (ref, file) => repostReviewerVerdict(context, ref, file),
    reprompt: (ref, brief) => repromptReviewer(context, ref, brief),
    close: (ref) => closeReviewer(context, ref),
    retire: (pr) => retireReviewer(context, pr),
    listedPulls: () => listedPullUrls(context),
  };
}

/** The herdr call the gate's functions make: the org's session is retargeted to the tickets' session here, and nothing else about the call changes. */
function herdrOf(context: Context): (args: string[]) => string {
  const { session, run } = boardOf(context);
  return (args) => run(args[0] === "--session" && args[1] === boardOf(context).herdr.ORG_SESSION ? ["--session", session, ...args.slice(2)] : args);
}

/** The agents herdr lists in the tickets' session, or null when it lists none it can read. */
function listedOf(context: Context): ListedAgent[] | null {
  const { session, run } = boardOf(context);
  return boardOf(context).herdr.readAgents(run, { session });
}

/**
 * What a seat's reviewer is sent (A11-156): the gate's own verdict prompt for the seat's repository, with the ticket's Done-when and the post-merge rule after it, or, for a re-review of a head that
 * already has this reviewer's block, the re-review brief in its place (the gate's prompt says the head has no verdict, which is no longer true of it).
 */
function promptWords(context: Context, seat: { label: string; key: string }, state: ReviewState, { pr: url, head }: ReviewerRef, brief: ReviewBrief | undefined): string {
  const { orders } = gateOf(context);
  const pr = { ...state.view, repoKey: seat.key };
  if (brief?.rereview !== undefined) {
    return rereviewWords({ number: Number(state.view.number), head, pr: url, roleFile: orders.reviewerRoleFile(pr), replies: brief.rereview.replies, doneWhen: brief.doneWhen, ...(brief.decisions === undefined ? {} : { decisions: brief.decisions }), ...(brief.step === undefined ? {} : { step: brief.step }), ...(state.unrequiredRed === undefined ? {} : { unrequiredRed: state.unrequiredRed }) });
  }
  return reviewWords(orders.awaitingVerdictPrompt(pr, orders.reviewHeadsOf(state.view, head, "settled")), brief, state.unrequiredRed);
}

/** Sends the seat's agent its prompt (`promptWords`). */
function sendPrompt(context: Context, seat: { label: string; key: string }, state: ReviewState, ref: ReviewerRef, brief: ReviewBrief | undefined): { sent: true } | { refusal: string } {
  const words = promptWords(context, seat, state, ref, brief);
  const { session, run } = boardOf(context);
  try {
    run(["--session", session, "agent", "prompt", seat.label, words]);
    return { sent: true };
  } catch (err) {
    return { refusal: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

/** Closes every workspace under a seat's label, as the gate's teardown does; a refusal names what would not close. */
function closeAll(context: Context, pr: string, label: string): Readonly<{ state: "closed" }> | Readonly<{ refusal: string }> {
  const problems: string[] = [];
  const closed = gateOf(context).wake.closeReviewer(label, { run: herdrOf(context), warn: (line) => problems.push(line) });
  return closed ? { state: "closed" } : { refusal: `no close for ${pr}: ${problems.join(" ") || `${label} would not close`}` };
}

/** The uncommitted paths in a checkout, none when it is gone. A `status` that fails is a refusal: a tree that could not be read is kept, never removed. */
function uncommittedOf(context: Context, path: string): { paths: string[] } | { refusal: string } {
  if (!existsOf(context)(path)) return { paths: [] };
  try {
    return { paths: uncommittedPathsOf(context)(path) };
  } catch (err) {
    return { refusal: `the changes in ${path} could not be read, so it is kept (${boardOf(context).herdr.firstLine(err)})` };
  }
}

function liveReviewer(context: Context, { pr, head }: ReviewerRef): boolean {
  const seat = seatOf(context, pr);
  return !("refusal" in seat) && boardOf(context).heads.get(seat.label) === head && (listedOf(context)?.some((agent) => agent.label === seat.label) ?? false);
}

/**
 * Writes a status under the claim's context on `sha` in `repo`, as the reviewer role: the identity the door posts as, whose token is minted in the checkout first. The one writer of a claim and of
 * its release (A11-149).
 */
function claimWriterOf(context: Context, seat: Seat, { repo, sha, tree }: { repo: string; sha: string; tree: string }): (description: string) => void {
  const environment = gateOf(context).wake.reviewerEnvironment(seat.label, repositoryEnvOf(context, seat), tree);
  return (description) => {
    const refusal = codeHostOf(context).writeReviewClaim({ repository: repo, head: sha, description, environment });
    if (refusal !== null) throw new Error(refusal);
  };
}

/** What claiming a head came to: the reviewer may start (`tookOver` names an expired claim it took over, `unclaimed` that it starts WITHOUT a claim and why), or the refusal that starts none (`unclaimed` when the claim is why). */
type Claimed = Readonly<{ tookOver: string | null; unclaimed?: string }> | Readonly<{ refusal: string; unclaimed?: string }>;

/**
 * Writes down which other instances a listing of a head's claim entries shows (A11-172): any status under the claim's context by another instance, whatever its head, says it is there, and that is what lets
 * an instance whose own claim cannot be written tell it is alone. Entries past the lease are dropped from the record, since they say nothing now.
 */
function noteOthersSeen(context: Context, entries: readonly Readonly<{ id: number; description: string; created: number }>[]): void {
  const { claims, instance, seen } = boardOf(context);
  for (const [other, at] of claims.othersSeenIn({ entries, instance })) seen.set(other, Math.max(at, seen.get(other) ?? at));
  const now = nowOf(context);
  for (const [other, at] of seen) if (now - at >= claims.REVIEW_LEASE_MS) seen.delete(other);
}

/** The claim entries of a head, read through the code host, with the other instances they show noted. THROWS the code host's reason when they could not be read. */
function claimEntriesOf(context: Context, { repo, sha }: { repo: string; sha: string }): readonly Readonly<{ id: number; description: string; created: number }>[] {
  const read = codeHostOf(context).readReviewClaims(repo, sha);
  if ("unreadable" in read) throw new Error(read.unreadable);
  noteOthersSeen(context, read.entries);
  return read.entries;
}

/** When any other instance was last seen under the claim's context on any head, or null for none (A11-172). */
const otherSeenOf = (context: Context): number | null => {
  const times = [...boardOf(context).seen.values()];
  return times.length === 0 ? null : Math.max(...times);
};

/**
 * Claims the head for this instance before its reviewer starts (A11-149). A mint that fails is a refusal, as a claim that cannot be written is. Returns the takeover note when an expired claim
 * was taken over, or the refusal that starts nothing: another instance holds the head, the review is posted, or the claim could not be made.
 *
 * A WRITE GITHUB REFUSED (A11-172), when no other instance holds the head and none has been seen within the lease, is no refusal: this instance is the only one there is, so nobody can review the head
 * twice, and the reviewer starts without a claim (`unclaimed` says why, for the board). Nothing was written, so nothing is released. With a second instance in sight it is a refusal, as it was.
 */
function claimOf(context: Context, seat: Seat, { pr, head, tree, rereview }: { pr: string; head: string; tree: string; rereview: boolean }): Claimed {
  const pull = pullOf(pr);
  if (pull === null) return { refusal: `no reviewer for ${pr}: it is not a pull request url` };
  const minted = mintOf(context, tree);
  if (minted !== null) return { refusal: `no reviewer for ${pr}: ${minted}` };
  const { repository } = pull;
  const board = boardOf(context);
  const { claims } = board;
  const answer = claims.claimHead({
    instance: board.instance, now: nowOf(context),
    read: () => claimEntriesOf(context, { repo: repository, sha: head }),
    write: claimWriterOf(context, seat, { repo: repository, sha: head, tree }),
    rereview,
    otherSeen: () => otherSeenOf(context),
  });
  switch (answer.outcome) {
    case "won": return { tookOver: answer.tookOver };
    case "alone": return { tookOver: null, unclaimed: answer.reason };
    case "held": return { refusal: `another instance (\`${answer.instance}\`) holds the review of ${pr} at ${head.slice(0, 8)} since ${new Date(answer.since).toISOString()}; its lease ends ${new Date(answer.since + claims.REVIEW_LEASE_MS).toISOString()}` };
    case "finished": return { refusal: `no reviewer for ${pr}: its review at ${head.slice(0, 8)} is already posted (${answer.description})` };
    case "unclaimed":
      // A claim whose read-back failed may be on GitHub already: released, so it does not hold the head for its whole lease.
      releaseClaim(context, seat, { pr, head, tree });
      return { refusal: `no reviewer for ${pr}: its claim at ${head.slice(0, 8)} could not be made (${answer.reason}), so none is started`, unclaimed: answer.reason };
  }
}

/**
 * Gives up this instance's claim on a head whose reviewer did not start (A11-149), so another instance may take the head now rather than when the lease ends. Best effort: a release that cannot be
 * written leaves the claim to expire with its lease, which is the state a release is for avoiding and no worse.
 */
function releaseClaim(context: Context, seat: Seat, { pr, head, tree }: { pr: string; head: string; tree: string }): void {
  const pull = pullOf(pr);
  if (pull === null) return;
  try {
    claimWriterOf(context, seat, { repo: pull.repository, sha: head, tree })(boardOf(context).claims.releasedDescriptionOf({ instance: boardOf(context).instance, now: nowOf(context) }));
  } catch {
    // Left to expire with its lease, as the comment above says.
  }
}

/** The code host the board reads each pull request through: its head, its reviews, its trust and whether its checks settled. */
const codeHostOf = (context: Context): CodeHost => boardOf(context).codeHost();

/**
 * Trusts the clone a review checkout belongs to in Codex's config, so Codex does not stop on its "Trust this folder?" dialog (A11-221). The reason no reviewer starts when the config cannot be used
 * (Codex could not start on it either), or null: an entry added, one already there, a root the host file does not name, or a checkout with no clone root all go ahead.
 */
function trustCodexFor(context: Context, { pr, tree }: { pr: string; tree: string }): string | null {
  const codex = context.seams.codexTrust;
  if (codex === undefined) return null;
  const root = codex.rootOf(tree);
  if (root === null) return null;
  const answer = codex.ensure(root);
  if (answer.kind === "refused") return `no reviewer for ${pr}: ${answer.reason}`;
  if (answer.kind === "added") codex.log(`codex now trusts ${answer.root}: the reviewer of ${pr} starts in it`);
  return null;
}

function startReviewer(context: Context, ref: ReviewerRef, brief: ReviewBrief | undefined): ReturnType<ReviewerPort["start"]> {
  const { pr, head } = ref;
  const seat = seatOf(context, pr);
  if ("refusal" in seat) return seat;
  const { trust } = gateOf(context);
  const board = boardOf(context);
  const state = codeHostOf(context).readReviewState(pr);
  if (state === null) return { refusal: `no reviewer for ${pr}: the pull request could not be read` };
  if (state.trust !== trust.INSIDE) return { refusal: `no reviewer for ${pr}: its author is outside the org, and the tickets' reviewer starts for the org's own pull requests only` };
  if (state.head !== head) return { refusal: `no reviewer for ${pr}: its head moved to ${state.head}, so ${head} is no longer to be reviewed` };
  if (!state.settled) return { refusal: `no reviewer for ${pr}: its checks at ${head} have not settled green` };
  const agents = listedOf(context);
  if (agents === null) return { refusal: `no reviewer for ${pr}: herdr did not list the ${board.session} session` };
  // A reviewer still holding the label is one for an earlier head: its workspace is closed before the next one starts under the same label.
  const stale = agents.some((agent) => agent.label === seat.label);
  if (stale) closeWorkspace(board.run, board.session, seat.label);
  const tree = checkoutSeam(context)({ pr: seat.number, session: seat.label, trust: trust.INSIDE, ...rootOf(seat) });
  if ("refusal" in tree) return tree;
  // Codex's trust comes before the claim and the spawn: a repository it has not been told to trust stops the reviewer on a dialog nobody answers (A11-221).
  const untrusted = trustCodexFor(context, { pr, tree: tree.path });
  if (untrusted !== null) return { refusal: untrusted };
  // The claim comes before the spawn: an instance that holds the head starts nothing, and a claim that cannot be made starts nothing either (A11-149).
  const claimed = claimOf(context, seat, { pr, head, tree: tree.path, rereview: brief?.rereview !== undefined });
  if ("refusal" in claimed) return claimed;
  // A reviewer started without a claim wrote none, so it has none to give up.
  const giveUpClaim = () => { if (claimed.unclaimed === undefined) releaseClaim(context, seat, { pr, head, tree: tree.path }); };
  const started = spawnOf(context)({ session: seat.label, cause: REVIEW_CAUSE, causeKey: `${pr}@${head}`, trust: trust.INSIDE },
    agents.filter((agent) => agent.label !== seat.label), { run: herdrOf(context), cwd: tree.path, env: reviewerEnvOf(context, seat) });
  if ("refusal" in started) {
    giveUpClaim();
    return started;
  }
  const prompted = sendPrompt(context, seat, state, ref, brief);
  if ("refusal" in prompted) {
    giveUpClaim();
    return { refusal: `no reviewer for ${pr}: ${prompted.refusal}` };
  }
  board.heads.set(seat.label, head);
  return { label: seat.label, ...(claimed.tookOver === null ? {} : { tookOver: claimed.tookOver }), ...(claimed.unclaimed === undefined ? {} : { unclaimed: claimed.unclaimed }) };
}

function settledReviewer(context: Context, { pr, head }: ReviewerRef): ReviewerSettled {
  const seat = seatOf(context, pr);
  if ("refusal" in seat || boardOf(context).heads.get(seat.label) !== head) return "gone";
  const agents = listedOf(context);
  // herdr did not say what is running, so the reviewer is working as far as anyone can tell: nothing is said of it on a guess.
  if (agents === null) return "working";
  const holders = agents.filter((agent) => agent.label === seat.label);
  if (holders.length === 0) return "gone";
  return holders.every((agent) => ENDED_STATUSES.includes(agent.status)) ? "ended" : "working";
}

function repostReviewerVerdict(context: Context, { pr, head }: ReviewerRef, file: string): RepostAnswer {
  const seat = seatOf(context, pr);
  if ("refusal" in seat) return { refusal: seat.refusal, final: true };
  const word = verdictWordOf(context, file, head);
  if (word === null) return { refusal: `the verdict file ${file} does not open with a verdict for ${head.slice(0, 8)}`, final: true };
  const tree = checkoutPathOf(context, seat.label);
  // The token first: the door posts as the reviewer App, and a token that is stale or missing is the failure this repost is for.
  const minted = mintOf(context, tree);
  if (minted !== null) return { refusal: minted, final: false };
  const { wake, doorPath } = gateOf(context);
  try {
    doorOf(context)(doorPath.reviewerDoorPath(), [String(seat.number), word, file], wake.reviewerEnvironment(seat.label, reviewerEnvOf(context, seat), tree));
    return { posted: true };
  } catch (err) {
    const status = (err as { status?: number | null }).status ?? null;
    return { refusal: doorReason(err, status), final: status !== null && FINAL_DOOR_EXITS.includes(status) };
  }
}

function repromptReviewer(context: Context, ref: ReviewerRef, brief: ReviewBrief | undefined): PromptAnswer {
  const { pr } = ref;
  const seat = seatOf(context, pr);
  if ("refusal" in seat) return seat;
  const state = codeHostOf(context).readReviewState(pr);
  if (state === null) return { refusal: `no reprompt for ${pr}: the pull request could not be read` };
  const sent = sendPrompt(context, seat, state, ref, brief);
  return "refusal" in sent ? { refusal: `no reprompt for ${pr}: ${sent.refusal}` } : { prompted: true };
}

function closeReviewer(context: Context, { pr, head }: ReviewerRef): CloseAnswer {
  const seat = seatOf(context, pr);
  if ("refusal" in seat) return seat;
  const board = boardOf(context);
  if (board.heads.get(seat.label) !== head) return { refusal: `no close for ${pr}: ${seat.label} was not started for ${head}` };
  const agents = listedOf(context);
  if (agents === null) return { refusal: `no close for ${pr}: herdr did not list the ${board.session} session` };
  const holders = agents.filter((agent) => agent.label === seat.label);
  if (holders.length === 0) return { state: "gone" };
  // A reviewer posts its verdict and then finishes its turn: closing it mid-turn would cut that turn off, so it waits for the next look.
  if (holders.some((agent) => agent.status === "working")) return { state: "busy" };
  // The checkout is kept: a head that moves re-points it, and the next reviewer for this seat uses it.
  return closeAll(context, pr, seat.label);
}

function retireReviewer(context: Context, pr: string): RetireAnswer {
  const seat = seatOf(context, pr);
  if ("refusal" in seat) return seat;
  const board = boardOf(context);
  const agents = listedOf(context);
  if (agents === null) return { refusal: `no retire for ${pr}: herdr did not list the ${board.session} session` };
  const holders = agents.filter((agent) => agent.label === seat.label);
  if (holders.some((agent) => agent.status === "working")) return { refusal: `no retire for ${pr}: ${seat.label} is still working, and is retired once it is not` };
  // The workspaces first, since nothing may be reading the tree when it goes; the checkout only once every workspace under the label has closed.
  if (holders.length > 0) {
    const closed = closeAll(context, pr, seat.label);
    if ("refusal" in closed) return closed;
  }
  const path = gateOf(context).wake.reviewCheckoutPath(seat.label);
  const uncommitted = uncommittedOf(context, path);
  if ("refusal" in uncommitted) return { refusal: `no retire for ${pr}: ${uncommitted.refusal}` };
  const head = board.heads.get(seat.label) ?? "an unrecorded head";
  const left = removeCheckoutOf(context)({ pr: seat.number, session: seat.label, key: seat.key, ...rootOf(seat) });
  if (left !== null) return { refusal: `no retire for ${pr}: ${left}` };
  board.heads.delete(seat.label);
  // The discard is reported only once it has happened: a removal that fails keeps the tree and says nothing was discarded.
  return { retired: true, report: discardReport({ label: seat.label, pr, head, path, paths: uncommitted.paths }) };
}

function listedPullUrls(context: Context): string[] {
  return (listedOf(context) ?? []).flatMap((agent) => {
    const instance = boardOf(context).attribution.reviewerInstance(agent.label);
    const repository = instance === null ? null : repositoryOfKey(context, instance.key);
    return instance === null || repository === null ? [] : [`https://github.com/${repository}/pull/${instance.number}`];
  });
}

/** The reviewer's token mint in a checkout, as the gate's own refresh makes it (A11-83): the reason it cannot, or null when the reviewer has a token. */
function reviewerTokenMintOf(context: Context): (tree: string) => string | null {
  return (tree) => {
    const { wake } = gateOf(context);
    return wake.reviewerTokenMinter(wake.reviewerAppOf())(tree);
  };
}

/** The verdict word of a verdict file whose opener is a verdict for `head`, and null for any other file (A11-83). */
function verdictWordOf(context: Context, file: string, head: string): "convinced" | "not-convinced" | null {
  const line = firstLineOfFile(file);
  if (line === null) return null;
  const { verdict } = boardOf(context);
  const read = verdict.reviewVerdict(line);
  if (read.verdict !== "convinced" && read.verdict !== "not-convinced") return null;
  return verdict.headMatches(read.head, head) ? read.verdict : null;
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

/**
 * The port for a host where the gate does not load (a host with no `primary`): it starts nothing and holds nothing, answering as an empty session would, so a caller that asks before it reads
 * `refusal()` gets an answer and not the gate's own exception. `refusal` is asked at each call, so a gate that loads later is the port again.
 */
export function portWhereGateLoads(port: ReviewerPort, refusal: () => string | null): ReviewerPort {
  const refused = (pr: string): string => `no reviewer for ${pr}: the reviewer's gate does not load on this host: ${refusal()}`;
  const loads = (): boolean => refusal() === null;
  return {
    start: (ref, brief) => (loads() ? port.start(ref, brief) : { refusal: refused(ref.pr) }),
    live: (ref) => loads() && port.live(ref),
    close: (ref) => (loads() ? port.close(ref) : { refusal: refused(ref.pr) }),
    retire: (pr) => (loads() ? port.retire(pr) : { refusal: refused(pr) }),
    listedPulls: () => (loads() ? port.listedPulls() : []),
    settled: (ref) => (loads() ? port.settled(ref) : "gone"),
    verdictFileOf: (ref) => (loads() ? port.verdictFileOf(ref) : null),
    repostVerdict: (ref, file) => (loads() ? port.repostVerdict(ref, file) : { refusal: refused(ref.pr), final: true }),
    reprompt: (ref, brief) => (loads() ? port.reprompt(ref, brief) : { refusal: refused(ref.pr) }),
  };
}
