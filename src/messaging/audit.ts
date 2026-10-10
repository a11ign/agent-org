// THE AUDIENCE AUDIT (a11ign/a11ign#4746, #928 row 4 of 5; the detector #4437 names): an `announcement` that asks the chairman something, or an `ask` with no row or
// record, is a LEDGER INCIDENT. Without it the channel drifts back into the one chat it replaced ("really hard to keep track of what I'm needed for").
//
//   announcement-question   an announcement whose text ends a line in `?`, or carries a `needs:chairman` / `answer:` / "reply" request marker (the lists below)
//   ask-row                 an ask naming neither a row (`row`) nor the reason its kind has none (`rowLess`): it could not be ticked or listed against anything
//   ask-record              an ask with no `askId`: `foldAsks` could not tell which ask it was
//
// **WHAT IS CHECKED IS WHAT REACHED THE CHAIRMAN.** A `sent` line of an outbound message. A failed or digested line told him nothing yet, an `edited` line is a tick of an ask whose
// first message was checked when it went (and a stall's tick carries no `rowLess`, so checking it would flag every stall), and the digest and the open-asks list are not asks.
//
// **A CURSOR, SO 100 TICKS DO NOT WRITE 100 ENTRIES.** It is a count of the ledger's lines, beside the ledger: the log is append-only, so a line's index is its identity. The
// first run has no cursor and BASELINES at the end rather than auditing from the start: an ask sent before #4745 has no `askId` or `row` and is not a misuse, and a flood of
// them would read as a repeat. The cursor moves only once the entries are written, and `recordFailures` skips a (class, ref) already logged, so a refused append retries.
//
// **THE ENTRY NAMES THE MESSAGE AND THE HALF, AND QUOTES AT MOST `EXCERPT_LENGTH` CHARACTERS** of the text, redacted before it is cut so a token is never shown half.
//
// A recorder never throws into the tick: every refusal goes to `report`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { MESSAGING_AUDIENCE_MISUSE_KIND, recordFailures, type FailureEvent } from "../failure-ledger.ts";
import { ANSWER_PREFIX, NEEDS_CHAIRMAN_LABEL } from "../project-vocabulary.ts";
import { DEFAULT_CONFIG } from "./core.ts";
import { ASKS_LIST_KIND, readLedgerLines, redact, STATUS } from "./ledger.ts";
import { AUDIENCE, AUDIENCES } from "./provider-contract.ts";

/** A text is an ask in an announcement's clothes when it carries any of these (case-insensitive): the project's own labels, read from its vocabulary and not spelled here. */
export const REQUEST_MARKERS: readonly string[] = Object.freeze([NEEDS_CHAIRMAN_LABEL, ANSWER_PREFIX]);
/** "reply" as a word: a request for the chairman to answer in the channel, which is one-way. */
export const REPLY_REQUEST = /\breply\b/i;
export const EXCERPT_LENGTH = 80;

export const HALF = Object.freeze({ question: "announcement-question", row: "ask-row", record: "ask-record" });

type Line = Record<string, any>;
export type Misuse = { half: string; messageRef: string; excerpt: string };
export type AudienceOf = (key: string) => string | undefined;
export type AuditResult = { checked: number; flagged: number; appended: number; refused: string | null; line: string };

const KINDS_WITHOUT_AUDIENCE_SUBJECT = new Set(["digest", ASKS_LIST_KIND]);
const reportToStderr = (line: string) => process.stderr.write(`${line}\n`);
const printToStdout = (line: string) => process.stdout.write(`${line}\n`);

/** Returns the audience a kind declares: what a line written before `audience` existed is classified by (the key's prefix is its kind). */
export const declaredAudience: AudienceOf = (key) => (DEFAULT_CONFIG.kinds as Record<string, { audience: string }>)[key.split(":")[0]]?.audience;

/** Whether the text asks the chairman something: a line ending `?`, a request marker, or the word "reply". */
export function asksSomething(text: string): boolean {
  const lowered = text.toLowerCase();
  const endsInQuestion = text.split(/\r?\n/).some((line) => line.trim().endsWith("?"));
  return endsInQuestion || REQUEST_MARKERS.some((marker) => lowered.includes(marker)) || REPLY_REQUEST.test(text);
}

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/** A delivered outbound message: the only kind of line the chairman was shown. */
function isDelivered(line: Line): boolean {
  return line.direction !== "in" && line.status === STATUS.sent && line.edited !== true && typeof line.key === "string" && !KINDS_WITHOUT_AUDIENCE_SUBJECT.has(line.kind);
}

/** One whitespace-collapsed, redacted, cut excerpt: the entry is one tab-free line, and a secret is never shown half. */
export function excerptOf(text: unknown): string {
  return redact(String(text ?? "")).replace(/\s+/g, " ").trim().slice(0, EXCERPT_LENGTH);
}

function refOf(line: Line): string {
  return nonEmpty(line.providerMessageId) ? line.providerMessageId : `${line.key}@${line.ts}`;
}

/** Returns the audience of a line that is checked, or undefined: a line is audited only when it was delivered and its audience is one of the two. */
function audienceChecked(line: Line, audienceOf: AudienceOf): string | undefined {
  if (!isDelivered(line)) return undefined;
  const audience = line.audience ?? audienceOf(line.key);
  return AUDIENCES.includes(audience) ? audience : undefined;
}

