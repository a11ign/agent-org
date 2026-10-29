// @ts-check
// module: the tickets' reviewer, what stays in core -- the gate the reviewer plugin drives, the pool's memory of its reviewers, and how a reviewer's reviews are read
//
// THE ATOMIC REVIEWER IS A PLUGIN (`plugins/atomic-reviewer`, A11-161). Its port -- `start` a reviewer for one pull request at one head, `live`, `close`, `retire` and the rest, which
// start the gate's codex reviewer in the tickets' herdr session -- moved there with its seats, claims and verdict files. What stays here is what the org's own reviewer shares with it and the
// pool needs whichever reviewer runs: THE GATE (`wake/*`, `review-trust.ts`, `work-gate/pr-orders.ts`, `project-config.ts`, the door path and `host-config.ts`), loaded once and handed to the
// plugin through `deps.reviewing` (`src/plugins/reviewing-helpers.ts`); the pool's own memory of its reviewers (`readReviewerMemory`, `writeReviewerMemory`); and the readers of a reviewer's
// reviews, which the pool and the board's lines use. The reviewer posts as `a11ign-reviewer`, and its verdict is what the pool reads back to decide whether the worker goes round again.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repositoryOfClone } from "../declared-clone.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { realExecAsync } from "../plugins/real-seams.ts";
import type { ReviewWord } from "./board-view/pull-review-state.ts";
import type { Review, ReviewState } from "../plugins/contracts/code-host.ts";
import type { ReviewJudge } from "../plugins/manifest.ts";
import type { ReviewerRef, ReviewerPort, ReviewerSettled, RepostAnswer, PromptAnswer, CloseAnswer, RetireAnswer } from "../plugins/contracts/reviewer.ts";

// THE PORT IS THE REVIEWER CONTRACT'S (`src/plugins/contracts/reviewer.ts`, A11-158); its types are re-exported here, so no caller changes.
export type { ReviewState, ReviewerRef, ReviewerPort, ReviewerSettled, RepostAnswer, PromptAnswer, CloseAnswer, RetireAnswer };

/**
 * The gate's modules, as core uses them in full: its reviewer, its trust rules, its verdict prompt, and the org's declaration. The reviewer plugin is handed them as `ReviewerGate`
 * (`plugins/manifest.ts`), the part of each it calls, with a signature of its own; `reviewing-helpers.ts` is where the two are held to each other.
 */
type ReviewerGate = {
  wake: typeof import("../wake/reviewer-tokens-and-checkouts.ts") & typeof import("../wake/ci-class-and-spares.ts") & typeof import("../wake/pull-request-spawn-orders.ts") & typeof import("../wake/seat-reset.ts") & typeof import("../wake/reviewer-start-async.ts");
  trust: typeof import("../review-trust.ts") & Pick<typeof import("../wake/reviewer-start-async.ts"), "runDoorAsync">; config: typeof import("../project-config.ts");
  identity: typeof import("../project-identity.ts"); orders: typeof import("../work-gate/pr-orders.ts"); doorPath: typeof import("../reviewer-door-path.ts"); host: typeof import("../host-config.ts");
};

/** What `loadReviewerGate` found: the modules, or the refusal that keeps them from loading on this host. Null until it has run. */
let gate: { ok: true; modules: ReviewerGate } | { ok: false; refusal: unknown } | null = null;

/**
 * Loads the gate's modules. Importing them names the declaration the org's `primary` makes, so a host with no `primary` cannot load them, and the
 * refusal is KEPT rather than thrown: `reviewerRefusal` says it. Nothing loads them at import, so a machine that starts no reviewer never does. The
 * instance calls this when a reviewer plugin is active or reviews are required (`server.ts`), before it makes its pool; the reviewer plugin's `load()` calls it too.
 */
