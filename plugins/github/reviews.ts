// module: what the reviewer reads of a pull request -- its head, its reviews, its trust and whether its required checks settled, and its state (A11-160, A11-175)
//
// Moved out of `ticket-mode/reviewer-port.ts` (`readReviewState`, `readPullState`), over the plugin's `gh`. THE READS ARE ASYNCHRONOUS AND BATCHED (A11-356): the instance's loop goes on while GitHub answers, and the open pull requests of a
// repository are read with ONE `gh pr list` that every pull request of it, and every caller, shares for a few seconds, where each caller read each pull request with a `gh pr view` of its own (35 a minute, each holding the loop for a second). WHAT IS TRUSTED AND WHAT IS SETTLED IS CORE'S: the pull request is read by
// the fields the reviewer's policy names (`policy.review().fields`), and the same policy judges it (`trustOf`, `settledOf`). Asking for the policy THROWS where the reviewer's gate does not
// load, before anything is read, as the read always did.
import type { Review, ReviewState } from "../../src/plugins/contracts/code-host.ts";
import type { CodeHostPolicy } from "../../src/plugins/manifest.ts";
import type { AsyncGh } from "./gh.ts";
import { MERGE_BOT_GATE, readHeadHoldsMergeBotAsync, readMergeFlowAsync, runsMergeBot } from "./merge-flow.ts";
import type { SharedReads } from "./shared-reads.ts";

/** The most open pull requests one batched read asks for. A repository with more is not read in full by it, and a pull request the list does not hold is read on its own. */
export const BATCH_LIMIT = 100;

type Pull = { repository: string; number: number };

/** A pull request's named `--json` fields, as the reviewer's policy reads them (its own contract types them loosely, since the fields it names are its own). */
type PullFields = Readonly<Record<string, any>>;

/** Whether `value` is an object of fields: what `gh --json` prints for a pull request, and not `null`, a list or a bare value. */
const isFields = (value: unknown): value is PullFields => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * THE OPEN PULL REQUESTS OF `repository` WITH THE NAMED `fields`, by number, in one `gh pr list` (the same fields `gh pr view --json` answers for each), or null when they could not be had: a refused `gh`, or an answer that does not
 * parse. Absence is not proof: a pull request this map lacks may be merged, closed, or past {@link BATCH_LIMIT}, so a caller reads it on its own.
 */
async function openPullsOf(repository: string, fields: string, gh: AsyncGh): Promise<Map<number, PullFields> | null> {
  try {
    const listed: unknown = JSON.parse(await gh(["pr", "list", "--repo", repository, "--state", "open", "--limit", String(BATCH_LIMIT), "--json", [...new Set(["number", ...fields.split(",")])].join(",")]));
    if (!Array.isArray(listed)) return null;
    return new Map(listed.flatMap((pr): [number, PullFields][] => (isFields(pr) && typeof pr.number === "number" ? [[pr.number, pr]] : [])));
  } catch {
    return null;
  }
}

/**
 * The named `fields` (a `--json` list) of one pull request, or null when they could not be had: a refused `gh`, or an answer that does not parse. Absence is not proof, so a caller reads null as no reading. Private: row mode's own read of
 * the same fields stays in core (`src/ticket-port/pull-request-fields.ts`) until its callers move into this plugin, and a plugin imports core's types only (ADR 0001), so the two cannot be one file.
 */
async function viewOf({ repository, number }: Pull, fields: string, gh: AsyncGh): Promise<PullFields | null> {
  try {
    const viewed: unknown = JSON.parse(await gh(["pr", "view", String(number), "--repo", repository, "--json", fields]));
    return isFields(viewed) ? viewed : null;
  } catch {
    return null;
  }
}

/**
 * What GitHub says is required of a pull request, for each check of its head commit: `isRequired(pullRequestNumber:)` is GitHub's own answer from the base branch's protection rules and rulesets, so a
 * stacked pull request is judged by its own base (A11-175). `pull-feedback.ts` reads the same field for the board's failing checks.
 */
