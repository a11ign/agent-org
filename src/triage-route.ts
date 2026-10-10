// #4385: THE TRIAGE ROUTE. `triageOrder` (#4384) answers where one order should go; this module is what the wake path does with the answer, for the orders it is
// allowed to ask about: a MANAGER seat's gate order. Everything else is delivered untouched and never sent to the provider -- a worker's order, a reviewer's,
// anything chairman-bound, a resumed order, an order with no `cause` (a direct message, which may be the chairman's) and a `--needs-decision` one.
//
// NO DROPS. `digest` and `drop` are the same route here: the order is HELD, in an append-only log beside the wake ledger, and delivered with the same seat's next real
// order or, at the latest, alone once its oldest item is {@link DIGEST_FLUSH_MS} old. A held order is not in the wake ledger until it is delivered: the ledger answers "did I
// just ask?", and a held order has not asked anyone anything, so the wakes-per-hour reading stays a count of wakes. While it is held the gate keeps emitting its cause, and
// the pending log is what stops it being asked about (and stored) a second time.
//
// JEV NEVER ACTS. The route is a decision about delivery. Nothing here labels, comments, edits or sends because of an answer: the order's text is agent-written state and
// the provider is a third party.
//
// THE STATE THE PROVIDER SEES IS FACTS (#4631): the cause, its key, the seat, the age of the last delivery of the same key to the same seat, whether main is red and whether a
// chairman direction is attached. The order's text is not among them, and `triage-provider.ts` whitelists the fields so it cannot become one by accident.
//
// A HELD ORDER'S OUTCOME IS NOW READABLE (#4631). When the same cause is offered again to the same seat within a day of a held order's delivery, one `outcome` line says
// `needed-action: true`. It is a PROXY, and the line says so: the gate emitting a cause again shows it still stands, not that anybody acted on the digest.
//
// THE REVERT IS `"provider": "none"` in the host's `triage` block. Routing then asks nobody and writes nothing, and delivery is byte-identical to before. Orders already held
// still ride or flush, because a revert must not strand what was held under the old setting.
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "./lib/cli-flags.ts";
import { triageOrder, type Label, type Said, type Triage, type TriageDeps, type TriageOrder } from "./triage-provider.ts";

/** The seats whose wakes cost the most and read the most digest material (the row names them). */
export const TRIAGE_MANAGERS: readonly string[] = Object.freeze(["ceo", "product-manager", "orchestrator"]);
/** The longest a held order waits when no real order reaches its seat: the gate flushes it alone at this age. */
export const DIGEST_FLUSH_MS = 60 * 60_000;
/** How many bytes of held orders ride one order, well inside what the order's own text also spends from. */
const DIGEST_RIDE_BYTES = 16 * 1024;
const MS_PER_MINUTE = 60_000;
const DIGEST_CAUSE = "triage-digest";
const CHAIRMAN = /chairman/i;
/** The cause `trunk-red.ts` gives the one order a red main produces. */
const RED_MAIN_CAUSE = "trunk-red";
/** How long after a held order's delivery its coming back is read as "it needed action". */
export const OUTCOME_WINDOW_MS = 24 * 60 * MS_PER_MINUTE;
export const NEEDED_ACTION_PROXY = "a PROXY: the same cause was offered to the same seat again within 24 hours of the held order's delivery, which shows it still stood and not that anybody acted on it";

/** `startFresh` is the gate's own mark of a row the chairman prioritised (#4524): the one structured chairman direction an order carries. */
export type GateOrder = { session: string; causeKey: string; prompt: string; cause?: string; resume?: boolean; decision?: boolean; startFresh?: boolean };
/** What was decided about one asked order: the ledger line the row calls `triage: { route, via, confidence }`. `reason` is carried when `via` is `none`: why nobody answered (a key that could not be read, a refusal, a timeout), which the outage cannot otherwise be diagnosed from. */
export type Routing = { route: Label; via: Triage["via"]; confidence?: number; reason?: string };
/** An order held for the digest: all that is needed to deliver it later, and what the provider said. */
export type Held = { at: number; causeKey: string; session: string; prompt: string; triage: Routing };
/** Every asked order, held or not -- the list the measurement reads. `answers` are the values composed into the route; `said` is what the provider answered to each question before any floor, so a floor can be tuned from a replay. */
export type Asked = { at: number; causeKey: string; session: string; triage: Routing; held: boolean; answers?: Record<string, string>; said?: Record<string, Said> };
/** What came of a held order: it was offered again after its delivery. `proxy` says what that does and does not show. */
export type Outcome = { at: number; causeKey: string; session: string; deliveredAt: number; "needed-action": true; proxy: string };
type DigestLine = { asked: Asked; prompt?: string } | { delivered: string[]; at: number; carrier: string } | { outcome: Outcome };
/** The log folded once: what is held, when each held order was last delivered (by seat and cause), and which deliveries already have an outcome line. */
type Folded = { pending: Held[]; deliveredAt: Map<string, number>; recorded: Set<string> };

