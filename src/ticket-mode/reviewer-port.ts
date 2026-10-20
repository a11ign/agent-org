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
import type { ReviewWord } from "./board-view/pull-review-state.ts";

/** The gate's modules: its reviewer, its trust rules, its verdict prompt, and the org's declaration. */
type GateModules = {
  wake: typeof import("../wake/ensure-reviewer-token.ts") & typeof import("../wake/ci-class-and-spares.ts") & typeof import("../wake/pull-request-spawn-orders.ts") & typeof import("../wake/seat-reset.ts"); trust: typeof import("../review-trust.ts"); config: typeof import("../project-config.ts");
  identity: typeof import("../project-identity.ts"); orders: typeof import("../work-gate/pr-orders.ts"); doorPath: typeof import("../reviewer-door-path.ts"); host: typeof import("../host-config.ts");
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
  // The host file's module is read only once the gate's own modules have loaded: it is one of them (`pull-request-spawn-orders` imports it), so
  // it is already loaded then, and a host with no `primary` keeps the refusal the declaration names, not this one.
  gate = await Promise.all([import("../wake/ensure-reviewer-token.ts"), import("../wake/ci-class-and-spares.ts"), import("../wake/pull-request-spawn-orders.ts"), import("../wake/seat-reset.ts"), import("../review-trust.ts"), import("../project-config.ts"), import("../project-identity.ts"), import("../work-gate/pr-orders.ts"), import("../reviewer-door-path.ts")]).then(
    async ([tokens, withCiFailure, spawnOrder, reset, trust, config, identity, orders, doorPath]) => ({ ok: true as const, modules: { wake: { ...tokens, ...withCiFailure, ...spawnOrder, ...reset }, trust, config, identity, orders, doorPath, host: await import("../host-config.ts") } }),
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

/** The host's checkouts by repository name (`host.json`'s `clones`), which carry no owner: a name is one of this org's repositories. */
type Clones = Readonly<Record<string, string>>;

/** The key of a repository the project declares: `""` for the primary's, `null` for one it does not declare. */
function repoKeyOf(repository: string): string | null {
  const { config, identity } = reviewerGate();
  if (repository === identity.REPO) return "";
  return config.homeProjectDeclaration().code.find((code) => code.repo === repository)?.key ?? null;
}

/**
 * The seat key and checkout of a repository the host clones and the project does not declare (PURE). Its key is its clone's name, which must be a
 * reviewer key (`reviewerInstance`'s grammar) and no declared key of another repository; its owner must be `owner`, the primary's, since `clones`
 * carries names only. Null for a repository that is none of these; a refusal names why a clone of it cannot be a seat.
 */
export function clonedSeatOf(repository: string, { owner, clones, codes }: { owner: string; clones: Clones; codes: readonly { key: string; repo: string }[] }): { key: string; clone: string } | { refusal: string } | null {
  const [repoOwner, name] = repository.split("/");
  if (repoOwner !== owner || !Object.hasOwn(clones, name)) return null;
  if (!/^[a-z0-9-]+$/.test(name) || /-[0-9]+$/.test(name)) return { refusal: `its name \`${name}\` cannot be a reviewer key (lowercase letters, digits and hyphens, not ending in a number)` };
  const clash = codes.find((code) => code.key === name);
  if (clash !== undefined) return { refusal: `the project declares \`${name}\` as the key of ${clash.repo}, so the host's clone \`${name}\` would take the same reviewer seat` };
  return { key: name, clone: clones[name] };
}

/** The repository a key names: the reverse of {@link repoKeyOf} and {@link clonedSeatOf}, and `null` for a key neither the project declares nor the host clones. */
function repositoryOfKey(key: string, clones: Clones): string | null {
  const { config, identity } = reviewerGate();
  if (key === "") return identity.REPO;
  const declared = config.homeProjectDeclaration().code.find((code) => code.key === key)?.repo;
  if (declared !== undefined) return declared;
  return Object.hasOwn(clones, key) ? `${identity.REPO.split("/")[0]}/${key}` : null;
}

/**
 * A reviewer's seat for a pull request: its label, number and repository key. A repository the host clones and the project does not declare also
 * names its `repository` and its `clone`, which the gate's calls would otherwise take from the declaration; a declared or primary seat names neither.
 */
type Seat = { label: string; number: number; key: string; repository?: string; clone?: string };

/** The reviewer's seat for a pull request: `reviewer-<n>` in the primary, `reviewer-<key>-<n>` elsewhere, or a refusal naming why it has none. */
function seatOf(url: string, clones: Clones): Seat | { refusal: string } {
  const pull = pullOf(url);
  if (pull === null) return { refusal: `no reviewer for ${url}: it is not a pull request url` };
  const key = repoKeyOf(pull.repository);
  if (key !== null) return { label: reviewerSeat({ repoKey: key, number: pull.number }), number: pull.number, key };
  const { config, identity } = reviewerGate();
  const cloned = clonedSeatOf(pull.repository, { owner: identity.REPO.split("/")[0], clones, codes: config.homeProjectDeclaration().code });
  if (cloned === null) return { refusal: `no reviewer for ${url}: ${pull.repository} is not a repository the project declares (\`code\` in .agent-org/project.json) and the host does not clone it (\`clones\` in host.json)` };
  if ("refusal" in cloned) return { refusal: `no reviewer for ${url}: ${cloned.refusal}` };
  return { label: reviewerSeat({ repoKey: cloned.key, number: pull.number }), number: pull.number, key: cloned.key, repository: pull.repository, clone: cloned.clone };
}

/** What a cloned-only seat's checkout is made in: its clone, which the gate would otherwise take from the declaration. Nothing for any other seat. */
function rootOf(seat: Seat): { repoRoot?: string } {
  return seat.clone === undefined ? {} : { repoRoot: seat.clone };
}

/** The environment a cloned-only seat's reviewer runs with: the repository its verdict door posts to, which the declaration would otherwise name. Nothing for any other seat. */
function repositoryEnvOf(seat: Seat): Record<string, string> {
  const { host } = reviewerGate();
  return seat.repository === undefined ? {} : { GH_REPO: seat.repository, [host.HOST_CONFIG_ENV]: host.hostConfigPath() };
}

/** The spawn option a cloned-only seat adds: its environment. Nothing for any other seat, so their spawn is called as it was. */
function envOptionOf(seat: Seat): { env?: Record<string, string> } {
  return seat.repository === undefined ? {} : { env: repositoryEnvOf(seat) };
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

/** The words a reviewer's review states read as on the board (A11-119). A review in any other state is no verdict. */
const REVIEW_WORDS: Readonly<Record<string, ReviewWord>> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", DISMISSED: "dismissed" };

/** The newest review the reviewer posted that `keep` accepts, as its head and its word, or null when there is none. */
function reviewWordOf(reviews: readonly Review[], keep: (review: Review) => boolean): Readonly<{ head: string; word: ReviewWord }> | null {
  const newest = reviews.filter((r) => r.author === REVIEWER_LOGIN && Object.hasOwn(REVIEW_WORDS, r.state) && keep(r)).sort((a, b) => b.at - a.at)[0];
  return newest === undefined ? null : { head: newest.commit, word: REVIEW_WORDS[newest.state] };
}

/** The word of the reviewer's newest review on `head`, or null while it has posted none there (A11-119). */
export function reviewWordAt(reviews: readonly Review[], head: string): ReviewWord | null {
  return reviewWordOf(reviews, (r) => r.commit === head)?.word ?? null;
}

/** The newest word of the reviewer's review on a head other than `head`, with that head, or null (A11-119). */
export function earlierReviewWord(reviews: readonly Review[], head: string): Readonly<{ head: string; word: ReviewWord }> | null {
  return reviewWordOf(reviews, (r) => r.commit !== head);
}

/**
 * The repositories whose open pull requests the pool reviews (A11-119): the primary's, the project's declared ones, and the host's clones under the
 * primary's owner. These are the repositories `seatOf` accepts, so a pull request of any other is one no reviewer could start for.
 */
export function reviewedRepositoriesOf(clones: Clones): string[] {
  const { config, identity } = reviewerGate();
  const owner = identity.REPO.split("/")[0];
  const declared = config.homeProjectDeclaration().code.map((code) => code.repo);
  return [...new Set([identity.REPO, ...declared, ...Object.keys(clones).map((name) => `${owner}/${name}`)])];
}

/** The most open pull requests one repository's list is read to: a list this long may be cut short, so it is no reading. */
const OPEN_PULL_LIMIT = 200;

/**
 * The URLs of a repository's open pull requests, or null for "could not ask": a refused `gh`, an answer that does not parse, or a list at the limit,
 * which may be cut short. `null` is never "none are open" (the same rule as `openPullsOf`).
 */
export function openPullUrlsOf(repository: string, gh: (args: string[]) => string): string[] | null {
  try {
    const pulls: unknown = JSON.parse(gh(["pr", "list", "--repo", repository, "--state", "open", "--limit", String(OPEN_PULL_LIMIT), "--json", "url"]));
    if (!Array.isArray(pulls) || pulls.length >= OPEN_PULL_LIMIT) return null;
    return pulls.map((pull) => String(pull?.url));
  } catch {
    return null;
  }
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
  const nothing = ({ unreadable }: { unreadable: boolean; }) => ({ memory: { heads: new Map<string, string>(), started: new Set<string>(), resumed: new Set<string>(), reposts: new Map<string, Repost>() }, unreadable });
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return nothing({ unreadable: (error as NodeJS.ErrnoException).code !== "ENOENT" });
  }
  try {
    const data = JSON.parse(text);
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
    // `reposts` is absent in a file written before A11-83: nothing was re-posted then.
    const reposts: Record<string, unknown> = data?.reposts ?? {};
    const repost = (value: any) => value !== null && typeof value === "object" && Number.isInteger(value.attempts) && value.attempts >= 0
      && (value.reason === undefined || typeof value.reason === "string");
    const isMalformedMemory = data === null || typeof data !== "object" || data.heads === null || typeof data.heads !== "object"
      || !Object.values(data.heads).every((head) => typeof head === "string") || !strings(data.started) || !strings(data.resumed)
      || reposts === null || typeof reposts !== "object" || !Object.values(reposts).every(repost);
    if (isMalformedMemory) {
      throw new Error("not a reviewer memory");
    }
    return { memory: { heads: new Map(Object.entries(data.heads) as [string, string][]), started: new Set(data.started), resumed: new Set(data.resumed),
      reposts: new Map(Object.entries(reposts) as [string, Repost][]) }, unreadable: false };
  } catch {
    return nothing({ unreadable: true });
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
  checkoutOf = reviewerGate().wake.reviewCheckoutPath, mint = reviewerTokenMintOf, door = reviewerGate().trust.runDoor, clones = {} }: {
  session: string; run: (args: string[]) => string; gh: (args: string[]) => string; declared?: DeclaredIdentities;
  spawn?: typeof import("../wake/ensure-reviewer-token.ts").spawnReviewer; checkout?: typeof import("../wake/ensure-reviewer-token.ts").prepareReviewCheckout; heads?: Map<string, string>;
  removeCheckout?: typeof import("../wake/ensure-reviewer-token.ts").removeReviewCheckout; uncommittedPaths?: (path: string) => string[]; exists?: (path: string) => boolean;
  /** Where a seat's reviewer keeps its checkout, which holds the verdict file it wrote. */
  checkoutOf?: (label: string) => string;
  /** Mints the reviewer's token in a checkout: the reason it could not, or null when it has one. */
  mint?: (tree: string) => string | null;
  /** Runs the verdict door with the reviewer's environment: throws on a non-zero exit, with the door's stderr. */
  door?: DoorRun;
  /** The host's checkouts (`clones`): a repository one of them names, under the primary's owner, is reviewed with no entry in the project's `code`. */
  clones?: Clones;
}): ReviewerPort {
  const seams: AtomicSeams = { session, run, gh, declared, spawn, checkout, heads, removeCheckout, uncommittedPaths, exists, checkoutOf, mint, door, clones };
  return {
    live: (ref) => liveReviewer(seams, ref),
    start: (ref) => startReviewer(seams, ref),
    settled: (ref) => settledReviewer(seams, ref),
    verdictFileOf: ({ pr, head }) => {
      const seat = seatOf(pr, seams.clones);
      return "refusal" in seat ? null : verdictFileIn(checkoutOf(seat.label), seat.number, head);
    },
    repostVerdict: (ref, file) => repostReviewerVerdict(seams, ref, file),
    reprompt: (ref) => repromptReviewer(seams, ref),
    close: (ref) => closeReviewer(seams, ref),
    retire: (pr) => retireReviewer(seams, pr),
    listedPulls: () => listedPullUrls(seams),
  };
}

/** The seams `atomicReviewerPort` runs through, each as the factory resolved it, defaults included. */
type AtomicSeams = Required<Parameters<typeof atomicReviewerPort>[0]>;

/** The herdr call the gate's functions make: the org's session is retargeted to the tickets' session here, and nothing else about the call changes. */
function herdrOf(seams: AtomicSeams): (args: string[]) => string {
  return (args) => seams.run(args[0] === "--session" && args[1] === ORG_SESSION ? ["--session", seams.session, ...args.slice(2)] : args);
}

/** The agents herdr lists in the tickets' session, or null when it lists none it can read. */
function listedOf(seams: AtomicSeams): ListedAgent[] | null {
  return readAgents(seams.run, { session: seams.session });
}

/** The gate's own verdict prompt, for a seat's repository, sent to the seat's agent: the same words the gate sends a reviewer for a ready pull request. */
function sendPrompt(seams: AtomicSeams, seat: { label: string; key: string }, state: ReviewState, head: string): { sent: true } | { refusal: string } {
  const words = reviewerGate().orders.awaitingVerdictPrompt({ ...state.view, repoKey: seat.key }, reviewerGate().orders.reviewHeadsOf(state.view, head, "settled"));
  try {
    seams.run(["--session", seams.session, "agent", "prompt", seat.label, words]);
    return { sent: true };
  } catch (err) {
    return { refusal: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

/** Closes every workspace under a seat's label, as the gate's teardown does; a refusal names what would not close. */
function closeAll(seams: AtomicSeams, pr: string, label: string): Readonly<{ state: "closed" }> | Readonly<{ refusal: string }> {
  const problems: string[] = [];
  const closed = reviewerGate().wake.closeReviewer(label, { run: herdrOf(seams), warn: (line) => problems.push(line) });
  return closed ? { state: "closed" } : { refusal: `no close for ${pr}: ${problems.join(" ") || `${label} would not close`}` };
}

/**
 * The uncommitted paths in a checkout, none when it is gone. A `status` that fails is a refusal: a tree that could not be read is kept, never removed.
 */
function uncommittedOf(seams: AtomicSeams, path: string): { paths: string[] } | { refusal: string } {
  if (!seams.exists(path)) return { paths: [] };
  try {
    return { paths: seams.uncommittedPaths(path) };
  } catch (err) {
    return { refusal: `the changes in ${path} could not be read, so it is kept (${firstLine(err)})` };
  }
}

function liveReviewer(seams: AtomicSeams, { pr, head }: ReviewerRef): boolean {
  const seat = seatOf(pr, seams.clones);
  return !("refusal" in seat) && seams.heads.get(seat.label) === head && (listedOf(seams)?.some((agent) => agent.label === seat.label) ?? false);
}

function startReviewer(seams: AtomicSeams, { pr, head }: ReviewerRef): Readonly<{ label: string }> | Readonly<{ refusal: string }> {
  const seat = seatOf(pr, seams.clones);
  if ("refusal" in seat) return seat;
  const { trust } = reviewerGate();
  const state = readReviewState(pr, seams.gh, seams.declared);
  if (state === null) return { refusal: `no reviewer for ${pr}: the pull request could not be read` };
  if (state.trust !== trust.INSIDE) return { refusal: `no reviewer for ${pr}: its author is outside the org, and the tickets' reviewer starts for the org's own pull requests only` };
  if (state.head !== head) return { refusal: `no reviewer for ${pr}: its head moved to ${state.head}, so ${head} is no longer to be reviewed` };
  if (!state.settled) return { refusal: `no reviewer for ${pr}: its checks at ${head} have not settled green` };
  const agents = listedOf(seams);
  if (agents === null) return { refusal: `no reviewer for ${pr}: herdr did not list the ${seams.session} session` };
  // A reviewer still holding the label is one for an earlier head: its workspace is closed before the next one starts under the same label.
  const stale = agents.some((agent) => agent.label === seat.label);
  if (stale) closeWorkspace(seams.run, seams.session, seat.label);
  const tree = seams.checkout({ pr: seat.number, session: seat.label, trust: trust.INSIDE, ...rootOf(seat) });
  if ("refusal" in tree) return tree;
  const started = seams.spawn({ session: seat.label, cause: REVIEW_CAUSE, causeKey: `${pr}@${head}`, trust: trust.INSIDE },
    agents.filter((agent) => agent.label !== seat.label), { run: herdrOf(seams), cwd: tree.path, ...envOptionOf(seat) });
  if ("refusal" in started) return started;
  const prompted = sendPrompt(seams, seat, state, head);
  if ("refusal" in prompted) return { refusal: `no reviewer for ${pr}: ${prompted.refusal}` };
  seams.heads.set(seat.label, head);
  return { label: seat.label };
}

function settledReviewer(seams: AtomicSeams, { pr, head }: ReviewerRef): ReviewerSettled {
  const seat = seatOf(pr, seams.clones);
  if ("refusal" in seat || seams.heads.get(seat.label) !== head) return "gone";
  const agents = listedOf(seams);
  // herdr did not say what is running, so the reviewer is working as far as anyone can tell: nothing is said of it on a guess.
  if (agents === null) return "working";
  const holders = agents.filter((agent) => agent.label === seat.label);
  if (holders.length === 0) return "gone";
  return holders.every((agent) => ENDED_STATUSES.includes(agent.status)) ? "ended" : "working";
}

function repostReviewerVerdict(seams: AtomicSeams, { pr, head }: ReviewerRef, file: string): RepostAnswer {
  const seat = seatOf(pr, seams.clones);
  if ("refusal" in seat) return { refusal: seat.refusal, final: true };
  const word = verdictWordOf(file, head);
  if (word === null) return { refusal: `the verdict file ${file} does not open with a verdict for ${head.slice(0, 8)}`, final: true };
  const tree = seams.checkoutOf(seat.label);
  // The token first: the door posts as the reviewer App, and a token that is stale or missing is the failure this repost is for.
  const minted = seams.mint(tree);
  if (minted !== null) return { refusal: minted, final: false };
  try {
    seams.door(reviewerGate().doorPath.reviewerDoorPath(), [String(seat.number), word, file], reviewerGate().wake.reviewerEnvironment(seat.label, repositoryEnvOf(seat), tree));
    return { posted: true };
  } catch (err) {
    const status = (err as { status?: number | null }).status ?? null;
    return { refusal: doorReason(err, status), final: status !== null && FINAL_DOOR_EXITS.includes(status) };
  }
}

function repromptReviewer(seams: AtomicSeams, { pr, head }: ReviewerRef): PromptAnswer {
  const seat = seatOf(pr, seams.clones);
  if ("refusal" in seat) return seat;
  const state = readReviewState(pr, seams.gh, seams.declared);
  if (state === null) return { refusal: `no reprompt for ${pr}: the pull request could not be read` };
  const sent = sendPrompt(seams, seat, state, head);
  return "refusal" in sent ? { refusal: `no reprompt for ${pr}: ${sent.refusal}` } : { prompted: true };
}

function closeReviewer(seams: AtomicSeams, { pr, head }: ReviewerRef): CloseAnswer {
  const seat = seatOf(pr, seams.clones);
  if ("refusal" in seat) return seat;
  if (seams.heads.get(seat.label) !== head) return { refusal: `no close for ${pr}: ${seat.label} was not started for ${head}` };
  const agents = listedOf(seams);
  if (agents === null) return { refusal: `no close for ${pr}: herdr did not list the ${seams.session} session` };
  const holders = agents.filter((agent) => agent.label === seat.label);
  if (holders.length === 0) return { state: "gone" };
  // A reviewer posts its verdict and then finishes its turn: closing it mid-turn would cut that turn off, so it waits for the next look.
  if (holders.some((agent) => agent.status === "working")) return { state: "busy" };
  // The checkout is kept: a head that moves re-points it, and the next reviewer for this seat uses it.
  return closeAll(seams, pr, seat.label);
}

function retireReviewer(seams: AtomicSeams, pr: string): RetireAnswer {
  const seat = seatOf(pr, seams.clones);
  if ("refusal" in seat) return seat;
  const { wake } = reviewerGate();
  const agents = listedOf(seams);
  if (agents === null) return { refusal: `no retire for ${pr}: herdr did not list the ${seams.session} session` };
  const holders = agents.filter((agent) => agent.label === seat.label);
  if (holders.some((agent) => agent.status === "working")) return { refusal: `no retire for ${pr}: ${seat.label} is still working, and is retired once it is not` };
  // The workspaces first, since nothing may be reading the tree when it goes; the checkout only once every workspace under the label has closed.
  if (holders.length > 0) {
    const closed = closeAll(seams, pr, seat.label);
    if ("refusal" in closed) return closed;
  }
  const path = wake.reviewCheckoutPath(seat.label);
  const uncommitted = uncommittedOf(seams, path);
  if ("refusal" in uncommitted) return { refusal: `no retire for ${pr}: ${uncommitted.refusal}` };
  const head = seams.heads.get(seat.label) ?? "an unrecorded head";
  const left = seams.removeCheckout({ pr: seat.number, session: seat.label, key: seat.key, ...rootOf(seat) });
  if (left !== null) return { refusal: `no retire for ${pr}: ${left}` };
  seams.heads.delete(seat.label);
  // The discard is reported only once it has happened: a removal that fails keeps the tree and says nothing was discarded.
  return { retired: true, report: discardReport({ label: seat.label, pr, head, path, paths: uncommitted.paths }) };
}

function listedPullUrls(seams: AtomicSeams): string[] {
  return (listedOf(seams) ?? []).flatMap((agent) => {
    const instance = reviewerInstance(agent.label);
    const repository = instance === null ? null : repositoryOfKey(instance.key, seams.clones);
    return instance === null || repository === null ? [] : [`https://github.com/${repository}/pull/${instance.number}`];
  });
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
