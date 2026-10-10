// THE PROVIDER-FREE CORE (a11ign/a11ign#2899, decision 1): what to say to the chairman, and when NOT to. A LEAF module -- it imports
// nothing from the tool and reads no project checkout -- with the clock, the ledger and the provider all INJECTED.
//
// THE LIFECYCLE: observed -> (hold-down: an incident waits 30 minutes, unresolved) -> sent -> (resolved: ONE "cleared" message,
// and only if the original was sent). A request is sent at once. REMINDERS: at most 3, 24 hours apart, and then silence until the
// event's declared `state` changes (the measured defect: a `needs:chairman` row asked 19 times in a day).
//
// **THE PLAN IS A PURE FUNCTION, THE DELIVERY IS THE ONLY EFFECT.** `planNotification` decides from (event, what the ledger says
// about its key, now, config) and touches nothing, so every number in the design is exercised against a clock a test owns. The
// messenger around it asks the rate limiter, calls the provider and writes ONE ledger line per attempt.
//
// **EVERY KIND DECLARES WHO IT IS FOR (a11ign/a11ign#4742).** `audience` is `ask` (needs the chairman: a request, a stall) or `announcement`
// (told to him, asks nothing: the rest), and the plan carries it so the provider can route. A kind with NO audience is refused at send,
// with a line naming the kind, and is never defaulted: a default would put a message in the chairman's ask list or in a channel nobody
// answers, and the first sign would be a missing ask.
//
// **AN ASK KEEPS A RECORD, AND IS TICKED IN PLACE (a11ign/a11ign#4745, `asks.ts`).** Where the provider can edit AND pin, an ask is never reminded by
// message and its resolution EDITS the message it was sent as (`✅ <outcome> — <first line>`) instead of sending a "cleared" one, and one pinned
// message lists what is still open. Where it cannot, every ask is reminded and cleared by message exactly as above: an ask that is neither ticked
// nor listed is visible only through its reminders. An ask names a row (or its kind declares why it has none), or it is refused at send.
//
// WHAT THE CORE NEVER DOES: invent a message the ledger does not hold. A held-down or duplicate observation writes no line (it is not
// an attempt, and 100 ticks must not write 100 lines); a deferral, a failure and a digest overflow each write one.

import { askFields, createAsks, firstLineOf, refusalFor } from "./asks.ts";
import { normalizeEvent, stateFingerprint } from "./event.ts";
import type { MessagingEvent } from "./event.ts";
import { STATUS, deliveredTimestamps, deliveryLine, describeError, foldLedger, applyLine } from "./ledger.ts";
import type { KeyRecord, createLedger } from "./ledger.ts";
import { AUDIENCE, AUDIENCES } from "./provider-contract.ts";
import { createRateLimiter, DEFAULT_RATE } from "./rate-limit.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const ELLIPSIS = "…";
const DIGEST_KEY_PREFIX = "digest:";
const DIGEST_ENTRY_LIMIT = 200;

