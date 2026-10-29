// @ts-check
// module: the atomic reviewer's port -- starts the gate's codex reviewer on a ready pull request, once per head, behind the reviewer contract (A11-161)
//
// EVERY CALL THAT SPAWNS A PROGRAM ANSWERS A PROMISE (A11-379, reviewer contract 2.0). A start held the board's loop about nine times, about 10 s, because its herdr, git, install, token mint and claim calls were synchronous spawns on the board's thread. They run
// through the async runners now (`board.runAsync`, the gate's `*Async` steps, the code host's claim calls), and the port stays in the board's process, so what it keeps (the heads it started, the instances it saw, the trust answers) is kept. A start in flight
// holds its seat: a second start of it is refused, and a close or retire of it waits, since the loop runs between the steps of a start.
// MOVED OUT OF `ticket-mode/reviewer-port.ts`, with nothing changed in what it does. THE PORT IS THE POOL'S ONLY SEAM: `start` a reviewer for one pull request at one head, and `live`, whether
// one is running for that head. It also `close`s a reviewer once its verdict is posted, `retire`s a pull request's reviewer and checkout once the pull request has merged or closed, and lists
// (`listedPulls`) the reviewer workspaces the session holds, for one a `ticket:review` start left that the pool does not remember. The adapter starts the gate's own reviewer, `spawnReviewer` in
// `wake.ts`, with its trust rules (`review-trust.ts`) and its verdict door, in the tickets' herdr session. Nothing here copies that code: THE GATE STAYS CORE'S, shared with the org's own
// reviewer, and reaches this plugin through `deps.reviewing` (a plugin imports core's types only, ADR 0001). The reviewer posts as `a11ign-reviewer`.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ListedAgent } from "../../src/herdr-agents.ts";
import type { CodeHost, ReviewState } from "../../src/plugins/contracts/code-host.ts";
import type { CloseAnswer, PromptAnswer, RepostAnswer, RetireAnswer, ReviewBrief, ReviewerDialog, ReviewerPort, ReviewerRef, ReviewerSettled } from "../../src/plugins/contracts/reviewer.ts";
import type { DoorRunAsync, ReviewerBoard, ReviewerGate, ReviewerHelpers } from "../../src/plugins/manifest.ts";
import type { Ensured } from "./codex-trust.ts";
import { reviewWords, rereviewWords } from "./prompt.ts";
import { answerDialog, readPaneDialog } from "./reviewer-dialog.ts";

/** The cause the reviewer is started for: the gate's `draft-awaiting-verdict`, the one a ready pull request is reviewed under. */
export const REVIEW_CAUSE = "draft-awaiting-verdict";

/** The statuses herdr shows for a reviewer whose turn is over: idle or done, or no agent at all (its process exited). */
const ENDED_STATUSES: readonly string[] = ["idle", "done", "unknown"];

