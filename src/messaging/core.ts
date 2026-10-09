// @ts-check
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
// WHAT THE CORE NEVER DOES: invent a message the ledger does not hold. A held-down or duplicate observation writes no line (it is not
// an attempt, and 100 ticks must not write 100 lines); a deferral, a failure and a digest overflow each write one.

import { normalizeEvent, stateFingerprint } from "./event.ts";
import { STATUS, deliveredTimestamps, deliveryLine, describeError, foldLedger, applyLine } from "./ledger.ts";
import { createRateLimiter, DEFAULT_RATE } from "./rate-limit.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const ELLIPSIS = "…";
const DIGEST_KEY_PREFIX = "digest:";
const DIGEST_ENTRY_LIMIT = 200;

export const DEFAULT_CONFIG = Object.freeze({
  kinds: Object.freeze({
    request: Object.freeze({ holdDownMs: 0, remind: true, silent: false }),
    incident: Object.freeze({ holdDownMs: 30 * MINUTE_MS, remind: true, silent: false }),
    stall: Object.freeze({ holdDownMs: 0, remind: true, silent: false }),
    // No quiet hours: the summary is the only silent message (decision 1).
    summary: Object.freeze({ holdDownMs: 0, remind: false, silent: true }),
    // A release is told once and never reminded or cleared: it is a fact that happened, not a condition that stands. Not silent: it is news.
    release: Object.freeze({ holdDownMs: 0, remind: false, silent: false }),
    // A milestone is told once and never reminded or cleared: it is a declared moment that happened, not a condition that stands. Not silent: it is news.
    milestone: Object.freeze({ holdDownMs: 0, remind: false, silent: false }),
    // A watched thing changing state is told once per change and never reminded or cleared: the chairman asked to be told when it moves, and the watch ends with the thing.
    watch: Object.freeze({ holdDownMs: 0, remind: false, silent: false }),
  }),
  reminders: Object.freeze({ max: 3, everyMs: 24 * HOUR_MS }),
  rate: Object.freeze({ burst: DEFAULT_RATE.burst, hourlyCap: DEFAULT_RATE.hourlyCap, windowMs: HOUR_MS }),
});

/**
 * All the numbers are config with the design's defaults. A partial override merges per kind, so overriding the incident hold-down
 * does not silently remove the request policy.
 *
 * @param {{kinds?: Record<string, object>, reminders?: object, rate?: object}} [overrides]
 */
export function resolveConfig(overrides: { kinds?: Record<string, object>; reminders?: object; rate?: object; } = {}) {
  const kinds = Object.fromEntries(Object.entries(DEFAULT_CONFIG.kinds).map(([kind, policy]) =>
    [kind, { ...policy, .../** @type {object} */ (overrides.kinds?.[kind] ?? {}) }]));
  return {
    kinds,
    reminders: { ...DEFAULT_CONFIG.reminders, ...overrides.reminders },
    rate: { ...DEFAULT_CONFIG.rate, ...overrides.rate },
  };
}

/**
 * @typedef {{action: "none", why: string}
 *   | {action: "send", kind: "first" | "update" | "reminder" | "cleared", reminder?: number}
 *   | {action: "withdraw"}} Plan
 */

/**
 * What to do about one observed event. Pure: the same inputs always give the same plan.
 *
 * @param {import("./event.ts").MessagingEvent} event
 * @param {import("./ledger.ts").KeyRecord | undefined} record  what the ledger says about this key
 * @param {number} nowMs
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {Plan}
 */
