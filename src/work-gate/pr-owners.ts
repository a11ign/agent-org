// module: who owns a pull request -- the owner each of the gate's PR orders is addressed to (#2898)
//
// MOVED OUT OF `work-gate.ts`, NOT REWRITTEN (#2898, the third split of #928's lever 2a): the three rungs that name a
// PR's owner (the row it closes, the session its branch names, the worktree stamp), the ended-label sweep that runs
// before them, and the `git worktree` read the last one needs. Measured on #2898: five rows waited behind two pull
// requests whose only edits were to exactly these definitions.
//
// THE BOUNDARY, as `work-gate/pr-orders.ts` states it: what only the owner rungs use lives here; the session
// vocabulary shared with the answer and claim families (`liveWorkspaceLabels`, `endedSessionLabels`, `defaultSpawn`)
// stays in `work-gate.ts` and is IMPORTED from it, the cycle that module documents, safe while nothing here reads an
// imported binding at load time. THE `git worktree` READ STAYED (`readWorktreeStamps`, `stampLookup`): a function that
// reads git or gh stays in the shim (`pr-orders.ts`'s boundary), and `git-spawn-classification.test.ts` refuses a file
// that spawns git without the scrubbing helper `defaultSpawn` already carries. `work-gate.ts` re-exports every name this file exports that it exported before.
import { labelsOf, sessionOf, liveWorkspaceLabels, endedSessionLabels } from "../work-gate.ts";
import { CLAIM_LABEL } from "../claim-labels.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";
import { ownerOfPr } from "./pr-orders.ts";

/**
 * #2882: THE SESSION A PULL REQUEST'S OWN ROW NAMES, for a pull request that carries no `session:` label.
 *
 * `pr:open` stamps the label from the worktree's `.a11y-owner`, and #2880 was opened 43 minutes before its tree was
 * stamped -- so it was unlabelled while row #2875 carried `session:worker-2875`, and `pr-checks-failing` went to
 * `product-manager` six times for a PR whose owner was on disk. The rows are already in hand (`readOpenRows`), so
 * this costs no call.
 *
 * EXACTLY ONE LIVE SESSION, OR NOTHING. A row is LIVE when it still holds its claim (`in-progress` beside a `session:`
 * label, the pair `anyBlockerClearingCandidate` reads), so a released claim names nobody. `isLiveSession` is NOT asked:
 * a retired session is excluded only because its claim is gone. Two different
 * sessions across the rows a PR closes is a question rather than an answer. A PR whose rows were not read (`openRows`
 * empty because the read was refused) matches nothing and is left exactly as it was. A PR with its OWN label is never
 * touched: the row never outranks it. #2928: when the closing rows name NOBODY, the row its branch `agent/<slug>-<n>` was
 * claimed for is asked (`branchRowOwner`); a closing-row split stays a split, because the suffix does not break that tie.
 * #4386: WIRED FOR EVERY SCOPE THE GATE WATCHES, and what makes that safe is `rowsRepo`, the repository the `openRows` live in. Without
 * it (the default scope, whose pull requests and rows share a repository) a PR's `Closes #n` is read as it always was. With it, a
 * pull request of ANOTHER repository (`pr.repo`, which the scope's reader stamps) is read only by what names `rowsRepo` out loud: a
 * `closingIssuesReferences` entry whose repository it is, and the `Closes`/`Fixes`/`Resolves`/`Row:` lines of its body written
 * `<owner/repo>#<n>`. A bare `#n` there is that pull request's OWN repository's issue and matches nothing, which is the
 * wrong-tracker match the header used to name as the reason for not wiring it.
 *
 *   @param [rowsRepo] the repository `openRows` are rows of; absent means the pull requests' own
 */
export function withClosingRowOwners(prs: any[], openRows: any[], rowsRepo?: string) {
  const held = heldRows(openRows);
  return prs.map((pr) => {
    if (labelStands(pr)) return pr;
    const closing = closingRowOwner(pr, held, rowsRepo);
    if (closing === "split") return pr;
    const owner = closing ?? branchRowOwner(pr, held);
    return owner ? { ...pr, rowOwner: owner } : pr;
  });
}

