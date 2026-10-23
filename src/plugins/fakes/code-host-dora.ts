// @ts-check
// module: the in-memory code host's operations for the DORA reader (A11-160, step 8)
//
// THEY ACT ON THE FACTS A TEST SEEDS in `world.reports.dora` and ignore the `run` the reader hands them: the commits a tag names, the releases of a repository, whether issues are enabled, the pages of a comparison and the merge
// of a pull request. A repository or a ref the world holds nothing for is a refused read, never an empty one: "could not ask" is not "no release".
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRowsWorld } from "./code-host-rows.ts";

/** What the DORA reader reads of the world. */
export type FakeDora = {
  /** The commit a ref names, by `repo@ref`: its sha and its parents' shas. */
  commits: Map<string, { sha: string; parents: string[] }>;
  /** The releases of a repository, as GitHub states them (`tag_name`, `published_at`, `draft`, `body`). */
  releases: Map<string, any[]>;
  /** Whether a repository has issues enabled; absent is enabled. */
  issuesEnabled: Map<string, boolean>;
  /** The pages of a comparison, by `repo@base...head`. */
  ranges: Map<string, any[]>;
  /** The merge commit and merge time of a pull request, by `repo#number`. */
  merges: Map<string, { mergeCommit: { oid: string } | null; mergedAt: string | null }>;
  /** Repositories whose every read is refused, with the refusal (a `gh` that hung or failed for that repository only). */
  unreadable: Map<string, Error>;
};

export const emptyDora = (): FakeDora => ({ commits: new Map(), releases: new Map(), issuesEnabled: new Map(), ranges: new Map(), merges: new Map(), unreadable: new Map() });

const seeded = <T>(held: T | undefined, what: string): T => {
  if (held === undefined) throw new Error(`the fake holds no ${what}`);
  return held;
};

type Operations = Pick<CodeHostRows, "commitAndParentsTextOf" | "releasesOf" | "hasIssuesEnabled" | "compareRangeOf" | "pullMergeOf">;

export function doraOperations(world: FakeRowsWorld): Operations {
  const dora = world.reports.dora;
  /** A repository the world marks unreadable refuses every read, before it answers anything. */
  const readable = (repo: string): void => {
    const refusal = dora.unreadable.get(repo);
    if (refusal !== undefined) throw refusal;
  };
  return {
    commitAndParentsTextOf: ({ repo, ref }) => {
      readable(repo);
      const commit = seeded(dora.commits.get(`${repo}@${ref}`), `commit ${repo}@${ref}`);
      return `${commit.sha} ${commit.parents.join(",")}\n`;
    },
    releasesOf: ({ repo }) => (readable(repo), structuredClone(seeded(dora.releases.get(repo), `releases of ${repo}`))),
    hasIssuesEnabled: ({ repo }) => (readable(repo), dora.issuesEnabled.get(repo) ?? true),
    compareRangeOf: ({ repo, base, head }) => (readable(repo), structuredClone(seeded(dora.ranges.get(`${repo}@${base}...${head}`), `comparison ${repo}@${base}...${head}`))),
    pullMergeOf: ({ repo, number }) => (readable(repo), structuredClone(seeded(dora.merges.get(`${repo}#${number}`), `merge of ${repo}#${number}`))),
  };
}
