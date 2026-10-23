// a11ign/agent-org A11-174: READING A RUNNING AGENT'S PANE FOR A CLAUDE CODE PERMISSION OR CONFIRMATION PROMPT, so the pool can answer it No on an unattended run and say so.
//
// Claude Code asks a person before some commands even with permissions bypassed (an `rm` on a path built from a variable that could be empty, A11-160), and nobody answers on an unattended
// run. Two results, and a pane that shows no dialog gives neither:
//   - a SAFETY PROMPT: a dialog whose question starts `Do you want to` and that offers a `No ... (esc)` choice, with the command it asks about and its warning line;
//   - an UNRECOGNISED PROMPT: any other dialog, with its first line. It is left for a person.
// The two start dialogs ("Is this a project you created or one you trust?", "Allow external CLAUDE.md file imports?") have another shape, and their No means exit: the pool answers them Yes
// first (`pool-start.ts`) and they are never read as safety prompts here.
//
// PURE, and a leaf: the dialog reader it builds on (`pane-dialog-read.ts`) imports nothing.
import { isFrame, readDialogLines } from "../pane-dialog-read.ts";

/** The longest command quoted: a pasted script is cut. */
const COMMAND_CHARS = 200;
/** The longest first line the board shows for a prompt it does not recognise. */
const FIRST_LINE_CHARS = 120;

const QUESTION = /^Do you want to\b/;
/** The choice Claude Code draws for No: `No, and tell Claude what to do differently (esc)`. */
const NO_CHOICE = /^No\b.*\(esc\)$/i;
/** The heading of the box a tool asks about: `Bash command`, `Edit file`. The command is under it. */
const TOOL_HEADING = /^(?:Bash command|(?:Edit|Create|Write|Read|Update|Delete) files?|Fetch|Web fetch|Web search|Tool use)$/i;
/** The warning Claude Code gives for an `rm` on a path built from a variable that could be empty. */
export const EMPTY_VARIABLE_WARNING = /possibly-empty variable/i;

export type PanePrompt =
  | { kind: "safety"; command: string; warning: string; firstLine: string }
  | { kind: "unrecognised"; firstLine: string };

const squeeze = (lines: readonly string[], chars: number): string => lines.join(" ").replace(/\s+/g, " ").trim().slice(0, chars);

/** The lines above the question in blocks, nearest the question last: each is a run of lines with no blank line or frame between them. */
function blocksOf(above: readonly string[]): string[][] {
  const blocks: string[][] = [[]];
  for (const line of above) {
    if (line === "" || isFrame(line)) blocks.push([]);
    else blocks[blocks.length - 1].push(line);
  }
  return blocks.filter((block) => block.length > 0);
}

/**
 * The command and the warning of a prompt. The command is the block under the tool's heading, and the warning is the text between it and the question: the blocks after the command,
 * and the paragraph lines above the question's own. A pane whose heading is not on screen has no command to name: the block nearest the question stands for it, with no warning.
 */
function whatIsAsked(above: readonly string[], preface: readonly string[]): { command: string; warning: string } {
  const blocks = blocksOf(above);
  const heading = blocks.findLastIndex((block) => TOOL_HEADING.test(block[0]));
  if (heading < 0) return { command: squeeze(blocks.at(-1) ?? [], COMMAND_CHARS), warning: squeeze(preface, COMMAND_CHARS) };
  const beside = blocks[heading].slice(1);
  const command = beside.length > 0 ? beside : (blocks[heading + 1] ?? []);
  const warned = [...blocks.slice(heading + (beside.length > 0 ? 1 : 2)).flat(), ...preface];
  return { command: squeeze(command, COMMAND_CHARS), warning: squeeze(warned, COMMAND_CHARS) };
}

/**
 * What a running agent's pane shows, or null when it shows no dialog (or could not be read). PURE. @param {string | null} pane
 */
export function readSafetyPrompt(pane: string | null): PanePrompt | null {
  const read = readDialogLines(pane);
  if (read === null) return null;
  const { dialog, paragraph, above } = read;
  const firstLine = paragraph[0].slice(0, FIRST_LINE_CHARS);
  const asked = paragraph.findIndex((line) => QUESTION.test(line));
  if (asked < 0 || !dialog.choices.some((choice) => NO_CHOICE.test(choice))) return { kind: "unrecognised", firstLine };
  return { kind: "safety", ...whatIsAsked(above, paragraph.slice(0, asked)), firstLine };
}

/**
 * The one message that tells the agent what was refused and why. Guard advice for the empty-variable warning, and "another way" for any other prompt. PURE.
 * The warning is quoted when there is one, and the command is named.
 */
export function declineMessage({ command, warning }: { command: string; warning: string }): string {
  const named = command === "" ? "your last command" : `your command \`${command}\``;
  const why = warning === "" ? "." : `: "${warning}".`;
  const advice = EMPTY_VARIABLE_WARNING.test(warning)
    ? 'Guard variable paths with ${VAR:?}, for example rm -rf "${DIR:?}/x", run it again that way, and carry on.'
    : "Do it another way that raises no prompt, and carry on.";
  return `The board answered No to a Claude Code safety prompt on ${named}${why} Nobody answers prompts on an unattended run. ${advice}`;
}
