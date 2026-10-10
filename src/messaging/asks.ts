// THE ASKS' RECORD (a11ign/a11ign#4745, row 3 of 5 of #928): AN ASK IS ONE MESSAGE, AND THE MESSAGE FOLLOWS THE ROW. A LEAF module: it imports
// the ledger's vocabulary and the audience names and nothing else, with the provider, the clock and the ledger writer all INJECTED.
//
// **THE CHAIRMAN'S RULE (#928, 2026-10-10): AN UNTICKED MESSAGE IS BY DEFINITION STILL OPEN.** The old lifecycle "cleared" an ask with a SECOND
// message, so the chat only grew. Here the resolved ask is EDITED in place to `✅ <outcome> — <its first line>` and nothing is sent, and one
// pinned message lists what is still open, rewritten only when the SET changes (an edit that moved nothing is a wasted call, and a ring).
//
// **THE LEDGER IS THE RECORD, AS EVERYWHERE IN THIS DIRECTORY.** An ask is `{askId, messageRef, row, state, outcome}` and it is not a second
// file: `foldAsks` rebuilds it from the lines the core already writes, which carry `askId`, `row` and (when it resolved) `outcome`. A line from
// before this row has none of them, so the fold DERIVES them (the row from the key, the episode by counting) and an open ask sent last week is
// ticked and listed like one sent a minute ago.
//
// **A RE-LABELLED ROW IS A NEW ASK.** Every `first` send opens an episode, so the ask the chairman ticked stays ticked and the new one is a
// new message with a new `askId` (`<key>:<episode>`).
//
// **EVERY MESSAGE OF AN ASK IS TICKED, NOT THE LATEST.** A changed brief is still sent as a message of its own (an edit would take its buttons
// away and never ring), so an ask can hold several messages and resolving it ticks each: otherwise the first would stay unticked and read as
// open for ever, which is the one thing the tick promises it cannot be.
//
// WHAT THIS MODULE NEVER DOES: invent a message the ledger does not hold. A provider that cannot both edit and pin keeps NOTHING of this (`kept`
// is false): its asks are reminded and cleared by message exactly as before, because an ask that is neither ticked nor listed is only visible
// through its reminders.

import { createHash } from "node:crypto";

import { ASKS_LIST_KIND, STATUS, describeError } from "./ledger.ts";
import { AUDIENCE } from "./provider-contract.ts";

/** The key the pinned list's lines are written under: not a kind of event, so no watcher can ever emit it. */
export const LIST_KEY = "asks:list";
export const TICK = "✅";