/** @returns the halves this one line fails, none for a line that is not checked */
export function misuseOf(line: Line, audienceOf: AudienceOf = declaredAudience): Misuse[] {
  const audience = audienceChecked(line, audienceOf);
  const failed: string[] = [];
  if (audience === AUDIENCE.announcement && asksSomething(String(line.text ?? ""))) failed.push(HALF.question);
  if (audience === AUDIENCE.ask && !nonEmpty(line.row) && !nonEmpty(line.rowLess)) failed.push(HALF.row);
  if (audience === AUDIENCE.ask && !nonEmpty(line.askId)) failed.push(HALF.record);
  return failed.map((half) => ({ half, messageRef: refOf(line), excerpt: excerptOf(line.text) }));
}

/** Returns how many lines were audited (those that were delivered messages of a known audience) and what they failed. */
export function auditLines(lines: Line[], audienceOf: AudienceOf = declaredAudience): { checked: number; misuses: { misuse: Misuse; at: number | undefined }[] } {
  let checked = 0;
  const misuses: { misuse: Misuse; at: number | undefined }[] = [];
  for (const line of lines) {
    if (audienceChecked(line, audienceOf) === undefined) continue;
    checked += 1;
    const at = Date.parse(line.ts);
    for (const misuse of misuseOf(line, audienceOf)) misuses.push({ misuse, at: Number.isFinite(at) ? at : undefined });
  }
  return { checked, misuses };
}

/** The ledger entry: `<message ref> <half> "<excerpt>"`, one line, with no tab or newline (`parseFailureLedger` throws on one). */
export function eventOf({ misuse, at }: { misuse: Misuse; at: number | undefined }): FailureEvent {
  const ref = `${misuse.messageRef} ${misuse.half} ${JSON.stringify(misuse.excerpt)}`.replace(/[\t\r\n]/g, " ");
  return { classKey: MESSAGING_AUDIENCE_MISUSE_KIND, ref, ...(at === undefined ? {} : { at }) };
}

/** @returns how many ledger lines were audited before, or null when no audit ever ran; a cursor that is not a count throws, so a corrupt one is never read as "start over" */
export function readCursor(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw cause;
  }
  if (!/^\d+$/.test(raw)) throw new Error(`${path} is not a line count: ${raw.slice(0, 40)}`);
  return Number(raw);
}

/** @returns the reason the cursor could not be written, or null: the pass reports it and the next one reads from the old cursor, so nothing is skipped */
function writeCursor(path: string, count: number, report: (line: string) => void): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${count}\n`);
    return null;
  } catch (cause) {
    const reason = String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160);
    report(`messaging audit: cursor NOT WRITTEN: ${reason}`);
    return reason;
  }
}

const countLine = (checked: number, flagged: number) => `messaging audit: ${checked} checked, ${flagged} flagged`;

export type AuditPaths = { ledgerPath: string; failureLogPath: string; cursorPath: string };
export type AuditIo = { now: number; audienceOf?: AudienceOf; report?: (line: string) => void; print?: (line: string) => void };

/**
 * ONE AUDIT PASS over the ledger lines the cursor has not seen. Never throws: an unreadable ledger or cursor is REPORTED and the cursor stays, so the next tick reads again.
 * Prints the count line `messaging audit: n checked, m flagged` only when something was flagged (agent-org#699): a pass that found nothing said it on every tick, and the repeating-line
 * detector read 47 of them as one fault. The reading is not lost, since `AuditResult.line` carries it for a caller that wants it, and a pass that could not do its job still reports why.
 */
export function auditMessaging({ ledgerPath, failureLogPath, cursorPath, now, audienceOf = declaredAudience, report = reportToStderr, print = printToStdout }: AuditPaths & AuditIo): AuditResult {
  const idle = (refused: string | null): AuditResult => ({ checked: 0, flagged: 0, appended: 0, refused, line: countLine(0, 0) });
  let lines: Line[];
  let cursor: number | null;
  try {
    lines = readLedgerLines(ledgerPath);
    cursor = readCursor(cursorPath);
  } catch (cause) {
    const reason = String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160);
    report(`messaging audit: NOT RUN: ${reason}`);
    return idle(reason);
  }
  if (cursor === null) {
    report(`messaging audit: first run, baseline at ${lines.length} earlier lines (not audited: asks before #4745 carry no record)`);
    const refused = writeCursor(cursorPath, lines.length, report);
    return idle(refused);
  }
  if (cursor > lines.length) report(`messaging audit: the ledger holds ${lines.length} lines and the cursor was at ${cursor}; reading it from the start`);
  const { checked, misuses } = auditLines(lines.slice(cursor > lines.length ? 0 : cursor), audienceOf);
  const recorded = recordFailures({ logPath: failureLogPath, events: misuses.map(eventOf), now, report });
  const refused = recorded.refused ?? writeCursor(cursorPath, lines.length, report);
  const line = countLine(checked, misuses.length);
  if (misuses.length > 0) print(line);
  return { checked, flagged: misuses.length, appended: recorded.appended, refused, line };
}
