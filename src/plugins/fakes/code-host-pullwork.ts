// @ts-check
// module: the in-memory code host's operations for the pullwork section (A11-160, step 9)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. The pull requests are the world's (their labels, whether auto-merge is armed, their branch and the rows they
// close), the rows are the world's (a row's body, labels and comments, in this repository or another's), and the section adds the few things a pull request does not hold: the login the next one is authored as, the
// labels a repository has, and the commit a branch is at. The four builders answer a fake argument list that names the step and the facts it was asked for (a fake has no `gh`), so a test of the caller sees the order of
// the steps and what each was about; what the real argument lists are is the plugin's test.
import type { RowsPullwork } from "../contracts/code-host-rows-pullwork.ts";
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowPull, FakeRowsWorld } from "./code-host-rows.ts";

/** What a test seeds for this section beyond the world's rows and pull requests. */
export type FakePullwork = {
  /** The login the next pull request is authored as, or `null` when no read can say; then `loginFailures` are the reasons. */
  login: string | null;
  loginFailures: string[];
  /** The labels the repository holds; `null` is a repository that holds every label asked of it. */
  repoLabels: Set<string> | null;
  /** The commit a branch of a repository is at, by `<repo>:<branch>`; a branch not here is one the repository does not hold. */
  branches: Map<string, string>;
  /** The pages of the pull requests' head refs whose answer is not a list of refs, by page number, with the words the caller refuses in. */
  unreadablePages: Map<number, string>;
  /** Called with the line a write is noted under (`commentOnCheckoutPull #10`) before the write is made: a test throws from it to refuse that one write and not another. */
  onWrite: ((line: string) => void) | null;
  /** Pull requests GitHub lists as closing a row (`<repo>#<row>`) that the fake holds none of, so a read of one is `null`: a closing pull request the caller cannot read. */
  closingUnread?: Map<string, { number: number; repo: string }[]>;
};

export const emptyPullwork = (): FakePullwork => ({ login: null, loginFailures: ["`gh api user`: the fake was given no login"], repoLabels: null, branches: new Map(), unreadablePages: new Map(), onWrite: null });

const iso = (world: FakeRowsWorld): string => new Date(world.now()).toISOString();

const pullOf = (world: FakeRowsWorld, number: number): FakeRowPull => {
  const pull = world.pulls.get(number);
  if (pull === undefined) throw new Error(`the fake holds no pull request #${number}`);
  return pull;
};

