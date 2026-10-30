// module: what GitHub says of a repository's open pull requests, read ONCE per repository per sweep and shared by every reader in the plugin (A11-365)
//
// ONE GRAPHQL QUERY PER REPOSITORY answers for every open pull request of it: its head, its reviews and comments, its review decision, its mergeability, its queue entry and its check rollup, with the names of the checks its base requires
// (`baseRef.rules` and `baseRef.branchProtectionRule`, which is GitHub's own list from the base branch's rulesets and protection, per pull request's own base, so a stacked pull request is judged by its own). The answer is kept for
// `SNAPSHOT_TTL_MS`, one sweep, and `reviews.ts`, `pull-feedback.ts`, `replies.ts`, `open-pulls.ts`, `dependency-pulls.ts`, `merged-findings.ts`, `closed-work.ts` and `stack-retarget.ts` all read it here and spawn no `gh` for a pull request
// of their own. Before this, each of them asked GitHub for each pull request on every call: the reviewer's read alone made 35 calls a minute on 2026-10-27.
//
// WHAT THE SNAPSHOT DOES NOT HOLD IS READ ONCE AND REMEMBERED. A pull request that is not open (merged or closed) is in no open list, and one opened since the snapshot was made is not in it yet: either is read by number, one call,
// and a pull request that is no longer open is remembered for `TERMINAL_TTL_MS`, so a blocker that merged costs one read and not one a sweep. A repository that cannot be read is not asked again for `FAILURE_TTL_MS`, serves the snapshot it had for `STALE_TTL_MS` more and is `null` after that, and is NEVER read pull request by
// pull request instead: an outage must not multiply the calls. A write the plugin makes to a repository drops its snapshot (`invalidate`), so a read after a write is a fresh one.
//
// THE PLUGIN READS A PULL REQUEST BY NUMBER ONLY HERE, and in the few modules `no-per-pull-reads.test.ts` names with their reasons (row mode's `rows/` aside, which that test holds to a ratchet).
import { SWEEP_MS } from "./call-counter.ts";
import type { AsyncGh } from "./gh.ts";
import { MERGE_BOT_FILE, MERGE_BOT_GATE, readHeadHoldsMergeBotAsync } from "./merge-flow.ts";

/** How long a repository's snapshot is kept, in ms: one sweep. */
export const SNAPSHOT_TTL_MS = SWEEP_MS;

/** How long a repository that could not be read is not asked again, in ms. */
export const FAILURE_TTL_MS = 10_000;

/** How long a repository's snapshot that has run out is still served while the repository cannot be read, in ms: a hiccup of GitHub must not stop every reader of the board, and a repository that stays unreadable is null after this. */
export const STALE_TTL_MS = 3 * SNAPSHOT_TTL_MS;

/** How long a pull request that is no longer open is remembered as read, in ms. */
export const TERMINAL_TTL_MS = 10 * 60_000;

/**
 * How many pull requests one page of the open list holds, and the most pages read. THE PAGE IS SMALL ON PURPOSE: GitHub charges a GraphQL query by the most nodes it could return, and the threads of a pull request's review (`reviewThreads`, each with its comments) are most of it, so a page of 50
 * cost 29 of the hour's 5,000 points measured on 2026-10-28 (a repository with 8 open pull requests) and a page of 10 costs 6. A repository with more open pull requests than the pages hold is read in part, and says so (`complete`).
 */
const PAGE = 10;
export const MAX_PAGES = 20;

/** The most pull requests remembered as no longer open, and head readings of the merge bot kept. */
const REMEMBERED = 500;

/** How much of each list one read takes, newest last: only the newest of each counts, so a long history is not read. */
const LAST = 50;

/** How many of the pull request's newest removals from the merge queue, commits and force-pushes one read takes: the removals since the head last moved are the trailing run of them. */
const QUEUE_WINDOW = 20;

/** The most pages of changed files one read takes: a pull request beyond this many files is read in part, and says so. */
export const MAX_FILE_PAGES = 10;

const AUTHOR = "author { login __typename }";