export async function loadReviewerGate(): Promise<void> {
  if (gate !== null) return;
  // The host file's module is read only once the gate's own modules have loaded: it is one of them (`pull-request-spawn-orders` imports it), so
  // it is already loaded then, and a host with no `primary` keeps the refusal the declaration names, not this one.
  gate = await Promise.all([import("../wake/reviewer-tokens-and-checkouts.ts"), import("../wake/ci-class-and-spares.ts"), import("../wake/pull-request-spawn-orders.ts"), import("../wake/seat-reset.ts"), import("../wake/reviewer-start-async.ts"), import("../review-trust.ts"), import("../project-config.ts"), import("../project-identity.ts"), import("../work-gate/pr-orders.ts"), import("../reviewer-door-path.ts")]).then(
    async ([tokens, withCiFailure, spawnOrder, reset, startAsync, trust, config, identity, orders, doorPath]) => ({ ok: true as const, modules: { wake: { ...tokens, ...withCiFailure, ...spawnOrder, ...reset, ...startAsync }, trust: { ...trust, runDoorAsync: startAsync.runDoorAsync }, config, identity, orders, doorPath, host: await import("../host-config.ts") } }),
    (refusal: unknown) => ({ ok: false as const, refusal }),
  );
}

/** Why the gate does not load on this host, or null when it does. A machine that asks for reviewers starts none while this is set. Needs `loadReviewerGate` first. */
export function reviewerRefusal(): string | null {
  if (gate === null) throw new Error("the gate is not loaded: loadReviewerGate runs before a pool with reviewers is made");
  if (gate.ok) return null;
  const { refusal } = gate;
  return refusal instanceof Error ? refusal.message.split("\n")[0] : String(refusal);
}

/** The gate's modules, once `loadReviewerGate` has read them (the reviewer plugin is handed them through `deps.reviewing`). Throws the refusal when they do not load on this host. */
export function reviewerGate(): ReviewerGate {
  if (gate === null) throw new Error("the gate is not loaded: loadReviewerGate runs first");
  if (!gate.ok) throw gate.refusal;
  return gate.modules;
}

/** The account the gate's reviewer posts as. Its reviews are the reviewer's, never the feedback a worker answers. */
export const REVIEWER_LOGIN = "a11ign-reviewer";

/**
 * The accounts whose reply to a block counts as one (A11-156): the board's own account, which is the run's worker, and the logins the org declares for its people (`declaredIdentities` of
 * `review-trust.ts`, the same line that decides whether a pull request is the org's own). The reviewer's own account never counts, and a bot the declaration names only by pattern does not: the
 * reply's text goes into a reviewer's prompt, and the org's repositories take comments from anyone. THROWS the gate's refusal when the gate does not load.
 */
export function replyAuthorsOf(ownLogin: string): string[] {
  const { exact } = reviewerGate().trust.declaredIdentities();
  return [...new Set([ownLogin, ...exact])].filter((login) => login !== REVIEWER_LOGIN);
}

/** The host's checkouts by repository name (`host.json`'s `clones`), which carry no owner: a name is one of this org's repositories. */
type Clones = Readonly<Record<string, string>>;

/**
 * How the gate judges a pull request the code host plugin reads for the reviewer (A11-160): the fields it reads by, whether its author is the org's own, and whether its checks have
 * settled green, the required ones only (A11-175). THROWS the gate's refusal when the gate does not load (`reviewerRefusal`), so a read that needs it refuses before it asks GitHub anything.
 */
