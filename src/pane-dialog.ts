// a11ign/agent-org#463 (epic a11ign/a11ign#4437, class `tool-drift-interactive-prompt`, chairman direction item 3): A PANE SHOWING A MENU OR DIALOG IS AN INCIDENT ON THE VERY NEXT TICK,
// RAISED TO THE SEAT THAT OWNS THE SESSION, AND NEVER LEFT.
//
// WHY THE GATE COULD NOT SEE IT. On 2026-10-09 `reviewer-lab-45` sat on a Codex dialog ("Background server has incompatible feature settings. This session requires
// api_key_model_discovery to be disabled", three choices) until the chairman happened to look. herdr's `agent_status` is a classifier over the output and the tick reads a pane for the
// words `idle` and `blocked`; nothing read the pane for "this is waiting for a CHOICE". `BLOCKED` is the nearest existing case and it is a status, not a reading.
//
// THREE PIECES, AND ONLY THE FIRST NEEDS A PANE:
//   1. `readDialog(text)`: pane text in, the question and the choices out, or `null`. A function of the text alone, so it is tested on text.
//   2. `raisePaneDialogs`: over every live session's pane, ONE order per dialog to the seat that owns the session; the same text on the next tick raises nothing, a changed text raises again.
//   3. `dialogOrder`: the order's text, whose `Class:` line is what `prompt:session` records the incident under in the failure ledger (`recordFailure`), as `trace/freshness.ts` does.
//
// WHAT COUNTS AS A DIALOG IS A JUDGMENT, AND THE TEST SAMPLES IT. A numbered list in ordinary output is not one, and a reader that fires on every `1. 2. 3.` is an incident every tick
// that nobody answers, which is the same as no detector. So a dialog is all of: (a) a LIVE block, nothing after it but blank lines, borders and key hints, so a list the output has moved
// past is not read; (b) two or more options, numbered from 1 or selector-marked; (c) the signature of a menu waiting on a key, a `›`/`❯` selector or a key hint ("Press enter to
// confirm", "Esc to cancel"); (d) a question paragraph above it, which is what the order quotes. The two TUIs this org runs draw them as `› 1. Yes` (Codex) and `❯ 1. Yes` (Claude Code).
//
// A LEAF: `node:` imports and two small leaves. The seams that need a project (herdr, the queue, the clock) are the caller's.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TOOL_DRIFT_KIND } from "./agent-tool-update.ts";
import { DEFAULT_ANSWERER, isLimitMenu, isWorkerSession } from "./worker-state.ts";

/** Which dialog each session was last raised for, by label. Beside the blocked-told memory in the state directory. */
export const PANE_DIALOG_RAISED_FILE = "pane-dialog-raised.json";

/** The pane lines read: the dialog is at the bottom of the screen, so the tail is enough and a long scrollback is not parsed. */
const WINDOW = 60;
const QUESTION_LINES = 4;
const QUESTION_CHARS = 300;
const CHOICE_CHARS = 120;
const MAX_CHOICES = 8;

export type Dialog = { question: string; choices: string[] };

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** A line that is only a frame: box drawing, rules. Blank lines are `""` and are tested separately. */
const FRAME = /^[\s─━═│┃┌┐└┘╭╮╰╯├┤┬┴┼\-_=+|]+$/;
/** The footer a menu draws under its options. `esc to interrupt` is a WORKING pane, not a menu, and is deliberately absent. */
const HINTS: readonly RegExp[] = [
  /\b(?:press )?enter to (?:confirm|select|continue|accept|submit|choose)\b/i,
  /\besc(?:ape)? to (?:cancel|go back|exit|dismiss|close)\b/i,
  /(?:↑|↓|up\/down|arrow keys?)[^\n]{0,30}(?:navigate|select|choose|move)/i,
  /\buse (?:the )?arrow keys\b/i,
];
/** `[indent][selector + spaces][number + . or ) + spaces]text`. A bare `>` is a selector only before a number, because `> text` is a quotation. */
const LINE = /^( *)(?:([›❯▶➤]|>(?=\s+\d{1,2}[.)]\s))( +))?(?:(\d{1,2})[.)]( +))?(\S.*?)\s*$/;