/** The digest log sits beside the wake ledger, the way every other piece of the tick's state does. */
export const digestPathFrom = (ledgerPath: string): string => join(dirname(ledgerPath), "triage-digest");

const causeOf = (order: Pick<GateOrder, "causeKey" | "cause">): string => order.cause ?? order.causeKey.split("/")[1] ?? "";
const seatKey = (session: string, causeKey: string): string => `${session}\t${causeKey}`;

/** Is this the order a red main produces? The tick asks it of EVERY gate order, so a red main whose order went out a few minutes ago is still known to be red. */
export const namesRedMain = (order: Pick<GateOrder, "causeKey" | "cause">): boolean => causeOf(order) === RED_MAIN_CAUSE;

/**
 * MAY THIS ORDER BE ASKED ABOUT AT ALL? Only a manager's gate order with a cause. `exclude` is the causeKeys of the orders the tick wrote itself (a stalled order, a pane at a
 * prompt): they say something is stuck, and a digest is the wrong place to hear that.
 */
export function routable(order: GateOrder, exclude: ReadonlySet<string> = new Set()): boolean {
  if (!TRIAGE_MANAGERS.includes(order.session)) return false;
  if (causeOf(order) === "" || CHAIRMAN.test(order.causeKey)) return false;
  return order.resume !== true && order.decision !== true && !exclude.has(order.causeKey);
}

/** The log, folded in order: a `delivered` line retires what precedes it, so the same cause held again later is live again. A malformed line throws, like the queue's. */
function foldDigest(path: string, read: typeof readFileSync): Folded {
  let raw: string;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return { pending: [], deliveredAt: new Map(), recorded: new Set() };
    throw err;
  }
  const pending = new Map<string, Held>();
  const deliveredAt = new Map<string, number>();
  const recorded = new Set<string>();
  for (const text of raw.split("\n").filter((line) => line.trim() !== "")) {
    const line = JSON.parse(text) as DigestLine;
    if ("outcome" in line) {
      recorded.add(`${seatKey(line.outcome.session, line.outcome.causeKey)}\t${line.outcome.deliveredAt}`);
    } else if ("delivered" in line) {
      for (const key of line.delivered) {
        const held = pending.get(key);
        if (held !== undefined) deliveredAt.set(seatKey(held.session, key), line.at);
        pending.delete(key);
      }
    } else if (line.asked.held && typeof line.prompt === "string" && !pending.has(line.asked.causeKey)) {
      const { at, causeKey, session, triage } = line.asked;
      pending.set(causeKey, { at, causeKey, session, prompt: line.prompt, triage });
    }
  }
  return { pending: [...pending.values()], deliveredAt, recorded };
}

/** What is held now. */
export const readDigest = (path: string, read: typeof readFileSync = readFileSync): Held[] => foldDigest(path, read).pending;

const appendLine = (path: string, line: DigestLine): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
};

/** What the tick knows that an order does not say. A part left out is NOT KNOWN, and the provider's state then omits the field rather than saying "no". */
export type TickFacts = { mainRed?: boolean; deliveries?: readonly { at: number; key: string; session: string }[] };
export type RouteDeps = {
  host: TriageDeps["host"]; digestPath: string; now?: () => number; triage?: typeof triageOrder;
  triageDeps?: Omit<TriageDeps, "host">; exclude?: ReadonlySet<string>; facts?: TickFacts;
};