/**
 * #2941: THE REST OF `ownerOfPr`'S LADDER -- the two rungs below the rows, put on each pull request that nothing above has
 * answered. `withClosingRowOwners` is rung 2 and 3; this is 4 (a live session the HEAD REF names) and 5 (a live session that
 * STAMPED the worktree the branch is checked out in). Runs AFTER it, and touches only a PR with no label and no `rowOwner`, so a
 * higher rung is never outranked and a PR with its own label is not even looked up.
 *
 * LIVE IS #2912's TEST, AND ITS LIMIT IS KEPT: a session that still holds a claim on an open row. `isLiveSession` is not asked
 * (#2174: the gate loads without `.agent-org/roles`), so a live session holding no claim is not named, and the PR falls to
 * `ceo`. The stamp rung is paid for only when a PR reaches it: `stampOf` is a function precisely so the `git worktree list` it
 * costs is made lazily, at most once, and not at all on a tick where every PR already has an owner.
 */
export function withNamedOwners(prs: any[], openRows: any[], stampOf: (branch: string) => string | null = () => null) {
  const live = new Set(openRows.filter((row) => labelsOf(row).includes(CLAIM_LABEL) && sessionOf(row)).map((row) => String(sessionOf(row))));
  return prs.map((pr) => {
    if (labelStands(pr) || pr.rowOwner) return pr;
    const named = sessionNamedByBranch(pr.headRefName, live);
    if (named) return { ...pr, branchOwner: { session: named } };
    const stamped = stampOf(String(pr.headRefName ?? ""));
    return stamped && live.has(stamped) ? { ...pr, stampOwner: { session: stamped } } : pr;
  });
}

/**
 * #4386: THE SAME LADDER FOR A PULL REQUEST OF ANOTHER REPOSITORY than its rows (agent-org's, whose rows are the product repository's).
 * The stamp rung is not asked: `git worktree list` reads THIS checkout, and a keyed scope's trees are not in it.
 *  @param openRows the rows of `rowsRepo`
 * @param scope `io` as `withPrOwners` reads it
 */
export function withScopedPrOwners(prs: any[], openRows: any[], { rowsRepo, io = null }: { rowsRepo: string; io?: Parameters<typeof withEndedLabels>[1] | null; }) {
  return withNamedOwners(withClosingRowOwners(io ? withEndedLabels(prs, io) : prs, openRows, rowsRepo), openRows);
}

/**
 * THE WHOLE LADDER BELOW A PR'S OWN LABEL (a label naming an ENDED session is not one, #3093), in the one order `main` and the test share, so neither can drift from the other.
 *
 * @param [io] where `withEndedLabels` reads herdr and the ending ledgers (#3093). ABSENT
 *        MEANS NOT ASKED, on purpose: a caller that names no source must not be answered by this host's herdr and ledgers, so `main`
 *        passes the live ones and every other caller stays pure.
 */
export function withPrOwners(prs: any[], openRows: any[], stampOf?: (branch: string) => string | null, io: Parameters<typeof withEndedLabels>[1] | null = null) {
  return withNamedOwners(withClosingRowOwners(io ? withEndedLabels(prs, io) : prs, openRows), openRows, stampOf);
}

/**
 * Whether the PR's own `session:` label is one the ladder must honour: it carries one and `withEndedLabels` did not find it dead.
 */
function labelStands(pr: any) {
  return Boolean(sessionOf(pr)) && !pr.labelEnded;
}

/**
 * #3093: `labelEnded` ON A PULL REQUEST WHOSE `session:` LABEL NAMES A SESSION THAT HAS ENDED, so `ownerOfPr` reads the PR as
 * unlabelled and falls to a lower rung, ending at `ceo`, which can re-lane. Without it the label rung ("never outranked") ordered
 * the PR to the dead seat on every tick: four agent-org PRs, 60 `UNDELIVERED` lines for #55 in three hours.
 *
 * THE TEST IS #2609's, UNCHANGED, because it is the same reading (see `withoutEndedAnswerSessions`): absent from a COMPLETE herdr
 * listing AND recorded by a teardown. Absent WITHOUT a record keeps the label (`reviewer-<n>` is started after its order can
 * exist), and a herdr that does not answer or a ledger that cannot be read classifies NOTHING. Neither source is asked unless a
 * pull request carries a `session:` label at all, so a quiet tick pays nothing. Only the label is read: a PR's other facts stay.
 */
