// module: the questions onboard asks at a terminal that a line of typing cannot answer well (A11-186) -- pick several from a list, answer yes or no, edit a prefilled line
//
// THE SEAM IS THREE CALLS, so `onboard-repos.ts` imports no library and its tests stub `Prompts` with a script. `clackPrompts` is the one implementation. A yes or no and a prefilled line are `@clack/prompts` 1.8.1's,
// made with `withGuide: false`, so their output is plain lines with no bar down the left (A11-185's readable style).
//
// A LIST IS AGENT-ORG'S OWN (A11-222), for both kinds, because clack's cannot be made to read as a picker: its filtered list ticks with Space only after an arrow key has moved (before that Space is typed into the filter, so Tab
// was the only key) and it hard-codes its hint lines. The keys here are the convention of every terminal picker: arrows move, SPACE TICKS AND UNTICKS THE HIGHLIGHTED ITEM ALWAYS (a filter never takes a space: a repository's
// name has none), Enter confirms. In a filtered list printable keys edit the filter and Backspace deletes; Tab ticks as well. It reads Node's own `readline` keypresses, which are the same in macOS Terminal, iTerm and Linux
// terminals, and draws ASCII marks where the terminal has no Unicode. A cancel (Ctrl-C or Esc) is thrown as {@link PromptCancelled}.
import { createInterface, emitKeypressEvents, type Key } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { confirm, isCancel, text, unicode } from "@clack/prompts";

/** One line of a list: what it answers, how it reads, and a hint shown beside it. */
export type Choice<V> = Readonly<{ value: V; label: string; hint?: string }>;

/** A list to pick from: those in `ticked` start ticked, `filter` lets the person type to narrow it, and `required` refuses an empty answer. */
export type PickQuestion<V extends string> = Readonly<{ message: string; choices: readonly Choice<V>[]; ticked: readonly V[]; filter: boolean; required: boolean }>;

export interface Prompts {
  /** Pick any number of the choices. @returns the ticked values, in the list's order */
  pickMany<V extends string>(question: PickQuestion<V>): Promise<V[]>;
  confirm(question: { message: string; initial: boolean }): Promise<boolean>;
  /** A line that starts as `initial`: enter accepts it. */
  text(question: { message: string; initial: string }): Promise<string>;
}

/** The person stopped a prompt (Ctrl-C or Esc). */
export class PromptCancelled extends Error {
  constructor() {
    super("the prompt was cancelled");
  }
}

const HINT = "↑↓ move · space select · enter confirm";
const FILTER_HINT = `${HINT} · type to filter`;
const NONE_TICKED = "Nothing is ticked: press space on an item, then enter.";
/** The most choices drawn at once; a longer list scrolls with the highlight. */
const WINDOW = 10;
/** Past this many ticked labels the answer is shown as a count. */
const LABELS_SHOWN = 3;

const marks = unicode ? { on: "◼", off: "◻", pointer: "›", more: "…" } : { on: "[x]", off: "[ ]", pointer: ">", more: "..." };

/** What a key does to a list. */
type KeyAction = "cancel" | "submit" | "up" | "down" | "toggle" | "erase" | { typed: string } | null;

function actionOf(str: string | undefined, key: Key | undefined): KeyAction {
  if (key?.ctrl && key.name === "c") return "cancel";
  switch (key?.name) {
    case "escape": return "cancel";
    case "return": case "enter": return "submit";
    case "up": return "up";
    case "down": return "down";
    case "space": case "tab": return "toggle";
    case "backspace": return "erase";
    default: break;
  }
  const printable = str !== undefined && str.length === 1 && str >= " " && str !== "\x7f" && !key?.ctrl && !key?.meta;
  return printable ? { typed: str } : null;
}

/** A list as the person sees it: what is highlighted, ticked and typed. The values it holds are the question's, so a tick survives a change of filter. */
class ListModel<V extends string> {
  private cursor = 0;
  private filter = "";
  private readonly ticked: Set<V>;
  error: string | null = null;

  private readonly question: PickQuestion<V>;

  constructor(question: PickQuestion<V>) {
    this.question = question;
    this.ticked = new Set(question.ticked);
  }

  /** The choices the filter lets through, in the list's order. */
  matches(): readonly Choice<V>[] {
    const needle = this.filter.toLowerCase();
    return needle === "" ? this.question.choices : this.question.choices.filter(({ label, value }) => `${label}\n${value}`.toLowerCase().includes(needle));
  }

  /** Typing and erasing edit the filter, which a plain list does not have: for it they do nothing. */
  press(action: Exclude<KeyAction, "cancel" | "submit" | null>): void {
    this.error = null;
    const shown = this.matches();
    if ((action === "erase" || typeof action === "object") && !this.question.filter) return;
    if (action === "up") this.cursor = shown.length === 0 ? 0 : (this.cursor + shown.length - 1) % shown.length;
    else if (action === "down") this.cursor = shown.length === 0 ? 0 : (this.cursor + 1) % shown.length;
    else if (action === "toggle") this.toggle(shown[this.cursor]);
    else this.edit(action === "erase" ? this.filter.slice(0, -1) : this.filter + action.typed);
  }

  private toggle(choice: Choice<V> | undefined): void {
    if (choice === undefined) return;
    if (!this.ticked.delete(choice.value)) this.ticked.add(choice.value);
  }

