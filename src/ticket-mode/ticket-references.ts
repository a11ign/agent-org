// @ts-check
// module: how a pull request's body names its ticket: the `Closes` and `Refs` lines, the `Partial:` line, and the `closes` report that reads them (A11-74, A11-92, A11-127)
//
// A LEAF, ON PURPOSE. `pr-open-ticket.ts` imports `CI_BODY_REPORTS` from the acceptance module, and CI's own `closes` report must read a ticket's declaration with the same
// grammar `pr:open` does. Were the grammar left in `pr-open-ticket.ts`, the acceptance module would import it back and the two would form a cycle. So both import this file,
// and there is one grammar, not two.
import { declaredRemains } from "./queue/queue-entries-and-outcomes.ts";
import type { Keywords } from "../plugins/contracts/tracker.ts";

/** A `Closes` or `Refs` line, at the start of a line, as a worker writes it, with or without bold around its verb: the tracker's two words. */
const referenceLine = ({ closing, nonClosing }: Keywords): RegExp => new RegExp(
  `^[ \\t]*(?:[-*>][ \\t]+)?(?:\\*\\*|__)?(${escapeRegExp(closing)}|${escapeRegExp(nonClosing)})(?:\\*\\*|__)?:?(?:\\*\\*|__)?[ \\t]+(\\S.*)$`, "gm");
const escapeRegExp = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A ticket's key, or a pull request's `#N`, as one word of a reference, with the markdown or punctuation a worker wraps it in. */
const REFERENCED = /^[*_`(]*([A-Za-z][A-Za-z0-9]*-\d+|#\d+)[*_`).,;:]*$/;
/** A body's `Partial:` line: what remains of the ticket after a partial pull request. A placeholder, or no words, is no declaration. */
const PARTIAL_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?Partial:(?:\*\*|__)?[ \t]*(\S.*)$/m;

/** What the body's `Partial:` line says remains of the ticket, or null when the body declares the pull request complete. PURE. */
const partialOf = (body: string): string | null => declaredRemains(PARTIAL_LINE.exec(body)?.[1] ?? "");

/** A body's `Closes` and `Refs` lines: each verb, the first word after it, and the ticket keys or pull request numbers its words name. */
export function referencesIn(body: string, keywords: Keywords): { verb: string; first: string; names: string[]; }[] {
  // A reason after a dash is not a name, and a word that is not a key is not one either: `Closes A11-74 (done-when met)` names A11-74.
  return [...body.matchAll(referenceLine(keywords))].map(([, verb, rest]) => {
    const words = rest.split(/\s(?:--|—)\s/)[0].split(/[\s,;]+/).filter((word) => word !== "");
    return { verb, first: words[0] ?? "", names: words.map((word) => REFERENCED.exec(word)?.[1]).filter((name): name is string => name !== undefined) };
  });
}