const rowIn = (world: FakeRowsWorld, repo: string, number: number): FakeRow => {
  const row = repo === world.repo ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`);
  if (row === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
  return row;
};

const isOpen = (pull: FakeRowPull): boolean => !pull.merged && (pull.closedAt ?? null) === null;

const stateOfPull = (pull: FakeRowPull): string => (pull.merged ? "MERGED" : isOpen(pull) ? "OPEN" : "CLOSED");

const noted = <T>(world: FakeRowsWorld, line: string, act: () => T): T => {
  world.tail.pullwork.onWrite?.(line);
  world.calls.push(line);
  return act();
};

type Builders = Pick<RowsPullwork, "pullWriteArgs" | "armArgsAfterCreate" | "labelArgsAfterCreate" | "labelCreateArgs">;

const builders = (): Builders => ({
  pullWriteArgs: (mode, rest) => ["fake-pull-write", mode, ...rest],
  armArgsAfterCreate: ({ rest, branch }) => [["fake-arm", branch ?? "", ...rest]],
  labelArgsAfterCreate: ({ rest, branch, label }) => [["fake-label", label, branch ?? "", ...rest]],
  labelCreateArgs: ({ name, description, repo }) => ["fake-label-create", name, description, repo ?? ""],
});

/** The reads `pr-open` makes of the repository and of the row a pull request names. */
function openReads(world: FakeRowsWorld): Pick<RowsPullwork, "labelExistsForOpening" | "pullHeadForOpening" | "rowBodyForOpening" | "branchHeadForOpening" | "authoringLoginOf"> {
  const pullwork = () => world.tail.pullwork;
  return {
    labelExistsForOpening: ({ name }) => {
      const held = pullwork().repoLabels;
      return held === null || held.has(name);
    },
    pullHeadForOpening: ({ number }) => {
      const pull = pullOf(world, Number(number));
      return { ref: pull.headRefName, oid: pull.headRefOid ?? "" };
    },
    rowBodyForOpening: ({ repo, number }) => rowIn(world, repo, number).body,
    branchHeadForOpening: ({ repo, branch }) => pullwork().branches.get(`${repo}:${branch}`) ?? null,
    authoringLoginOf: () => {
      const { login, loginFailures } = pullwork();
      return login === null ? { failures: [...loginFailures] } : { login };
    },
  };
}

/** The reads and writes `pr-hold` makes of a pull request's labels, its auto-merge and the row a hold waits on. */
function holdOperations(world: FakeRowsWorld): Pick<RowsPullwork, "heldPullLabelsOf" | "editHeldPullLabel" | "autoMergeOfHeldPull" | "autoMergeRequestOfHeldPull" | "armHeldPull" | "disarmHeldPull" | "holdTargetRowOf"> {
  const pullwork = () => world.tail.pullwork;
  const autoMergeRequest = (pull: FakeRowPull) => (pull.armed ? { enabledAt: iso(world) } : null);
  return {
    heldPullLabelsOf: ({ number }) => world.pulls.get(number)?.labels.slice() ?? null,
    editHeldPullLabel: ({ number, label, how, createdWith }) => noted(world, `editHeldPullLabel #${number} ${how} ${label}`, () => {
      const pull = pullOf(world, number);
      if (how === "remove") {
        pull.labels = pull.labels.filter((held) => held !== label);
        return;
      }
      const held = pullwork().repoLabels;
      if (held !== null && !held.has(label)) {
        if (createdWith === undefined) throw new Error(`'${label}' not found`);
        held.add(label);
      }
      if (!pull.labels.includes(label)) pull.labels.push(label);
    }),
    autoMergeOfHeldPull: ({ number }) => {
      const pull = world.pulls.get(number);
      return pull === undefined ? null : { autoMergeRequest: autoMergeRequest(pull), state: stateOfPull(pull) };
    },
    autoMergeRequestOfHeldPull: ({ number }) => ({ autoMergeRequest: autoMergeRequest(pullOf(world, number)) }),
    armHeldPull: ({ number }) => noted(world, `armHeldPull #${number}`, () => {
      const pull = pullOf(world, number);
      if (pull.armRefusal != null) throw new Error(pull.armRefusal);
      if (pull.armTakes !== false) pull.armed = true;
    }),
    disarmHeldPull: ({ number }) => noted(world, `disarmHeldPull #${number}`, () => { pullOf(world, number).armed = false; }),
    holdTargetRowOf: ({ repo, number }) => {
      const row = repo === world.repo ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`);
      if (row === undefined) return null;
      const closing = [...world.pulls.values()].filter((pull) => isOpen(pull) && (pull.closes ?? []).some((closes) => closes.number === number && (closes.repo ?? world.repo) === repo));
      const openPullRequests = [...closing.map((pull) => ({ number: pull.number, repo: world.repo })), ...(world.tail.pullwork.closingUnread?.get(`${repo}#${number}`) ?? [])];
      return { state: row.state === "OPEN" ? "open" : "closed", labels: [...row.labels], openPullRequests,
        row: { number, state: row.state, body: row.body, labels: row.labels.map((name) => ({ name })), comments: row.comments.map(({ body, createdAt }) => ({ body, createdAt })),
          closedByPullRequestsReferences: closing.map((pull) => ({ number: pull.number, repository: { name: world.repo.split("/")[1], owner: { login: world.repo.split("/")[0] } } })) } };
    },
  };
}

/** The pull request listings the branch tools and the `Stop` hook read, and the sweep's two writes. */
function listingOperations(world: FakeRowsWorld): Pick<RowsPullwork, "openPullNumberOfBranch" | "pullHeadRefsPageOf" | "openPullsForSweep" | "commentOnCheckoutPull" | "closeCheckoutPull" | "pullsListedForStop"> {
  const byCreation = () => [...world.pulls.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
  return {
    openPullNumberOfBranch: ({ branch }) => byCreation().find((pull) => isOpen(pull) && pull.headRefName === branch)?.number ?? null,
    pullHeadRefsPageOf: ({ page, pageSize }) => {
      const unreadable = world.tail.pullwork.unreadablePages.get(page);
      return unreadable !== undefined ? { unreadable } : { refs: byCreation().slice((page - 1) * pageSize, page * pageSize).map((pull) => pull.headRefName) };
    },
    openPullsForSweep: ({ limit }) => byCreation().filter(isOpen).slice(0, limit)
      .map((pull) => ({ number: pull.number, headRefName: pull.headRefName, createdAt: pull.createdAt, isDraft: pull.isDraft, labels: pull.labels.map((name) => ({ name })), mergeStateStatus: pull.mergeStateStatus ?? "CLEAN" })),
    commentOnCheckoutPull: ({ number, body }) => noted(world, `commentOnCheckoutPull #${number}`, () => { pullOf(world, number).comments.push(body); }),
    closeCheckoutPull: ({ number }) => noted(world, `closeCheckoutPull #${number}`, () => { pullOf(world, number).closedAt = iso(world); }),
    pullsListedForStop: ({ limit }) => byCreation().slice(0, limit)
      .map((pull) => ({ number: pull.number, state: stateOfPull(pull), headRefName: pull.headRefName, title: pull.title ?? "", labels: pull.labels.map((name) => ({ name })), body: pull.body })),
  };
}

export function pullworkOperations(world: FakeRowsWorld): Pick<CodeHostRows, keyof RowsPullwork> {
  return {
    ...builders(), ...openReads(world), ...holdOperations(world), ...listingOperations(world),
  };
}