export function withEndedLabels(prs: any[], { agents = liveWorkspaceLabels, ended = endedSessionLabels,
  say = (line) => process.stderr.write(line) }: { agents?: () => string[] | null; ended?: () => Map<string, number>; say?: (line: string) => void; } = {}): any[] {
  if (!prs.some((pr) => sessionOf(pr))) return prs;
  const live = agents();
  if (live === null) {
    say(`NOTE: herdr did not answer, so no pull request's \`${SESSION_PREFIX}\` label was classed as ended this tick -- every one still orders (#3093).\n`);
    return prs;
  }
  let gone;
  try {
    gone = ended();
  } catch (err) {
    say(`NOTE: the ended-session ledgers could not be read (${String((err as any)?.message ?? err).split("\n")[0]}) -- no pull request's \`${SESSION_PREFIX}\` label was classed as ended this tick (#3093).\n`);
    return prs;
  }
  return prs.map((pr) => {
    const label = sessionOf(pr);
    return label && label !== "engineers" && !live.includes(label) && gone.has(label) ? { ...pr, labelEnded: true } : pr;
  });
}

/**
 * The live session a head ref NAMES: `agent/<session>` whole, or a `worker-<n>` token anywhere in it. `null` when it names no
 * live one. Two live ones in one ref name the first -- the ref is the author's, and a ref naming two sessions is a rename.
 */
function sessionNamedByBranch(headRef: unknown, live: Set<string>) {
  const ref = String(headRef ?? "");
  const whole = /^agent\/(.+)$/.exec(ref)?.[1];
  if (whole && live.has(whole)) return whole;
  return (ref.match(/worker-\d+/g) ?? []).find((token) => live.has(token)) ?? null;
}

/**
 * The live session the rows a PR CLOSES name: that session, `null` for none, `"split"` for two different ones. "Closes" is
 * every row it states (#4386): GitHub's own resolution and the body's `Row:` line are the same claim, so two different
 * claimants across them are a split, never a pick.
 */
function closingRowOwner(pr: any, held: Map<number, { session: string; row: number; }>, rowsRepo?: string) {
  const owners = rowsNamedBy(pr, rowsRepo).filter(({ via }) => via !== "branch")
    .map(({ row }) => held.get(row)).filter((owner: any) => owner !== undefined);
  const sessions = new Set(owners.map((owner: any) => owner.session));
  if (sessions.size > 1) return "split";
  return sessions.size === 1 ? { ...owners[0], source: "closing" } : null;
}

/** The sessions that hold a claim, by the row they hold: `in-progress` beside a `session:` label. */
const heldRows = (openRows: any[]) => new Map(openRows.filter((row) => labelsOf(row).includes(CLAIM_LABEL) && sessionOf(row))
  .map((row) => [Number(row.number), { session: String(sessionOf(row)), row: Number(row.number) }]));

/** The repository a `closingIssuesReferences` entry belongs to, as `owner/name`, or `undefined` when the entry does not say. */
function repoOfReference(ref: any) {
  const repository = ref?.repository;
  if (typeof repository?.nameWithOwner === "string") return repository.nameWithOwner;
  return repository?.owner?.login && repository?.name ? `${repository.owner.login}/${repository.name}` : undefined;
}

/** A body line that STATES a row, whatever it is called: `Closes`, `Fixes`, `Resolves` or the `Row:` form agent-org#436 used (#4386). */
const STATED_ROW_LINE = /^[ \t]*(?:[-*][ \t]+)?\*{0,2}(?:closes|fixes|resolves|row)\b[^\n]*/gim;
/** One reference inside it: `owner/repo#n`, or a bare `#n`. */
const REFERENCE = /(?:([\w.-]+\/[\w.-]+))?#(\d+)/g;

/**
 * EVERY ROW A PULL REQUEST NAMES, once each, and how: GitHub's resolution (`closing`), a stated line of the body (`stated`),
 * and, last, the number its branch `agent/<slug>-<n>` ends in (`branch`) -- which names a row of the DEFAULT tracker by the
 * claim's own convention, whatever repository the pull request is in. With `rowsRepo`, a reference counts only when it names that
 * repository; a bare one counts only for a pull request of that repository itself (see `withClosingRowOwners`).
 */
function rowsNamedBy(pr: any, rowsRepo?: string): { row: number; via: "closing" | "stated" | "branch"; }[] {
  const closing = (Array.isArray(pr?.closingIssuesReferences) ? pr.closingIssuesReferences : [])
    .filter((ref: any) => rowsRepo === undefined || (repoOfReference(ref) ?? pr?.repo) === rowsRepo)
    .map((ref: any) => ({ row: Number(ref?.number), via: ("closing" as const) }));
  const stated = rowsRepo === undefined ? [] : String(pr?.body ?? "").match(STATED_ROW_LINE)?.flatMap((line) =>
    [...line.matchAll(REFERENCE)].filter((m) => (m[1] === undefined ? pr?.repo === rowsRepo : m[1] === rowsRepo))
      .map((m) => ({ row: Number(m[2]), via: ("stated" as const) }))) ?? [];
  const suffix = /^agent\/.+-(\d+)$/.exec(String(pr?.headRefName ?? ""));
  return [...closing, ...stated, ...(suffix ? [{ row: Number(suffix[1]), via: ("branch" as const) }] : [])];
}