/** What is asked of each pull request. THE SHAPE `pull-feedback.ts` has always read, with the pull request's own fields (`number`, `url`, `title`, `headRefName`, `isDraft`, `isCrossRepository`, `author`) and the replies' text beside it. */
const PULL_SELECTION = `
  number url state title body isDraft isCrossRepository headRefName headRefOid baseRefName
  ${AUTHOR}
  reviewDecision mergeable mergeStateStatus
  mergeQueueEntry { state }
  autoMergeRequest { enabledAt }
  timelineItems(last: ${QUEUE_WINDOW}, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]) { nodes {
    __typename
    ... on RemovedFromMergeQueueEvent { createdAt reason actor { login } beforeCommit { oid } }
    ... on HeadRefForcePushedEvent { createdAt afterCommit { oid } }
  } }
  files(first: 100) { pageInfo { hasNextPage endCursor } nodes { path } }
  reviews(last: ${LAST}) { nodes { state submittedAt body url ${AUTHOR} commit { oid } } }
  comments(last: ${LAST}) { nodes { createdAt lastEditedAt body url ${AUTHOR} } }
  reviewThreads(last: ${LAST}) { nodes { comments(last: 20) { nodes { createdAt body url ${AUTHOR} } } } }
  baseRef { rules(first: 50) { nodes { type parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } } } } branchProtectionRule { requiredStatusChecks { context } } }
  commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
    __typename
    ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
    ... on StatusContext { context state createdAt targetUrl }
  } } } } } }`;

/** What is asked of the repository itself: whether it is private, and whether its default branch holds the merge bot (`merge-flow.ts`). */
const REPOSITORY_SELECTION = `isPrivate ${MERGE_BOT_FILE}`;

const LIST_QUERY = `query($owner: String!, $repo: String!, $after: String) { repository(owner: $owner, name: $repo) { ${REPOSITORY_SELECTION}
  pullRequests(states: OPEN, first: ${PAGE}, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) { pageInfo { hasNextPage endCursor } nodes {${PULL_SELECTION}
  } }
} }`;

const ONE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { ${REPOSITORY_SELECTION}
  pullRequest(number: $number) {${PULL_SELECTION}
  }
} }`;

/** The page of changed files after `cursor`, read the same way as the first page of a pull request. */
const FILES_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
  files(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { path } }
} } }`;

/** One pull request as GitHub's query answers it (`PULL_SELECTION`), with `isRequired` set on each check of its rollup from the names its base requires. */
export type PullNode = Record<string, any>;

/** Whether a repository is private and holds the merge bot on its default branch: what decides if its flow is the merge bot (`runsMergeBot`). */
export type RepoFlow = Readonly<{ private: boolean; mergeBot: boolean }>;

/** A pull request and the flow of its repository. */
export type PullRead = Readonly<{ node: PullNode; flow: RepoFlow }>;

/** A repository's open pull requests as they were read at `at` (ms). `complete` is false when more were open than the pages read held: the list is then no list of them all. */
export type RepoSnapshot = Readonly<{ repository: string; at: number; complete: boolean; flow: RepoFlow; pulls: ReadonlyMap<number, PullNode> }>;

export type PullSnapshots = Readonly<{
  /** The open pull requests of `repository` (`owner/name`), or null for "could not ask". */
  snapshot(repository: string): Promise<RepoSnapshot | null>;
  /** Pull request `number` of `repository` from the snapshot, else read by number once; null for "could not ask" and for a pull request that is none. */
  pull(repository: string, number: number): Promise<PullRead | null>;
  /** Drops the snapshot of `repository`: the next read of it is a fresh one. Call it after a write to the repository. */
  invalidate(repository: string): void;
  /** Whether the head `head` of pull request `number` holds the merge bot (`merge-flow.ts`): read once per head. */
  headHoldsMergeBot(repository: string, number: number, head: string): Promise<boolean>;
  /** The page of changed files of pull request `number` after `cursor`, as GitHub answers it. REJECTS when it cannot be read. */
  moreFiles(repository: string, number: number, cursor: string): Promise<unknown>;
}>;

