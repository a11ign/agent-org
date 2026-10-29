// @ts-check
// module: the pull requests a ticket already has on the code host, for the brief of a run started again and for Respond (A11-240)
//
// A RUN THAT IS QUEUED AGAIN IS NOT TOLD BY THE BOARD'S OWN RECORD what its ticket has opened, because the crash that ended the run before may have emptied it (A11-205: Respond was refused with "has no pull request open" while a11ign/control#140 was open).
// So the code host is asked which pull requests name the ticket (`pullsNaming`, contract 1.18), and the answer is narrowed here to the ones that are the ticket's: a pull request that only mentions the key in passing ("holds step 2 until A11-240
// has merged") is not. Only a `Closes` or `Refs` line that names the key counts, the lines `pr:open` makes a worker write. A host without the read, or one that cannot be asked, gives none, and everything is as it was: the board's own record is all there is.

import { type OpenedPull } from "./brief-ticket-text.ts";
import { type PoolContext } from "./pool-context.ts";
import { log, messageOf } from "./pool-state.ts";
import { reviewedRepositoriesOf } from "./reviewer-port.ts";
import { pullsOf } from "./board-view/view-types-and-filters.ts";
import { type Entry, type PullRequest } from "./queue/queue-entries-and-outcomes.ts";
import { DEFAULT_KEYWORDS, type Keywords } from "./source.ts";
import { declarationOf, referencesIn } from "./ticket-references.ts";
import type { NamingPull } from "../plugins/contracts/code-host.ts";

/** Whether `body` has a `Closes` or `Refs` line that names `key`: the pull request is the ticket's, not a mention of it. PURE. */
const referencesTicket = (body: string, key: string, keywords: Keywords): boolean =>
  referencesIn(body, keywords).some(({ names }) => names.some((name) => name.toLowerCase() === key.toLowerCase()));

const keywordsOf = ({ source }: PoolContext): Keywords => source.keywords ?? DEFAULT_KEYWORDS;

/**
 * The pull requests of the repositories the board reviews that are `key`'s, in any state, as the code host lists them. None when the host cannot be asked, and the reason is said in the log: the board must not
 * stop a start or a Respond for it.
 */
async function ticketPullsOf(ctx: PoolContext, key: string): Promise<readonly NamingPull[]> {
  const { codeHost, settings } = ctx;
  if (codeHost.pullsNaming === undefined) return [];
  try {
    const found = await codeHost.pullsNaming(key, reviewedRepositoriesOf(settings.clones));
    if (found === null) {
      log(`${key}: the pull requests that name it could not be listed, so none is told to its worker or answered by Respond`);
      return [];
    }
    return found.filter(({ body }) => referencesTicket(body, key, keywordsOf(ctx)));
  } catch (err) {
    log(`${key}: the pull requests that name it could not be listed: ${messageOf(err).split("\n")[0]}`);
    return [];
  }
}

/** A pull request the lookup is about, before the board reads the open ones: its state and body as the host listed them, or as the board recorded them (`body` is unknown then). */
type Candidate = Readonly<{ url: string; repo: string; state: OpenedPull["state"]; body: string | null }>;

/** The host's list and the entry's own record, each pull request once, by address. The pull requests of the plan steps already merged are left out: the brief lists the steps itself. */
function candidatesOf(entry: Entry, listed: readonly NamingPull[]): Candidate[] {
  const steps = new Set((entry.steps ?? []).flatMap(({ prs }) => prs));
  const fromHost = listed.filter(({ url }) => !steps.has(url)).map(({ url, repo, state, body }): Candidate => ({ url, repo, state, body }));
  const seen = new Set([...steps, ...fromHost.map(({ url }) => url)]);
  const recorded = pullsOf(entry).filter(({ url }) => !seen.has(url)).map(({ url, repo }): Candidate => {
    const state = entry.pullStates?.[url];
    return { url, repo, state: state === "merged" || state === "closed" ? state : "open", body: null };
  });
  return [...fromHost, ...recorded];
}

/**
 * Every pull request `entry`'s ticket has that the brief of a work run should name (A11-240): the host's list (narrowed to the ticket's) and the board's own record, each once, by address. An open one is read for its head and
 * its failing checks, and every one for what its body declares of the ticket. A pull request of a merged plan step is left out: the brief lists the steps already. It reads the host and writes nothing.
 */
export async function openedPullsOf(ctx: PoolContext, entry: Entry): Promise<readonly OpenedPull[]> {
  const key = entry.ticket.key;
  try {
    return await readOpened(ctx, entry);
  } catch (err) {
    // The brief of a run must not fail for a read of the host that was only to tell it more.
    log(`${key}: the pull requests its ticket has could not be read: ${messageOf(err).split("\n")[0]}`);
    return [];
  }
}

/** {@link openedPullsOf}, over the reads of the code host, which may throw. */
async function readOpened(ctx: PoolContext, entry: Entry): Promise<readonly OpenedPull[]> {
  const { codeHost, feedbackIgnores } = ctx;
  const key = entry.ticket.key;
  const keywords = keywordsOf(ctx);
  const candidates = candidatesOf(entry, await ticketPullsOf(ctx, key));
  if (candidates.some(({ state }) => state === "open")) ctx.ownLogin.value ??= await codeHost.readOwnLogin();
  const self = ctx.ownLogin.value;
  return Promise.all(candidates.map(async ({ url, repo, state, body }): Promise<OpenedPull> => {
    const read = state === "open" && self !== null ? await codeHost.readPullFeedback(url, self, feedbackIgnores) : null;
    const text = read?.body ?? body ?? "";
    return { url, repo, state: read?.state ?? state, head: read?.head ?? null, failing: read?.failing ?? [], declared: declarationOf(text, key, keywords) };
  }));
}

/**
 * The open pull requests the code host holds for `entry`'s ticket that its own record does not (A11-240), as the review round Respond queues takes them. Respond is refused for "no pull request open" when the record
 * holds none, so this is what it answers by instead. A pull request the record holds, whatever state the record has it in, is the record's to judge, and is not found again.
 */
export async function openPullsFound(ctx: PoolContext, entry: Entry): Promise<PullRequest[]> {
  const recorded = new Set(pullsOf(entry).map(({ url }) => url));
  return (await ticketPullsOf(ctx, entry.ticket.key)).filter(({ url, state }) => state === "open" && !recorded.has(url)).map(({ repo, url }) => ({ repo, url }));
}
