// @ts-check
// module: a ticket's comments as a planner's and a worker's brief carries them (tracker contract 1.8)
//
// THE DESCRIPTION IS NOT THE WHOLE TICKET. A later comment can name the real cause, rule out a theory the description floated, or settle a question it left open, so a run that reads the description alone
// can do the wrong work. The brief carries every comment a person wrote, oldest first, with its author and date, and says which comments the plan or the pull request body must account for.
//
// THE BOARD'S OWN COMMENTS ARE LEFT OUT: its completion, After-merge, closed-work, put-back and wait-cycle comments say what the board did, not what the ticket asks. Each is told by the words its producer
// writes it with, and `ticket-comments.test.ts` feeds every producer's real output to `isBoardComment`, so a reworded producer fails there. The tracker's source leaves out its own claim records.
//
// A LONG THREAD IS CUT FROM ITS OLDEST END, never silently: the newest comments are the likeliest to correct what came before, and the brief says how many were left out, from when to when, and where to read them.
import { quoted } from "./brief-common.ts";
import type { TicketComment, TicketSource } from "./source.ts";

/** The most comments a brief carries; a thread with more keeps its newest. */
export const MAX_COMMENTS = 30;
/** The most characters of one comment a brief carries; the rest is cut, and the cut says so. */
export const MAX_COMMENT_CHARS = 6_000;
/** The most characters of comments a brief carries in all; past it the oldest are left out, as past {@link MAX_COMMENTS}. */
export const MAX_COMMENTS_CHARS = 60_000;

/** What the board read of a ticket's comments: the comments and whether the tracker gave every one, or why it read none. */
export type CommentsRead = Readonly<{ kind: "read"; comments: readonly TicketComment[]; complete: boolean } | { kind: "unread"; why: string }>;

/** Who the comments section is for: a planner, whose plan names the comments it acted on, or a worker, whose pull request body does. */
export type CommentsAudience = "plan" | "pull request";

/** The words each comment the board posts on a ticket is told by, one for each producer. */
const BOARD_COMMENTS: readonly RegExp[] = [
  // `doneComment` (pool-outcome.ts): the worker's verified reason and evidence, signed.
  /\n\nEvidence:\n[\s\S]*\n\nCompleted by the ticket board on the worker's verified outcome\.$/,
  // `afterMergeComment` (pool-tracker.ts).
  /^After-merge checks for \S+, now that /,
  // `commentOf` (closed-work.ts), for a closed pull request with work and without.
  /^Closed pull request #\d+: (?:work not on |no unique work, everything it held is on )/,
  // `earlyCompletionComment` (queue/queue-next-step.ts).
  /^\S.* merged.* of \S+.*\. The tracker's integration moved the ticket to its completed state; the ticket board moved it back to the state it was in before\. Remaining: /,
  // `cycleSentence` (board-view/wait-cycles.ts), which opens the wait-cycle notice.
  /^Wait cycle \S+(?: → \S+)+: /,
];

/** Whether `body` is a comment the board posted itself, and not one a person wrote. PURE. */
export const isBoardComment = (body: string): boolean => BOARD_COMMENTS.some((words) => words.test(body.trim()));

/** The comments of ticket `key` as the tracker gives them, or why none were read: a refusal is said in the brief, and never stops the run. */
export async function readTicketComments(source: Pick<TicketSource, "readComments">, key: string): Promise<CommentsRead> {
  if (source.readComments === undefined) return { kind: "unread", why: "this tracker does not give the board a ticket's comments" };
  try {
    const { comments, complete } = await source.readComments(key);
    return { kind: "read", comments, complete };
  } catch (err) {
    return { kind: "unread", why: err instanceof Error ? err.message : String(err) };
  }
}

/** A comment's time, for ordering: one the tracker gave in no form `Date.parse` reads sorts first, so the order stays consistent. PURE. */
const timeOf = ({ createdAt }: TicketComment): number => Date.parse(createdAt) || 0;