const ELLIPSIS = "…";
const OUTCOME_SEPARATOR = " — ";
const MAX_LIST_LINE = 120;
const FINGERPRINT_LENGTH = 16;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** `2026-10-10T09:00`: an ISO time cut at the minute. */
const ISO_MINUTE_END = 16;
/** `<kind>:<repo>#<number>`, as `requestKey` spells it (`sources/requests.ts`); `asks.test.ts` pins the two together, because this leaf may not import it. */
const ROW_KEY = /^[a-z]+:([^#\s]+)#(\d+)$/;
const NO_OPEN_ASKS = "No open asks.";

export type Message = { ref: string; firstLine: string };
/** `rowLess` is the reason a kind with no row declared (`stall`), `null` for an ask that belongs to a row. */
export type Ask = {
  askId: string; key: string; row: string | null; rowLess: string | null; state: "open" | "resolved"; outcome: string | null;
  /** In the order sent: the first is the ask's own, the rest are changed briefs. Empty for an ask told only by a digest. */
  messages: Message[]; openedAt: number;
};
export type AsksState = {
  /** The CURRENT episode of each key: a resolved one stays until the key asks again. */
  asks: Map<string, Ask>;
  /** How many episodes each key has opened, so a new one is numbered without reading the lines again. */
  episodes: Map<string, number>;
  list: { messageRef: string | null; pinnedRef: string | null; fingerprint: string | null };
};
type Line = Record<string, any>;
/** What a key's kind says its audience is: what a line written before `audience` existed is classified by. */
export type AudienceOf = (key: string) => string | undefined;

/** Returns `repo#number` for a key that names a row, or null: a stall is the whole org's, not one row's */
export function rowOf(key: string): string | null {
  const match = ROW_KEY.exec(key);
  return match === null ? null : `${match[1]}#${match[2]}`;
}

export function firstLineOf(text: string): string {
  return text.split("\n")[0];
}

function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}

/** `✅ <outcome> — <first line>`, cut to `maxText` at the FIRST LINE: the tick and the outcome are what the edit exists to say. */
export function tickedText({ outcome, firstLine, maxText }: { outcome: string; firstLine: string; maxText: number; }): string {
  const head = `${TICK} ${fit(outcome, maxText - TICK.length - 1)}`;
  const room = maxText - head.length - OUTCOME_SEPARATOR.length;
  return room > 0 ? `${head}${OUTCOME_SEPARATOR}${fit(firstLine, room)}` : head;
}

function emptyState(): AsksState {
  return { asks: new Map(), episodes: new Map(), list: { messageRef: null, pinnedRef: null, fingerprint: null } };
}

function isAskLine(line: Line, audienceOf: AudienceOf): boolean {
  return (line.audience ?? audienceOf(line.key)) === AUDIENCE.ask;
}

function openEpisode(state: AsksState, line: Line): void {
  const episode = (state.episodes.get(line.key) ?? 0) + 1;
  state.episodes.set(line.key, episode);
  const told = line.status === STATUS.sent && typeof line.providerMessageId === "string";
  state.asks.set(line.key, {
    askId: line.askId ?? `${line.key}:${episode}`, key: line.key, row: line.row ?? rowOf(line.key), rowLess: line.rowLess ?? null,
    state: "open", outcome: null, openedAt: Date.parse(line.ts),
    messages: told ? [{ ref: line.providerMessageId, firstLine: firstLineOf(String(line.text ?? line.key)) }] : [],
  });
}

function resolveEpisode(state: AsksState, line: Line, outcome: string | null): void {
  const ask = state.asks.get(line.key);
  if (ask !== undefined) Object.assign(ask, { state: "resolved", outcome: outcome ?? line.outcome ?? null });
}

function addMessage(state: AsksState, line: Line): void {
  const ask = state.asks.get(line.key);
  if (ask === undefined || ask.state !== "open" || line.status !== STATUS.sent || typeof line.providerMessageId !== "string") return;
  ask.messages.push({ ref: line.providerMessageId, firstLine: firstLineOf(String(line.text ?? line.key)) });
}

function applyListLine(list: AsksState["list"], line: Line): void {
  if (line.status === STATUS.sent) Object.assign(list, { messageRef: line.providerMessageId, pinnedRef: null, fingerprint: line.fingerprint ?? null });
  else if (line.status === STATUS.edited) list.fingerprint = line.fingerprint ?? null;
  else if (line.status === STATUS.pinned) list.pinnedRef = line.providerMessageId;
}

/** Applies one ledger line. The same function folds history and follows the lines the messenger writes, so the two cannot disagree. */
export function applyAskLine(state: AsksState, line: Line, audienceOf: AudienceOf): void {
  if (line.direction === "in" || typeof line.key !== "string") return;
  if (line.kind === ASKS_LIST_KIND) return applyListLine(state.list, line);
  if (line.kind === "digest" || !isAskLine(line, audienceOf)) return;
  if (line.status === STATUS.withdrawn) return resolveEpisode(state, line, "withdrawn");
  if (line.status !== STATUS.sent && line.status !== STATUS.digested) return;
  if (line.kind === "first") openEpisode(state, line);
  else if (line.kind === "cleared") resolveEpisode(state, line, null);
  else addMessage(state, line);
}

export function foldAsks(lines: Line[], audienceOf: AudienceOf): AsksState {
  const state = emptyState();
  for (const line of lines) applyAskLine(state, line, audienceOf);
  return state;
}

/** The asks still open, oldest first: the order the chairman met them in. */
export function openAsks(state: AsksState): Ask[] {
  return [...state.asks.values()].filter((ask) => ask.state === "open").sort((left, right) => left.openedAt - right.openedAt);
}

/** What the list is about, and nothing that drifts: the age is NOT in it, which is why a quiet tick edits nothing. */
export function listFingerprint(open: Ask[]): string {
  const body = open.map((ask) => `${ask.askId}\n${ask.messages[0]?.firstLine ?? ""}`).join("\n\n");
  return createHash("sha256").update(body).digest("hex").slice(0, FINGERPRINT_LENGTH);
}

export function describeAge(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(0, Math.floor(ms / MINUTE_MS))}m`;
  if (ms < DAY_MS * 2) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

function listLine(ask: Ask, nowMs: number): string {
  const parsed = ask.row === null ? null : /#(\d+)$/.exec(ask.row);
  const name = parsed === null ? ask.key : `#${parsed[1]}`;
  return `• ${name} ${fit(ask.messages[0]?.firstLine ?? ask.key, MAX_LIST_LINE)} (${describeAge(nowMs - ask.openedAt)})`;
}

