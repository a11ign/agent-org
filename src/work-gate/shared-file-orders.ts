// pure: orders for open pull requests that change one file, from the list handed in -- nothing here reads gh, git or herdr
/**
 * #3480: TWO OPEN PULL REQUESTS THAT CHANGE ONE FILE ARE REPORTED TO THE OWNER OF THE LATER ONE, while both are open and before either
 * conflicts. Nothing on the tick compared open pull requests WITH EACH OTHER: B4 compares a ROW's Region with the pull requests' files at
 * claim time, and `perPullRequestOrders` reads each pull request alone, so a pair was first reported by the second one's `DIRTY`, after the
 * first had merged. Measured on a11ign/agent-org, 2026-10-04: #148, #149 and #150 shared `watch.ts` from 13:41:48Z and the first signal any
 * of them gave was `DIRTY`. It is also the control for a Region that is too narrow, because it reads what the pull requests CHANGED, not
 * what any row declared.
 *
 * AHEAD IS THE LOWER NUMBER. A pull request number is handed out at creation and only grows within a repository, so "opened first" is a
 * comparison of two integers and needs no timestamp that a later edit could move.
 *
 * #1165, BEHIND `RECHECK_FLAG` (shipped OFF): ahead is ALSO an approved, green pull request whatever its number; a hold whose overlap has gone
 * is released; and a DIRTY pull request is told to rebase now, not to hold. All three are read from the pull requests' CURRENT state each tick,
 * so none of them can go stale.
 *
 * FILED UNDER `pr-merge-conflict`, no new cause (a cause is four places: `CAUSES`, START/JUDGMENT, the worker-profile `PROFILES` and a
 * changeset): the audience is the same -- the owner of a pull request -- and so is the remedy the order ends in, a rebase. It arrives before
 * the conflict does, which is the whole point. The key says `shares`, so it never collides with a conflicted head's.
 *
 * A PAIR ALREADY SEQUENCED IS NOT REPORTED, by B4's own two-fact test for a held pull request waiting on the asker (#2493): the `hold:` label
 * AND a `Waiting-for: merged <ahead>`, because either alone is a hole -- a label with no wait is a hold nobody can lift, a wait with no label
 * holds nothing.
 *
 * ABSENT IS NOT "NO OVERLAP". A pull request whose file list is shorter than its `changedFiles` was not read in full, so it is left out of
 * the comparison AND SAID SO (#3365's wording for B4): an overlap hiding in the files that did not come back must never read as a clean pair.
 * A pull request of a different repository never overlaps on a path name (`repoKey`).
 */
import { createHash } from "node:crypto";
import { subjectMention, subjectRef } from "../review-attribution.ts";
import { holdersOf } from "../pr-hold-state.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";
import { isAcceptancePath } from "../acceptance-file.ts";
import { waitItemOf, declaredWaitsOf } from "../wait-condition.ts";
import { labelsOf, sessionOf } from "./vocabulary.ts";
import { ownerOfPr, DEAD_OWNER_FALLBACK } from "./pr-orders/red-only-by-superseded-run.ts";
import { mergeCandidates, reviewStateOf, REVIEW_STATE } from "./pr-state.ts";

/** Where an order goes when nobody can be named as the later pull request's owner (the row's ruling; `ownerOfPr`'s own last rung is `ceo`). */
const NO_OWNER_SESSION = "product-manager";
/**
 * #1165: THE FLAG FOR THE THREE RE-CHECKS BELOW. The caller reads it from `machinery-canary.json` and passes `recheck`; OFF (the default) is
 * the ordering above, byte for byte, so nothing turns on until the flag does.
 */
export const RECHECK_FLAG = "holds.recheck";
/** Changeset files are excluded on both sides, as B4 excludes them (`file-overlap-rule.ts`): every pull request adds its own, and a shared NAME is no shared change. */
const isChangeset = (path: string) => path.startsWith(".changeset/") || isAcceptancePath(path); // ADR 0044: each pull request adds its own `.acceptance/` file
const HASH_LENGTH = 10;

export type Overlap = { ahead: Compared, shared: string[] };
export type Compared = { pr: any, files: Set<string> };

