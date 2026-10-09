// @ts-check
// pure: orders for open pull requests that change one file, from the list handed in -- nothing here reads gh, git or herdr
/**
 * #3480: TWO OPEN PULL REQUESTS THAT CHANGE ONE FILE ARE REPORTED TO THE OWNER OF THE LATER ONE, while both are open and before either
 * conflicts. Nothing on the tick compared open pull requests WITH EACH OTHER: B4 compares a ROW's Region with the pull requests' files at
 * claim time, and `perPullRequestOrders` reads each pull request alone, so a pair was first reported by the second one's `DIRTY`, after the
 * first had merged. Measured on a11ign/agent-org, 2026-10-04: #148, #149 and #150 shared `watch.mjs` from 13:41:48Z and the first signal any
 * of them gave was `DIRTY`. It is also the control for a Region that is too narrow, because it reads what the pull requests CHANGED, not
 * what any row declared.
 *
 * AHEAD IS THE LOWER NUMBER. A pull request number is handed out at creation and only grows within a repository, so "opened first" is a
 * comparison of two integers and needs no timestamp that a later edit could move.
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
import { labelsOf } from "../work-gate.ts";
import { ownerOfPr, DEAD_OWNER_FALLBACK } from "./pr-orders.mjs";

/** Where an order goes when nobody can be named as the later pull request's owner (the row's ruling; `ownerOfPr`'s own last rung is `ceo`). */
const NO_OWNER_SESSION = "product-manager";
/** Changeset files are excluded on both sides, as B4 excludes them (`file-overlap-rule.mjs`): every pull request adds its own, and a shared NAME is no shared change. */
const isChangeset = (/** @type {string} */ path) => path.startsWith(".changeset/") || isAcceptancePath(path); // ADR 0044: each pull request adds its own `.acceptance/` file
const HASH_LENGTH = 10;

/**
 * @typedef {{ pr: any, files: Set<string> }} Compared
 * @typedef {{ ahead: Compared, shared: string[] }} Overlap
 */

/**
 * @param {any[]} prs
 * @param {(line: string) => void} [say] the diagnostic for a pull request left out; the gate's stderr by default
 * @returns {{ session: string, fallback?: string, fallbackOnlyIfAbsent?: boolean, fallbackPrompt?: string, cause: string, subject: string,
 *   discriminator: string, prompt: string, causeKey: string }[]}
 */
export function sharedFileOrders(prs, say = (line) => process.stderr.write(line)) {
  const compared = (prs ?? []).flatMap((pr) => comparedOf(pr, say));
  return [...groupByRepo(compared).values()].flatMap(ordersWithin);
}

/** @param {any} pr @param {(line: string) => void} say @returns {Compared[]} none when the list is not the whole of the pull request's files */
function comparedOf(pr, say) {
  if (!pr || !Number.isInteger(Number(pr.number)) || !Array.isArray(pr.files)) return []; // never read by `readPrs`: nothing was asked, so nothing is said
  const paths = pr.files.map((/** @type {any} */ f) => String(f?.path ?? f));
  if (!Number.isInteger(Number(pr.changedFiles)) || paths.length !== Number(pr.changedFiles)) {
    say(`work-gate: ${subjectMention(pr)} lists ${paths.length} files, not the ${pr.changedFiles} it reports -- left out of the shared-file comparison, which is NOT a reading of "no overlap" (#3480)\n`);
    return [];
  }
  return [{ pr, files: new Set(paths.filter((/** @type {string} */ p) => !isChangeset(p))) }];
}