export const DEFAULT_CONFIG = Object.freeze({
  kinds: Object.freeze({
    // `audience`: a request and a stall NEED the chairman, so they are asks; everything else is told to him and asks nothing.
    // `rowLess`: why an ask of this kind may name no row (#4745). A request is a row's, so it has none to give and is refused without one.
    request: Object.freeze({ holdDownMs: 0, remind: true, silent: false, audience: AUDIENCE.ask, rowLess: null as string | null }),
    incident: Object.freeze({ holdDownMs: 30 * MINUTE_MS, remind: true, silent: false, audience: AUDIENCE.announcement, rowLess: null as string | null }),
    stall: Object.freeze({
      holdDownMs: 0, remind: true, silent: false, audience: AUDIENCE.ask,
      rowLess: "a stall is the whole org not moving, so it belongs to no one row" as string | null,
    }),
    // No quiet hours: the summary is the only silent message (decision 1).
    summary: Object.freeze({ holdDownMs: 0, remind: false, silent: true, audience: AUDIENCE.announcement, rowLess: null as string | null }),
    // A release is told once and never reminded or cleared: it is a fact that happened, not a condition that stands. Not silent: it is news.
    release: Object.freeze({ holdDownMs: 0, remind: false, silent: false, audience: AUDIENCE.announcement, rowLess: null as string | null }),
    // A milestone is told once and never reminded or cleared: it is a declared moment that happened, not a condition that stands. Not silent: it is news.
    milestone: Object.freeze({ holdDownMs: 0, remind: false, silent: false, audience: AUDIENCE.announcement, rowLess: null as string | null }),
    // A watched thing changing state is told once per change and never reminded or cleared: the chairman asked to be told when it moves, and the watch ends with the thing.
    watch: Object.freeze({ holdDownMs: 0, remind: false, silent: false, audience: AUDIENCE.announcement, rowLess: null as string | null }),
  }),
  reminders: Object.freeze({ max: 3, everyMs: 24 * HOUR_MS }),
  rate: Object.freeze({ burst: DEFAULT_RATE.burst, hourlyCap: DEFAULT_RATE.hourlyCap, windowMs: HOUR_MS }),
});

/**
 * All the numbers are config with the design's defaults. A partial override merges per kind, so overriding the incident hold-down
 * does not silently remove the request policy.
 */
export function resolveConfig(overrides: { kinds?: Record<string, object>; reminders?: object; rate?: object; } = {}) {
  const kinds = Object.fromEntries(Object.entries(DEFAULT_CONFIG.kinds).map(([kind, policy]) =>
    [kind, { ...policy, ...(overrides.kinds?.[kind] ?? {}) }]));
  return {
    kinds,
    reminders: { ...DEFAULT_CONFIG.reminders, ...overrides.reminders },
    rate: { ...DEFAULT_CONFIG.rate, ...overrides.rate },
  };
}

/** What the plan reads: the resolved numbers, and whether the provider keeps the asks' record (it can edit AND pin, so an ask is listed and need not be reminded). */
type Config = ReturnType<typeof resolveConfig> & { asksKept?: boolean };

/** `audience` is what the kind declared, carried as it was found: an undeclared one is `undefined` here and is refused where it would be sent. */
type Plan = { action: "none"; why: string; }
  | { action: "send"; kind: "first" | "update" | "reminder" | "cleared"; reminder?: number; audience?: string; }
  | { action: "withdraw"; };

/**
 * What to do about one observed event. Pure: the same inputs always give the same plan.
 *
 * `record` is what the ledger says about this key. A plan to send carries the audience its kind declared.
 */
export function planNotification(event: MessagingEvent, record: KeyRecord | undefined, nowMs: number, config: Config): Plan {
  const plan = planWhatToDo(event, record, nowMs, config);
  return plan.action === "send" ? { ...plan, audience: config.kinds[event.kind].audience } : plan;
}

function planWhatToDo(event: MessagingEvent, record: KeyRecord | undefined, nowMs: number, config: Config): Plan {
  const open = record?.open ?? false;
  // The episode already ended: a stale observation of it (same `firstSeenAt`, or earlier) is not a recurrence.
  if (!open && record?.clearedAt != null && event.firstSeenAt <= record.clearedAt) return { action: "none", why: "already-cleared" };
  if (event.resolved) return planResolution(record, open);
  const policy = config.kinds[event.kind];
  if (!open) {
    return nowMs - event.firstSeenAt < policy.holdDownMs ? { action: "none", why: "held" } : { action: "send", kind: "first" };
  }
  if (record && record.stateHash !== stateFingerprint(event)) return { action: "send", kind: "update" };
  return planReminder(record, policy, nowMs, config);
}

function planResolution(record: KeyRecord | undefined, open: boolean): Plan {
  // Resolved before the chairman was told anything: tell him nothing at all. That is the point of the hold-down.
  if (!open) return { action: "none", why: "resolved-before-sent" };
  // Told only by a digest that has not gone out yet: a "cleared" for something he never saw would be noise, and the digest must
  // stop naming it.
  return record?.pending ? { action: "withdraw" } : { action: "send", kind: "cleared" };
}