/**
 * @param [say] the diagnostic for a pull request left out; the gate's stderr by default
 * @param [recheck] `RECHECK_FLAG` is on: the sequencing is read against the pull requests' CURRENT state (#1165), see `ordersWithin`
 */
export function sharedFileOrders(prs: any[], say: (line: string) => void = (line) => process.stderr.write(line), { recheck = false }: { recheck?: boolean } = {}): {
    session: string; fallback?: string; fallbackOnlyIfAbsent?: boolean; fallbackPrompt?: string; cause: string; subject: string;
    discriminator: string; prompt: string; causeKey: string;
}[] {
  const compared = (prs ?? []).flatMap((pr) => comparedOf(pr, say));
  return [...groupByRepo(compared).values()].flatMap((group) => ordersWithin(group, recheck));
}

/** @returns none when the list is not the whole of the pull request's files */
function comparedOf(pr: any, say: (line: string) => void): Compared[] {
  if (!pr || !Number.isInteger(Number(pr.number)) || !Array.isArray(pr.files)) return []; // never read by `readPrs`: nothing was asked, so nothing is said
  const paths = pr.files.map((f: any) => String(f?.path ?? f));
  if (!Number.isInteger(Number(pr.changedFiles)) || paths.length !== Number(pr.changedFiles)) {
    say(`work-gate: ${subjectMention(pr)} lists ${paths.length} files, not the ${pr.changedFiles} it reports -- left out of the shared-file comparison, which is NOT a reading of "no overlap" (#3480)\n`);
    return [];
  }
  return [{ pr, files: new Set(paths.filter((p: string) => !isChangeset(p))) }];
}