  private edit(filter: string): void {
    this.filter = filter;
    this.cursor = 0;
  }

  /** The ticked values in the list's order; a required list with none ticked says so and returns null. */
  submit(): V[] | null {
    const picked = this.question.choices.filter(({ value }) => this.ticked.has(value)).map(({ value }) => value);
    if (picked.length === 0 && this.question.required) {
      this.error = NONE_TICKED;
      return null;
    }
    return picked;
  }

  /** The lines of the open list: the message, the filter, the window of choices, and the hint. */
  frame(rows: number): string[] {
    const shown = this.matches();
    const top = Math.min(Math.max(0, this.cursor - Math.floor(rows / 2)), Math.max(0, shown.length - rows));
    const window = shown.slice(top, top + rows);
    const lines = [this.question.message];
    if (this.question.filter) lines.push(`Search: ${this.filter}${shown.length === this.question.choices.length ? "" : ` (${shown.length === 1 ? "1 match" : `${shown.length} matches`})`}`);
    if (shown.length === 0) lines.push("  No match: Backspace widens the search.");
    if (top > 0) lines.push(`  ${marks.more} ${top} more above`);
    lines.push(...window.map((choice, at) => this.row(choice, top + at)));
    if (top + rows < shown.length) lines.push(`  ${marks.more} ${shown.length - top - rows} more below`);
    if (this.error !== null) lines.push(this.error);
    lines.push(this.question.filter ? FILTER_HINT : HINT);
    return lines;
  }

  /** The line of the choice at `position` in what the filter lets through. */
  private row({ value, label, hint }: Choice<V>, position: number): string {
    return `${position === this.cursor ? marks.pointer : " "} ${this.ticked.has(value) ? marks.on : marks.off} ${label}${hint === undefined ? "" : `  ${hint}`}`;
  }

  /** The one line a finished list leaves behind: the message and what was ticked. */
  summary(picked: readonly V[]): string {
    const labels = this.question.choices.filter(({ value }) => picked.includes(value)).map(({ label }) => label);
    return `${this.question.message}  ${labels.length === 0 ? "none" : labels.length <= LABELS_SHOWN ? labels.join(", ") : `${labels.length} selected`}`;
  }
}

type Streams = Readonly<{ input?: Readable; output?: Writable }>;

/** Draws `lines` over the `drawn` lines before them. */
function redraw(output: Writable, lines: readonly string[], drawn: number): void {
  const columns = (output as Writable & { columns?: number }).columns ?? 80;
  const fit = (line: string): string => (line.length >= columns ? `${line.slice(0, Math.max(1, columns - 2))}${marks.more}` : line);
  output.write(`${drawn > 0 ? `\x1b[${drawn}A` : ""}\r\x1b[J${lines.map((line) => `${fit(line)}\n`).join("")}`);
}

/** One list, asked on `streams` (this process's terminal unless a test names others). */
function pickMany<V extends string>(question: PickQuestion<V>, streams: Streams): Promise<V[]> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const model = new ListModel(question);
  const rows = Math.max(3, Math.min(WINDOW, ((output as Writable & { rows?: number }).rows ?? 24) - 6));
  return new Promise<V[]>((resolve, reject) => {
    // The interface only turns the stream into keypresses (and, on a terminal, raw mode); with no `output` it echoes nothing.
    const lines = createInterface({ input, tabSize: 1, prompt: "", escapeCodeTimeout: 50, terminal: true });
    emitKeypressEvents(input, lines);
    if ((input as Readable & { isTTY?: boolean }).isTTY) (input as Readable & { setRawMode?: (mode: boolean) => void }).setRawMode?.(true);
    let drawn = 0;
    const show = (frame: readonly string[]): void => {
      redraw(output, frame, drawn);
      drawn = frame.length;
    };
    const finish = (settle: () => void, last: string): void => {
      input.off("keypress", onKey);
      lines.close();
      redraw(output, [last], drawn);
      settle();
    };
    function onKey(str: string | undefined, key: Key | undefined): void {
      const action = actionOf(str, key);
      if (action === "cancel") return finish(() => reject(new PromptCancelled()), `${question.message}  cancelled`);
      if (action === "submit") {
        const picked = model.submit();
        if (picked !== null) return finish(() => resolve(picked), model.summary(picked));
        return show(model.frame(rows));
      }
      if (action !== null) model.press(action);
      show(model.frame(rows));
    }
    input.on("keypress", onKey);
    show(model.frame(rows));
  });
}

/** The answer of a prompt, or {@link PromptCancelled} when it was cancelled. */
function answered<T>(value: unknown): T {
  if (isCancel(value)) throw new PromptCancelled();
  return value as T;
}

/** The prompts: lists of agent-org's own, and clack's yes or no and prefilled line, on this process's terminal unless `streams` name others (a test drives them with key bytes). */
export function clackPrompts(streams: Streams = {}): Prompts {
  const common = { ...streams, withGuide: false };
  return {
    pickMany: (question) => pickMany(question, streams),
    async confirm({ message, initial }) {
      return answered<boolean>(await confirm({ ...common, message, initialValue: initial }));
    },
    async text({ message, initial }) {
      return answered<string>(await text({ ...common, message, initialValue: initial, defaultValue: initial }));
    },
  };
}
