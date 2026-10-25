// @ts-check
// module: how a pull request's body names its ticket: the `Closes` and `Refs` lines, the `Partial:` line, the closing words the tracker reads anywhere in a body, and the `closes` report that reads them (A11-74, A11-92, A11-127, A11-178, A11-239)
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

/** The words of a body's `Partial:` line, as written, or undefined when it has none. */
const partialWordsOf = (body: string): string | undefined => PARTIAL_LINE.exec(body)?.[1];

/** What the body's `Partial:` line says remains of the ticket, or null when the body declares the pull request complete. PURE. */
const partialOf = (body: string): string | null => declaredRemains(partialWordsOf(body) ?? "");

/** Where a `Partial:` line's leading clause ends: a sentence or clause break, a bracket, or a dash with a space on both sides. */
const CLAUSE_END = /[;.,(]| - | -- | — /;
/** What a worker writes after `Partial:` when nothing remains, each as the whole of a leading clause (A11-239). A later wording is added here. */
const NOTHING_REMAINS: ReadonlySet<string> = new Set(["none", "nothing", "n/a", "na", "nil", "-", "—", "last step", "the last step", "final step", "the final step",
  "nothing remains", "nothing left", "nothing left to do", "nothing more", "no remainder", "none remain", "none remains"]);

/** How many characters of a `Partial:` line a refusal quotes. */
const SHOWN_WORDS = 60;
const cutAt = (text: string, length: number): string => text.length > length ? `${text.slice(0, length)}...` : text;

/**
 * Whether the words of a `Partial:` line say that nothing remains (A11-239): `none; this is the last step.` is no remainder, it is the last step, which closes the ticket. The line's LEADING clause
 * (lower-cased, markdown emphasis stripped, cut at the first break) must be one of {@link NOTHING_REMAINS} in full, after one `this is ` or `it is `. A word inside a real remainder
 * (`none of the UI yet`, `the last step adds the card`) is no match. PURE.
 */
export function saysNothingRemains(words: string): boolean {
  const clause = words.toLowerCase().replace(/[*_`]/g, "").split(CLAUSE_END)[0].trim().replace(/^(?:this|it) is /, "");
  return NOTHING_REMAINS.has(clause);
}

/** What a pull request's body declares of its ticket (A11-181): that it leaves `remains` to do, or that it completes the ticket. */
export type Declaration = Readonly<{ kind: "partial"; remains: string } | { kind: "closes" }>;

/**
 * What one pull request's body declares of the ticket `key`, or null when it declares nothing: the `Partial:` line's words when it has one, whatever closing words the same body carries (a partial body that
 * quoted one is still partial, A11-127); else `closes` when a reference line with the tracker's closing keyword names `key`. `Refs <KEY>` alone, a body that names no ticket, an empty body and a closing
 * keyword of another ticket declare nothing. A `Partial:` line that says nothing remains ({@link saysNothingRemains}) is `closes`, with or without a closing line (A11-239). It reads the grammar `pr:open` and CI's `closes` report read, and adds none (A11-181). PURE.
 */
export function declarationOf(body: string, key: string, keywords: Keywords): Declaration | null {
  if (saysNothingRemains(partialWordsOf(body) ?? "")) return { kind: "closes" };
  const remains = partialOf(body);
  if (remains !== null) return { kind: "partial", remains };
  const closes = referencesIn(body, keywords).some(({ verb, names }) => verb === keywords.closing && names.some((name) => sameKey(name, key)));
  return closes ? { kind: "closes" } : null;
}

/** A ticket's key, as the tracker writes it, inside a longer text. */
const KEY_IN_TEXT = "[A-Za-z][A-Za-z0-9]*-\\d+\\b";

/** Every word `keywords` completes a ticket by anywhere in a body: its `closingWords`, and always its closing keyword, which completes a ticket too (contract 1.5). PURE. */
export const closingWordsOf = ({ closing, closingWords }: Keywords): readonly string[] => [...new Set([closing, ...(closingWords ?? [])].map((word) => word.toLowerCase()))];

/** A closing word read anywhere in a body, the line it is on, and the ticket keys it names, as written. */
export type ClosingMention = Readonly<{ line: string; names: readonly string[] }>;

/**
 * Every closing word of the tracker followed by ticket keys, ANYWHERE in `body` (A11-178): any case, on word boundaries, with an optional colon or markdown between, and a list of keys as the tracker reads it
 * (`Fixes ENG-123, DES-5 and ENG-256`). It reads a code span, a fence and a quoted example as it reads prose, because the tracker's integration does: a pull request that QUOTED `Closes A11-127` in its tests
 * completed A11-127 on merge though it declared itself partial. `referencesIn` reads only the lines a worker writes the ticket on; this reads what the tracker acts on. PURE.
 */
export function closingMentionsIn(body: string, keywords: Keywords): ClosingMention[] {
  const words = closingWordsOf(keywords).map(escapeRegExp).join("|");
  const list = `${KEY_IN_TEXT}(?:[ \\t]*(?:,|&|\\band\\b)[ \\t]*(?:\\band\\b[ \\t]*)?${KEY_IN_TEXT})*`;
  const mention = new RegExp(`\\b(?:${words})\\b[ \\t:*_\`'"(\\[]*(${list})`, "gi");
  return [...body.matchAll(mention)].map(({ 0: found, 1: named, index = 0 }) => ({
    line: lineAt(body, index + found.length - 1).trim(), names: [...named.matchAll(new RegExp(KEY_IN_TEXT, "g"))].map(([name]) => name),
  }));
}

/** The line of `text` that holds the character at `at`. PURE. */
function lineAt(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const end = text.indexOf("\n", at);
  return text.slice(start, end === -1 ? undefined : end);
}

/** Whether two ticket keys are one ticket's, whatever case a body writes them in. PURE. */
const sameKey = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Whether `name` is the key of another ticket of `key`'s team (`A11-31` beside `A11-74`), whatever case a body writes them in. PURE. */
const isTeammate = (name: string, key: string): boolean => !sameKey(name, key) && name.slice(0, name.lastIndexOf("-")).toLowerCase() === key.slice(0, key.lastIndexOf("-")).toLowerCase();

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
 * request merges, so the report says which it found. `Closes: none`, a `Partial:` line that says nothing remains (the last step closes), a closing keyword of any other ticket, a partial pull request that says it is
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
  const words = partialWordsOf(body)?.trim() ?? "";
  if (saysNothingRemains(words)) {
    return refuse(`CLOSES: REFUSED -- the \`Partial:\` line says nothing remains ("${cutAt(words, SHOWN_WORDS)}"). The last step closes the ticket: write \`${closing} ${key}\` and no \`Partial:\` line (A11-239).`);
  }
  const others = closes.flatMap(({ names }) => names).filter((name) => name !== key);
  if (others.length > 0) {
    return refuse(`CLOSES: REFUSED -- \`${closing} ${others.join(", ")}\` names a ticket other than ${key}. \`${closing}\` completes the ticket it names when the pull request `
      + `merges, so only ${key} may be closed here (A11-74).`);
  }
  const mentions = closingMentionsIn(body, keywords);
  // Another ticket is one of this ticket's team: `fixes UTF-8 handling` and `implements ISO-8601` name no ticket, and the tracker acts on none.
  const strays = mentions.filter(({ names }) => names.some((name) => isTeammate(name, key)));
  if (strays.length > 0) {
    const foreign = strays[0].names.filter((name) => isTeammate(name, key));
    return refuse(`CLOSES: REFUSED -- line \`${strays[0].line}\` reads as a closing word followed by ${foreign.join(", ")}, which is not ${key}. The tracker completes the ticket a closing word names `
      + `when the pull request merges, wherever in the body it is, a code span or a quoted example included, so only ${key} may follow one. If it is not a ticket's key, say it in other words (A11-178).`);
  }
  if (closes.some(({ names }) => names.includes(key))) {
    if (partial !== null) {
      return refuse(`CLOSES: REFUSED -- \`${closing} ${key}\` completes the ticket when the pull request merges, but the body also has a \`Partial:\` line. `
        + `Drop the line if this pull request completes ${key}, or write \`${nonClosing} ${key}\` if it does not (A11-92).`);
    }
    return { ok: true, lines: [`CLOSES: ${key} -- \`${closing}\` completes it when the pull request merges`] };
  }
  const quoted = partial === null ? undefined : mentions.find(({ names }) => names.some((name) => sameKey(name, key)));
  if (quoted !== undefined) {
    return refuse(`CLOSES: REFUSED -- the body has a \`Partial:\` line, but line \`${quoted.line}\` reads as a closing word followed by ${key}. The tracker completes the ticket when the pull request `
      + `merges if it finds one anywhere in the body, a code span or a quoted example included, whatever the rest of the body declares. Drop the example, or describe it in words, such as `
      + `"the closing keyword followed by the key"; spelling the word another way is not the fix (A11-178).`);
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

/** A body's `Blocked-by:` line, at the start of a line, with or without a list marker or bold around its label: the ticket keys it names follow. */
const BLOCKED_BY_LINE = /^[ \t]*(?:[-*>][ \t]+)?(?:\*\*|__)?Blocked-by:(?:\*\*|__)?[ \t]*(\S.*)$/gim;

/** The ticket keys a body's `Blocked-by:` lines name, in the order written, each once: `Blocked-by: A11-127, A11-130`. A word that is not a ticket's key is not one. PURE. */
export function blockedByIn(body: string): string[] {
  const words = [...body.matchAll(BLOCKED_BY_LINE)].flatMap(([, rest]) => rest.split(/[\s,;]+/).filter((word) => word !== ""));
  return [...new Set(words.map((word) => REFERENCED.exec(word)?.[1]).filter((name): name is string => name !== undefined && isTicketKey(name)))];
}

/**
 * The ticket that owns a red check a run cannot mend (A11-179), or null when none is named: the first ticket other than the run's own (`key`) that the pull request's `Blocked-by:` line names, else the first
 * key of the run's team that the check's own error lines name (its refusal text: `A11-127 retires this check`). A key of another team in a log is not read, since `UTF-8` and `SHA-256` are written
 * the same way. PURE.
 */
export function ownerOfRed(key: string, body: string, errorLines: readonly string[]): string | null {
  const blocker = blockedByIn(body).find((name) => !sameKey(name, key));
  if (blocker !== undefined) return blocker;
  const named = errorLines.flatMap((line) => [...line.matchAll(new RegExp(KEY_IN_TEXT, "g"))].map(([name]) => name));
  return named.find((name) => isTeammate(name, key)) ?? null;
}