function groupByRepo(compared: Compared[]) {
  const groups: Map<string, Compared[]> = new Map();
  for (const entry of compared) {
    const key = String(entry.pr.repoKey ?? "");
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
}

/**
 * @param group one repository's pull requests
 * @param recheck #1165, `RECHECK_FLAG` on: the sequencing is read against the CURRENT state, every tick, so it cannot go stale.
 *   (2) an approved, green pull request is ahead of an overlapping one whatever its number; (1) a hold whose overlap has gone is released,
 *   and (3) a DIRTY pull request is told to rebase, which `orderFor` says. OFF: ahead is the lower number, and a hold is never looked at again.
 */
// eslint-disable-next-line clean-code/no-flag-arguments -- #1165's recheck flag changes the ranking, the hold release and the DIRTY order together; a function per setting would copy the sequencing
function ordersWithin(group: Compared[], recheck: boolean) {
  const ascending = [...group].sort((a, b) => rankOf(a, recheck) - rankOf(b, recheck) || Number(a.pr.number) - Number(b.pr.number));
  return ascending.flatMap((later, i) => {
    const earlier = ascending.slice(0, i);
    const overlaps = earlier.map((ahead) => overlapOf(ahead, later)).filter((o) => o !== null);
    const unsequenced = (overlaps as Overlap[]).filter((o) => !sequencedBehind(later.pr, o.ahead.pr));
    const released = recheck ? earlier.filter((ahead) => overlapOf(ahead, later) === null && sequencedBehind(later.pr, ahead.pr)) : [];
    return [
      ...(unsequenced.length === 0 ? [] : [orderFor(later.pr, unsequenced, recheck)]),
      ...(released.length === 0 ? [] : [releaseOrderFor(later.pr, released)]),
    ];
  });
}

/** 0 sorts ahead: with the flag on, an approved, green pull request; otherwise every pull request is one rank and the number decides. */
// eslint-disable-next-line clean-code/no-flag-arguments -- the recheck flag's ranking, read by ordersWithin, which says why it is one function
const rankOf = (entry: Compared, recheck: boolean) => (recheck && approvedAndGreen(entry.pr) ? 0 : 1);

/**
 * GitHub's approval, and the gate's own "can go first" reading of this pull request (`mergeCandidates`: not a draft, not held, its checks
 * settled green, not conflicting). The rollup is read in `pr-state.ts`, not here, which is where the red-state rule asks for it.
 */
function approvedAndGreen(pr: any): boolean {
  return reviewStateOf(pr).code === REVIEW_STATE.APPROVED && mergeCandidates([pr]).length === 1;
}

function overlapOf(ahead: Compared, later: Compared): Overlap | null {
  const shared = [...later.files].filter((path) => ahead.files.has(path)).sort();
  return shared.length === 0 ? null : { ahead, shared };
}

/** Whether `pr` is held AND declares it waits for `ahead` to merge. A bare `#n` names the pull request's OWN repository (`declaredWaitsOf`). */
function sequencedBehind(pr: any, ahead: any) {
  if (holdersOf(labelsOf(pr)).length === 0) return false;
  const { waits } = declaredWaitsOf(waitItemOf(pr, "pr"));
  return waits.some((w) => w.state === "merged" && w.number === Number(ahead.number) && (w.repo ?? null) === (ahead.repo ?? null));
}

/** @param recheck #1165: a DIRTY pull request is told to rebase NOW, not to hold, and an approved one ahead of it is named as such */
// eslint-disable-next-line clean-code/no-flag-arguments -- the recheck flag's DIRTY order and wording, read by ordersWithin, which says why it is one function
function orderFor(pr: any, overlaps: Overlap[], recheck: boolean) {
  const { session: labelled, source } = ownerOfPr(pr);
  const unowned = source === "ceo";
  const byBot = source === "dependency-bot";
  const byChairman = source === "chairman-author";
  const ownerGone = source === "owner-gone";
  const session = unowned ? NO_OWNER_SESSION : labelled;
  const ref = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  const digest = createHash("sha1").update(overlaps.map(keyPart).join(";")).digest("hex").slice(0, HASH_LENGTH);
  const dirty = recheck && pr.mergeStateStatus === "DIRTY";
  const what = whatItSays(pr, overlaps, { recheck, dirty });
  const holder = unowned ? "<its-owner>" : session; // an ownerless pull request is held by the session that takes it, not by the reader of this order
  const then = dirty ? rebaseNow(pr, overlaps) : remedy(pr, overlaps, holder);
  const prompt = `${what}${ownerSentence(pr, { unowned, byBot, byChairman, ownerGone })} ${then}`;
  return {
    session,
    ...fallbackOf(session, what, then),
    cause: "pr-merge-conflict",
    subject: ref,
    discriminator: `shares-${digest}`,
    prompt,
    causeKey: `${session}/pr-merge-conflict/${ref}/shares/${digest}`,
  };
}

/**
 * #1165, (1): A HOLD WHOSE OVERLAP HAS GONE. The hold and its `Waiting-for: merged` were written for files the two pull requests shared, and
 * they no longer share one, so the sequence is empty and the owner releases the hold. This does not hold anything itself: the hold is a label
 * and a wait the owner's session put on, and only that session lifts them (`pr:release`, with its reason on the pull request).
 */
function releaseOrderFor(pr: any, aheads: Compared[]) {
  const { session: labelled, source } = ownerOfPr(pr);
  const session = source === "ceo" ? NO_OWNER_SESSION : labelled;
  const ref = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  const digest = createHash("sha1").update(aheads.map(({ pr: ahead }) => `released:${ahead.number}`).join(";")).digest("hex").slice(0, HASH_LENGTH);
  const named = aheads.map(({ pr: ahead }) => subjectMention(ahead)).join(", ");
  const what = `${subjectMention(pr)} is held behind ${named} (\`Waiting-for: merged\`), but it no longer shares an open file with ${aheads.length === 1 ? "it" : "them"}, so the hold is not a sequence any more. `;
  const key = pr.repoKey ? ` --repo-key=${pr.repoKey}` : "";
  const then = `Release the hold: \`pnpm run pr:release ${pr.number}${key} --session=${session}\`, and write on the pull request that the files it shared are no longer shared, which a release by another session needs.`;
  return {
    session,
    ...fallbackOf(session, what, then),
    cause: "pr-merge-conflict",
    subject: ref,
    discriminator: `released-${digest}`,
    prompt: `${what}${then}`,
    causeKey: `${session}/pr-merge-conflict/${ref}/released/${digest}`,
  };
}

/** The fallback an order to a session that may have ENDED carries: a dead owner's order reaches a live reader, once, as the other orders do. */
function fallbackOf(session: string, what: string, then: string) {
  return session === DEAD_OWNER_FALLBACK ? {}
    : { fallback: DEAD_OWNER_FALLBACK, fallbackOnlyIfAbsent: true,
      fallbackPrompt: `${what}Its owner, \`${session}\`, NO LONGER EXISTS (no workspace carries that label), so this order reached you: put the label of a session that can act on it, then ${then}` };
}

/** @param overlap what the key is made of: the pull request ahead and the files, so a file the later one adds is a new order */
const keyPart = ({ ahead, shared }: Overlap) => `${ahead.pr.number}:${shared.join(",")}`;

/** #1165: an ahead pull request that is ahead BECAUSE it is approved and green says so; the number is not the reason then. */
function whatItSays(pr: any, overlaps: Overlap[], { recheck, dirty }: { recheck: boolean; dirty: boolean }) {
  const why = (ahead: any) => (recheck && approvedAndGreen(ahead) !== approvedAndGreen(pr) ? "approved and green, so it goes first" : "opened first");
  const lines = overlaps.map(({ ahead, shared }) => `  ${subjectMention(ahead.pr)}, which is ahead of it (${why(ahead.pr)}), on ${shared.map((p) => `\`${p}\``).join(", ")}`);
  return `${subjectMention(pr)} changes files that ${overlaps.length === 1 ? "another open pull request also changes" : `${overlaps.length} open pull requests also change`}:\n${lines.join("\n")}\n`
    + (dirty ? "" : "Whichever merges second conflicts with the first, and today nothing says so until GitHub reports `DIRTY`, after the first has merged. ");
}

/**
 * #1165, (3): a pull request GitHub reports DIRTY against `main` is already conflicting, and holding it never saves its rebase, so the order says
 * rebase now. It names the files it shares with the pull requests ahead, which are where the rebase will meet them.
 */
function rebaseNow(pr: any, overlaps: Overlap[]) {
  const files = [...new Set(overlaps.flatMap(({ shared }) => shared))].map((p) => `\`${p}\``).join(", ");
  const ahead = overlaps.map(({ ahead }) => subjectMention(ahead.pr)).join(", ");
  return `Rebase onto \`main\` now and push: GitHub reports ${subjectMention(pr)} \`DIRTY\` against \`main\`, and a hold behind ${ahead} would not save that rebase, so do not hold it. `
    + `Resolve ${files} as you go, the files it shares with ${ahead}.`;
}

