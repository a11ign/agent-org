// @ts-check
// module: who owns a pull request -- the owner each of the gate's PR orders is addressed to (#2898)
//
// MOVED OUT OF `work-gate.ts`, NOT REWRITTEN (#2898, the third split of #928's lever 2a): the three rungs that name a
// PR's owner (the row it closes, the session its branch names, the worktree stamp), the ended-label sweep that runs
// before them, and the `git worktree` read the last one needs. Measured on #2898: five rows waited behind two pull
// requests whose only edits were to exactly these definitions.
//
// THE BOUNDARY, as `work-gate/pr-orders.mjs` states it: what only the owner rungs use lives here; the session
// vocabulary shared with the answer and claim families (`liveWorkspaceLabels`, `endedSessionLabels`, `defaultSpawn`)
// stays in `work-gate.ts` and is IMPORTED from it, the cycle that module documents, safe while nothing here reads an
// imported binding at load time. THE `git worktree` READ STAYED (`readWorktreeStamps`, `stampLookup`): a function that
// reads git or gh stays in the shim (`pr-orders.mjs`'s boundary), and `git-spawn-classification.test.ts` refuses a file
// that spawns git without the scrubbing helper `defaultSpawn` already carries. `work-gate.ts` re-exports every name this file exports that it exported before.
import { labelsOf, sessionOf, liveWorkspaceLabels, endedSessionLabels } from "../work-gate.ts";
import { CLAIM_LABEL } from "../claim-labels.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";

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
 * Wired for the default scope only -- a scope whose pull requests live in another
 * repository than its rows would match a PR's `Closes #n` against the wrong tracker's numbers.
 *
 * @param {any[]} prs @param {any[]} openRows
 */
export function withClosingRowOwners(prs, openRows) {
  const held = new Map(openRows.filter((row) => labelsOf(row).includes(CLAIM_LABEL) && sessionOf(row))
    .map((row) => [Number(row.number), { session: String(sessionOf(row)), row: Number(row.number) }]));
  return prs.map((pr) => {
    if (labelStands(pr)) return pr;
    const closing = closingRowOwner(pr, held);
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
 *
 * @param {any[]} prs @param {any[]} openRows @param {(branch: string) => string | null} [stampOf]
 */
export function withNamedOwners(prs, openRows, stampOf = () => null) {
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
 * THE WHOLE LADDER BELOW A PR'S OWN LABEL (a label naming an ENDED session is not one, #3093), in the one order `main` and the test share, so neither can drift from the other.
 * @param {any[]} prs @param {any[]} openRows @param {(branch: string) => string | null} [stampOf]
 * @param {Parameters<typeof withEndedLabels>[1] | null} [io] where `withEndedLabels` reads herdr and the ending ledgers (#3093). ABSENT
 *        MEANS NOT ASKED, on purpose: a caller that names no source must not be answered by this host's herdr and ledgers, so `main`
 *        passes the live ones and every other caller stays pure.
 */
export function withPrOwners(prs, openRows, stampOf, io = null) {
  return withNamedOwners(withClosingRowOwners(io ? withEndedLabels(prs, io) : prs, openRows), openRows, stampOf);
}

/**
 * Whether the PR's own `session:` label is one the ladder must honour: it carries one and `withEndedLabels` did not find it dead.
 * @param {any} pr
 */
function labelStands(pr) {
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
 *
 * @param {any[]} prs
 * @param {{agents?: () => string[] | null, ended?: () => Map<string, number>, say?: (line: string) => void}} [io]
 * @returns {any[]}
 */
export function withEndedLabels(prs, { agents = liveWorkspaceLabels, ended = endedSessionLabels,
  say = (line) => process.stderr.write(line) } = {}) {
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
    say(`NOTE: the ended-session ledgers could not be read (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}) -- no pull request's \`${SESSION_PREFIX}\` label was classed as ended this tick (#3093).\n`);
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
 * @param {unknown} headRef @param {Set<string>} live
 */
function sessionNamedByBranch(headRef, live) {
  const ref = String(headRef ?? "");
  const whole = /^agent\/(.+)$/.exec(ref)?.[1];
  if (whole && live.has(whole)) return whole;
  return (ref.match(/worker-\d+/g) ?? []).find((token) => live.has(token)) ?? null;
}

/**
 * The live session the rows a PR CLOSES name: that session, `null` for none, `"split"` for two different ones.
 * @param {any} pr @param {Map<number, {session: string, row: number}>} held
 */
function closingRowOwner(pr, held) {
  if (!Array.isArray(pr.closingIssuesReferences)) return null;
  const owners = pr.closingIssuesReferences.map((/** @type {any} */ ref) => held.get(Number(ref?.number)))
    .filter((/** @type {any} */ owner) => owner !== undefined);
  const sessions = new Set(owners.map((/** @type {any} */ owner) => owner.session));
  if (sessions.size > 1) return "split";
  return sessions.size === 1 ? { ...owners[0], source: "closing" } : null;
}

/**
 * #2928: the live session holding the row a PR's BRANCH was claimed for, or `null`. `row-claim claim <n>
 * --branch=agent/<slug>-<n>` writes the trailing number, so it names the row even when the PR says `Closes: none`
 * because the done-when belongs to someone else. The last authority: a PR that closes rows is answered by them.
 * @param {any} pr @param {Map<number, {session: string, row: number}>} held
 */
function branchRowOwner(pr, held) {
  const suffix = /^agent\/.+-(\d+)$/.exec(String(pr.headRefName ?? ""));
  const owner = suffix ? held.get(Number(suffix[1])) : undefined;
  return owner ? { ...owner, source: "branch" } : null;
}