/** @param {Compared[]} compared */
function groupByRepo(compared) {
  /** @type {Map<string, Compared[]>} */
  const groups = new Map();
  for (const entry of compared) {
    const key = String(entry.pr.repoKey ?? "");
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
}

/** @param {Compared[]} group one repository's pull requests */
function ordersWithin(group) {
  const ascending = [...group].sort((a, b) => Number(a.pr.number) - Number(b.pr.number));
  return ascending.flatMap((later, i) => {
    const overlaps = ascending.slice(0, i).map((ahead) => overlapOf(ahead, later)).filter((o) => o !== null);
    const unsequenced = /** @type {Overlap[]} */ (overlaps).filter((o) => !sequencedBehind(later.pr, o.ahead.pr));
    return unsequenced.length === 0 ? [] : [orderFor(later.pr, unsequenced)];
  });
}

/** @param {Compared} ahead @param {Compared} later @returns {Overlap | null} */
function overlapOf(ahead, later) {
  const shared = [...later.files].filter((path) => ahead.files.has(path)).sort();
  return shared.length === 0 ? null : { ahead, shared };
}

/**
 * Whether `pr` is held AND declares it waits for `ahead` to merge. A bare `#n` names the pull request's OWN repository (`declaredWaitsOf`).
 * @param {any} pr @param {any} ahead
 */
function sequencedBehind(pr, ahead) {
  if (holdersOf(labelsOf(pr)).length === 0) return false;
  const { waits } = declaredWaitsOf(waitItemOf(pr, "pr"));
  return waits.some((w) => w.state === "merged" && w.number === Number(ahead.number) && (w.repo ?? null) === (ahead.repo ?? null));
}

/** @param {any} pr @param {Overlap[]} overlaps */
function orderFor(pr, overlaps) {
  const { session: labelled, source } = ownerOfPr(pr);
  const unowned = source === "ceo";
  const session = unowned ? NO_OWNER_SESSION : labelled;
  const ref = `pr-${subjectRef(pr.repoKey, pr.number)}`;
  const digest = createHash("sha1").update(overlaps.map(keyPart).join(";")).digest("hex").slice(0, HASH_LENGTH);
  const what = whatItSays(pr, overlaps);
  const holder = unowned ? "<its-owner>" : session; // an ownerless pull request is held by the session that takes it, not by the reader of this order
  const prompt = `${what}${ownerSentence(pr, { unowned })} ${remedy(pr, overlaps, holder)}`;
  return {
    session,
    ...(session === DEAD_OWNER_FALLBACK ? {}
      : { fallback: DEAD_OWNER_FALLBACK, fallbackOnlyIfAbsent: true,
        fallbackPrompt: `${what}Its owner, \`${session}\`, NO LONGER EXISTS (no workspace carries that label), so this order reached you: put the label of a session that can act on it, then ${remedy(pr, overlaps, holder)}` }),
    cause: "pr-merge-conflict",
    subject: ref,
    discriminator: `shares-${digest}`,
    prompt,
    causeKey: `${session}/pr-merge-conflict/${ref}/shares/${digest}`,
  };
}

/** @param {Overlap} overlap what the key is made of: the pull request ahead and the files, so a file the later one adds is a new order */
const keyPart = ({ ahead, shared }) => `${ahead.pr.number}:${shared.join(",")}`;

/** @param {any} pr @param {Overlap[]} overlaps */
function whatItSays(pr, overlaps) {
  const lines = overlaps.map(({ ahead, shared }) => `  ${subjectMention(ahead.pr)}, which is ahead of it (opened first), on ${shared.map((p) => `\`${p}\``).join(", ")}`);
  return `${subjectMention(pr)} changes files that ${overlaps.length === 1 ? "another open pull request also changes" : `${overlaps.length} open pull requests also change`}:\n${lines.join("\n")}\n`
    + "Whichever merges second conflicts with the first, and today nothing says so until GitHub reports `DIRTY`, after the first has merged. ";
}

/** @param {any} pr @param {{ unowned: boolean }} says */
function ownerSentence(pr, { unowned }) {
  if (!unowned) return "It is yours (its session label, or the row it closes, names you), so the sequencing is yours.";
  return `IT HAS NO OWNER: no \`${SESSION_PREFIX}\` label of a live session, no live session holding a row it closes or its branch \`${pr.headRefName}\` names, and no live session stamped its worktree. `
    + `You are the first reader for process, so put the label of a session that can act on it (\`${SESSION_PREFIX}<name>\`), then take the remedy below.`;
}

/** @param {any} pr @param {Overlap[]} overlaps @param {string} session */
function remedy(pr, overlaps, session) {
  const waits = overlaps.map(({ ahead }) => `\`Waiting-for: merged ${subjectMention(ahead.pr)}\``).join(", ");
  const key = pr.repoKey ? ` --repo-key=${pr.repoKey}` : "";
  const hold = `pnpm run pr:hold ${pr.number}${key} --session=${session} --until="merged ${subjectMention(overlaps[0].ahead.pr)}"`;
  const more = overlaps.length === 1 ? "" : ` \`pr:hold\` takes one \`--until\`, so for the rest edit the hold's marker comment to carry one \`Waiting-for:\` line per pull request ahead (${waits}).`;
  return "Do not rebase onto `main` yet and do not ask for a review; hold behind it "
    + `(${waits}) and rebase once, after it merges: \`${hold}\`.${more} A hold with the label and the wait is sequenced and is not reported again.`;
}
