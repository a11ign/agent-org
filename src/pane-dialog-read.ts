// a11ign/agent-org#463: THE PURE READER OF A PANE'S MENU OR DIALOG, split from `pane-dialog.ts` so ticket mode can read a run's pane without loading the org's row machinery.
// `pane-dialog.ts` imports `worker-state.ts`, and through it the GitHub ticket adapter; this file imports nothing at all, so the pool's decline of a Claude Code
// safety prompt (A11-174, `ticket-mode/safety-prompt.ts`) reads the same dialogs the org's seats do, with the same judgment of what counts as one. `pane-dialog.ts` re-exports it.
//
// See `pane-dialog.ts` for what counts as a dialog and why: (a) a LIVE block, (b) two or more options, (c) a selector or key hint, (d) a question paragraph above it.

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
export const isFrame = (line: string): boolean => line !== "" && FRAME.test(line);
const isMenuTail = (line: string): boolean => line === "" || isFrame(line) || isHint(line);
const isUnnumberedText = (line: Line | null | undefined): boolean => line !== null && line?.number === null && !line?.marker;
const isParagraphLine = (line: string, parsedLine: Line | null | undefined): boolean => line !== "" && !isFrame(line)
  && !(parsedLine?.marker === true || parsedLine?.number != null);

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
    while (at >= 0 && isUnnumberedText(lines[at])) at--;
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

/** A dialog with the lines it was read from: the question's paragraph as the pane draws it, and every line above that paragraph, trimmed. */
export type DialogLines = { dialog: Dialog; paragraph: string[]; above: string[] };

/**
 * Does this pane text show a menu or dialog waiting for a choice? `null` for a text that is not one, and for `null`: a pane that could not be read shows no dialog and is not
 * claimed to show none -- the caller keeps what it knew.
 *
 * PURE. @param {string | null} pane
 * @returns {Dialog | null} the question as the pane words it (its paragraph, joined) and the choices without their numbers or selectors
 */
export const readDialog = (pane: string | null): Dialog | null => readDialogLines(pane)?.dialog ?? null;

/**
 * {@link readDialog} with the lines it was read from, for a caller that needs more of the screen than the question: the paragraph's own lines (the first is the prompt's first
 * line) and the lines above it (a tool's heading and what it asks to run). `readDialog`'s answer is the `dialog` of this one.
 *
 * PURE. @param {string | null} pane
 */
export function readDialogLines(pane: string | null): DialogLines | null {
  if (pane === null) return null;
  const raw = pane.replace(ANSI, "").split("\n").slice(-WINDOW).map(cleaned);
  let end = raw.length - 1;
  let hinted = false;
  // THE TAIL IS ALL THAT MAY FOLLOW A LIVE MENU: blank lines, a frame, its key hints. Anything else (a prompt, a spinner, more output) means the menu is behind us.
  while (end >= 0 && isMenuTail(raw[end])) {
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
  while (at >= 0 && paragraph.length < QUESTION_LINES && isParagraphLine(raw[at], lines[at])) paragraph.unshift(raw[at--].trim());
  if (paragraph.length === 0) return null;

  const choices = run.map((index, position) => {
    const next = position + 1 < run.length ? run[position + 1] : end + 1;
    const continued = raw.slice(index + 1, next).filter((line) => line !== "" && !isFrame(line)).map((line) => line.trim());
    return squeeze([(lines[index] as Line).text, ...continued].join(" "), CHOICE_CHARS);
  });
  return { dialog: { question: squeeze(paragraph.join(" "), QUESTION_CHARS), choices: choices.slice(0, MAX_CHOICES) }, paragraph, above: raw.slice(0, at + 1).map((line) => line.trim()) };
}