/** `ttlMs` is how long a repository's snapshot is kept (`SNAPSHOT_TTL_MS` when absent; the live check of the stacked retarget keeps none, because it reads what it just changed). */
export type PullSnapshotDeps = Readonly<{ gh: AsyncGh; now?: () => number; ttlMs?: number }>;

/** The owner and name of a repository written `owner/name`, or null for any other text. */
function repositoryOf(repository: string): { owner: string; name: string } | null {
  const match = /^([^/\s"\\]+)\/([^/\s"\\]+)$/.exec(repository);
  return match === null ? null : { owner: match[1], name: match[2] };
}

const holds = (file: unknown): boolean => file !== null && typeof file === "object";

/** The names of the checks the base branch requires: those of its rulesets (`REQUIRED_STATUS_CHECKS`) and of its branch protection. */
function requiredNamesOf(baseRef: any): Set<string> {
  const names = new Set<string>();
  for (const rule of baseRef?.rules?.nodes ?? []) {
    if (rule?.type !== "REQUIRED_STATUS_CHECKS") continue;
    for (const check of rule.parameters?.requiredStatusChecks ?? []) if (typeof check?.context === "string") names.add(check.context);
  }
  for (const check of baseRef?.branchProtectionRule?.requiredStatusChecks ?? []) if (typeof check?.context === "string") names.add(check.context);
  return names;
}

/** The checks of the head commit's rollup as the query answers them: the first page of contexts, and whether more follow (the rollup is then not all seen). Absent contexts are an empty page. */
export function rollupOf(node: PullNode): Readonly<{ checks: readonly Record<string, any>[]; cut: boolean }> {
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  return { checks: Array.isArray(contexts?.nodes) ? contexts.nodes : [], cut: contexts?.pageInfo?.hasNextPage === true };
}

/** Sets `isRequired` on each check of `node`'s rollup, true when the base requires the check's name, and answers `node`. It is the only change made to what GitHub answered. */
function markRequired(node: PullNode): PullNode {
  const required = requiredNamesOf(node.baseRef);
  for (const check of rollupOf(node).checks) if (check !== null && typeof check === "object") check.isRequired = required.has(String(check.name ?? check.context ?? ""));
  return node;
}

/**
 * The checks the pull request waits on where GitHub names none: `gate` in a repository whose flow is the merge bot (A11-341), the default branch holding it or, for the pull request that adds it, the head (A11-344, asked of `snapshots` once per head);
 * else none. The head is asked only where the answer can matter: a private repository without the bot on its default branch.
 */
export async function flowGateOf(snapshots: Pick<PullSnapshots, "headHoldsMergeBot">, repository: string, node: PullNode, flow: RepoFlow): Promise<string[]> {
  if (!flow.private) return [];
  return flow.mergeBot || await snapshots.headHoldsMergeBot(repository, node.number, String(node.headRefOid ?? "")) ? [MERGE_BOT_GATE] : [];
}

const isPullNode = (node: unknown): node is PullNode => node !== null && typeof node === "object" && Number.isInteger((node as PullNode).number) && typeof (node as PullNode).state === "string";