function ownerSentence(pr: any, { unowned, byBot, byChairman, ownerGone }: { unowned: boolean; byBot: boolean; byChairman: boolean; ownerGone: boolean; }) {
  if (byBot) return "A dependency bot opened it and no session works such a pull request, so the sequencing is yours (#4624).";
  if (byChairman) return "The chairman opened it and no session works it, so the sequencing is yours (agent-org#950).";
  if (ownerGone) return `Its \`${SESSION_PREFIX}\` label names \`${sessionOf(pr)}\`, which has ENDED, and the row it closed is closed, so the sequencing is yours to route: re-lane it (\`${SESSION_PREFIX}<name>\` on the PR), or close it (#4644).`;
  if (!unowned) return "It is yours (its session label, or the row it closes, names you), so the sequencing is yours.";
  return `IT HAS NO OWNER: no \`${SESSION_PREFIX}\` label of a live session, no live session holding a row it closes or its branch \`${pr.headRefName}\` names, and no live session stamped its worktree. `
    + `You are the first reader for process, so put the label of a session that can act on it (\`${SESSION_PREFIX}<name>\`), then take the remedy below.`;
}

function remedy(pr: any, overlaps: Overlap[], session: string) {
  const waits = overlaps.map(({ ahead }) => `\`Waiting-for: merged ${subjectMention(ahead.pr)}\``).join(", ");
  const key = pr.repoKey ? ` --repo-key=${pr.repoKey}` : "";
  const hold = `pnpm run pr:hold ${pr.number}${key} --session=${session} --until="merged ${subjectMention(overlaps[0].ahead.pr)}"`;
  const more = overlaps.length === 1 ? "" : ` \`pr:hold\` takes one \`--until\`, so for the rest edit the hold's marker comment to carry one \`Waiting-for:\` line per pull request ahead (${waits}).`;
  return "Do not rebase onto `main` yet and do not ask for a review; hold behind it "
    + `(${waits}) and rebase once, after it merges: \`${hold}\`.${more} A hold with the label and the wait is sequenced and is not reported again.`;
}