type Line = { indent: number; col: number; marker: boolean; number: number | null; text: string };

const isHint = (line: string): boolean => HINTS.some((hint) => hint.test(line));
const isFrame = (line: string): boolean => line !== "" && FRAME.test(line);

/** One pane line with its frame's side bars and trailing blanks off, and its indentation kept: the options of one menu are aligned. */
function cleaned(raw: string): string {
  return raw.replace(/\t/g, "  ").replace(/^(\s*)[│┃]/, "$1 ").replace(/[│┃]\s*$/, "").replace(/\s+$/, "");
}

function parsed(line: string): Line | null {
  const match = LINE.exec(line);
  if (match === null) return null;
  const [, spaces, marker, gap = "", number, , text] = match;
  return { indent: spaces.length, col: spaces.length + (marker === undefined ? 0 : marker.length + gap.length), marker: marker !== undefined,
    number: number === undefined ? null : Number(number), text };
}

const squeeze = (text: string, chars: number): string => text.replace(/\s+/g, " ").trim().slice(0, chars);

/** A line below an option that continues it: not blank, not itself an option, and indented past it. */
const continues = (line: Line | null, option: Line): boolean => line !== null && line.number === null && !line.marker && line.indent > option.indent;

/** `1. a` `2. b` ... `n. z` ending at or above `end`, nothing but continuations between its last line and `end`. @returns the option lines' indices, first to last, or `null` */
function numberedRun(lines: (Line | null)[], end: number): number[] | null {
  let last = end;
  while (last >= 0 && lines[last]?.number == null) last--;
  if (last < 0) return null;
  const lastLine = lines[last] as Line;
  for (let at = last + 1; at <= end; at++) if (!continues(lines[at], lastLine)) return null;
  const found = [last];
  for (let want = (lastLine.number as number) - 1, at = last - 1; want >= 1; want--) {
    while (at >= 0 && lines[at] !== null && lines[at]?.number === null && !lines[at]?.marker) at--;
    const line = at >= 0 ? lines[at] : null;
    if (line === null || line === undefined || line.number !== want) return null;
    for (let between = at + 1; between < found[0]; between++) if (!continues(lines[between], line)) return null;
    found.unshift(at--);
  }
  return found.length >= 2 ? found : null;
}

/** A `›`-marked line with no number and at least one sibling aligned under its text, ending at `end`. @returns the option lines' indices, or `null` */
function selectorRun(lines: (Line | null)[], end: number): number[] | null {
  let at = end;
  while (at >= 0 && !(lines[at]?.marker === true && lines[at]?.number === null)) at--;
  if (at < 0) return null;
  const selected = lines[at] as Line;
  const aligned = (line: Line | null): boolean => line !== null && !line.marker && line.number === null && line.indent === selected.col;
  for (let below = at + 1; below <= end; below++) if (!aligned(lines[below])) return null;
  let first = at;
  while (first > 0 && aligned(lines[first - 1])) first--;
  const run = Array.from({ length: end - first + 1 }, (_, i) => first + i);
  return run.length >= 2 ? run : null;
}

/**
 * Does this pane text show a menu or dialog waiting for a choice? `null` for a text that is not one, and for `null`: a pane that could not be read shows no dialog and is not
 * claimed to show none -- the caller keeps what it knew.
 *
 * PURE. @param {string | null} pane
 * @returns {Dialog | null} the question as the pane words it (its paragraph, joined) and the choices without their numbers or selectors
 */