/** A map that forgets its oldest entry for a new one past `REMEMBERED`. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > REMEMBERED) map.delete(map.keys().next().value as string);
}

/** What is read of GitHub, through `gh`: a repository's open pull requests, one pull request by its number, and a page of a pull request's changed files. Each answers null (the last rejects) for what GitHub does not say. */
function readsOf(gh: AsyncGh, now: () => number): Readonly<{ repository(repository: string): Promise<RepoSnapshot | null>; one(repository: string, number: number): Promise<PullRead | null>; files(repository: string, number: number, cursor: string): Promise<unknown> }> {
  /** One page of the open list, parsed; rejects on an answer of another shape. */
  async function readPage(parsed: { owner: string; name: string }, after: string | null): Promise<{ flow: RepoFlow; nodes: PullNode[]; next: string | null }> {
    const answer = JSON.parse(await gh(["api", "graphql", "-f", `query=${LIST_QUERY}`, "-f", `owner=${parsed.owner}`, "-f", `repo=${parsed.name}`, ...(after === null ? [] : ["-f", `after=${after}`])]));
    const repository = answer?.data?.repository;
    const list = repository?.pullRequests;
    if (typeof repository?.isPrivate !== "boolean" || !Array.isArray(list?.nodes)) throw new Error("the open pull requests were not in the answer");
    // A page that cannot be read whole is no page: a node dropped or a missing cursor would make the list look complete while pull requests are missing from it.
    if (!list.nodes.every(isPullNode)) throw new Error("a pull request of the open list could not be read");
    return { flow: { private: repository.isPrivate, mergeBot: holds(repository.bot) }, nodes: list.nodes.map(markRequired), next: nextCursorOf(list.pageInfo) };
  }

  return {
    async repository(repository) {
      const parsed = repositoryOf(repository);
      if (parsed === null) return null;
      try {
        const pulls = new Map<number, PullNode>();
        let flow: RepoFlow | null = null;
        let after: string | null = null;
        let complete = false;
        for (let page = 0; page < MAX_PAGES && !complete; page++) {
          const read = await readPage(parsed, after);
          flow = read.flow;
          for (const node of read.nodes) pulls.set(node.number, node);
          complete = read.next === null;
          after = read.next;
        }
        return flow === null ? null : { repository, at: now(), complete, flow, pulls };
      } catch (error) {
        void error; // a repository GitHub will not answer is "could not ask", and the next sweep asks again
        return null;
      }
    },
    async one(repository, number) {
      const parsed = repositoryOf(repository);
      if (parsed === null) return null;
      try {
        const answer = JSON.parse(await gh(["api", "graphql", "-f", `query=${ONE_QUERY}`, "-f", `owner=${parsed.owner}`, "-f", `repo=${parsed.name}`, "-F", `number=${number}`]));
        const repo = answer?.data?.repository;
        const node: unknown = repo?.pullRequest;
        if (!isPullNode(node) || typeof repo.isPrivate !== "boolean") return null;
        return { node: markRequired(node), flow: { private: repo.isPrivate, mergeBot: holds(repo.bot) } };
      } catch (error) {
        void error; // no reading, which the caller reads as "could not ask"
        return null;
      }
    },
    async files(repository, number, cursor) {
      const parsed = repositoryOf(repository);
      if (parsed === null) throw new Error(`${repository} is not owner/name`);
      const answer = JSON.parse(await gh(["api", "graphql", "-f", `query=${FILES_QUERY}`, "-f", `owner=${parsed.owner}`, "-f", `repo=${parsed.name}`, "-F", `number=${number}`, "-f", `cursor=${cursor}`]));
      return answer?.data?.repository?.pullRequest?.files;
    },
  };
}

/** The cursor of the page after this one, or null when `pageInfo` says none follows. THROWS for a `pageInfo` that does not say, or says another page follows and names no cursor to read it by. */
function nextCursorOf(pageInfo: unknown): string | null {
  const { hasNextPage, endCursor } = (pageInfo ?? {}) as { hasNextPage?: unknown; endCursor?: unknown };
  if (typeof hasNextPage !== "boolean") throw new Error("the open list does not say whether another page follows");
  if (!hasNextPage) return null;
  if (typeof endCursor !== "string") throw new Error("the open list has another page and names no cursor for it");
  return endCursor;
}

/** `load`, started once for `key` however many callers ask while it runs: they all get its answer. The entry is let go when it settles, unless a newer one took its place. */
function once<T>(running: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const held = running.get(key);
  if (held !== undefined) return held;
  const reading: Promise<T> = load().finally(() => { if (running.get(key) === reading) running.delete(key); });
  running.set(key, reading);
  return reading;
}

