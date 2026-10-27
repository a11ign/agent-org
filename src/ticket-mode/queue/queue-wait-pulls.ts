// @ts-check
// module: what the queue holds of a running run's pull requests (A11-358) -- the ones it opened, and what the board told its idle worker of them (PURE)
import type { FedTrouble } from "../wait-on/wait-types.ts";
import { replace, type PullRequest, type Queue } from "./queue-entries-and-outcomes.ts";

/** Add the pull requests a running run opened (A11-358, `Entry.opened`) to those it has: an address it has already is kept as it is, and nothing is written when there is nothing new. PURE. */
export function recordOpened(queue: Queue, key: string, pulls: readonly PullRequest[]): Queue {
  return replace(queue, key, (entry) => {
    const fresh = pulls.filter(({ url }) => !(entry.opened ?? []).some((held) => held.url === url));
    return fresh.length === 0 ? entry : { ...entry, opened: [...(entry.opened ?? []), ...fresh] };
  });
}

/** Record what the board told the worker of a running run's pull requests (`WorkingNote.fed`), or drop the record when it is empty. A run with no `working` note keeps none. PURE. */
export function recordFed(queue: Queue, key: string, fed: Readonly<Record<string, FedTrouble>>): Queue {
  return replace(queue, key, (entry) => {
    if (entry.working === undefined) return entry;
    const { fed: _earlier, ...rest } = entry.working;
    return { ...entry, working: Object.keys(fed).length === 0 ? rest : { ...rest, fed } };
  });
}
