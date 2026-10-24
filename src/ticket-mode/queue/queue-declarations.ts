// @ts-check
// module: what a merged pull request's own body declares of its ticket, and what that does to a run's `partial` (A11-181) -- PURE
//
// A run's outcome says `partial` in the worker's own words, and a worker can get them wrong: on A11-155 the outcome listed what was DONE, while the pull request said `Closes` and delivered the whole ticket. So once a run's
// pull requests merged, the board reads their bodies (`pool-pull-declarations.ts`), and the merged pull request's declaration decides: `Closes <KEY>` drops the outcome's `partial`, a `Partial:` line replaces it, and a
// body that declares nothing leaves the outcome as it is. Every reader of `partial` then follows the pull request. Where the declaration overruled the outcome, the run records both, and the card names them.
import { settledByPulls } from "../board-view/pull-settled.ts";
import { stepNamed } from "../board-view/plan-steps.ts";
import { pullsOf } from "../board-view/view-types-and-filters.ts";
import type { PartialOverruled, PullDeclared } from "../board-view/pull-declared.ts";
import { replace, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import type { Declaration } from "../ticket-references.ts";

/** One merged pull request's body, read: its address, and what the body declares of the ticket (null for nothing). */
export type ReadDeclaration = Readonly<{ url: string; declaration: Declaration | null }>;

/** The merged pull requests of a run, in the order the run lists them. PURE. */
export const mergedPullUrls = (entry: Entry): string[] => pullsOf(entry).map(({ url }) => url).filter((url) => entry.pullStates?.[url] === "merged");

/**
 * The finished runs whose merged pull requests' bodies are still to be read (A11-181): all their pull requests have merged or closed with one merged, nothing has been recorded yet, the tracker has not
 * canceled the ticket, and no person is known to have completed it. A parked run is read too: the put-back of a ticket the tracker completed does not wait for a workspace to close (A11-178). PURE.
 */
export const declarationsDue = (queue: Queue): Entry[] => queue.entries.filter((entry) => entry.phase === "finished" && entry.declared === undefined && entry.completedBy !== "person"
  && entry.trackerState !== "canceled" && entry.trackerState !== "duplicate" && settledByPulls(entry) === "completed");

/** The `Partial:` words of a declaration that makes the run partial: they name a plan step, or the run has exactly one pull request. Sibling pull requests' free words make none (see {@link declare}). PURE. */
const remainsOf = (declaration: Declaration | null, pullCount: number): string | null =>
  declaration?.kind === "partial" && (pullCount === 1 || stepNamed(declaration.remains) !== null) ? declaration.remains : null;

/**
 * What a run's merged pull requests declare, from the bodies read. `partial`, with the first such body's words, when a body's `Partial:` line names a plan step, or when the run has exactly one pull request
 * and its body has a `Partial:` line; else `closes` when any body closes the ticket; else `none`. A run of several pull requests whose bodies say `Refs` with a `Partial:` line in free words is the brief's own
 * convention for pull requests that finish the ticket together (`worker-files.ts`: each `Partial:` names the run's other pull requests), so that is `none`, not a remainder. PURE.
 */
export function declare(read: readonly ReadDeclaration[], pullCount: number): PullDeclared {
  const urls = read.map(({ url }) => url);
  const remains = read.map(({ declaration }) => remainsOf(declaration, pullCount)).find((words) => words !== null);
  if (remains !== undefined && remains !== null) return { kind: "partial", remains, urls };
  return { kind: read.some(({ declaration }) => declaration?.kind === "closes") ? "closes" : "none", urls };
}

/** Whether two `partial` declarations name different steps of the plan: no step at all on both is the same, and different words for the same step are too (A11-181). PURE. */
function namesOtherStep(outcome: string, pull: string): boolean {
  const [a, b] = [stepNamed(outcome), stepNamed(pull)];
  return a === null || b === null ? a !== b : a.step !== b.step || a.of !== b.of;
}

/** How the board names a declaration on the card: `Closes A11-155`, or `Partial: step 1 of 3 …`. PURE. */
const declarationLine = ({ kind, remains }: PullDeclared, closing: string, key: string): string => (kind === "closes" ? `${closing} ${key}` : `Partial: ${remains}`);

/**
 * Record what `key`'s merged pull requests declared (A11-181), and let it decide the run's `partial`: `closes` drops it, `partial` replaces it with the body's words, `none` leaves the outcome's as it is.
 * Where that overrules the outcome, the outcome's words and the declaration are kept beside it: a `Closes` against an outcome that has a `partial`, or a `Partial:` against an outcome with none or one that
 * names another step. Different words for the same step are no disagreement. A run that is not finished is left as it is. PURE.
 */
export function recordDeclared(queue: Queue, key: string, declared: PullDeclared, closing: string): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "finished") return entry;
    const { partial: outcome, partialOverruled: _earlier, ...rest } = entry;
    const kept: Entry = { ...rest, declared, ...(outcome !== undefined ? { partial: outcome } : {}) };
    if (declared.kind === "none") return kept;
    const pull = declarationLine(declared, closing, key);
    if (declared.kind === "closes") {
      const { partial: _dropped, ...whole } = kept;
      return outcome === undefined ? whole : { ...whole, partialOverruled: overruled(outcome, pull, declared) };
    }
    const remains = declared.remains ?? "";
    const disagrees = outcome === undefined || namesOtherStep(outcome, remains);
    return { ...kept, partial: remains, ...(disagrees ? { partialOverruled: overruled(outcome ?? null, pull, declared) } : {}) };
  });
}

const overruled = (outcome: string | null, pull: string, { urls }: PullDeclared): PartialOverruled => ({ outcome, pull, urls });