export function gateReviewJudge(): ReviewJudge {
  const { trust, orders } = reviewerGate();
  const declared = trust.declaredIdentities();
  return { fields: orders.REVIEW_PULL_FIELDS, trustOf: (pr) => trust.reviewTrustOf(pr, declared), settledOf: (pr, required) => orders.settledGreenOf(pr, required), unrequiredRedOf: (pr, required) => orders.unrequiredRedOf(pr, required) };
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
 * The reviewer's block on `head`: its newest review there when that review asked for changes, else null (A11-156). A reply to a review that is not the newest answers nothing, so only the
 * newest counts, and only when it is a block: a head the reviewer approved has no block to answer.
 */
export function standingBlock(reviews: readonly Review[], head: string): Review | null {
  const newest = reviews.filter((r) => r.author === REVIEWER_LOGIN && r.commit === head).sort((a, b) => b.at - a.at)[0];
  return newest?.state === "CHANGES_REQUESTED" ? newest : null;
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

/** How long one clone's `origin` is read for, so a clone on a stalled mount holds the board's loop for no longer. */
const ORIGIN_TIMEOUT_MS = 3000;
/** How long a read origin is kept: the sweeps ask every few minutes, and a clone's remote does not change under them. */
const ORIGIN_KEPT_MS = 300_000;
const origins = new Map<string, { at: number; url: string | undefined }>();

/**
 * Read the `origin` of every clone whose kept answer is older than {@link ORIGIN_KEPT_MS}, together and without holding the loop, and keep each where {@link originOf} finds it (A11-282). The sweeps ask `originOf` for every clone
 * at once, and each of those was a `git` the board thread waited on: a clone read every five minutes, on a host under load, was a hold of 100 ms and more for each. A sweep warms the answers first and then reads them
 * from the cache. Never rejects: a clone it cannot read is kept as having none, as `originOf` keeps it.
 */
export async function warmOrigins(clones: Clones, now: () => number = Date.now): Promise<void> {
  const stale = [...new Set(Object.values(clones))].filter((path) => {
    const held = origins.get(path);
    return held === undefined || now() - held.at >= ORIGIN_KEPT_MS;
  });
  const env = sandboxGitEnv();
  const withoutEnv = Object.keys(process.env).filter((name) => !(name in env));
  await Promise.all(stale.map(async (path) => {
    // A clone that is not on this machine has no origin to read, and asking `git` for it would only wait for the answer `originOf` gives: none.
    if (!existsSync(path)) return void origins.set(path, { at: now(), url: undefined });
    const answer = await realExecAsync("git", ["-C", path, "remote", "get-url", "origin"], { env: Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined)), withoutEnv, timeoutMs: ORIGIN_TIMEOUT_MS });
    origins.set(path, { at: now(), url: answer.status === 0 ? answer.stdout.trim() : undefined });
  }));
}

/** The `origin` URL of the clone at `path`, or undefined when it has none or is not a clone. */
export function originOf(path: string, now: () => number = Date.now): string | undefined {
  const held = origins.get(path);
  if (held !== undefined && now() - held.at < ORIGIN_KEPT_MS) return held.url;
  let url: string | undefined;
  try {
    url = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "ignore"], timeout: ORIGIN_TIMEOUT_MS }).trim();
  } catch (err) {
    void err; // no origin, no clone at that path, or no answer in time: it names no repository, and the caller takes the key for a name
  }
  origins.set(path, { at: now(), url });
  return url;
}

/** Each clone of `clones` with the repository it is the checkout of: the declaration's, else its remote's, else its key taken as a name under the primary's owner (A11-360). */
function repositoriesOfClones(clones: Clones, remote: (path: string) => string | undefined): { key: string; repository: string }[] {
  const { config, identity } = reviewerGate();
  const owner = identity.REPO.split("/")[0];
  const code = config.homeProjectDeclaration().code;
  return Object.entries(clones).map(([key, path]) => ({ key, repository: repositoryOfClone(key, path, { code, remote }) ?? `${owner}/${key}` }));
}

/** The key under which `clones` lists the clone of `repository` (`owner/name`), or undefined when it lists none: a writer places a ticket by this key. */
export function cloneKeyForRepository(clones: Clones, repository: string, remote: (path: string) => string | undefined = originOf): string | undefined {
  return repositoriesOfClones(clones, remote).find((cloned) => cloned.repository === repository)?.key;
}

/**
 * The repositories whose open pull requests the pool reviews (A11-119): the primary's, the project's declared ones, and the repositories the host's clones are checkouts of. These are the repositories the reviewer plugin
 * gives a seat to, so a pull request of any other is one no reviewer could start for. A clone's repository is found from the declaration or its git remote, never from its key (A11-360: the key `github` of the clone
 * of `.github` listed `a11ign/github`). A clone whose remote cannot be read is listed under its key as a name, as `clones` lists a clone (`doctor` fails a key that is no repository).
 */
