// a11ign/agent-org A11-174, A11-209: READING A RUNNING AGENT'S PANE FOR A CLAUDE CODE PERMISSION OR CONFIRMATION PROMPT, so the pool can answer it No on an unattended run and say so.
//
// Claude Code asks a person before some commands even with permissions bypassed (an `rm` on a path built from a variable that could be empty, A11-160), and nobody answers on an unattended
// run. Two results, and a pane that shows no dialog gives neither:
//   - a SAFETY PROMPT: a dialog whose question starts `Do you want to` and that offers a `No` choice, with the command it asks about and its warning line, and, for a subagent's,
//     the subagent's name. Older Claude Code drew `No ... (esc)`; 2.1.310 draws a bare `No`, which counts only under a tool's heading (A11-209);
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
/** The choice older Claude Code draws for No: `No, and tell Claude what to do differently (esc)`. */
const NO_CHOICE_ESC = /^No\b.*\(esc\)$/i;
/** The choice Claude Code 2.1.310 draws for No: a bare `No`. It is a safety prompt's only under a tool's heading, because the start dialogs' No means exit. */
const NO_CHOICE = /^No\b/i;
/**
 * The heading of the box a tool asks about: `Bash command`, `Edit file`. The command is under it. A subagent's tool call adds ` · from the <name> agent`, and `<name>` is kept.
 */
const TOOL_HEADING = /^(?:Bash command|(?:Edit|Create|Write|Read|Update|Delete) files?|Fetch|Web fetch|Web search|Tool use)(?: · from the (.+?) agent)?$/i;
/** A line that is only a dashed rule, which 2.1.310 draws above and below the command. */
const RULE = /^[╌╍┄┅┈┉╎╏\s]+$/;
/** The line 2.1.310 adds to a dialog that has sat a while: it is neither the command nor the warning. */
const AUTO_DENY_NOTICE = /^⚠.*automatically deny/i;
/** The warning Claude Code gives for an `rm` on a path built from a variable that could be empty. */
export const EMPTY_VARIABLE_WARNING = /possibly-empty variable/i;
/** The warning Claude Code gives for an `rm` on a path it cannot resolve before the command runs, such as `*` after `cd "$S/x"` (A11-209). */
const UNRESOLVABLE_TARGET_WARNING = /statically-unresolvable target/i;

export type PanePrompt =
  | { kind: "safety"; command: string; warning: string; firstLine: string; agent?: string }
  | { kind: "unrecognised"; firstLine: string };

const squeeze = (lines: readonly string[], chars: number): string => lines.join(" ").replace(/\s+/g, " ").trim().slice(0, chars);

/** A run of lines with no blank line, frame or dashed rule between them. `ruled` is whether a dashed rule closes it. */
type Block = { lines: string[]; ruled: boolean };

/** The lines above the question in blocks, nearest the question last. */
function blocksOf(above: readonly string[]): Block[] {
  const blocks: Block[] = [{ lines: [], ruled: false }];
  for (const line of above) {
    if (RULE.test(line)) blocks[blocks.length - 1].ruled = true;
    if (line === "" || isFrame(line) || RULE.test(line)) blocks.push({ lines: [], ruled: false });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks.filter((block) => block.lines.length > 0);
}

/**
 * The command and the warning of a prompt, and the subagent that raised it. The command is the block under the tool's heading, and the warning is the text between it and the question:
 * the blocks after the command, and the paragraph lines above the question's own. 2.1.310 puts a description under the heading, closed by a dashed rule, and the command between two
 * rules: then the description is not the command. A pane whose heading is not on screen has no command to name: the block nearest the question stands for it, with no warning.
 * `headed` is whether the tool's heading was found.
 */
function whatIsAsked(above: readonly string[], preface: readonly string[]): { command: string; warning: string; agent?: string; headed: boolean } {
  const blocks = blocksOf(above);
  const heading = blocks.findLastIndex((block) => TOOL_HEADING.test(block.lines[0]));
  if (heading < 0) return { command: squeeze(blocks.at(-1)?.lines ?? [], COMMAND_CHARS), warning: squeeze(preface, COMMAND_CHARS), headed: false };
  const beside = blocks[heading].lines.slice(1);
  const inline = beside.length > 0 && !blocks[heading].ruled;
  const command = inline ? beside : (blocks[heading + 1]?.lines ?? []);
  const warned = [...blocks.slice(heading + (inline ? 1 : 2)).flatMap((block) => block.lines), ...preface].filter((line) => !AUTO_DENY_NOTICE.test(line));
  const agent = TOOL_HEADING.exec(blocks[heading].lines[0])?.[1];
  return { command: squeeze(command, COMMAND_CHARS), warning: squeeze(warned, COMMAND_CHARS), headed: true, ...(agent === undefined ? {} : { agent }) };
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
  if (asked < 0) return { kind: "unrecognised", firstLine };
  const { headed, ...what } = whatIsAsked(above, paragraph.slice(0, asked));
  const declinable = dialog.choices.some((choice) => NO_CHOICE_ESC.test(choice)) || (headed && dialog.choices.some((choice) => NO_CHOICE.test(choice)));
  return declinable ? { kind: "safety", ...what, firstLine } : { kind: "unrecognised", firstLine };
}

const GUARD_ADVICE = 'Guard variable paths with ${VAR:?}, for example rm -rf "${DIR:?}/x", run it again that way, and carry on.';
const EXPLICIT_PATH_ADVICE = 'Name an explicit path guarded with ${VAR:?}, for example rm -rf "${S:?}/x", never a bare * after cd, run it again that way, and carry on.';
const SUBAGENT_ADVICE = "Subagents follow the same rules on an unattended run: tell your subagent, or run the command yourself, guarded.";

/** The advice for the warning: guard a path that could be empty, name an explicit path where one cannot be resolved, and "another way" for any other prompt. PURE. */
function adviceFor(warning: string): string {
  if (EMPTY_VARIABLE_WARNING.test(warning)) return GUARD_ADVICE;
  return UNRESOLVABLE_TARGET_WARNING.test(warning) ? EXPLICIT_PATH_ADVICE : "Do it another way that raises no prompt, and carry on.";
}

/**
 * The one message that tells the agent what was refused and why. Guard advice for the empty-variable warning, an explicit guarded path for the unresolvable-target one, and "another way"
 * for any other prompt. PURE. The warning is quoted when there is one, and the command is named. A subagent's prompt names the subagent and says it follows the same rules (A11-209).
 */
export function declineMessage({ command, warning, agent }: { command: string; warning: string; agent?: string }): string {
  const subagent = `your \`${agent}\` subagent`;
  const named = agent === undefined
    ? (command === "" ? "your last command" : `your command \`${command}\``)
    : (command === "" ? `the last command ${subagent} ran` : `the command \`${command}\` that ${subagent} ran`);
  const why = warning === "" ? "." : `: "${warning}".`;
  return `The board answered No to a Claude Code safety prompt on ${named}${why} Nobody answers prompts on an unattended run. ${adviceFor(warning)}${agent === undefined ? "" : ` ${SUBAGENT_ADVICE}`}`;
}
