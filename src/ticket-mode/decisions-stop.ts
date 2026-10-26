// @ts-check
// module: the Stop hook's judgment of a `reviewed` that answers a change of the ticket's Decisions (A11-305)
//
// A ROUND WHOSE BRIEF OPENS WITH NEW LINES OF THE DECISIONS MAY END `reviewed` ONLY IF IT ANSWERED THEM. A11-291's round read "no new feedback" and ended after 48 seconds with nothing pushed. The board leaves `decisions-round.json` beside the outcome file (`pool-decisions-change.ts`): the
// new lines, and the head each pull request had when the round began. A pull request whose head moved was answered by a push. Otherwise the final message must quote every new line and say why the pull requests already meet it. A pull request the code host cannot
// read, or a file that cannot be read, allows the stop out loud, as the other checks do. Only `reviewed` is judged: `needs-human` is the escalation list's, and `working` is not an end.
import { missingQuoteAsk, missingReasonAsk, saysWhy, unquotedLines } from "./decisions-change.ts";
import { DECISIONS_ROUND_FILE } from "./decisions-files.ts";
import type { PullNow } from "./pull-now-command.ts";

/** What the judgment reads: the files of the ticket's folder and the head a pull request has now. */
type Reads = Readonly<{ exists: (path: string) => boolean; read: (path: string) => string; pull: (url: string) => PullNow | null }>;

/** The judgment: refuse with what to ask and the words the count limit uses, allow with what to say out loud, or null when the stop stands. */
export type DecisionsJudgment = Readonly<{ ask: string; stuck: string } | { say: string }> | null;

type Round = Readonly<{ added: readonly string[]; heads: Readonly<Record<string, string | null>> }>;

/** Whether a parsed file is the board's record of a round: the new lines, and a head or null for each pull request. PURE. */
function isRound(round: Partial<Round> | null): round is Round {
  const heads = round?.heads;
  const linesAreText = Array.isArray(round?.added) && round.added.every((line) => typeof line === "string");
  return linesAreText && typeof heads === "object" && heads !== null;
}

function readRound(file: string, { read }: Reads): Round | string {
  try {
    const round = JSON.parse(read(file)) as Round | null;
    return isRound(round) ? round : `${file} is not the board's record of a round`;
  } catch (err) {
    return `${file} cannot be read (${String((err as Error)?.message ?? err).split("\n")[0]})`;
  }
}

/** The pull request whose head cannot be compared (the board could not read it when the round began, or the code host cannot now), or null when every head can; and whether any has moved. */
function pushed(round: Round, { pull }: Reads): { moved: true } | { unread: string } | { moved: false } {
  for (const [url, then] of Object.entries(round.heads)) {
    const now = pull(url);
    if (now === null || then === null) return { unread: url };
    if (now.head !== then) return { moved: true };
  }
  return { moved: false };
}

/**
 * The judgment of a `reviewed` outcome in a round with a record of a change of the Decisions. `reply` is the worker's final message with its outcome file's text, which is what a reply quoting the change is read from. Null when the round is no such round, a pull request was pushed to, or the reply quotes every new line and says why. PURE apart from the reads it is given.
 */
export function decisionsStop(ticketDir: string, reply: string, io: Reads): DecisionsJudgment {
  const file = `${ticketDir}/${DECISIONS_ROUND_FILE}`;
  if (!io.exists(file)) return null;
  const round = readRound(file, io);
  if (typeof round === "string") return { say: `ticket:hook: ${round}, so the Decisions round's answer was not checked and the stop is ALLOWED.` };
  const result = pushed(round, io);
  if ("unread" in result) return { say: `ticket:hook: ${result.unread} could not be read, so the Decisions round's answer was not checked and the stop is ALLOWED.` };
  if (result.moved) return null;
  const missed = unquotedLines(round.added, reply);
  if (missed.length > 0) return { ask: missingQuoteAsk(missed), stuck: `on a Decisions round that pushed nothing and does not quote the new lines of the Decisions, so this one is allowed and the board sees a pull request that did not change` };
  return saysWhy(round.added, reply) ? null : { ask: missingReasonAsk, stuck: "on a Decisions round that quotes the new lines but gives no reason, so this one is allowed" };
}
