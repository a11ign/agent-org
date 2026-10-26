// @ts-check
// module: whether a worker's reply to a block disputes a DECISION, which only the planner can change (A11-290) -- PURE
//
// A STAND-OFF GOES TO THE PLANNER FIRST WHEN THE WORKER'S REPLY DISPUTES A DECISION IN THE PLAN OR THE TICKET, or says the plan's own decision cannot be met (#1933: the plan's 200 KB limit could not be met). The worker's brief says how a reply
// says so, and the board reads it the same way: a reply that QUOTES a line of the decisions it was given, or has a line that starts with one of the two phrases {@link DISPUTE_PHRASES}. Anything else is a dispute about the code or the evidence,
// which the worker answers by changing them.

/** The phrases a reply starts a line with to say it disputes a decision, or that the plan's own decision cannot be met. The worker's brief (`DISPUTED_REVIEW`) tells it to use them. */
export const DISPUTE_PHRASES = ["Disputes a decision:", "Plan cannot be met:"] as const;

/** The shortest line of a decision a reply must quote to count: a short line ("none", "yes") is in any text. */
const QUOTE_MIN_CHARS = 25;

const MARKDOWN_LEAD = /^[\s>*\-+#\d.)]+/;

/** A line as it is compared: its list and quote marks and emphasis gone, its white space one space, lower case. */
const plain = (line: string): string => line.replace(MARKDOWN_LEAD, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The lines of `decisions` long enough to be quoted, as {@link plain} reads them. */
const quotable = (decisions: string | null | undefined): string[] => (decisions ?? "").split("\n").map(plain).filter((line) => line.length >= QUOTE_MIN_CHARS);

/** The first line of `reply` that starts with one of {@link DISPUTE_PHRASES}, or null. */
function phrased(reply: string): string | null {
  const lines = reply.split("\n").map((line) => line.replace(/^[\s>*\-+]+/, "").replace(/\*+/g, "").trim());
  return lines.find((line) => DISPUTE_PHRASES.some((phrase) => line.toLowerCase().startsWith(phrase.toLowerCase()))) ?? null;
}

/**
 * What of the worker's `replies` disputes a decision: the line it says so in, or the decision line it quotes, or null when it disputes none. `decisions` are the texts the decisions come from (the plan's, the ticket's). PURE.
 */
export function disputedDecision(replies: readonly string[], decisions: readonly (string | null | undefined)[]): string | null {
  const quoted = decisions.flatMap(quotable);
  for (const reply of replies) {
    const said = phrased(reply);
    if (said !== null) return said;
    const flat = plain(reply.replace(/\n/g, " "));
    const hit = quoted.find((line) => flat.includes(line));
    if (hit !== undefined) return hit;
  }
  return null;
}