function planReminder(record: KeyRecord | undefined, policy: { remind: boolean; }, nowMs: number, config: Config): Plan {
  if (!record || !policy.remind || record.reminders >= config.reminders.max) return { action: "none", why: "duplicate" };
  if (nowMs - record.lastNotifiedAt < config.reminders.everyMs) return { action: "none", why: "duplicate" };
  return { action: "send", kind: "reminder", reminder: record.reminders + 1 };
}

function fit(body: string, maxText: number): string {
  return body.length <= maxText ? body : `${body.slice(0, Math.max(0, maxText - 1))}${ELLIPSIS}`;
}

/**
 * The words sent. The text is shortened to `maxText` BEFORE the provider sees it (a provider refuses over-length text; it does not
 * cut it), and it is the TEXT that gives way, never the links: a message that lost its link lost the one thing to act on.
 */
export function composeText(event: MessagingEvent, plan: Extract<Plan, { action: "send"; }>, maxText: number, reminderMax: number) {
  const prefix = plan.kind === "cleared" ? "Cleared: " : plan.kind === "reminder" ? `Reminder ${plan.reminder} of ${reminderMax}: ` : "";
  const tail = event.links.length > 0 ? `\n${event.links.join("\n")}` : "";
  if (prefix.length + tail.length >= maxText) return fit(`${prefix}${event.text}${tail}`, maxText);
  return `${fit(`${prefix}${event.text}`, maxText - tail.length)}${tail}`;
}

/**
 * The buttons a message carries: the event's own, on a message that still asks something, and only for a provider that draws them. A cleared notice asks
 * nothing, so it carries none: a button under it would answer a request that is already gone. The key is ABSENT (not empty) otherwise, so a provider
 * that never heard of `actions` is handed the message it always was.
 */
export function buttonsFor(event: MessagingEvent, plan: Extract<Plan, { action: "send"; }>, capabilities: { buttons?: boolean; }): { actions?: { label: string; data: string; }[]; } {
  return plan.kind !== "cleared" && capabilities.buttons === true && event.actions.length > 0 ? { actions: [...event.actions] } : {};
}

/**
 * The ONE digest line for everything the hourly cap held back. When the entries do not all fit in `maxText` the last line says how
 * many more there are; every one of them is still covered by this digest, so none is lost.
 */
export function composeDigest(entries: { kind: string; text: string; key: string; }[], maxText: number) {
  const head = `${entries.length} notification${entries.length === 1 ? "" : "s"} held back by the hourly cap:`;
  const lines = [head];
  for (const [index, entry] of entries.entries()) {
    const line = `- ${entry.kind === "cleared" ? "cleared: " : ""}${fit(entry.text.split("\n")[0], DIGEST_ENTRY_LIMIT)}`;
    const after = entries.length - index - 1;
    const trailer = after > 0 ? [overflowLine(after)] : [];
    if ([...lines, line, ...trailer].join("\n").length > maxText) {
      lines.push(overflowLine(entries.length - index));
      return fit(lines.join("\n"), maxText);
    }
    lines.push(line);
  }
  return fit(lines.join("\n"), maxText);
}

function overflowLine(count: number): string {
  return `${ELLIPSIS}and ${count} more (see the delivery log)`;
}

/**
 * `action` is what happened: sent, reminded, updated, cleared, digested,
 * deferred, failed, withdrawn, invalid, or a `none` reason (held, duplicate, resolved-before-sent, already-cleared).
 */
type Decision = { key: string; action: string; };

/**
 * `now` returns epoch milliseconds. Nothing else in the core reads the clock, the filesystem path or the network.
 */