export function planNotification(event: import("./event.ts").MessagingEvent, record: import("./ledger.ts").KeyRecord | undefined, nowMs: number, config: ReturnType<typeof resolveConfig>): Plan {
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

/** @param {import("./ledger.ts").KeyRecord | undefined} record @param {boolean} open @returns {Plan} */
function planResolution(record: import("./ledger.ts").KeyRecord | undefined, open: boolean): Plan {
  // Resolved before the chairman was told anything: tell him nothing at all. That is the point of the hold-down.
  if (!open) return { action: "none", why: "resolved-before-sent" };
  // Told only by a digest that has not gone out yet: a "cleared" for something he never saw would be noise, and the digest must
  // stop naming it.
  return record?.pending ? { action: "withdraw" } : { action: "send", kind: "cleared" };
}

/**
 * @param {import("./ledger.ts").KeyRecord | undefined} record @param {{remind: boolean}} policy @param {number} nowMs
 * @param {ReturnType<typeof resolveConfig>} config @returns {Plan}
 */
function planReminder(record: import("./ledger.ts").KeyRecord | undefined, policy: { remind: boolean; }, nowMs: number, config: ReturnType<typeof resolveConfig>): Plan {
  if (!record || !policy.remind || record.reminders >= config.reminders.max) return { action: "none", why: "duplicate" };
  if (nowMs - record.lastNotifiedAt < config.reminders.everyMs) return { action: "none", why: "duplicate" };
  return { action: "send", kind: "reminder", reminder: record.reminders + 1 };
}

/** @param {string} body @param {number} maxText @returns {string} */
function fit(body: string, maxText: number): string {
  return body.length <= maxText ? body : `${body.slice(0, Math.max(0, maxText - 1))}${ELLIPSIS}`;
}

/**
 * The words sent. The text is shortened to `maxText` BEFORE the provider sees it (a provider refuses over-length text; it does not
 * cut it), and it is the TEXT that gives way, never the links: a message that lost its link lost the one thing to act on.
 *
 * @param {import("./event.ts").MessagingEvent} event @param {Extract<Plan, {action: "send"}>} plan @param {number} maxText
 * @param {number} reminderMax
 */
export function composeText(event: import("./event.ts").MessagingEvent, plan: Extract<Plan, { action: "send"; }>, maxText: number, reminderMax: number) {
  const prefix = plan.kind === "cleared" ? "Cleared: " : plan.kind === "reminder" ? `Reminder ${plan.reminder} of ${reminderMax}: ` : "";
  const tail = event.links.length > 0 ? `\n${event.links.join("\n")}` : "";
  if (prefix.length + tail.length >= maxText) return fit(`${prefix}${event.text}${tail}`, maxText);
  return `${fit(`${prefix}${event.text}`, maxText - tail.length)}${tail}`;
}

/**
 * The buttons a message carries: the event's own, on a message that still asks something, and only for a provider that draws them. A cleared notice asks
 * nothing, so it carries none: a button under it would answer a request that is already gone. The key is ABSENT (not empty) otherwise, so a provider
 * that never heard of `actions` is handed the message it always was.
 *
 * @param {import("./event.ts").MessagingEvent} event @param {Extract<Plan, {action: "send"}>} plan @param {{buttons?: boolean}} capabilities
 * @returns {{actions?: {label: string, data: string}[]}}
 */
export function buttonsFor(event: import("./event.ts").MessagingEvent, plan: Extract<Plan, { action: "send"; }>, capabilities: { buttons?: boolean; }): { actions?: { label: string; data: string; }[]; } {
  return plan.kind !== "cleared" && capabilities.buttons === true && event.actions.length > 0 ? { actions: [...event.actions] } : {};
}

/**
 * The ONE digest line for everything the hourly cap held back. When the entries do not all fit in `maxText` the last line says how
 * many more there are; every one of them is still covered by this digest, so none is lost.
 *
 * @param {{kind: string, text: string, key: string}[]} entries @param {number} maxText
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

/** @param {number} count @returns {string} */
function overflowLine(count: number): string {
  return `${ELLIPSIS}and ${count} more (see the delivery log)`;
}

/**
 * @typedef {{key: string, action: string}} Decision  `action` is what happened: sent, reminded, updated, cleared, digested,
 *   deferred, failed, withdrawn, invalid, or a `none` reason (held, duplicate, resolved-before-sent, already-cleared).
 */

/**
 * @param {{provider: any, ledger: ReturnType<typeof import("./ledger.ts").createLedger>, now: () => number, config?: Parameters<typeof resolveConfig>[0]}} options
 *   `now` returns epoch milliseconds. Nothing else in the core reads the clock, the filesystem path or the network.
 */
export function createMessenger({ provider, ledger, now, config: overrides }: { provider: any; ledger: ReturnType<typeof import("./ledger.ts").createLedger>; now: () => number; config?: Parameters<typeof resolveConfig>[0]; }) {
  const config = resolveConfig(overrides);
  const maxText = provider.capabilities.maxText;
  const history = ledger.read();
  const state = foldLedger(history);
  const limiter = createRateLimiter({
    now, ratePerSecond: provider.capabilities.ratePerSecond, burst: config.rate.burst,
    hourlyCap: config.rate.hourlyCap, windowMs: config.rate.windowMs,
  });
  // The hourly cap survives a restart: the hour's allowance is what the LEDGER says went out, not a counter that resets to zero.
  for (const at of deliveredTimestamps(history)) limiter.noteDelivered(at);

  /** @param {Record<string, unknown>} fields @returns {Record<string, any>} */
  const record = (fields: Record<string, unknown>): Record<string, any> => {
    const line = ledger.append(deliveryLine(/** @type {any} */ ({ provider: provider.id, ...fields })));
    applyLine(state, line);
    return line;
  };

  /** Asks the rate limiter, then the provider. @param {string} key @param {Record<string, any>} message @param {Record<string, unknown>} extra @returns {Promise<{status: string, line: Record<string, any>}>} */
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

  /** @param {import("./event.ts").MessagingEvent} event @param {Extract<Plan, {action: "send"}>} plan @returns {Promise<Decision>} */
  async function deliver(event: import("./event.ts").MessagingEvent, plan: Extract<Plan, { action: "send"; }>): Promise<Decision> {
    const known = state.get(event.key);
    const text = composeText(event, plan, maxText, config.reminders.max);
    const message = {
      text,
      silent: config.kinds[event.kind].silent,
      replyTo: plan.kind === "cleared" && provider.capabilities.replies && known?.messageRef ? known.messageRef : undefined,
      ...buttonsFor(event, plan, provider.capabilities),
    };
    // The ledger keeps the text AS SENT, link and all: what the chairman was shown is the one thing a later reading must not have to rebuild.
    const extra = { kind: plan.kind, stateHash: stateFingerprint(event), reminder: plan.reminder ?? null, text };
    const { status } = await attemptSend(event.key, message, extra);
    const spoken = { first: "sent", update: "updated", reminder: "reminded", cleared: "cleared" }[plan.kind];
    return { key: event.key, action: status === STATUS.sent ? spoken : status };
  }

  /** @param {import("./event.ts").MessagingEvent} event @returns {Promise<Decision>} */
  async function observeOne(event: import("./event.ts").MessagingEvent): Promise<Decision> {
    const plan = planNotification(event, state.get(event.key), now(), config);
    if (plan.action === "none") return { key: event.key, action: plan.why };
    if (plan.action === "withdraw") {
      record({ key: event.key, status: STATUS.withdrawn, kind: "withdrawn" });
      return { key: event.key, action: "withdrawn" };
    }
    return deliver(event, plan);
  }

  /** @returns {Promise<Decision[]>} the ONE digest line, once the hour has room for it */
  async function flushDigest(): Promise<Decision[]> {
    const held = [...state.entries()].filter(([, entry]) => entry.pending).map(([key, entry]) => ({ key, ...entry.pending }));
    if (held.length === 0 || !limiter.hasHourlyRoom()) return [];
    const key = `${DIGEST_KEY_PREFIX}${new Date(now()).toISOString()}`;
    const message = { text: composeDigest(/** @type {any} */ (held), maxText), silent: false };
    const { status } = await attemptSend(key, message, { kind: "digest", covers: held.map((entry) => entry.key) });
    return [{ key, action: status === STATUS.sent ? "digest-sent" : `digest-${status}` }];
  }

  return {
    /**
     * One observation pass: everything the watcher currently sees, in one call. Safe to call every tick, and from a fresh process.
     *
     * @param {unknown[]} events @returns {Promise<Decision[]>}
     */
    async tick(events: unknown[]): Promise<Decision[]> {
      const decisions = await flushDigest();
      for (const raw of events) {
        let event;
        try {
          event = normalizeEvent(raw);
        } catch (error) {
          // A malformed event is a watcher bug and must be loud, but it must not stop the well-formed ones behind it.
          const key = typeof (/** @type {any} */ (raw))?.key === "string" ? /** @type {any} */ (raw).key : null;
          record({ key, status: STATUS.invalid, error: describeError(error) });
          decisions.push({ key: key ?? "", action: "invalid" });
          continue;
        }
        decisions.push(await observeOne(event));
      }
      return decisions;
    },
  };
}