/** Whether a head holds the merge bot, read once for a head that does (it always does) and again after a sweep for one that does not (that may be a reading that failed). */
function headBotReader(gh: AsyncGh, now: () => number): PullSnapshots["headHoldsMergeBot"] {
  const heads = new Map<string, { holds: boolean; until: number }>();
  return async (repository, number, head) => {
    const key = `${repository}#${number}@${head}`;
    const kept = heads.get(key);
    if (kept !== undefined && now() < kept.until) return kept.holds;
    const holdsBot = await readHeadHoldsMergeBotAsync(repository, number, gh);
    remember(heads, key, { holds: holdsBot, until: holdsBot ? Number.POSITIVE_INFINITY : now() + SNAPSHOT_TTL_MS });
    return holdsBot;
  };
}

/**
 * The snapshots of a plugin's repositories, read through `gh`. A read in flight is shared: callers that ask for a repository while it is being read wait for that one read, and a write that drops a repository while its read is in
 * flight keeps that read from being kept, so what is kept was always read after the last write.
 */
export function createPullSnapshots({ gh, now = Date.now, ttlMs = SNAPSHOT_TTL_MS }: PullSnapshotDeps): PullSnapshots {
  type Entry = { snapshot: RepoSnapshot; opened: Map<number, PullNode>; expires: number };
  const reads = readsOf(gh, now);
  const entries = new Map<string, Entry>();
  const loading = new Map<string, Promise<Entry | null>>();
  const oneLoading = new Map<string, Promise<PullRead | null>>();
  const dropped = new Map<string, number>();
  const failedUntil = new Map<string, number>();
  const notOpen = new Map<string, { read: PullRead; until: number }>();
  const headHolds = headBotReader(gh, now);

  /** The snapshot that has run out, while it is still young enough to serve a repository that cannot be read; none after that. */
  function staleOf(repository: string, kept: Entry | undefined): Entry | null {
    if (kept !== undefined && now() < kept.snapshot.at + STALE_TTL_MS) return kept;
    entries.delete(repository);
    return null;
  }
  /** Reads `repository` and keeps what was read, unless a write dropped the repository meanwhile. */
  async function load(repository: string, kept: Entry | undefined): Promise<Entry | null> {
    const generation = dropped.get(repository) ?? 0;
    const snapshot = await reads.repository(repository);
    const written = (dropped.get(repository) ?? 0) !== generation;
    if (snapshot === null) {
      if (!written) failedUntil.set(repository, now() + FAILURE_TTL_MS);
      return staleOf(repository, written ? undefined : kept);
    }
    const entry = { snapshot, opened: new Map<number, PullNode>(), expires: snapshot.at + ttlMs };
    if (!written) entries.set(repository, entry);
    return entry;
  }
  async function entryOf(repository: string): Promise<Entry | null> {
    const kept = entries.get(repository);
    if (kept !== undefined && now() < kept.expires) return kept;
    const until = failedUntil.get(repository);
    if (until !== undefined && now() < until) return staleOf(repository, kept);
    failedUntil.delete(repository);
    return once(loading, repository, () => load(repository, kept));
  }
  /** The pull request by its number, once for the callers that ask while it is read. */
  function oneOf(repository: string, number: number): Promise<PullRead | null> {
    return once(oneLoading, `${repository}#${number}`, () => reads.one(repository, number));
  }
  return {
    snapshot: async (repository) => (await entryOf(repository))?.snapshot ?? null,
    async pull(repository, number) {
      const entry = await entryOf(repository);
      if (entry === null) return null;
      const listed = entry.snapshot.pulls.get(number) ?? entry.opened.get(number);
      if (listed !== undefined) return { node: listed, flow: entry.snapshot.flow };
      const key = `${repository}#${number}`;
      const remembered = notOpen.get(key);
      if (remembered !== undefined && now() < remembered.until) return remembered.read;
      const read = await oneOf(repository, number);
      if (read === null) return null;
      if (read.node.state === "OPEN") entry.opened.set(number, read.node);
      else remember(notOpen, key, { read, until: now() + TERMINAL_TTL_MS });
      return read;
    },
    invalidate(repository) {
      entries.delete(repository);
      failedUntil.delete(repository);
      loading.delete(repository);
      dropped.set(repository, (dropped.get(repository) ?? 0) + 1);
    },
    headHoldsMergeBot: headHolds,
    moreFiles: reads.files,
  };
}