export function readDialog(pane: string | null): Dialog | null {
  if (pane === null) return null;
  const raw = pane.replace(ANSI, "").split("\n").slice(-WINDOW).map(cleaned);
  let end = raw.length - 1;
  let hinted = false;
  // THE TAIL IS ALL THAT MAY FOLLOW A LIVE MENU: blank lines, a frame, its key hints. Anything else (a prompt, a spinner, more output) means the menu is behind us.
  while (end >= 0 && (raw[end] === "" || isFrame(raw[end]) || isHint(raw[end]))) {
    if (isHint(raw[end])) hinted = true;
    end--;
  }
  if (end < 0) return null;
  const lines = raw.map((line) => (line === "" || isFrame(line) ? null : parsed(line)));
  const numbered = numberedRun(lines, end);
  const run = numbered ?? selectorRun(lines, end);
  if (run === null) return null;
  // A numbered list needs a selector on one of its lines OR a key hint under it; a bare selector list needs the hint (`› Ask Codex to do anything` over `? for shortcuts` is an idle prompt).
  const selector = numbered !== null && run.some((at) => lines[at]?.marker === true);
  if (!selector && !hinted) return null;

  const start = run[0];
  let at = start - 1;
  for (let skipped = 0; skipped < 2 && at >= 0 && (raw[at] === "" || isFrame(raw[at])); skipped++) at--;
  const paragraph: string[] = [];
  while (at >= 0 && paragraph.length < QUESTION_LINES && raw[at] !== "" && !isFrame(raw[at]) && !(lines[at]?.marker === true || lines[at]?.number != null)) paragraph.unshift(raw[at--].trim());
  if (paragraph.length === 0) return null;

  const choices = run.map((index, position) => {
    const next = position + 1 < run.length ? run[position + 1] : end + 1;
    const continued = raw.slice(index + 1, next).filter((line) => line !== "" && !isFrame(line)).map((line) => line.trim());
    return squeeze([(lines[index] as Line).text, ...continued].join(" "), CHOICE_CHARS);
  });
  return { question: squeeze(paragraph.join(" "), QUESTION_CHARS), choices: choices.slice(0, MAX_CHOICES) };
}

/** What a dialog IS, for "has the text changed": the question and the choices, never the rest of the pane (a clock or a spinner elsewhere on the screen is not a new dialog). */
export function dialogSignature(dialog: Dialog): string {
  return createHash("sha1").update(`${dialog.question}\n${dialog.choices.join("\n")}`).digest("hex").slice(0, 12);
}

/**
 * THE SEAT THAT OWNS A SESSION, which is the seat the org already names for it: a `reviewer-<n>` and a `worker-<n>` are re-prompted by the first reader for rows
 * (`DEFAULT_ANSWERER`, `product-manager`), and a standing seat owns its own pane.
 * @param {string} label @returns {string}
 */
export function dialogOwner(label: string): string {
  return isWorkerSession(label) || /^reviewer-/.test(label) ? DEFAULT_ANSWERER : label;
}

/**
 * The order. `Class:` alone on its first line is the token `prompt:session` records the order under in the failure ledger, so the incident is one `recordFailure` line of kind
 * `tool-drift-interactive-prompt` when the order is accepted (delivered or queued) and none when it is refused, which the tick retries. It quotes the question and the choices
 * and says which pane to read, and for a seat that owns its own pane it says so rather than telling it to message itself.
 * @param {{ label: string, owner: string, dialog: Dialog }} what @returns {string}
 */
export function dialogOrder({ label, owner, dialog }: { label: string; owner: string; dialog: Dialog }): string {
  const read = `\`herdr --session org agent read ${label} --source recent\``;
  return `Class: ${TOOL_DRIFT_KIND}\n\n`
    + `INCIDENT: ${label} is showing a menu or dialog that is waiting for a choice, and nobody is answering it (a11ign/a11ign#4437: an agent session never meets a dialog).\n`
    + `Question: ${dialog.question}\n`
    + `Choices:\n${dialog.choices.map((choice, i) => `  ${i + 1}. ${choice}`).join("\n")}\n`
    + `Pane: ${label}; read it with ${read}.\n`
    + (owner === label
      ? "This is your own pane and you own it: answer the dialog, then say on the row what chose it and why.\n"
      : `Owner: you (${owner}). Answer the dialog in ${label}'s pane (or re-prompt or restart that session), and say on the row what chose it. `
        + "This is raised once for this text and again only if the text changes.\n");
}