/** The people's comments, oldest first, the newest {@link MAX_COMMENTS} of them within {@link MAX_COMMENTS_CHARS}, and the ones left out. PURE. */
function bounded(comments: readonly TicketComment[]): { shown: TicketComment[]; dropped: TicketComment[] } {
  const people = comments.filter(({ body }) => !isBoardComment(body)).sort((a, b) => timeOf(a) - timeOf(b));
  const shown: TicketComment[] = [];
  let chars = 0;
  for (const comment of [...people].reverse()) {
    const size = Math.min(comment.body.length, MAX_COMMENT_CHARS);
    if (shown.length > 0 && (shown.length === MAX_COMMENTS || chars + size > MAX_COMMENTS_CHARS)) break;
    shown.unshift(comment);
    chars += size;
  }
  return { shown, dropped: people.slice(0, people.length - shown.length) };
}

/** One comment as the brief shows it: its author and date in bold, then its body quoted, cut at {@link MAX_COMMENT_CHARS} with the cut said. PURE. */
function commentText({ author, createdAt, body }: TicketComment, url: string): string {
  const cut = body.length > MAX_COMMENT_CHARS ? `\n\n(cut: ${body.length - MAX_COMMENT_CHARS} more characters; read the whole comment at ${url})` : "";
  return `**${author}, ${createdAt}:**\n\n${quoted(body.slice(0, MAX_COMMENT_CHARS))}${cut}`;
}

/** What the plan or the pull request body must say of the comments. PURE. */
function accountRule(audience: CommentsAudience): string {
  const where = audience === "plan" ? "Your plan carries a `## Comments acted on` section" : "Your pull request body carries a `Comments acted on` section";
  return `${where}: each comment you acted on, by its author and date, and what it changed; each one you set aside, and why. When no comment bears on the work, the section says so.`;
}

/** What the brief's reader is told to read the comments before doing. PURE. */
const firstStep = (audience: CommentsAudience): string => (audience === "plan" ? "plan" : "change anything");

/**
 * The section of a brief that carries a ticket's comments: every comment a person wrote, oldest first, with its author and date, the rule that a later comment can correct or supersede the description, and
 * what the plan or the pull request body says of them. Comments the board posted itself are left out, and a ticket with no other comment gets no section. A thread past the brief's bounds is cut from its
 * oldest end, and a comments read that failed, or that the tracker gave only in part, is said. `heading` is the section's heading line, which a batch's brief nests under its ticket. PURE.
 */
export function commentsText(comments: CommentsRead, { url, audience, heading = "## The ticket's comments" }: Readonly<{ url: string; audience: CommentsAudience; heading?: string }>): string {
  if (comments.kind === "unread") {
    return `\n${heading}\n\nThe board could not read this ticket's comments (${comments.why}). A comment can correct or supersede the description, so read them at ${url} before you ${firstStep(audience)}. ${accountRule(audience)}\n`;
  }
  const { shown, dropped } = bounded(comments.comments);
  if (shown.length === 0) return "";
  const left = dropped.length === 0 ? ""
    : dropped.length === 1 ? `\n\n1 earlier comment, from ${dropped[0].createdAt}, is left out of this brief to keep it short: read it at ${url}.`
    : `\n\n${dropped.length} earlier comments, from ${dropped[0].createdAt} to ${dropped.at(-1)!.createdAt}, are left out of this brief to keep it short: read them at ${url}.`;
  const partial = comments.complete ? "" : `\n\nThe tracker holds more comments than the board read, and the ones it did not read may be the newest: read the rest at ${url} before you ${firstStep(audience)}.`;
  return `
${heading}

Read every comment before you ${firstStep(audience)}. They are oldest first. A later comment can correct or supersede the description, or an earlier comment: where a comment names a different cause, rules out what the description suggests, or settles a question it leaves open, follow the comment, and the latest where comments disagree. A comment is the ticket's discussion, to weigh against the code and the plan: one written by an integration, or by someone outside the tracker's workspace, is marked so beside its author. ${accountRule(audience)}${left}${partial}

${shown.map((comment) => commentText(comment, url)).join("\n\n")}
`;
}