/**
 * THE `closes` REPORT FOR A TICKET, replacing a row's: the body names its ticket with the tracker's closing keyword when the pull request completes it,
 * or with its non-closing keyword and a `Partial: <what remains>` line when it is partial (A11-92). The closing keyword completes the ticket when the pull
 * request merges, so the report says which it found. `Closes: none`, a closing keyword of any other ticket, a partial pull request that says it is
 * complete, and a body that names no ticket are refused. A non-closing keyword of another ticket is no refusal.
 * @param {string} body @param {string} key the ticket's key @param {Keywords} keywords the tracker's two words
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function ticketClosesReport(body: string, key: string, keywords: Keywords): { ok: boolean; lines: string[]; } {
  const { closing, nonClosing } = keywords;
  const references = referencesIn(body, keywords);
  const closes = references.filter(({ verb }) => verb === closing);
  const partial = partialOf(body);
  if (closes.some(({ first }) => first.toLowerCase() === "none")) {
    return refuse(`CLOSES: REFUSED -- \`${closing}: none\` is not a ticket's pull request's declaration. Name ${key} with \`${closing} ${key}\` when this pull request `
      + `completes it, or with \`${nonClosing} ${key}\` and a \`Partial:\` line when it does not (A11-74, A11-92).`);
  }
  const others = closes.flatMap(({ names }) => names).filter((name) => name !== key);
  if (others.length > 0) {
    return refuse(`CLOSES: REFUSED -- \`${closing} ${others.join(", ")}\` names a ticket other than ${key}. \`${closing}\` completes the ticket it names when the pull request `
      + `merges, so only ${key} may be closed here (A11-74).`);
  }
  if (closes.some(({ names }) => names.includes(key))) {
    if (partial !== null) {
      return refuse(`CLOSES: REFUSED -- \`${closing} ${key}\` completes the ticket when the pull request merges, but the body also has a \`Partial:\` line. `
        + `Drop the line if this pull request completes ${key}, or write \`${nonClosing} ${key}\` if it does not (A11-92).`);
    }
    return { ok: true, lines: [`CLOSES: ${key} -- \`${closing}\` completes it when the pull request merges`] };
  }
  if (references.some(({ names }) => names.includes(key))) {
    if (partial === null) {
      return refuse(`CLOSES: REFUSED -- \`${nonClosing} ${key}\` links the ticket and does not complete it, and the body has no \`Partial:\` line. Write \`${closing} ${key}\` `
        + `if this pull request completes ${key}, or add \`Partial: <what remains>\` if it does not (A11-92).`);
    }
    return { ok: true, lines: [`CLOSES: ${key} -- \`${nonClosing}\` links it and does not complete it: the pull request is partial, and ${partial} remains`] };
  }
  return refuse(`CLOSES: MISSING -- the body names no ticket: write \`${closing} ${key}\` when this pull request completes it, or \`${nonClosing} ${key}\` with a `
    + `\`Partial:\` line when it does not (A11-74, A11-92).`);
}


export const refuse = (line: string): { ok: boolean; lines: string[]; } => ({ ok: false, lines: [line] });

/** A ticket's key as the tracker writes it (`A11-127`), and nothing else: not a pull request's `#N`, which `REFERENCED` also reads. */
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Whether a word is a ticket's key in full, as the tracker writes it. PURE. */
export const isTicketKey = (word: string): boolean => TICKET_KEY.test(word);

/** The ticket key a reference's first word names, markdown and punctuation around it ignored, or undefined when that word is no ticket's key. */
const keyOfFirstWord = (word: string): string | undefined => {
  const name = REFERENCED.exec(word)?.[1];
  return name !== undefined && isTicketKey(name) ? name : undefined;
};

/**
 * THE `closes` REPORT IN CI, where no ticket is known to compare with: the same report as `ticketClosesReport`, for the one ticket the body names. A reference names a
 * ticket by its FIRST word, as a worker writes it (`Closes A11-127`), so `Closes the SHA-256 bug` names none. That ticket is the one the first closing line names, else the
 * first a non-closing line does. Null, so the row report's verdict stands, when the body names no ticket, or when any closing line names something else first: a row's
 * `#N` (a row that was tried and got wrong must not be read past), `none`, or prose. PURE.
 * @param {string} body @param {Keywords} keywords the tracker's two words
 * @returns {{ ok: boolean, lines: string[] } | null}
 */
export function namedTicketClosesReport(body: string, keywords: Keywords): { ok: boolean; lines: string[]; } | null {
  const references = referencesIn(body, keywords).map(({ verb, first }) => ({ verb, key: keyOfFirstWord(first) }));
  const closing = references.filter(({ verb }) => verb === keywords.closing);
  if (closing.some(({ key }) => key === undefined)) return null;
  const key = (closing[0] ?? references.find(({ key: named }) => named !== undefined))?.key;
  return key === undefined ? null : ticketClosesReport(body, key, keywords);
}