export type Memory = Record<string, string>;

/** The memory, or `{}` for a file that is absent or unreadable: an unread memory is "raised nothing", and a repeat order is a nuisance where a lost one is the stall this ends. */
export function readRaised(path: string, read: (path: string) => string = (file) => readFileSync(file, "utf8")): Memory {
  try {
    const parsedFile: unknown = JSON.parse(read(path));
    if (parsedFile === null || typeof parsedFile !== "object" || Array.isArray(parsedFile)) return {};
    return Object.fromEntries(Object.entries(parsedFile).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/** Written only when it changed, by rename, so a tick killed mid-write leaves the old memory and not half of a new one. */
export function writeRaised(path: string, before: Memory, after: Memory): void {
  if (JSON.stringify(Object.entries(before).sort()) === JSON.stringify(Object.entries(after).sort())) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(after)}\n`);
  renameSync(`${path}.tmp`, path);
}

export type Raising = {
  /** the memory to keep */
  raised: Memory;
  /** sessions an order was accepted for this tick */
  sent: { label: string; owner: string; dialog: Dialog }[];
  /** sessions whose dialog the order could not be accepted for: not remembered, so the next tick tries again */
  refused: string[];
  /** sessions whose pane could not be read: their memory is kept as it was */
  unread: string[];
};

/**
 * ONE ORDER PER DIALOG, DECIDED FROM THE PANES AND THE MEMORY.
 *   - a session showing a dialog it was not raised for (or a different text of one) is ordered to its owner and remembered once the order is accepted;
 *   - the same dialog on the next tick raises nothing;
 *   - a session whose pane READS and shows no dialog is forgotten, so the same dialog meeting it later is a new incident;
 *   - the usage-limit menu is read as showing no dialog (agent-org#1481): the dated account wait and `limitMenuTick` own that screen, and an order here would offer "switch to usage credits" to a manager on every seat of the account;
 *   - a pane that could not be read keeps what was known: absence of a reading is not a reading of absence;
 *   - a session no longer listed is forgotten.
 * `order` returns whether the owner's order was accepted (delivered or queued) and may throw: a throw is a refusal.
 *
 * @param {{ roster: {label: string}[], read: (label: string) => string | null, memory: Memory, order: (owner: string, text: string) => boolean, report?: (line: string) => void }} tick
 */
export function raisePaneDialogs({ roster, read, memory, order, report = () => {} }: {
  roster: readonly { label: string }[]; read: (label: string) => string | null; memory: Memory;
  order: (owner: string, text: string) => boolean; report?: (line: string) => void;
}): Raising {
  const raising: Raising = { raised: {}, sent: [], refused: [], unread: [] };
  for (const { label } of roster) {
    const pane = read(label);
    if (pane === null) {
      raising.unread.push(label);
      if (label in memory) raising.raised[label] = memory[label];
      continue;
    }
    if (isLimitMenu(pane)) continue;
    const dialog = readDialog(pane);
    if (dialog === null) continue;
    const signature = dialogSignature(dialog);
    if (memory[label] === signature) {
      raising.raised[label] = signature;
      continue;
    }
    const owner = dialogOwner(label);
    let accepted = false;
    try {
      accepted = order(owner, dialogOrder({ label, owner, dialog }));
    } catch (err) {
      report(`PANE DIALOG ${label}: the order to ${owner} could not be sent (${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 160)}); it is tried again next tick.`);
    }
    if (accepted) {
      raising.raised[label] = signature;
      raising.sent.push({ label, owner, dialog });
    } else {
      raising.refused.push(label);
      if (label in memory) raising.raised[label] = memory[label];
    }
  }
  return raising;
}