export function createMessenger({ provider, ledger, now, config: overrides }: { provider: any; ledger: ReturnType<typeof createLedger>; now: () => number; config?: Parameters<typeof resolveConfig>[0]; }) {
  const resolved = resolveConfig(overrides);
  const maxText = provider.capabilities.maxText;
  const history = ledger.read();
  const state = foldLedger(history);
  const asks = createAsks({
    provider, history, now, noteDelivered: () => limiter.noteDelivered(), append: (fields) => record(fields),
    audienceOf: (key) => resolved.kinds[key.split(":")[0]]?.audience,
  });
  const config: Config = { ...resolved, asksKept: asks.kept };
  const limiter = createRateLimiter({
    now, ratePerSecond: provider.capabilities.ratePerSecond, burst: config.rate.burst,
    hourlyCap: config.rate.hourlyCap, windowMs: config.rate.windowMs,
  });
  // The hourly cap survives a restart: the hour's allowance is what the LEDGER says went out, not a counter that resets to zero.
  for (const at of deliveredTimestamps(history)) limiter.noteDelivered(at);

  const record = (fields: Record<string, unknown>): Record<string, any> => {
    const line = ledger.append(deliveryLine({ provider: provider.id, ...fields } as Parameters<typeof deliveryLine>[0]));
    applyLine(state, line);
    asks.apply(line);
    return line;
  };

  /** Asks the rate limiter, then the provider. */
  async function attemptSend(key: string, message: Record<string, any>, extra: Record<string, unknown>): Promise<{ status: string; line: Record<string, any>; }> {
    const gate = limiter.tryAcquire();
    if (!gate.ok) {
      const status = gate.reason === "hourly-cap" ? STATUS.digested : STATUS.deferred;
      return { status, line: record({ key, status, reason: gate.reason, ...extra }) };
    }
    try {
      const result = await provider.send(message);
      if (typeof result?.messageRef !== "string" || result.messageRef === "") throw new Error("provider returned no messageRef");
      limiter.noteDelivered();
      // `silent` is what the provider says it APPLIED, not what was asked: a bot cannot read `disable_notification` back, so this line is
      // the only evidence "was it silent" will ever have. A provider that returns none is `null` (unknown), never `false` (loud).
      const silent = typeof result.silent === "boolean" ? result.silent : null;
      return { status: STATUS.sent, line: record({ key, status: STATUS.sent, providerMessageId: result.messageRef, silent, ...extra }) };
    } catch (error) {
      return { status: STATUS.failed, line: record({ key, status: STATUS.failed, error: describeError(error), ...extra }) };
    }
  }

  /** Refused BEFORE the rate limiter is asked: a kind that cannot be routed spends none of the hour's allowance. */
  function refuse(event: MessagingEvent, error: string): Decision {
    record({ key: event.key, status: STATUS.invalid, error });
    return { key: event.key, action: "invalid" };
  }

  function refuseUndeclared(event: MessagingEvent): Decision {
    return refuse(event, `alert not sent: kind ${JSON.stringify(event.kind)} declares no audience (ask or announcement), and the sender never defaults one`);
  }

  /**
   * A resolved ask is TICKED where it stands and sends nothing (#4745). When it cannot be (no provider edit, no message the ledger knows, or the edit
   * failed and said so on a line), the old "cleared" message is the answer, so a resolved ask is never left unticked AND unannounced.
   */
  async function tickInPlace(event: MessagingEvent): Promise<Decision | null> {
    const outcome = firstLineOf(event.text);
    return (await asks.tickResolved({ key: event.key, outcome })) ? { key: event.key, action: "cleared" } : null;
  }

  async function deliver(event: MessagingEvent, plan: Extract<Plan, { action: "send"; }>): Promise<Decision> {
    const { audience } = plan;
    if (audience === undefined || !AUDIENCES.includes(audience)) return refuseUndeclared(event);
    const policy = config.kinds[event.kind];
    const asked = audience === AUDIENCE.ask;
    const refusal = asked ? refusalFor({ key: event.key, rowLess: policy.rowLess }) : null;
    if (refusal !== null) return refuse(event, refusal);
    if (asked && plan.kind === "cleared") {
      const ticked = await tickInPlace(event);
      if (ticked !== null) return ticked;
    }
    const known = state.get(event.key);
    const text = composeText(event, plan, maxText, config.reminders.max);
    // A "cleared" notice replies under the message it clears, EXCEPT in the one-way channel (an announcement with a destination of its own):
    // there the "Cleared: ..." stands alone and carries the text that says what it clears. With one destination the announcement is in the
    // chairman's chat, as it always was, and threads as it always did.
    const toChannel = audience === AUDIENCE.announcement && (provider.capabilities.destinations ?? 1) >= AUDIENCES.length;
    const repliesUnderOriginal = !toChannel && plan.kind === "cleared" && provider.capabilities.replies && known?.messageRef;
    const message = {
      text,
      silent: policy.silent,
      audience,
      replyTo: repliesUnderOriginal ? known.messageRef : undefined,
      ...buttonsFor(event, plan, provider.capabilities),
    };
    // The ledger keeps the text AS SENT, link and all: what the chairman was shown is the one thing a later reading must not have to rebuild.
    // An ask also keeps its record (`asks.ts`): which ask, which row, and for a clearing the outcome it ended with.
    const askRecord = asked ? askFields(asks.state, { key: event.key, kind: plan.kind, rowLess: policy.rowLess }) : {};
    const outcome = plan.kind === "cleared" ? { outcome: firstLineOf(event.text) } : {};
    const extra = { kind: plan.kind, stateHash: stateFingerprint(event), reminder: plan.reminder ?? null, text, audience, ...askRecord, ...outcome };
    const { status } = await attemptSend(event.key, message, extra);
    const spoken = { first: "sent", update: "updated", reminder: "reminded", cleared: "cleared" }[plan.kind];
    return { key: event.key, action: status === STATUS.sent ? spoken : status };
  }

  async function observeOne(event: MessagingEvent): Promise<Decision> {
    const plan = planNotification(event, state.get(event.key), now(), config);
    if (plan.action === "none") return { key: event.key, action: plan.why };
    if (plan.action === "withdraw") {
      record({ key: event.key, status: STATUS.withdrawn, kind: "withdrawn" });
      return { key: event.key, action: "withdrawn" };
    }
    return deliver(event, plan);
  }

  /** Returns the ONE digest line, once the hour has room for it. */
  async function flushDigest(): Promise<Decision[]> {
    const held = [...state.entries()].filter(([, entry]) => entry.pending).map(([key, entry]) => ({ key, ...entry.pending }));
    if (held.length === 0 || !limiter.hasHourlyRoom()) return [];
    const key = `${DIGEST_KEY_PREFIX}${new Date(now()).toISOString()}`;
    // The digest is ONE message over both audiences (the ledger's `pending` does not hold which each entry was for), so it goes where
    // every message could always go: the chairman's chat. Splitting it by audience is a ledger change, which this row's Region excludes.
    const message = { text: composeDigest(held as Parameters<typeof composeDigest>[0], maxText), silent: false, audience: AUDIENCE.ask };
    const { status } = await attemptSend(key, message, { kind: "digest", covers: held.map((entry) => entry.key), audience: AUDIENCE.ask });
    return [{ key, action: status === STATUS.sent ? "digest-sent" : `digest-${status}` }];
  }

  return {
    /**
     * One observation pass: everything the watcher currently sees, in one call. Safe to call every tick, and from a fresh process.
     */
    async tick(events: unknown[]): Promise<Decision[]> {
      const decisions = await flushDigest();
      for (const raw of events) {
        let event;
        try {
          event = normalizeEvent(raw);
        } catch (error) {
          // A malformed event is a watcher bug and must be loud, but it must not stop the well-formed ones behind it.
          const rawKey = (raw as { key?: unknown } | null | undefined)?.key;
          const key = typeof rawKey === "string" ? rawKey : null;
          record({ key, status: STATUS.invalid, error: describeError(error) });
          decisions.push({ key: key ?? "", action: "invalid" });
          continue;
        }
        decisions.push(await observeOne(event));
      }
      // After every event, so the list is written ONCE for the pass and from the set the pass left (#4745).
      decisions.push(...await asks.syncList());
      return decisions;
    },
  };
}