export function reviewedRepositoriesOf(clones: Clones, remote: (path: string) => string | undefined = originOf): string[] {
  const { config, identity } = reviewerGate();
  return [...new Set([identity.REPO, ...config.homeProjectDeclaration().code.map((declared) => declared.repo), ...repositoriesOfClones(clones, remote).map(({ repository }) => repository)])];
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
 * What a reviewer was started against for one `url@head` (A11-235): when it started, and the pull request body it was started with. A description edit is not a new head, so this is what a later look compares
 * the body with, and the time a reply has to follow. The newest start of the head is the one kept. `decisions` is the ticket's decisions the start was briefed with, empty when it was briefed with none (A11-250);
 * a look written before then has none, and its decisions are unknown: the head is never re-reviewed for them. A Decisions change is a new decision, so this is what a later look compares them with. `plan` is the plan's decisions the start was briefed
 * with (A11-290), kept the same way: a planner's amendment of a decision is a new decision too, and a look without it is never re-reviewed for the plan. `decided` is the lines of the ticket's Decisions that changed and so summoned this re-review (A11-290),
 * absent for a start no Decisions change summoned: a re-review that stays not convinced after them is a stand-off the planner is shown at once.
 */
export type Look = { at: number; body: string; decisions?: string; plan?: string; decided?: string };

/**
 * What herdr's refusals to start the reviewer for one `url@head` have come to (A11-241): herdr's reason for the last one, and how many in a row gave that same reason. A different reason starts the count again at 1.
 * Kept on disk, so a restart does not reset the count and `agent-org doctor`, a separate process, can read it.
 */
export type StartRefusal = { reason: string; count: number };

/** The pull request and the head a `url@head` key of the memory names (A11-241). A pull request's address holds no `@`, so the last one splits them. */
export function splitHeadKey(key: string): { url: string; head: string } {
  const at = key.lastIndexOf("@");
  return { url: key.slice(0, at), head: key.slice(at + 1) };
}

/**
 * What a pool remembers of its reviewers across a restart: the head each seat's reviewer was started for (`heads`, by seat label), the reviewers
 * started (`started`, `url@head`), the verdicts a worker was asked to answer (`resumed`, `url@head`), the re-posts of a verdict not on its pull request
 * (`reposts`, `url@head`), the heads a reply to a block earned one re-review of (`rereviewed`, `url@head`, A11-156), and when each OTHER instance was last seen under the review claim's
 * context on any head (`seen`, by instance name, epoch ms, A11-172), and why a reviewer started WITHOUT a claim has none (`unclaimed`, `url@head` to GitHub's reason, A11-172), which the board keeps saying
 * while it runs, across a restart and for a `ticket:review` start too, and the look each head's newest start had (`looks`, `url@head`, A11-235), and herdr's refusals to start a head's reviewer (`refusals`, `url@head`, A11-241). The pool holds it and the port reads `heads` and writes `seen`.
 */
export type ReviewerMemory = { heads: Map<string, string>; started: Set<string>; resumed: Set<string>; reposts: Map<string, Repost>; rereviewed: Set<string>; seen: Map<string, number>; unclaimed: Map<string, string>; looks: Map<string, Look>; refusals: Map<string, StartRefusal> };

/** Nothing remembered: what a pool starts from when there is no file, and what a file it cannot read is read as. */
export const noReviewerMemory = (): ReviewerMemory => ({ heads: new Map(), started: new Set(), resumed: new Set(), reposts: new Map(), rereviewed: new Set(), seen: new Map(), unclaimed: new Map(), looks: new Map(), refusals: new Map() });

/**
 * The memory on disk. A file that is not there is nothing remembered yet; one that is there and is not what `writeReviewerMemory` writes is
 * `unreadable`, and is also nothing remembered. Neither throws.
 */
export function readReviewerMemory(path: string): { memory: ReviewerMemory; unreadable: boolean } {
  const nothing = ({ unreadable }: { unreadable: boolean; }) => ({ memory: noReviewerMemory(), unreadable });
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return nothing({ unreadable: (error as NodeJS.ErrnoException).code !== "ENOENT" });
  }
  try {
    const data = JSON.parse(text);
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
    // `reposts` is absent in a file written before A11-83: nothing was re-posted then. `rereviewed` is absent in a file written before A11-156: no head was re-reviewed then.
    const reposts: Record<string, unknown> = data?.reposts ?? {};
    const rereviewed: unknown = data?.rereviewed ?? [];
    // `seen` and `unclaimed` are absent in a file written before A11-172, and in one for a pool that saw no other instance and started nothing without a claim. An entry of either that is not the right
    // type is left out, not a reason to forget every started head: neither is what keeps a head from being started twice.
    const entriesOf = <T>(value: unknown, isT: (item: unknown) => item is T): [string, T][] =>
      (typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value).filter((entry): entry is [string, T] => isT(entry[1])) : []);
    // `looks` is absent in a file written before A11-235 (and a look has no `decisions` before A11-250), and a look that is not the right shape is left out like a `seen` entry: the head then has none, and is re-reviewed by a reply only.
    const lookOf = (value: unknown): value is Look => value !== null && typeof value === "object" && Number.isFinite((value as Look).at) && typeof (value as Look).body === "string"
      && ((value as Look).decisions === undefined || typeof (value as Look).decisions === "string") && ((value as Look).plan === undefined || typeof (value as Look).plan === "string")
      && ((value as Look).decided === undefined || typeof (value as Look).decided === "string");
    // `refusals` is absent in a file written before A11-241, and in one for a pool whose starts herdr never refused. One that is not the right shape is left out like a `look`: its head is then refused again from a count of 1.
    const refusalOf = (value: unknown): value is StartRefusal => value !== null && typeof value === "object" && typeof (value as StartRefusal).reason === "string"
      && Number.isInteger((value as StartRefusal).count) && (value as StartRefusal).count >= 1;
    const repost = (value: any) => value !== null && typeof value === "object" && Number.isInteger(value.attempts) && value.attempts >= 0
      && (value.reason === undefined || typeof value.reason === "string");
    const isMalformedMemory = data === null || typeof data !== "object" || data.heads === null || typeof data.heads !== "object"
      || !Object.values(data.heads).every((head) => typeof head === "string") || !strings(data.started) || !strings(data.resumed) || !strings(rereviewed)
      || reposts === null || typeof reposts !== "object" || !Object.values(reposts).every(repost);
    if (isMalformedMemory) {
      throw new Error("not a reviewer memory");
    }
    return { memory: { heads: new Map(Object.entries(data.heads) as [string, string][]), started: new Set(data.started), resumed: new Set(data.resumed),
      reposts: new Map(Object.entries(reposts) as [string, Repost][]), rereviewed: new Set(rereviewed),
      seen: new Map(entriesOf(data.seen, (at): at is number => typeof at === "number" && Number.isFinite(at))), unclaimed: new Map(entriesOf(data.unclaimed, (reason): reason is string => typeof reason === "string")),
      looks: new Map(entriesOf(data.looks, lookOf)), refusals: new Map(entriesOf(data.refusals, refusalOf)) }, unreadable: false };
  } catch {
    return nothing({ unreadable: true });
  }
}

