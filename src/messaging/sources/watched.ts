// THE WATCHED SOURCE (a11ign/a11ign#3418, A5; chairman point 2 of #3409): a thing the chairman asked to be kept posted on is read each tick, and when its state is not the
// one he was last given the source offers `watch:<thing>` with the text `<what it is>: now <state>`. `watch-list.mjs` holds what is watched and why it ends; this file
// only asks.
//
// **"LAST GIVEN" IS THE LEDGER'S, NOT THIS FILE'S.** The state to compare with is the last `watch:<thing>` delivery the core recorded as told, or the state read when the watch
// was added. Nothing is remembered here, so a tick that offered a change and was refused by the provider offers it again on the next, and a tick that re-reads an unchanged
// thing offers nothing (the core would call it a duplicate; the source does not ask it to).
//
// **A THING THAT CANNOT BE READ IS `cannot-ask`**, never "unchanged" and never "ended": the watch stays, the others are read, and the reason is logged. A thing that has
// reached its final state is offered ONCE like any other change; it stops being asked after that because `activeWatches` no longer lists it once the core has told it.
//
// A LEAF and INJECTED, as `milestones.mjs` is: it imports siblings and node's own, and reads only through the placeholder `readers` it is handed.

import { stateFingerprint } from "../event.ts";
import type { Readers } from "../placeholders.ts";
import type { Watch } from "../watch-list.ts";
import { WATCHABLE, WATCH_KIND, activeWatches, readState, watchKey } from "../watch-list.ts";
import { observe } from "./stall.ts";

function eventOf({ thing, kind, id }: Watch, state: string, { repo, at }: { repo: string; at: number; }): Record<string, unknown> {
  const { label, link } = WATCHABLE[kind];
  return {
    key: watchKey(thing), kind: WATCH_KIND, severity: "info", firstSeenAt: at, text: `${label(id)}: now ${state}`,
    links: link === null ? [] : [link(repo, id)], resolved: false, state,
  };
}

/**
 * One event per watched thing whose state differs from the last the chairman was given, in the order they were added.
 * `lines` is the ledger as it stands: the watches and what they were last told are both read from it.
 */
export async function observeWatched({ lines, readers, now, repo, log = () => {} }: { lines: Record<string, any>[]; readers: Readers; now: () => number; repo: string; log?: (line: string) => void; }): Promise<{ events: Record<string, unknown>[]; cannotAsk: { source: string; reason: string; }[]; }> {
  const parts = await Promise.all(activeWatches(lines).map((watch) => observe(
    watchKey(watch.thing),
    async () => {
      const state = await readState(watch, { readers, now });
      return stateFingerprint({ state }) === (watch.toldHash ?? watch.baselineHash) ? [] : [eventOf(watch, state, { repo, at: now() })];
    },
    log,
  )));
  return { events: parts.flatMap((part) => part.events), cannotAsk: parts.flatMap((part) => part.cannotAsk) };
}
