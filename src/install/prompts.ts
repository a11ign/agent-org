// module: the questions onboard asks at a terminal that a line of typing cannot answer well (A11-186) -- pick several from a list, answer yes or no, edit a prefilled line
//
// THE SEAM IS THREE CALLS, so `onboard-repos.ts` imports no library and its tests stub `Prompts` with a script. `clackPrompts` is the one implementation, over `@clack/prompts` 1.8.1: arrow keys move, space ticks, enter finishes,
// and a filtered list narrows as the person types (Tab ticks the one in focus while typing, and space does once an arrow key has moved). The library reads Node's own `readline` keypresses, which are the same in macOS Terminal, iTerm and Linux terminals, and it draws ASCII marks where the terminal has no
// Unicode. Every prompt is made with `withGuide: false`, so its output is plain lines with no bar down the left (A11-185's readable style). A cancel (Ctrl-C or Esc) is thrown as {@link PromptCancelled}.
import type { Readable, Writable } from "node:stream";
import { autocompleteMultiselect, confirm, isCancel, multiselect, text, type Option } from "@clack/prompts";

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

/** The answer of a prompt, or {@link PromptCancelled} when it was cancelled. */
function answered<T>(value: unknown): T {
  if (isCancel(value)) throw new PromptCancelled();
  return value as T;
}

/** The prompts over `@clack/prompts`, on this process's terminal unless `streams` name others (a test drives them with key bytes). */
export function clackPrompts(streams: Readonly<{ input?: Readable; output?: Writable }> = {}): Prompts {
  const common = { ...streams, withGuide: false };
  return {
    async pickMany<V extends string>({ message, choices, ticked, filter, required }: PickQuestion<V>) {
      const options = choices.map(({ value, label, hint }) => ({ value, label, ...(hint === undefined ? {} : { hint }) })) as Option<V>[];
      const picked = filter
        ? await autocompleteMultiselect({ ...common, message, options, initialValues: [...ticked], required })
        : await multiselect({ ...common, message, options, initialValues: [...ticked], required });
      return answered<V[]>(picked);
    },
    async confirm({ message, initial }) {
      return answered<boolean>(await confirm({ ...common, message, initialValue: initial }));
    },
    async text({ message, initial }) {
      return answered<string>(await text({ ...common, message, initialValue: initial, defaultValue: initial }));
    },
  };
}
