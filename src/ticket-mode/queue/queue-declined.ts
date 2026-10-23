// @ts-check
// module: the queue's record of a Claude Code safety prompt the pool declined on a run (A11-174)

import { type Entry, replace, type Queue } from "./queue-entries-and-outcomes.ts";

/**
 * The pool answered a Claude Code safety prompt on this run No (A11-174): it is recorded, with the count of declines so far, and the run is not waiting on a person.
 * `told` is false until the agent has been sent why ({@link toldDeclined}).
 */
export function declinedPrompt(queue: Queue, key: string, prompt: Pick<NonNullable<Entry["declined"]>, "command" | "warning">, now: number): Queue {
  return replace(queue, key, ({ prompt: _read, ...entry }) => ({ ...entry, waiting: false, declined: { ...prompt, at: now, count: (entry.declined?.count ?? 0) + 1, told: false } }));
}

/** The agent of a run with a declined safety prompt was told which command was refused and why. */
export function toldDeclined(queue: Queue, key: string): Queue {
  return replace(queue, key, (entry) => (entry.declined === undefined ? entry : { ...entry, declined: { ...entry.declined, told: true } }));
}