/** The status herdr shows for a reviewer waiting on a dialog (A11-221). */
const BLOCKED_STATUS = "blocked";


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
 * The seat key and checkout of a repository the host clones and the project does not declare (PURE). Its key is `keys`' for its clone's name (`cloneKeys`: made from the name, so a dotted name such as
 * `a11ign.github.io` has one, and distinct from every other clone's and every declared key); its owner must be `owner`, the primary's, since `clones` carries names only. Null for a repository that is
 * none of these. A clone named as a declared key is that declared repository's checkout (`clones` is by key), not a clone of a repository of that name, so it is refused.
 */
export function clonedSeatOf(repository: string, { owner, clones, codes, keys }: { owner: string; clones: Clones; codes: readonly { key: string; repo: string }[]; keys: ReadonlyMap<string, string> }): { key: string; clone: string } | { refusal: string } | null {
  const [repoOwner, name] = repository.split("/");
  if (repoOwner !== owner || !Object.hasOwn(clones, name)) return null;
  const clash = codes.find((code) => code.key === name);
  if (clash !== undefined) return { refusal: `the project declares \`${name}\` as the key of ${clash.repo}, so the host's clone \`${name}\` is that repository's checkout and not ${repository}'s` };
  return { key: keys.get(name)!, clone: clones[name] };
}

/**
 * A reviewer's seat for a pull request: its label, number and repository key. A repository the host clones and the project does not declare also names its `repository` and its `clone`, which the
 * gate's calls would otherwise take from the declaration; a declared or primary seat names neither.
 */
type Seat = { label: string; number: number; key: string; repository?: string; clone?: string };

/** What the port reads of the board and the gate, as one record: `board` is the board's collaborators, and `gate` the gate's modules, each asked when it is used. `trustAnswers` counts the trust dialogs answered for each seat's head (`unblock`). `holding` is what each seat is busy with, by label, until the call that holds it settles (a start, a close or a retire). `checkouts` is the last git call made against each clone (by its path, "" for the primary's), which the next waits for. */
type Context = Readonly<{ helpers: ReviewerHelpers; seams: Seams; trustAnswers: Map<string, number>; holding: Map<string, SeatWork>; checkouts: Map<string, Promise<unknown>> }>;

/** What holds a seat: a call of the port that has not settled. */
type SeatWork = "starting" | "closing" | "retiring";

/**
 * Runs `work` with the seat held for `doing`, and lets it go however `work` ends. The loop runs between the steps of a start, a close or a retire, so a second call for the seat could begin in the middle of the first: callers ask
 * `holding` before they hold (A11-379).
 */
async function holdingSeat<T>(context: Context, label: string, doing: SeatWork, work: () => Promise<T>): Promise<T> {
  context.holding.set(label, doing);
  try {
    return await work();
  } finally {
    context.holding.delete(label);
  }
}

/**
 * Runs `git` work against a clone after the work begun against it before. A synchronous start was one uninterrupted block, so two pull requests of one repository never ran `git fetch` and `git worktree add` or `remove` against its clone at the same
 * time; the steps of two starts now interleave, and git's own locks on the clone would refuse one of them (A11-379).
 */
function onClone<T>(context: Context, seat: Seat, work: () => Promise<T>): Promise<T> {
  const clone = seat.clone ?? "";
  const run = (context.checkouts.get(clone) ?? Promise.resolve()).then(work, work);
  context.checkouts.set(clone, run.catch(() => undefined));
  return run;
}

const boardOf = ({ helpers }: Context) => helpers.board();
const gateOf = ({ helpers }: Context): ReviewerGate => helpers.gate();

/** The key of a repository the project declares: `""` for the primary's, `null` for one it does not declare. */
function repoKeyOf(context: Context, repository: string): string | null {
  const { config, identity } = gateOf(context);
  if (repository === identity.REPO) return "";
  return config.homeProjectDeclaration().code.find((code) => code.repo === repository)?.key ?? null;
}

/** The reviewer key of each of the host's clones, by the clone's name: made from the name, and distinct from the project's declared keys (A11-259). */
function cloneKeysOf(context: Context): ReadonlyMap<string, string> {
  const { clones, attribution } = boardOf(context);
  return attribution.cloneKeys(clones, gateOf(context).config.homeProjectDeclaration().code.map((code) => code.key));
}

/** The repository a key names: the reverse of {@link repoKeyOf} and {@link clonedSeatOf}, and `null` for a key neither the project declares nor the host clones. The clone's name is the repository's real name. */
function repositoryOfKey(context: Context, key: string): string | null {
  const { config, identity } = gateOf(context);
  if (key === "") return identity.REPO;
  const declared = config.homeProjectDeclaration().code.find((code) => code.key === key)?.repo;
  if (declared !== undefined) return declared;
  const cloned = [...cloneKeysOf(context)].find(([, cloneKey]) => cloneKey === key)?.[0];
  return cloned === undefined ? null : `${identity.REPO.split("/")[0]}/${cloned}`;
}

/** The reviewer's seat for a pull request: `reviewer-<n>` in the primary, `reviewer-<key>-<n>` elsewhere, or a refusal naming why it has none. */
function seatOf(context: Context, url: string): Seat | { refusal: string } {
  const pull = pullOf(url);
  if (pull === null) return { refusal: `no reviewer for ${url}: it is not a pull request url` };
  const key = repoKeyOf(context, pull.repository);
  const { attribution } = boardOf(context);
  if (key !== null) return { label: attribution.reviewerSeat({ repoKey: key, number: pull.number }), number: pull.number, key };
  const { config, identity } = gateOf(context);
  const cloned = clonedSeatOf(pull.repository, { owner: identity.REPO.split("/")[0], clones: boardOf(context).clones, codes: config.homeProjectDeclaration().code, keys: cloneKeysOf(context) });
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
  spawn?: ReviewerGate["wake"]["spawnReviewerAsync"];
  checkout?: ReviewerGate["wake"]["prepareReviewCheckoutAsync"];
  removeCheckout?: ReviewerGate["wake"]["removeReviewCheckoutAsync"];
  uncommittedPaths?: (path: string) => Promise<string[]>;
  exists?: (path: string) => boolean;
  /** Where a seat's reviewer keeps its checkout, which holds the verdict file it wrote. */
  checkoutOf?: (label: string) => string;
  /** Mints the reviewer's token in a checkout: the reason it could not, or null when it has one. */
  mint?: (tree: string) => Promise<string | null>;
  /** Runs the verdict door with the reviewer's environment: rejects on a non-zero exit, with the door's stderr. */
  door?: DoorRunAsync;
  now?: () => number;
  /**
   * Makes Codex trust the repository a review checkout belongs to, before the reviewer starts (A11-221): `rootOf` finds the checkout's clone root (the one Codex resolves a worktree's trust to),
   * `ensure` trusts it when the host file names it, and `log` says what was added. Absent, the port trusts nothing.
   */
  codexTrust?: Readonly<{ rootOf: (tree: string) => Promise<string | null>; ensure: (root: string) => Ensured; log: (line: string) => void }>;
}>;

const spawnOf = (context: Context) => context.seams.spawn ?? gateOf(context).wake.spawnReviewerAsync;
const checkoutSeam = (context: Context) => context.seams.checkout ?? gateOf(context).wake.prepareReviewCheckoutAsync;
const removeCheckoutOf = (context: Context) => context.seams.removeCheckout ?? gateOf(context).wake.removeReviewCheckoutAsync;
const uncommittedPathsOf = (context: Context) => context.seams.uncommittedPaths ?? gateOf(context).wake.uncommittedPathsOfAsync;
const existsOf = (context: Context) => context.seams.exists ?? existsSync;
const checkoutPathOf = (context: Context, label: string): string => (context.seams.checkoutOf ?? gateOf(context).wake.reviewCheckoutPath)(label);
const mintOf = (context: Context, tree: string): Promise<string | null> => (context.seams.mint ?? reviewerTokenMintOf(context))(tree);
const doorOf = (context: Context): DoorRunAsync => context.seams.door ?? gateOf(context).trust.runDoorAsync;
const nowOf = (context: Context): number => (context.seams.now ?? Date.now)();

/**
 * The atomic adapter: the gate's codex reviewer, started in the tickets' herdr session. The gate's functions name the org's session, so the calls they make are retargeted to the board's session
 * here, and nothing else about them changes. It refuses a pull request whose author is not the org's own (`review-trust.ts`): the gate's verdict door and pane reader run only in the org's
 * session, so an outside reviewer has no place to post from. The head each reviewer was started for is in the board's `heads` (by seat label), which the pool keeps across a restart, so a restart
 * starts a reviewer again only for a head it has not reviewed. It refuses a head whose checks have not settled green: the gate's verdict is asked only of settled checks.
 */
export function atomicReviewerPort(helpers: ReviewerHelpers, seams: Seams = {}): ReviewerPort {
  const context: Context = { helpers, seams, trustAnswers: new Map(), holding: new Map(), checkouts: new Map() };
  return {
    live: (ref) => liveReviewer(context, ref),
    start: (ref, brief) => startReviewerOnce(context, ref, brief),
    settled: (ref) => settledReviewer(context, ref),
    verdictFileOf: ({ pr, head }) => {
      const seat = seatOf(context, pr);
      return "refusal" in seat ? null : verdictFileIn(checkoutPathOf(context, seat.label), seat.number, head, boardOf(context).verdict);
    },
    repostVerdict: (ref, file) => repostReviewerVerdict(context, ref, file),
    reprompt: (ref, brief) => repromptReviewer(context, ref, brief),
    unblock: (ref) => unblockReviewer(context, ref),
    close: (ref) => closeReviewer(context, ref),
    retire: (pr) => retireReviewer(context, pr),
    listedPulls: () => listedPullUrls(context),
  };
}

/** The herdr call the gate's functions make: the org's session is retargeted to the tickets' session here, and nothing else about the call changes. */
function herdrOf(context: Context): (args: string[]) => Promise<string> {
  const { session, runAsync } = boardOf(context);
  return (args) => runAsync(args[0] === "--session" && args[1] === boardOf(context).herdr.ORG_SESSION ? ["--session", session, ...args.slice(2)] : args);
}

/** The agents herdr lists in the tickets' session, or null when it lists none it can read. */
function listedOf(context: Context): Promise<ListedAgent[] | null> {
  const { session, runAsync } = boardOf(context);
  return boardOf(context).herdr.readAgentsAsync(runAsync, { session });
}

/**
 * What a seat's reviewer is sent (A11-156): the gate's own verdict prompt for the seat's repository, with the ticket's Done-when and the post-merge rule after it, or, for a re-review of a head that
 * already has this reviewer's block, the re-review brief in its place (the gate's prompt says the head has no verdict, which is no longer true of it).
 */
function promptWords(context: Context, seat: { label: string; key: string }, state: ReviewState, { pr: url, head }: ReviewerRef, brief: ReviewBrief | undefined): string {
  const { orders } = gateOf(context);
  const pr = { ...state.view, repoKey: seat.key };
  if (brief?.rereview !== undefined) {
    return rereviewWords({ number: Number(state.view.number), head, pr: url, roleFile: orders.reviewerRoleFile(pr), replies: brief.rereview.replies, ...(brief.rereview.body === undefined ? {} : { body: brief.rereview.body }), ...(brief.rereview.decisions === undefined ? {} : { decided: brief.rereview.decisions }), ...(brief.rereview.planDecisions === undefined ? {} : { planChanged: brief.rereview.planDecisions }), ...(brief.rereview.unsupported === undefined ? {} : { unsupported: brief.rereview.unsupported }), doneWhen: brief.doneWhen, ...(brief.decisions === undefined ? {} : { decisions: brief.decisions }), ...(brief.planDecisions === undefined ? {} : { planDecisions: brief.planDecisions }), ...(brief.escalation === undefined ? {} : { escalation: brief.escalation }), ...(brief.step === undefined ? {} : { step: brief.step }), ...(brief.closing === undefined ? {} : { closing: brief.closing }), ...(state.unrequiredRed === undefined ? {} : { unrequiredRed: state.unrequiredRed }) });
  }
  return reviewWords(orders.awaitingVerdictPrompt(pr, orders.reviewHeadsOf(state.view, head, "settled")), brief, state.unrequiredRed);
}

/** Sends the seat's agent its prompt (`promptWords`). */
async function sendPrompt(context: Context, seat: { label: string; key: string }, state: ReviewState, ref: ReviewerRef, brief: ReviewBrief | undefined): Promise<{ sent: true } | { refusal: string }> {
  const words = promptWords(context, seat, state, ref, brief);
  const board = boardOf(context);
  const { session, runAsync } = board;
  try {
    await runAsync(["--session", session, "agent", "prompt", board.herdr.agentName(seat.label), words]);
    return { sent: true };
  } catch (err) {
    return { refusal: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

/** Closes every workspace under a seat's label, as the gate's teardown does; a refusal names what would not close. */
async function closeAll(context: Context, pr: string, label: string): Promise<Readonly<{ state: "closed" }> | Readonly<{ refusal: string }>> {
  const problems: string[] = [];
  const closed = await gateOf(context).wake.closeReviewerAsync(label, { run: herdrOf(context), warn: (line) => problems.push(line) });
  return closed ? { state: "closed" } : { refusal: `no close for ${pr}: ${problems.join(" ") || `${label} would not close`}` };
}

/** The uncommitted paths in a checkout, none when it is gone. A `status` that fails is a refusal: a tree that could not be read is kept, never removed. */
async function uncommittedOf(context: Context, path: string): Promise<{ paths: string[] } | { refusal: string }> {
  if (!existsOf(context)(path)) return { paths: [] };
  try {
    return { paths: await uncommittedPathsOf(context)(path) };
  } catch (err) {
    return { refusal: `the changes in ${path} could not be read, so it is kept (${boardOf(context).herdr.firstLine(err)})` };
  }
}

async function liveReviewer(context: Context, { pr, head }: ReviewerRef): Promise<boolean> {
  const seat = seatOf(context, pr);
  return !("refusal" in seat) && boardOf(context).heads.get(seat.label) === head && ((await listedOf(context))?.some((agent) => agent.label === seat.label) ?? false);
}

/**
 * Writes a status under the claim's context on `sha` in `repo`, as the reviewer role: the identity the door posts as, whose token is minted in the checkout first. The one writer of a claim and of
 * its release (A11-149).
 */
function claimWriterOf(context: Context, seat: Seat, { repo, sha, tree }: { repo: string; sha: string; tree: string }): (description: string) => Promise<void> {
  const environment = gateOf(context).wake.reviewerEnvironment(seat.label, repositoryEnvOf(context, seat), tree);
  return async (description) => {
    const refusal = await codeHostOf(context).writeReviewClaim({ repository: repo, head: sha, description, environment });
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
async function claimEntriesOf(context: Context, { repo, sha }: { repo: string; sha: string }): Promise<readonly Readonly<{ id: number; description: string; created: number }>[]> {
  const read = await codeHostOf(context).readReviewClaims(repo, sha);
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
async function claimOf(context: Context, seat: Seat, { pr, head, tree, rereview }: { pr: string; head: string; tree: string; rereview: boolean }): Promise<Claimed> {
  const pull = pullOf(pr);
  if (pull === null) return { refusal: `no reviewer for ${pr}: it is not a pull request url` };
  const minted = await mintOf(context, tree);
  if (minted !== null) return { refusal: `no reviewer for ${pr}: ${minted}` };
  const { repository } = pull;
  const board = boardOf(context);
  const { claims } = board;
  const answer = await claims.claimHead({
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
      await releaseClaim(context, seat, { pr, head, tree });
      return { refusal: `no reviewer for ${pr}: its claim at ${head.slice(0, 8)} could not be made (${answer.reason}), so none is started`, unclaimed: answer.reason };
  }
}

/**
 * Gives up this instance's claim on a head whose reviewer did not start (A11-149), so another instance may take the head now rather than when the lease ends. Best effort: a release that cannot be
 * written leaves the claim to expire with its lease, which is the state a release is for avoiding and no worse.
 */
async function releaseClaim(context: Context, seat: Seat, { pr, head, tree }: { pr: string; head: string; tree: string }): Promise<void> {
  const pull = pullOf(pr);
  if (pull === null) return;
  try {
    await claimWriterOf(context, seat, { repo: pull.repository, sha: head, tree })(boardOf(context).claims.releasedDescriptionOf({ instance: boardOf(context).instance, now: nowOf(context) }));
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
async function trustCodexFor(context: Context, { pr, tree }: { pr: string; tree: string }): Promise<string | null> {
  const codex = context.seams.codexTrust;
  if (codex === undefined) return null;
  const root = await codex.rootOf(tree);
  if (root === null) return null;
  const answer = codex.ensure(root);
  if (answer.kind === "refused") return `no reviewer for ${pr}: ${answer.reason}`;
  if (answer.kind === "added") codex.log(`codex now trusts ${answer.root}: the reviewer of ${pr} starts in it`);
  return null;
}

/**
 * A START IN FLIGHT HOLDS ITS SEAT (A11-379). The loop runs between the steps of a start, so two sweeps, or a sweep and `ticket:review`, could start the same seat at once: a second start of a seat whose start has not settled is refused, which the pool
 * reads as "try on a later sweep". The seat leaves the set when its start ends, whatever it came to.
 */
async function startReviewerOnce(context: Context, ref: ReviewerRef, brief: ReviewBrief | undefined): ReturnType<ReviewerPort["start"]> {
  const seat = seatOf(context, ref.pr);
  if ("refusal" in seat) return seat;
  const doing = context.holding.get(seat.label);
  if (doing !== undefined) return { refusal: `no reviewer for ${ref.pr}: a reviewer for it is still ${doing}` };
  return holdingSeat(context, seat.label, "starting", () => startReviewer(context, ref, brief, seat));
}

async function startReviewer(context: Context, ref: ReviewerRef, brief: ReviewBrief | undefined, seat: Seat): ReturnType<ReviewerPort["start"]> {
  const { pr, head } = ref;
  const { trust } = gateOf(context);
  const board = boardOf(context);
  const state = codeHostOf(context).peekReviewState?.(pr) ?? null;
  if (state === null) return { refusal: `no reviewer for ${pr}: the pull request could not be read` };
  if (state.trust !== trust.INSIDE) return { refusal: `no reviewer for ${pr}: its author is outside the org, and the tickets' reviewer starts for the org's own pull requests only` };
  if (state.head !== head) return { refusal: `no reviewer for ${pr}: its head moved to ${state.head}, so ${head} is no longer to be reviewed` };
  if (!state.settled) return { refusal: `no reviewer for ${pr}: its checks at ${head} have not settled green` };
  const agents = await listedOf(context);
  if (agents === null) return { refusal: `no reviewer for ${pr}: herdr did not list the ${board.session} session` };
  // A reviewer still holding the label is one for an earlier head: its workspace is closed before the next one starts under the same label.
  const stale = agents.some((agent) => agent.label === seat.label);
  if (stale) await closeWorkspace(board.runAsync, board.session, seat.label);
  const tree = await onClone(context, seat, () => checkoutSeam(context)({ pr: seat.number, session: seat.label, trust: trust.INSIDE, ...rootOf(seat) }));
  if ("refusal" in tree) return tree;
  // Codex's trust comes before the claim and the spawn: a repository it has not been told to trust stops the reviewer on a dialog nobody answers (A11-221).
  const untrusted = await trustCodexFor(context, { pr, tree: tree.path });
  if (untrusted !== null) return { refusal: untrusted };
  // The claim comes before the spawn: an instance that holds the head starts nothing, and a claim that cannot be made starts nothing either (A11-149).
  const claimed = await claimOf(context, seat, { pr, head, tree: tree.path, rereview: brief?.rereview !== undefined });
  if ("refusal" in claimed) return claimed;
  // A reviewer started without a claim wrote none, so it has none to give up.
  const giveUpClaim = async () => { if (claimed.unclaimed === undefined) await releaseClaim(context, seat, { pr, head, tree: tree.path }); };
  const started = await spawnOf(context)({ session: seat.label, cause: REVIEW_CAUSE, causeKey: `${pr}@${head}`, trust: trust.INSIDE },
    agents.filter((agent) => agent.label !== seat.label), { run: herdrOf(context), cwd: tree.path, env: reviewerEnvOf(context, seat), ...(boardOf(context).tmpBase === undefined ? {} : { tmpBase: boardOf(context).tmpBase }) });
  if ("refusal" in started) {
    await giveUpClaim();
    return started;
  }
  const prompted = await sendPrompt(context, seat, state, ref, brief);
  if ("refusal" in prompted) {
    await giveUpClaim();
    return { refusal: `no reviewer for ${pr}: ${prompted.refusal}` };
  }
  board.heads.set(seat.label, head);
  return { label: seat.label, ...(claimed.tookOver === null ? {} : { tookOver: claimed.tookOver }), ...(claimed.unclaimed === undefined ? {} : { unclaimed: claimed.unclaimed }) };
}

async function settledReviewer(context: Context, { pr, head }: ReviewerRef): Promise<ReviewerSettled> {
  const seat = seatOf(context, pr);
  if ("refusal" in seat || boardOf(context).heads.get(seat.label) !== head) return "gone";
  const agents = await listedOf(context);
  // herdr did not say what is running, so the reviewer is working as far as anyone can tell: nothing is said of it on a guess.
  if (agents === null) return "working";
  const holders = agents.filter((agent) => agent.label === seat.label);
  if (holders.length === 0) return "gone";
  return holders.every((agent) => ENDED_STATUSES.includes(agent.status)) ? "ended" : "working";
}

/**
 * Looks at the pane of a seat's reviewer when herdr lists it `blocked` (A11-221, contract 1.6), and answers Codex's trust dialog for a repository the host file names (`answerDialog`). Any other dialog is `stuck`, with its
 * first line, and nothing is pressed. Null when the reviewer is not blocked (its pane is left unread) or its pane shows no dialog; `unread` when herdr cannot be asked or the pane cannot be read, which says nothing of a dialog.
 */
async function unblockReviewer(context: Context, { pr, head }: ReviewerRef): Promise<ReviewerDialog | null> {
  const seat = seatOf(context, pr);
  const board = boardOf(context);
  if ("refusal" in seat || board.heads.get(seat.label) !== head) return null;
  const agents = await listedOf(context);
  if (agents === null) return { unread: `herdr did not list the ${board.session} session` };
  if (!agents.some((agent) => agent.label === seat.label && agent.status === BLOCKED_STATUS)) return null;
  let pane: string;
  try {
    pane = await board.runAsync(["--session", board.session, "agent", "read", board.herdr.agentName(seat.label), "--source", "visible"]);
  } catch (err) {
    return { unread: `${seat.label}'s pane could not be read (${board.herdr.firstLine(err)})` };
  }
  const seen = readPaneDialog(pane, board.herdr.readDialogLines);
  if (seen === null) return null;
  const key = `${seat.label}@${head}`;
  const answers = context.trustAnswers.get(key) ?? 0;
  const codex = context.seams.codexTrust;
  let pressed = false;
  const answer = await answerDialog({ seen, answers,
    ensure: codex?.ensure ?? (() => ({ kind: "refused", file: "", reason: "the port is given no Codex trust to ask" })),
    press: () => { pressed = true; return pressEnter(board, seat.label); } });
  // An answer is counted when a key was tried, so a press herdr keeps refusing does not go on for ever.
  if (pressed) context.trustAnswers.set(key, answers + 1);
  return answer;
}

/** Sends `enter` to the seat's agent, which answers the dialog's selected option: whether herdr took it. */
async function pressEnter(board: ReviewerBoard, label: string): Promise<boolean> {
  try {
    await board.runAsync(["--session", board.session, "agent", "send-keys", board.herdr.agentName(label), "enter"]);
    return true;
  } catch {
    return false;
  }
}

async function repostReviewerVerdict(context: Context, { pr, head }: ReviewerRef, file: string): Promise<RepostAnswer> {
  const seat = seatOf(context, pr);
  if ("refusal" in seat) return { refusal: seat.refusal, final: true };
  const word = verdictWordOf(context, file, head);
  if (word === null) return { refusal: `the verdict file ${file} does not open with a verdict for ${head.slice(0, 8)}`, final: true };
  const tree = checkoutPathOf(context, seat.label);
  // The token first: the door posts as the reviewer App, and a token that is stale or missing is the failure this repost is for.
  const minted = await mintOf(context, tree);
  if (minted !== null) return { refusal: minted, final: false };
  const { wake, doorPath } = gateOf(context);
  try {
    await doorOf(context)(doorPath.reviewerDoorPath(), [String(seat.number), word, file], wake.reviewerEnvironment(seat.label, reviewerEnvOf(context, seat), tree));
    return { posted: true };
  } catch (err) {
    const status = (err as { status?: number | null }).status ?? null;
    return { refusal: doorReason(err, status), final: status !== null && FINAL_DOOR_EXITS.includes(status) };
  }
}

async function repromptReviewer(context: Context, ref: ReviewerRef, brief: ReviewBrief | undefined): Promise<PromptAnswer> {
  const { pr } = ref;
  const seat = seatOf(context, pr);
  if ("refusal" in seat) return seat;
  const state = codeHostOf(context).peekReviewState?.(pr) ?? null;
  if (state === null) return { refusal: `no reprompt for ${pr}: the pull request could not be read` };
  const sent = await sendPrompt(context, seat, state, ref, brief);
  return "refusal" in sent ? { refusal: `no reprompt for ${pr}: ${sent.refusal}` } : { prompted: true };
}

async function closeReviewer(context: Context, { pr, head }: ReviewerRef): Promise<CloseAnswer> {
  const seat = seatOf(context, pr);
  if ("refusal" in seat) return seat;
  // A start, a close or a retire in flight is asked again: its checkout and its workspace are still being made, or closed.
  if (context.holding.has(seat.label)) return { state: "busy" };
  return holdingSeat(context, seat.label, "closing", () => closeHeld(context, seat, { pr, head }));
}

async function closeHeld(context: Context, seat: Seat, { pr, head }: ReviewerRef): Promise<CloseAnswer> {
  const board = boardOf(context);
  if (board.heads.get(seat.label) !== head) return { refusal: `no close for ${pr}: ${seat.label} was not started for ${head}` };
  const agents = await listedOf(context);
  if (agents === null) return { refusal: `no close for ${pr}: herdr did not list the ${board.session} session` };
  const holders = agents.filter((agent) => agent.label === seat.label);
  if (holders.length === 0) return { state: "gone" };
  // A reviewer posts its verdict and then finishes its turn: closing it mid-turn would cut that turn off, so it waits for the next look.
  if (holders.some((agent) => agent.status === "working")) return { state: "busy" };
  // The checkout is kept: a head that moves re-points it, and the next reviewer for this seat uses it.
  return closeAll(context, pr, seat.label);
}

async function retireReviewer(context: Context, pr: string): Promise<RetireAnswer> {
  const seat = seatOf(context, pr);
  if ("refusal" in seat) return seat;
  const doing = context.holding.get(seat.label);
  if (doing !== undefined) return { refusal: `no retire for ${pr}: a reviewer for it is still ${doing}, and is retired once it is not` };
  return holdingSeat(context, seat.label, "retiring", () => retireHeld(context, seat, pr));
}

async function retireHeld(context: Context, seat: Seat, pr: string): Promise<RetireAnswer> {
  const board = boardOf(context);
  const agents = await listedOf(context);
  if (agents === null) return { refusal: `no retire for ${pr}: herdr did not list the ${board.session} session` };
  const holders = agents.filter((agent) => agent.label === seat.label);
  if (holders.some((agent) => agent.status === "working")) return { refusal: `no retire for ${pr}: ${seat.label} is still working, and is retired once it is not` };
  // The workspaces first, since nothing may be reading the tree when it goes; the checkout only once every workspace under the label has closed.
  if (holders.length > 0) {
    const closed = await closeAll(context, pr, seat.label);
    if ("refusal" in closed) return closed;
  }
  const path = gateOf(context).wake.reviewCheckoutPath(seat.label);
  const uncommitted = await uncommittedOf(context, path);
  if ("refusal" in uncommitted) return { refusal: `no retire for ${pr}: ${uncommitted.refusal}` };
  const head = board.heads.get(seat.label) ?? "an unrecorded head";
  const left = await onClone(context, seat, () => removeCheckoutOf(context)({ pr: seat.number, session: seat.label, key: seat.key, ...rootOf(seat) }));
  if (left !== null) return { refusal: `no retire for ${pr}: ${left}` };
  board.heads.delete(seat.label);
  // The discard is reported only once it has happened: a removal that fails keeps the tree and says nothing was discarded.
  return { retired: true, report: discardReport({ label: seat.label, pr, head, path, paths: uncommitted.paths }) };
}

async function listedPullUrls(context: Context): Promise<string[]> {
  return ((await listedOf(context)) ?? []).flatMap((agent) => {
    const instance = boardOf(context).attribution.reviewerInstance(agent.label);
    const repository = instance === null ? null : repositoryOfKey(context, instance.key);
    return instance === null || repository === null ? [] : [`https://github.com/${repository}/pull/${instance.number}`];
  });
}

/** The reviewer's token mint in a checkout, as the gate's own refresh makes it (A11-83): the reason it cannot, or null when the reviewer has a token. */
function reviewerTokenMintOf(context: Context): (tree: string) => Promise<string | null> {
  return (tree) => {
    const { wake } = gateOf(context);
    return wake.reviewerTokenMinterAsync(wake.reviewerAppOf())(tree);
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
async function closeWorkspace(run: (args: string[]) => Promise<string>, session: string, label: string): Promise<void> {
  const workspaces = JSON.parse(await run(["--session", session, "workspace", "list"]))?.result?.workspaces ?? [];
  const id = workspaces.find((w: { label?: unknown }) => w?.label === label)?.workspace_id;
  if (typeof id === "string") await run(["--session", session, "workspace", "close", id]);
}

/**
 * The port for a host where the gate does not load (a host with no `primary`): it starts nothing and holds nothing, answering as an empty session would, so a caller that asks before it reads
 * `refusal()` gets an answer and not the gate's own exception. `refusal` is asked at each call, so a gate that loads later is the port again.
 */
export function portWhereGateLoads(port: ReviewerPort, refusal: () => string | null): ReviewerPort {
  const refused = (pr: string): string => `no reviewer for ${pr}: the reviewer's gate does not load on this host: ${refusal()}`;
  const loads = (): boolean => refusal() === null;
  return {
    start: async (ref, brief) => (loads() ? port.start(ref, brief) : { refusal: refused(ref.pr) }),
    live: async (ref) => loads() && port.live(ref),
    close: async (ref) => (loads() ? port.close(ref) : { refusal: refused(ref.pr) }),
    retire: async (pr) => (loads() ? port.retire(pr) : { refusal: refused(pr) }),
    listedPulls: async () => (loads() ? port.listedPulls() : []),
    settled: async (ref) => (loads() ? port.settled(ref) : "gone"),
    verdictFileOf: (ref) => (loads() ? port.verdictFileOf(ref) : null),
    repostVerdict: async (ref, file) => (loads() ? port.repostVerdict(ref, file) : { refusal: refused(ref.pr), final: true }),
    reprompt: async (ref, brief) => (loads() ? port.reprompt(ref, brief) : { refusal: refused(ref.pr) }),
    unblock: async (ref) => (loads() ? (await port.unblock?.(ref)) ?? null : null),
  };
}