/**
 * #2928: the live session holding the row a PR's BRANCH was claimed for, or `null`. `row-claim claim <n>
 * --branch=agent/<slug>-<n>` writes the trailing number, so it names the row even when the PR says `Closes: none`
 * because the done-when belongs to someone else. The last authority: a PR that closes rows is answered by them.
 */
function branchRowOwner(pr: any, held: Map<number, { session: string; row: number; }>) {
  const suffix = /^agent\/.+-(\d+)$/.exec(String(pr.headRefName ?? ""));
  const owner = suffix ? held.get(Number(suffix[1])) : undefined;
  return owner ? { ...owner, source: "branch" } : null;
}

export type ResolverDefect = { repo: string, number: number, session: string, row: number, via: "closing" | "stated" | "branch" };

/**
 * #4386: A PULL REQUEST THAT REACHED `ceo`'S RUNG WHILE IT NAMES A LIVE CLAIMANT IS A RESOLVER DEFECT, EVERY TIME. Pure, driven by the
 * PR object after the ladder has run. `NOBODY COULD BE NAMED` is the honest answer for a PR that names nobody (a branch `fix-typo`, a
 * row nobody holds) and a false one for a PR whose branch ends in `-4371` while `worker-4371` holds #4371: agent-org#436 and #437 were
 * that, 8 minutes apart, and each ended as a hand route by `ceo` that read as done once routed.
 *
 * ONE CLAIMANT, OR NOTHING. Two different sessions across the lines are a question the ladder rightly leaves unanswered (see
 * `closingRowOwner`), so they are not flagged: the defect is a name the ladder could have used, not one it was right to refuse.
 * `null` for a PR the ladder answered, for one naming no live claim, and for one naming two.
 *
 * @param pr a pull request AFTER `withPrOwners`/`withScopedPrOwners`  @param [rowsRepo] as `withClosingRowOwners`
 */
export function resolverDefectOf(pr: any, openRows: any[], rowsRepo?: string): ResolverDefect | null {
  if (ownerOfPr(pr).source !== "ceo") return null;
  const held = heldRows(openRows);
  const claimants = rowsNamedBy(pr, rowsRepo).flatMap(({ row, via }) => {
    const claim = held.get(row);
    return claim ? [{ ...claim, via }] : [];
  });
  if (new Set(claimants.map((claimant) => claimant.session)).size !== 1) return null;
  const [{ session, row, via }] = claimants;
  return { repo: String(pr?.repo ?? ""), number: Number(pr?.number), session, row, via };
}

/**
 * The defects of a whole list, one per pull request.
 */
export function resolverDefectsOf(prs: any[], openRows: any[], rowsRepo?: string): ResolverDefect[] {
  return prs.flatMap((pr) => resolverDefectOf(pr, openRows, rowsRepo) ?? []);
}

/** The label the class row carries, and the key a defect is remembered by. */
export const RESOLVER_DEFECT_LABEL = "resolver-defect";
export const resolverDefectKey = ({ repo, number }: ResolverDefect) => `${repo === "" ? "(primary)" : repo}#${number}`;

/**
 * What the gate writes on the class row for ONE defect: the title of a row it has to file, and the comment for every PR after the first.
 */
export function resolverDefectText(defect: ResolverDefect): { title: string; comment: string; } {
  const via = { closing: "a row it closes", stated: "a `Closes`/`Row:` line of its body", branch: "the row number its branch ends in" }[defect.via];
  const fixture = resolverDefectKey(defect);
  return {
    title: `resolver-defect: a pull request the gate could not own although it names ${defect.session} (first fixture ${fixture})`,
    comment: `Fixture \`${fixture}\`: the gate ordered \`ceo\` (NOBODY COULD BE NAMED) while ${via} names row #${defect.row}, held by live \`${defect.session}\`. `
      + "The ladder (`withPrOwners` / `withScopedPrOwners`) should have answered it; find which rung did not read what the PR carries, and fix THAT, not this one PR. "
      + "Filed by the gate once per pull request (`work-gate.ts` `fileResolverDefects`, #4386).",
  };
}