/**
 * The pinned list. Its header says WHEN it was written, because its ages are only true then (it is rewritten when the set changes, not on a
 * timer). An empty list says so in one line; one too long for `maxText` says how many more there are.
 */
export function renderList({ open, nowMs, maxText }: { open: Ask[]; nowMs: number; maxText: number; }): string {
  if (open.length === 0) return NO_OPEN_ASKS;
  const asOf = new Date(nowMs).toISOString().slice(0, ISO_MINUTE_END).replace("T", " ");
  const lines = [`Open asks (${open.length}), as of ${asOf}Z:`];
  for (const [index, ask] of open.entries()) {
    const line = listLine(ask, nowMs);
    const after = open.length - index - 1;
    const closing = after > 0 ? [`${ELLIPSIS}and ${after} more`] : [];
    if ([...lines, line, ...closing].join("\n").length > maxText) {
      lines.push(`${ELLIPSIS}and ${open.length - index} more`);
      break;
    }
    lines.push(line);
  }
  return fit(lines.join("\n"), maxText);
}

/** The fields an ask's lines carry: the record `foldAsks` reads and the audit (row 4) checks. Absent for a line that is not an ask's. */
export function askFields(state: AsksState, { key, kind, rowLess }: { key: string; kind: string; rowLess: string | null; }): Record<string, unknown> {
  const current = state.asks.get(key);
  const episode = (state.episodes.get(key) ?? 0) + 1;
  const askId = kind === "first" || current === undefined ? `${key}:${episode}` : current.askId;
  return { askId, row: rowOf(key), rowLess: rowOf(key) === null ? rowLess : null };
}

/** The reason an ask cannot be sent, or null: an ask belongs to a row, or its kind says why it does not. */
export function refusalFor({ key, rowLess }: { key: string; rowLess: string | null; }): string | null {
  if (rowOf(key) !== null || rowLess !== null) return null;
  return `ask not sent: key ${JSON.stringify(key)} names no row and its kind declares no row-less reason, so it could not be ticked or listed against anything`;
}

type Provider = {
  capabilities: Record<string, any>;
  send: (message: Record<string, unknown>) => Promise<any>;
  edit?: (message: { messageRef: string; text: string; audience?: string }) => Promise<any>;
  pin?: (message: { messageRef: string; audience?: string }) => Promise<any>;
};
type Decision = { key: string; action: string };

/**
 * The effects, over an injected provider. `append` is the messenger's ledger writer (it applies the line to the messenger's own fold and to
 * `state` here, through `apply`), and `noteDelivered` tells the hourly cap about the one real message this module ever sends: the list.
 */