/** The facts of one order that the provider is asked about. Its text is not among them. */
function stateOf(order: GateOrder, facts: TickFacts, now: number): TriageOrder {
  const deliveries = facts.deliveries?.filter((d) => d.key === order.causeKey && d.session === order.session);
  const last = deliveries === undefined ? undefined : deliveries.length === 0 ? null : Math.max(...deliveries.map((d) => d.at));
  return {
    cause: causeOf(order), causeKey: order.causeKey, session: order.session,
    ...(last === undefined ? {} : { lastDeliveredMinutesAgo: last === null ? null : Math.max(0, Math.round((now - last) / MS_PER_MINUTE)) }),
    ...(facts.mainRed === undefined ? {} : { mainRed: facts.mainRed }),
    chairmanDirection: order.startFresh === true || CHAIRMAN.test(order.causeKey),
  };
}

/** A provider that throws is a provider that failed: the order is delivered as before, and the line says why. */
async function askSafely(order: GateOrder, deps: RouteDeps, now: number): Promise<Triage> {
  const ask = deps.triage ?? triageOrder;
  try {
    return await ask(stateOf(order, deps.facts ?? {}, now), { ...deps.triageDeps, host: deps.host });
  } catch {
    return { route: "wake", via: "none", reason: "the triage read failed" };
  }
}

const routing = ({ route, via, confidence, reason }: Triage): Routing => ({ route, via, ...(confidence === undefined ? {} : { confidence }), ...(via === "none" ? { reason } : {}) });

/**
 * READ A HELD ORDER'S OUTCOME. An order that was held, delivered, and is offered AGAIN to the same seat inside {@link OUTCOME_WINDOW_MS} gets one `outcome` line: it still
 * stood after the digest carried it. One line per delivery, however many ticks offer it again. Provider `none` never reaches here: it writes nothing.
 */
function recordNeededAction(offered: readonly GateOrder[], history: Folded, { digestPath, at }: { digestPath: string; at: number }): void {
  for (const { session, causeKey } of offered) {
    const deliveredAt = history.deliveredAt.get(seatKey(session, causeKey));
    if (deliveredAt === undefined || at - deliveredAt > OUTCOME_WINDOW_MS) continue;
    const identity = `${seatKey(session, causeKey)}\t${deliveredAt}`;
    if (history.recorded.has(identity)) continue;
    history.recorded.add(identity);
    appendLine(digestPath, { outcome: { at, causeKey, session, deliveredAt, "needed-action": true, proxy: NEEDED_ACTION_PROXY } });
  }
}

/**
 * SPLIT THE TICK'S ORDERS INTO WHAT IS DELIVERED NOW AND WHAT IS HELD. Provider `none` or absent returns the orders as they came, asks nobody and writes nothing. Below the
 * host's `minConfidence`, or on any provider error, the question that was not answered takes its fallback, which wakes. An order already held is not asked again.
 * The reads run together, so a slow provider costs one timeout and not one per order.
 */
export async function routeOrders<T extends GateOrder>(orders: readonly T[], deps: RouteDeps): Promise<{ deliver: T[]; held: Held[] }> {
  if ((deps.host.triage?.provider ?? "none") === "none") return { deliver: [...orders], held: [] };
  const history = foldDigest(deps.digestPath, readFileSync);
  const alreadyHeld = new Set(history.pending.map((h) => h.causeKey));
  const asking = orders.filter((o) => routable(o, deps.exclude) && !alreadyHeld.has(o.causeKey));
  const at = (deps.now ?? Date.now)();
  recordNeededAction(asking, history, { digestPath: deps.digestPath, at });
  const answers = new Map(await Promise.all(asking.map(async (o) => [o, await askSafely(o, deps, at)] as const)));
  const deliver: T[] = [];
  const held: Held[] = [];
  for (const order of orders) {
    if (alreadyHeld.has(order.causeKey) && routable(order, deps.exclude)) continue;
    const answer = answers.get(order);
    if (answer === undefined) { deliver.push(order); continue; }
    const { causeKey, session, prompt } = order;
    const keep = answer.route !== "wake";
    const asked: Asked = { at, causeKey, session, triage: routing(answer), held: keep, ...(answer.answers === undefined ? {} : { answers: answer.answers }), ...(answer.said === undefined ? {} : { said: answer.said }) };
    appendLine(deps.digestPath, { asked, ...(keep ? { prompt } : {}) });
    if (keep) held.push({ at, causeKey, session, prompt, triage: routing(answer) }); else deliver.push(order);
  }
  return { deliver, held };
}