/** Writes the memory whole, through a temporary file renamed over the last one, so a write that stops midway leaves that last one. */
export function writeReviewerMemory(path: string, memory: ReviewerMemory): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify({ heads: Object.fromEntries(memory.heads), started: [...memory.started], resumed: [...memory.resumed],
    // Written only when there is one, so a file for a pool that re-posted nothing reads as it always did.
    ...(memory.reposts.size > 0 ? { reposts: Object.fromEntries(memory.reposts) } : {}),
    // Likewise: a file for a pool that re-reviewed nothing reads as it always did.
    ...(memory.rereviewed.size > 0 ? { rereviewed: [...memory.rereviewed] } : {}),
    // Likewise: a file for a pool that saw no other instance reads as it always did.
    ...(memory.seen.size > 0 ? { seen: Object.fromEntries(memory.seen) } : {}),
    // Likewise: a file for a pool that started every reviewer with its claim reads as it always did.
    ...(memory.unclaimed.size > 0 ? { unclaimed: Object.fromEntries(memory.unclaimed) } : {}),
    // Likewise: a file for a pool that started nothing reads as it always did.
    ...(memory.looks.size > 0 ? { looks: Object.fromEntries(memory.looks) } : {}),
    // Likewise: a file for a pool whose starts herdr never refused reads as it always did.
    ...(memory.refusals.size > 0 ? { refusals: Object.fromEntries(memory.refusals) } : {}) }));
  renameSync(`${path}.tmp`, path);
}