export function createAsks({ provider, history, now, append, noteDelivered, audienceOf }: {
        provider: Provider; history: Line[]; now: () => number; append: (fields: Record<string, unknown>) => Line;
        noteDelivered: () => void; audienceOf: AudienceOf;
    }) {
  const state = foldAsks(history, audienceOf);
  const maxText = provider.capabilities.maxText;
  const kept = provider.capabilities.edit === true && provider.capabilities.pin === true;

  async function tickResolved({ key, outcome }: { key: string; outcome: string; }): Promise<boolean> {
    const ask = state.asks.get(key);
    if (!kept || ask === undefined || ask.state !== "open" || ask.messages.length === 0) return false;
    const shown = (message: Message) => tickedText({ outcome, firstLine: message.firstLine, maxText });
    const record = { key, kind: "cleared", edited: true, audience: AUDIENCE.ask, askId: ask.askId, row: ask.row, outcome };
    try {
      // Every message, in order; an edit to what already reads so is a success (`unchanged`), so a retry after a partial failure is safe.
      for (const message of ask.messages) await provider.edit?.({ messageRef: message.ref, text: shown(message), audience: AUDIENCE.ask });
    } catch (error) {
      append({ ...record, status: STATUS.failed, error: describeError(error) });
      return false;
    }
    // `sent` with `edited`, not a status of its own: what reads "this key was cleared" (`readEpisodeStart`, the snooze, `measure`) looks for exactly that.
    append({ ...record, status: STATUS.sent, providerMessageId: ask.messages[0].ref, editedRefs: ask.messages.map((message) => message.ref), text: shown(ask.messages[0]) });
    return true;
  }

  async function sendList({ text, fingerprint }: { text: string; fingerprint: string; }): Promise<Decision> {
    const base = { key: LIST_KEY, kind: ASKS_LIST_KIND, audience: AUDIENCE.ask, text, fingerprint };
    try {
      // Silent: bookkeeping must not ring. Sent past the rate limiter's refusal on purpose: it is one message, and a held-back list is a list that lies.
      const result = await provider.send({ text, silent: true, audience: AUDIENCE.ask });
      if (typeof result?.messageRef !== "string" || result.messageRef === "") throw new Error("provider returned no messageRef");
      noteDelivered();
      append({ ...base, status: STATUS.sent, providerMessageId: result.messageRef });
      return { key: LIST_KEY, action: "list-sent" };
    } catch (error) {
      append({ ...base, status: STATUS.failed, error: describeError(error) });
      return { key: LIST_KEY, action: "list-failed" };
    }
  }

  /** Edits the list in place; when it cannot (the chairman deleted it), says so and sends a fresh one, whose new ref is then pinned. */
  async function rewriteList({ open, fingerprint }: { open: Ask[]; fingerprint: string; }): Promise<Decision> {
    const text = renderList({ open, nowMs: now(), maxText });
    const messageRef = state.list.messageRef;
    if (messageRef === null) return sendList({ text, fingerprint });
    const base = { key: LIST_KEY, kind: ASKS_LIST_KIND, audience: AUDIENCE.ask, text, fingerprint, providerMessageId: messageRef };
    try {
      await provider.edit?.({ messageRef, text, audience: AUDIENCE.ask });
      append({ ...base, status: STATUS.edited });
      return { key: LIST_KEY, action: "list-edited" };
    } catch (error) {
      append({ ...base, status: STATUS.failed, error: describeError(error) });
      return sendList({ text, fingerprint });
    }
  }

  async function pinList(messageRef: string): Promise<Decision> {
    const base = { key: LIST_KEY, kind: ASKS_LIST_KIND, audience: AUDIENCE.ask, providerMessageId: messageRef };
    try {
      await provider.pin?.({ messageRef, audience: AUDIENCE.ask });
      append({ ...base, status: STATUS.pinned });
      return { key: LIST_KEY, action: "list-pinned" };
    } catch (error) {
      append({ ...base, status: STATUS.failed, error: describeError(error) });
      return { key: LIST_KEY, action: "list-pin-failed" };
    }
  }

  /**
   * The list, once per tick, after every event was handled. It is written when the SET changed and not otherwise, and pinned once, and again
   * only when its message is a different one. Nothing is sent for an empty list nobody ever had: there is nothing for it to say.
   */
  async function syncList(): Promise<Decision[]> {
    if (!kept) return [];
    const open = openAsks(state);
    if (state.list.messageRef === null && open.length === 0) return [];
    const decisions: Decision[] = [];
    const fingerprint = listFingerprint(open);
    if (fingerprint !== state.list.fingerprint) decisions.push(await rewriteList({ open, fingerprint }));
    const { messageRef, pinnedRef } = state.list;
    if (messageRef !== null && pinnedRef !== messageRef) decisions.push(await pinList(messageRef));
    return decisions;
  }

  return {
    kept,
    state,
    apply: (line: Line) => applyAskLine(state, line, audienceOf),
    tickResolved,
    syncList,
  };
}