const age = (ms: number): string => `${Math.max(0, Math.round(ms / MS_PER_MINUTE))} minute(s)`;

/** The held orders as a section of the order they ride in. It says they asked nothing yet and are readings at the moment they were held. */
function digestSection(items: readonly Held[], now: number): string {
  const body = items.map((h, i) => `DIGEST ${i + 1} (held ${age(now - h.at)}, ${h.triage.via} read it as ${h.triage.route}):\n${h.prompt}`);
  return `HELD FOR YOUR NEXT ORDER, THIS ONE: ${items.length} item${items.length === 1 ? "" : "s"} a triage read judged were not worth a wake of their own. `
    + `Each is a reading at the moment it was held -- re-read anything it names, and act on any that still asks something.\n\n${body.join("\n\n")}`;
}

/** The oldest-first items that fit one order; the first is always taken, so a single large item is never stuck. */
function fit(items: readonly Held[], budget: number): Held[] {
  const take: Held[] = [];
  let used = 0;
  for (const item of [...items].sort((a, b) => a.at - b.at)) {
    used += Buffer.byteLength(item.prompt);
    if (take.length > 0 && used > budget) break;
    take.push(item);
  }
  return take;
}

/**
 * LET THE HELD ORDERS RIDE EACH ORDER ADDRESSED TO THEIR SEAT. `rides` is keyed by the carrying order's causeKey and names the held causeKeys it carried, so the caller
 * retires them only once that order is recorded as sent: an order that is refused carries nothing away.
 */
export function ridingDigest<T extends { session: string; causeKey: string; prompt: string }>(orders: readonly T[], pending: readonly Held[], now: number): { orders: T[]; rides: Map<string, string[]> } {
  const rides = new Map<string, string[]>();
  const taken = new Set<string>();
  const carrying = orders.map((order) => {
    const mine = pending.filter((h) => h.session === order.session);
    if (mine.length === 0 || taken.has(order.session)) return order;
    taken.add(order.session);
    const take = fit(mine, DIGEST_RIDE_BYTES);
    rides.set(order.causeKey, take.map((h) => h.causeKey));
    return { ...order, prompt: `${order.prompt}\n\n${digestSection(take, now)}` };
  });
  return { orders: carrying, rides };
}

/** Is any held order old enough that the tick must deliver it alone? The quiet exit asks this before it decides there is nothing to do. */
export const digestDue = (pending: readonly Held[], now: number): boolean => pending.some((h) => now - h.at >= DIGEST_FLUSH_MS);

/**
 * THE ORDERS THE TICK WRITES FOR A SEAT THAT HELD ITEMS A HOUR AND NO REAL ORDER REACHED. `carried` is the held causeKeys the riding above has already placed; a seat
 * whose oldest uncarried item is under {@link DIGEST_FLUSH_MS} is left holding. The key carries the oldest item's time, so two flushes never share one.
 */
export function flushOrders(pending: readonly Held[], carried: ReadonlySet<string>, now: number): { orders: GateOrder[]; rides: Map<string, string[]> } {
  const orders: GateOrder[] = [];
  const rides = new Map<string, string[]>();
  const left = pending.filter((h) => !carried.has(h.causeKey));
  for (const session of new Set(left.map((h) => h.session))) {
    const mine = left.filter((h) => h.session === session);
    if (!digestDue(mine, now)) continue;
    const take = fit(mine, DIGEST_RIDE_BYTES);
    const causeKey = `${session}/${DIGEST_CAUSE}/${take[0].at}`;
    orders.push({ session, causeKey, cause: DIGEST_CAUSE, prompt: digestSection(take, now) });
    rides.set(causeKey, take.map((h) => h.causeKey));
  }
  return { orders, rides };
}

/**
 * RETIRE WHAT A DELIVERED ORDER CARRIED. Each ridden cause enters the wake ledger now (`ledgerAppend`), because now is when it was delivered: it keeps the gate from
 * emitting the cause again inside the wake window, exactly as a delivery of it would have.
 */
export function settleRidden(carrier: string, ridden: readonly string[] | undefined, deps: { digestPath: string; ledgerAppend: (causeKey: string) => void; now?: () => number }): void {
  if (ridden === undefined || ridden.length === 0) return;
  for (const causeKey of ridden) deps.ledgerAppend(causeKey);
  appendLine(deps.digestPath, { delivered: [...ridden], at: (deps.now ?? Date.now)(), carrier });
}

