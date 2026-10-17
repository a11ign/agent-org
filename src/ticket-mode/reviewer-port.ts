// @ts-check
// module: the tickets' reviewer -- starts the gate's codex reviewer on a ready pull request, once per head, behind a port the pool holds
//
// THE PORT IS THE POOL'S ONLY SEAM: `start` a reviewer for one pull request at one head, and `live`, whether one is running for that head.
// The atomic adapter starts the gate's own reviewer, `spawnReviewer` in `wake.ts` with its trust rules (`review-trust.ts`) and its verdict door,
// in the tickets' herdr session. Nothing here copies that code: it is imported. The reviewer posts as `a11ign-reviewer`, and its verdict is what
// the pool reads back to decide whether the worker goes round again.

import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reviewerSeat } from "../review-attribution.ts";
import { ORG_SESSION, readAgents, type ListedAgent } from "../herdr-agents.ts";
import { pullRequestFieldsOf } from "../ticket-port/pull-request-fields.ts";
import type { ReviewTrust } from "../review-trust.ts";

/** The gate's modules: its reviewer, its trust rules, its verdict prompt, and the org's declaration. */
type GateModules = {
  wake: typeof import("../wake.ts"); trust: typeof import("../review-trust.ts"); config: typeof import("../project-config.ts");
  identity: typeof import("../project-identity.ts"); orders: typeof import("../work-gate/pr-orders.ts");
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
  gate = await Promise.all([import("../wake.ts"), import("../review-trust.ts"), import("../project-config.ts"), import("../project-identity.ts"), import("../work-gate/pr-orders.ts")]).then(
    ([wake, trust, config, identity, orders]) => ({ ok: true as const, modules: { wake, trust, config, identity, orders } }),
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

/** The port: start a reviewer for a ready pull request at its head, or refuse naming why; and say whether one is live for that head. */
export type ReviewerPort = Readonly<{
  start(ref: ReviewerRef): Readonly<{ label: string }> | Readonly<{ refusal: string }>;
  live(ref: ReviewerRef): boolean;
}>;

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
 * The reviewer's verdict on `head`: the newest review it posted on that commit, `convinced` for an approval and `not-convinced` for requested
 * changes; null while it has not posted one. A review on an earlier head says nothing about this one.
 */
export function reviewVerdict(reviews: readonly Review[], head: string): "convinced" | "not-convinced" | null {
  const newest = reviews.filter((r) => r.author === REVIEWER_LOGIN && r.commit === head).sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) return null;
  return newest.state === "APPROVED" ? "convinced" : newest.state === "CHANGES_REQUESTED" ? "not-convinced" : null;
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
 * What a pool remembers of its reviewers across a restart: the head each seat's reviewer was started for (`heads`, by seat label), the reviewers
 * started (`started`, `url@head`), and the verdicts a worker was asked to answer (`resumed`, `url@head`). The pool holds it and the port reads `heads`.
 */
export type ReviewerMemory = { heads: Map<string, string>; started: Set<string>; resumed: Set<string> };

/**
 * The memory on disk. A file that is not there is nothing remembered yet; one that is there and is not what `writeReviewerMemory` writes is
 * `unreadable`, and is also nothing remembered. Neither throws.
 */
export function readReviewerMemory(path: string): { memory: ReviewerMemory; unreadable: boolean } {
  const nothing = (unreadable: boolean) => ({ memory: { heads: new Map<string, string>(), started: new Set<string>(), resumed: new Set<string>() }, unreadable });
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return nothing((error as NodeJS.ErrnoException).code !== "ENOENT");
  }
  try {
    const data = JSON.parse(text);
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
    if (data === null || typeof data !== "object" || data.heads === null || typeof data.heads !== "object"
      || !Object.values(data.heads).every((head) => typeof head === "string") || !strings(data.started) || !strings(data.resumed)) {
      throw new Error("not a reviewer memory");
    }
    return { memory: { heads: new Map(Object.entries(data.heads) as [string, string][]), started: new Set(data.started), resumed: new Set(data.resumed) }, unreadable: false };
  } catch {
    return nothing(true);
  }
}

/** Writes the memory whole, through a temporary file renamed over the last one, so a write that stops midway leaves that last one. */
export function writeReviewerMemory(path: string, memory: ReviewerMemory): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify({ heads: Object.fromEntries(memory.heads), started: [...memory.started], resumed: [...memory.resumed] }));
  renameSync(`${path}.tmp`, path);
}

/**
 * The atomic adapter: the gate's codex reviewer, started in the tickets' herdr `session`. The gate's functions name the org's session, so the calls
 * they make are retargeted to `session` here, and nothing else about them changes. It refuses a pull request whose author is not the org's own
 * (`review-trust.ts`): the gate's verdict door and pane reader run only in the org's session, so an outside reviewer has no place to post from.
 * The head each reviewer was started for is in `heads` (by seat label), which the pool keeps across a restart, so a restart starts a reviewer again only for a
 * head it has not reviewed. It refuses a head whose checks have not settled green: the gate's verdict is asked only of settled checks.
 */
export function atomicReviewerPort({ session, run, gh, declared = reviewerGate().trust.declaredIdentities(), spawn = reviewerGate().wake.spawnReviewer, checkout = reviewerGate().wake.prepareReviewCheckout, heads = new Map<string, string>() }: {
  session: string; run: (args: string[]) => string; gh: (args: string[]) => string; declared?: DeclaredIdentities;
  spawn?: typeof import("../wake.ts").spawnReviewer; checkout?: typeof import("../wake.ts").prepareReviewCheckout; heads?: Map<string, string>;
}): ReviewerPort {
  const herdr = (args: string[]) => run(args[0] === "--session" && args[1] === ORG_SESSION ? ["--session", session, ...args.slice(2)] : args);
  const listed = (): ListedAgent[] | null => readAgents(run, { session });

  return {
    live({ pr, head }) {
      const seat = seatOf(pr);
      return !("refusal" in seat) && heads.get(seat.label) === head && (listed()?.some((agent) => agent.label === seat.label) ?? false);
    },
    start({ pr, head }) {
      const seat = seatOf(pr);
      if ("refusal" in seat) return seat;
      const { trust, orders } = reviewerGate();
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
      // The gate's own verdict prompt, for this seat's repository: the same words the gate sends a reviewer for a ready pull request.
      const prompt = orders.awaitingVerdictPrompt({ ...state.view, repoKey: seat.key }, orders.reviewHeadsOf(state.view, head, "settled"));
      try {
        run(["--session", session, "agent", "prompt", seat.label, prompt]);
      } catch (err) {
        return { refusal: `no reviewer for ${pr}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
      }
      heads.set(seat.label, head);
      return { label: seat.label };
    },
  };
}

/** Closes the workspace a label holds in the session, if herdr lists it. */
function closeWorkspace(run: (args: string[]) => string, session: string, label: string): void {
  const workspaces = JSON.parse(run(["--session", session, "workspace", "list"]))?.result?.workspaces ?? [];
  const id = workspaces.find((w: { label?: unknown }) => w?.label === label)?.workspace_id;
  if (typeof id === "string") run(["--session", session, "workspace", "close", id]);
}
