// module: when the open page is in the middle of an `agent-org update`, and what it shows -- the Updating, Slow and Back screens and the pill (PURE, no React)
//
// THE DETECTION RULE (A11-217). The page shows Updating when the shell's queue poll is `reconnecting` (A11-211's restart classification: no answer, or a proxy's 502 or 503) AND the last good queue
// read showed an update underway: a drain note (a breaking release waiting on live runs) or `update.next` (the version a normal update is moving to while `agent-org update` holds its lock). Without
// that reason the restart keeps A11-211's quiet "Reconnecting..." line; a server-answered error and an SSH connection that cannot be reached are never Updating.
//
// THE OUTAGE is a run of `reconnecting` polls. Updating is Slow once it has lasted SLOW_AFTER_MS. The first good read after it shows Back when the version it reports is not the one the page knew;
// a restart that came back on the same version (a plain restart, or an update that did not apply) ends the outage with no screen.
import type { PollState } from "../api/use-poll.ts";
import type { QueueView } from "../api/types.ts";

/** How long the queue poll must have failed, from its first failure of the outage, before Updating says it is taking longer than usual. A restart takes 10 to 30 s (A11-211). */
export const SLOW_AFTER_MS = 60_000;

/** How long Back stays before the page reloads itself onto the new version's code. */
export const BACK_AFTER_MS = 5_000;

/** What the instance says of the update: the version it runs, the breaking release that drains, and the version a running update is moving to. An older instance leaves out what it does not know. */
export type UpdateInfo = Partial<QueueView["update"]>;

export type Release = "normal" | "breaking";

/** An update the page has reason to think is under way: which kind, the version the instance ran and the one it is moving to. */
export type Underway = Readonly<{ release: Release; from: string; to: string }>;

/**
 * The update an instance's answer says is under way, or null: the target is the drain note's, else `next`, and the version the instance runs is where it moves from. Without both, or when they
 * are the same version (a drain record that outlives the swap), there is nothing to show "from vX to vY" for. PURE.
 */
export function underwayOf(update: UpdateInfo | null | undefined): Underway | null {
  const note = update?.note ?? null;
  const from = update?.version ?? null;
  const to = note?.target ?? update?.next ?? null;
  if (from === null || to === null || from === to) return null;
  return { release: note === null ? "normal" : "breaking", from, to };
}

/** The run of failed polls the page is in, from when the first one failed, with what the last good read said of the update. */
export type Outage = Readonly<{ since: number; known: UpdateInfo | null }>;

/** The page's back on the version it moved to: that version as it was read, and which kind of release it was. */
export type Back = Readonly<{ to: string; release: Release }>;

/** What the page remembers across polls: the outage it is in, and the Back it has reached (kept until the page reloads). */
export type Track = Readonly<{ outage: Outage | null; back: Back | null }>;

export const IDLE: Track = { outage: null, back: null };

/** One queue poll as the model sees it: its state, the `update` of its (last good) data, and when it was seen. */
export type Read = Readonly<{ state: PollState; update: UpdateInfo | null; at: number }>;

/** The Back a first good read makes, or null: the version it reports is not the one the page knew, which is the page's proof that the instance moved. PURE. */
function backAfter(known: UpdateInfo | null, update: UpdateInfo | null): Back | null {
  const [before, after] = [known?.version ?? null, update?.version ?? null];
  if (before === null || after === null || before === after) return null;
  return { to: after, release: known?.note == null ? "normal" : "breaking" };
}

/**
 * What the page remembers after a poll. A `reconnecting` poll starts an outage, or continues the one it is in; a good read ends it, and is a Back when the version changed; any other state (loading, an error
 * the server answered with, an unreachable SSH connection) ends it with no screen. Back stays until a new outage starts. Returns `track` itself when nothing changed. PURE.
 */
export function trackAfter(track: Track, { state, update, at }: Read): Track {
  if (state === "reconnecting") return track.outage !== null ? track : { outage: { since: at, known: update }, back: null };
  if (state === "ready" || state === "empty") {
    if (track.outage === null) return track;
    return { outage: null, back: backAfter(track.outage.known, update) ?? track.back };
  }
  return track.outage === null ? track : { ...track, outage: null };
}

/** Whether an outage has lasted long enough to be Slow, at `now`. PURE. */
export const isSlow = ({ since }: Outage, now: number): boolean => now - since >= SLOW_AFTER_MS;

/** The screen the page shows. */
export type UpdateView =
  | Readonly<{ kind: "none" }>
  | (Underway & Readonly<{ kind: "updating"; slow: boolean }>)
  | (Back & Readonly<{ kind: "back" }>);

export const NO_UPDATE: UpdateView = { kind: "none" };

/** The screen for what the page remembers, at `now`: Back once reached, Updating through an outage that has a reason, else none. PURE. */
export function viewOf({ outage, back }: Track, now: number): UpdateView {
  if (back !== null) return { kind: "back", ...back };
  const underway = outage === null ? null : underwayOf(outage.known);
  return outage === null || underway === null ? NO_UPDATE : { kind: "updating", ...underway, slow: isSlow(outage, now) };
}