export const carriedKeys = (...rides: ReadonlyMap<string, readonly string[]>[]): Set<string> => new Set(rides.flatMap((r) => [...r.values()].flat()));

// ---- THE DIGEST SHARE, READ (a11ign#4627 item 2) ----
/** The share of a day's asks held for the digest under which the day is a ledger incident, once it holds {@link INCIDENT_MIN_ASKS} asks (chairman, a11ign#4627). */
export const DIGEST_SHARE_FLOOR = 0.05;
export const INCIDENT_MIN_ASKS = 50;
const PERCENT = 100;

/** One UTC day of `asked` lines: how many were asked, how many of those were held, and whether the day is an incident. */
export type DigestDay = { day: string; asked: number; held: number; share: number; incident: boolean };

/**
 * THE DIGEST SHARE PER DAY, from the log's `asked` lines. A line that is not JSON, or an `asked` line without a time and a held flag, is counted and not guessed at: a share over lines
 * that were skipped silently would look complete and be wrong by exactly those. A day is an incident under {@link DIGEST_SHARE_FLOOR} over at least {@link INCIDENT_MIN_ASKS} asks.
 */
export function digestShareByDay(text: string): { days: DigestDay[]; unreadable: number } {
  const byDay = new Map<string, { asked: number; held: number }>();
  let unreadable = 0;
  for (const raw of text.split("\n").filter((line) => line.trim() !== "")) {
    let line: Partial<DigestLine> & { asked?: Partial<Asked> };
    try {
      line = JSON.parse(raw);
    } catch {
      unreadable += 1;
      continue;
    }
    if (typeof line !== "object" || line === null || !("asked" in line)) continue;
    const { at, held } = line.asked ?? {};
    if (typeof at !== "number" || !Number.isFinite(at) || typeof held !== "boolean") { unreadable += 1; continue; }
    const day = new Date(at).toISOString().slice(0, 10);
    const count = byDay.get(day) ?? { asked: 0, held: 0 };
    count.asked += 1;
    if (held) count.held += 1;
    byDay.set(day, count);
  }
  const days = [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, { asked, held }]): DigestDay => {
    const share = held / asked;
    return { day, asked, held, share, incident: asked >= INCIDENT_MIN_ASKS && share < DIGEST_SHARE_FLOOR };
  });
  return { days, unreadable };
}

const percent = (share: number): string => `${(share * PERCENT).toFixed(1)}%`;

/** The reading a person reads: a line per day, and an incident line under it for each day that is one. */
export function formatDigestShare({ days, unreadable }: ReturnType<typeof digestShareByDay>): string {
  if (days.length === 0) return ["No asked orders in the triage digest log.", ...(unreadable === 0 ? [] : [`${unreadable} line(s) could not be read.`])].join("\n");
  return [
    "Triage digest share per day (UTC), held of asked:",
    ...days.map((d) => `${d.day}  ${d.held} of ${d.asked}  ${percent(d.share)}`),
    ...days.filter((d) => d.incident).map((d) => `LEDGER INCIDENT: ${d.day} wake-triage digest share ${percent(d.share)} (${d.held} of ${d.asked} asks) is under ${percent(DIGEST_SHARE_FLOOR)}.`),
    ...(unreadable === 0 ? [] : [`${unreadable} line(s) could not be read and are not in this reading.`]),
  ].join("\n");
}

async function main(): Promise<void> {
  refuseUnknownFlags(["--log="], { entry: import.meta.url, command: "node src/triage-route.ts" });
  let path = flagValue(process.argv, "log");
  if (path === undefined) {
    // Imported here and not at the top: the modules that know the host resolve its checkout on import, which the routing above must not need.
    const { stateEntryPath } = await import("./host-config.ts");
    path = digestPathFrom(stateEntryPath("wake-ledger"));
  }
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: string })?.code !== "ENOENT") {
      process.stderr.write(`CANNOT ASK: the digest log could not be read (${(err as { code?: string })?.code ?? "unknown error"}). That is a failed read, NOT a day with no asks.\n`);
      process.exit(2);
    }
  }
  process.stdout.write(`${formatDigestShare(digestShareByDay(text))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