const REQUIRED_QUERY = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
    __typename
    ... on CheckRun { name isRequired(pullRequestNumber: $number) }
    ... on StatusContext { context isRequired(pullRequestNumber: $number) }
  } } } } } }
} } }`;

/**
 * The names of the checks the pull request's base requires, or null when GitHub did not say: a refused `gh`, or an answer that does not hold the head commit's checks. Null is never "nothing is
 * required", which is an empty list: the caller counts every check for both. Required checks that have not reported are not in the answer, so they are not named. A head with more checks than one page holds
 * is not read in full, so a required check could be missing from the list and counted as not required: that is null too.
 */
async function readRequiredChecks(pull: Pull, gh: AsyncGh): Promise<string[] | null> {
  const [owner, repo] = pull.repository.split("/");
  try {
    const answer = JSON.parse(await gh(["api", "graphql", "-f", `query=${REQUIRED_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${pull.number}`]));
    const page = answer?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    const contexts = page?.nodes;
    if (!Array.isArray(contexts) || page.pageInfo?.hasNextPage === true) return null;
    const required = contexts.filter((check: { isRequired?: boolean } | null) => check?.isRequired === true).map((check: { name?: string; context?: string }) => String(check.name ?? check.context ?? ""));
    return [...new Set(required.filter((name) => name !== ""))];
  } catch {
    return null;
  }
}

/** The pull request's repository (`owner/name`) and number, or null for a url that is none. */
export function pullOf(url: string): Pull | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(url);
  return match === null ? null : { repository: match[1], number: Number(match[2]) };
}

/** What the reviewer reads of a pull request, over a `gh` that does not hold the process still. */
export type ReviewReads = Readonly<{
  /** {@link ReviewReads.state}: the pull request's state as the reviewer sees it. */
  state(url: string, policy: CodeHostPolicy, options?: Readonly<{ fresh?: boolean }>): Promise<ReviewState | null>;
  /** The pull request's state as GitHub names it. */
  pullState(url: string): Promise<string | null>;
  /** The state {@link ReviewReads.state} last answered for the pull request, if that was within {@link PEEK_MS}; null otherwise. Reads nothing. */
  peek(url: string): ReviewState | null;
}>;

/** How long {@link ReviewReads.peek} answers what `state` last read: the reviewer starts for a head the sweep has just read, and a start that comes later than this reads nothing and is asked again on the next sweep. */
export const PEEK_MS = 60_000;

/**
 * The reads of the reviewer over `gh`, with the answers `shared` (A11-356). A repository's open pull requests are read once for every pull request of it and every caller of it within the bound of `shared`, and so are a pull request's required checks and a
 * repository's merge flow; a pull request the repository's list does not hold (a merged one, a closed one, one past {@link BATCH_LIMIT}) is read on its own, once in the same time.
 */
export function createReviewReads({ gh, shared, now = Date.now }: Readonly<{ gh: AsyncGh; shared: SharedReads; now?: () => number }>): ReviewReads {
  const read = new Map<string, { state: ReviewState; at: number }>();

  /** The named `fields` of `pull`: from its repository's one list when the list holds it, else on their own. */
  async function fieldsOf(pull: Pull, fields: string): Promise<PullFields | null> {
    const listed = (await shared(`list ${pull.repository} ${fields}`, () => openPullsOf(pull.repository, fields, gh)))?.get(pull.number);
    return listed ?? shared(`view ${pull.repository}#${pull.number} ${fields}`, () => viewOf(pull, fields, gh));
  }

  /**
   * The checks the pull request waits on: those its base requires, or, where it requires none and the repository's flow is the merge bot (A11-341), the bot's own condition, `gate`. The flow is the merge bot when the default branch holds it or the pull request's head does (A11-344: the pull request that adds the bot). A private repository on
   * GitHub Free has no ruleset to require anything, so every check would hold the review, and a red one that is not the merge condition would hold it for good. Null when GitHub did not say what is required;
   * a repository whose flow could not be read is read as one without the bot, which counts every check as before.
   */
  async function waitedOnChecks(pull: Pull): Promise<string[] | null> {
    const required = await shared(`required ${pull.repository}#${pull.number}`, () => readRequiredChecks(pull, gh));
    if (required === null || required.length > 0) return required;
    const flow = await shared(`flow ${pull.repository}`, () => readMergeFlowAsync(pull.repository, gh));
    if (flow === null) return required;
    const headBot = flow.private && !flow.mergeBot && await shared(`head bot ${pull.repository}#${pull.number}`, () => readHeadHoldsMergeBotAsync(pull.repository, pull.number, gh));
    return runsMergeBot({ ...flow, headBot }) ? [MERGE_BOT_GATE] : required;
  }

  return {
    /**
     * The pull request's state as the reviewer sees it: its head, whether its author is the org's own (`INSIDE`), its reviews, and whether its REQUIRED checks have settled green (A11-175). A rollup
     * that is all green is settled and asks nothing more; otherwise GitHub is asked which checks are required (`waitedOnChecks`: the base's required checks, or the merge bot's `gate` where it requires none), and a failing check that is not required is named in `unrequiredRed`
     * and holds nothing. An answer that cannot be had counts every check. Null when GitHub does not say, which the caller reads as no reading rather than as a verdict. REJECTS with the gate's refusal when the
     * gate does not load, before anything is read, as the read always threw.
     */
    async state(url, policy, options) {
      const judge = policy.review();
      const pull = pullOf(url);
      if (pull === null) return null;
      if (options?.fresh === true) {
        shared.forget(`list ${pull.repository} `);
        shared.forget(`view ${pull.repository}#${pull.number} `);
        shared.forget(`required ${pull.repository}#${pull.number}`);
      }
      const pr = await fieldsOf(pull, judge.fields);
      try {
        if (typeof pr?.headRefOid !== "string") return null;
        const reviews: Review[] = (pr.reviews ?? []).map((r: { author?: { login?: string }; state?: string; commit?: { oid?: string }; submittedAt?: string }) => ({
          author: String(r.author?.login ?? ""), state: String(r.state ?? ""), commit: String(r.commit?.oid ?? ""),
          at: Date.parse(String(r.submittedAt ?? "")) || 0,
        }));
        const allGreen = judge.settledOf(pr);
        const required = allGreen ? undefined : await waitedOnChecks(pull);
        const settled = allGreen || judge.settledOf(pr, required);
        const unrequiredRed = judge.unrequiredRedOf(pr, required);
        const state: ReviewState = { head: pr.headRefOid, trust: judge.trustOf(pr), reviews, settled, ...(unrequiredRed.length === 0 ? {} : { unrequiredRed }), view: { ...pr, number: pull.number } };
        for (const [other, last] of read) if (now() - last.at >= PEEK_MS) read.delete(other);
        read.set(url, { state, at: now() });
        return state;
      } catch {
        return null;
      }
    },

    /**
     * The pull request's state as GitHub names it, `OPEN`, `MERGED` or `CLOSED`, or null when it does not say. A merged or closed pull request is the one `retire` is for; an unreadable one
     * is nothing to act on. A pull request in its repository's list of open ones is open; any other is read on its own.
     */
    async pullState(url) {
      const pull = pullOf(url);
      if (pull === null) return null;
      const state = (await fieldsOf(pull, "state"))?.state;
      return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
    },

    peek(url) {
      const last = read.get(url);
      if (last !== undefined && now() - last.at >= PEEK_MS) read.delete(url);
      return last !== undefined && now() - last.at < PEEK_MS ? last.state : null;
    },
  };
}
