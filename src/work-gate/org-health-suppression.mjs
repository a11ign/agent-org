// @ts-check
// ONE WAKE PER NEW SIGNAL CLASS OR SEVERITY CROSSING, THE SUPPRESSION LOGGED, THE REST IN A DIGEST THAT RIDES THE NEXT ORDER (a11ign/a11ign#4065, #4055 move 1b).
//
// BEFORE THIS, the gate woke `ceo` with cause `org-health` once per tick a detector fired, keyed on the signal's whole rendered subject, so a signal whose member list changed woke again: 255 wakes
// and about $150 over 2026-10-01..08 across 230 distinct causeKeys but only 18 CLASSES (`overdue` 110, `runner-behind-newest-release` 43, `order-deferred-too-long` 37). A suppression keyed on the whole
// key would have spared 20 of them; the cost is in classes that recur with a changing member list, so the decision is made per CLASS, and the table below is the one judgment call.
//
// WHAT IS KEPT, in `org-health-suppression.json` beside the other state entries: per (class, key) the last time the gate let it through; per class the distinct keys seen inside the window (the CHURN) and
// whether it is above its bound; and the digest being gathered. WHAT IS WRITTEN: every suppression as one line of `org-health-suppressed.ndjson` (class, key, count, time, why), and the digest as
// `org-health-digest.md`, which the board edition reads. NOTHING IS WRITTEN TO STDERR PER SUPPRESSION: `repeatingLinesTick` offers a line repeated every tick as a fault of its own.
//
// A SIGNAL WAKES `ceo` FOR THREE REASONS ONLY: its class is `page` and its (class, key) was not let through inside the window; its class is `digest` and its churn has just passed the bound (the SEVERITY
// CROSSING, once, and not again until the churn has fallen to the bound and passed it again); or its class is in no table (a new detector is loud, never silent -- and the test fails until it is declared).
// Only orders to `ceo` are touched: an order to a first reader (`product-manager`) is that session's work and is not a turn of `ceo`'s.
//
// A LEAF: it imports only the host's state-path helper, so `work-gate.ts` can import it. It NEVER THROWS -- an unreadable or unwritable state lets every order through (the old behaviour) and says so on stderr.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateEntryPath } from "../host-config.ts";

const HOUR_MS = 3_600_000;
/** How long a (class, key) that was let through is not let through again. */
export const WINDOW_MS = 6 * HOUR_MS;
/** How often a digest with content rides an order. A quiet hour has no content and costs nothing. */
export const DIGEST_EVERY_MS = HOUR_MS;
/** Distinct keys of one digest class inside the window above which it crosses to a wake. `overdue` had 98 distinct keys in 7 days (about 4 per window), so this fires on a storm and not on ordinary churn. */
export const CHURN_BOUND = 12;
/** The only session this module quiets. */
export const QUIETED_SESSION = "ceo";
/** `off` in this variable restores the old behaviour (every order wakes): the rollback a unit can set without a revert, and what a test of a DETECTOR through the gate's process sets so it reads the detector and not this filter. */
export const SWITCH_ENV = "A11IGN_ORG_HEALTH_SUPPRESSION";
const LOG_CAP_BYTES = 1_000_000;
const KEY_SHOWN_CHARS = 120;

const PAGE = Object.freeze({ severity: "page" });
const DIGEST = Object.freeze({ severity: "digest", bound: CHURN_BOUND });

/**
 * THE TABLE: every class an `org-health` order can carry (the `causeKey` text between `org-health/` and its first `@`, `/` or `:`), declared once.
 * `page` = a decision or an act today, rare, and missing it costs an idle org, a spent pool, a leaking fleet or a ruling not taken. `digest` = a list that has a first reader or an owner ordered by
 * name, where `ceo` reading it again adds a turn and not a decision. Measured on the trace store, 2026-10-01T08:40Z..10-08T08:40Z: the digest classes are 234 of 255 wakes, the page classes 21.
 * @type {Readonly<Record<string, { severity: "page" } | { severity: "digest", bound: number }>>}
 */
export const ORG_HEALTH_CLASSES = Object.freeze({
  "no-merge-while-work-exists": PAGE,
  "red-pr-unattended": PAGE,
  "ready-row-refused": PAGE,
  "primary-not-at-main": PAGE,
  "primary-milestone-idle": PAGE,
  "fleet-idle-while-work-waits": PAGE,
  "copies-drifted": PAGE,
  "team-access-drifted": PAGE,
  "fleet-auto-off-refusing": PAGE,
  "release-run-failed": PAGE,
  "release-behind-main": PAGE,
  "api-pool-low": PAGE,
  "node-cannot-strip": PAGE,
  "github-incident": PAGE,
  "pane-stopped-at-a-prompt": PAGE,
  "class-repeat": PAGE,
  "ruling-not-taken": PAGE,
  "chairman-ask-raised-order": PAGE,
  "chairman-ask-malformed-order": PAGE,
  "overdue": DIGEST,
  "runner-behind-newest-release": DIGEST,
  "order-deferred-too-long": DIGEST,
  "stale-wait": DIGEST,
  "stale-wait-order": DIGEST,
  "held-on-satisfied-order": DIGEST,
  "umbrella-edge-order": DIGEST,
  "idle-with-open-rows": DIGEST,
  "row-without-exactly-one-state": DIGEST,
  "wait-without-reason": DIGEST,
  "board-disagrees-with-reality": DIGEST,
});

/**
 * @typedef {{ at: number, class: string, key: string, count: number, why: string }} Suppression
 * @typedef {{ class: string, key: string, count: number, lastAt: number }} Pending
 * @typedef {{ delivered: Record<string, number>, counts: Record<string, number>, seen: Record<string, Record<string, number>>, crossed: Record<string, boolean>,
 *            pending: Record<string, Pending>, digestRodeAt: number | null }} State
 */

/** @returns {State} */
export const emptyState = () => ({ delivered: {}, counts: {}, seen: {}, crossed: {}, pending: {}, digestRodeAt: null });

/** @param {string} causeKey @returns {{ class: string, key: string } | null} `null` for a causeKey that is not an `org-health` one */
export function classAndKeyOf(causeKey) {
  const rest = /\/org-health\/(.*)$/s.exec(String(causeKey))?.[1];
  if (rest === undefined) return null;
  const cut = rest.search(/[@/:]/);
  return cut === -1 ? { class: rest, key: "" } : { class: rest.slice(0, cut), key: normalisedKey(rest.slice(cut + 1)) };
}

/**
 * The subject set, normalised: ISO timestamps and hour buckets dropped (a pool's reset time is not another pool), the member list sorted, ids kept.
 * @param {string} raw @returns {string}
 */
export function normalisedKey(raw) {
  const members = raw.replace(/\d{4}-\d{2}-\d{2}T[\d:.]*Z?/g, "").split(",").map((m) => m.replace(/[@/:]+$/, "")).filter((m) => m !== "");
  return members.sort().join(",");
}

/** @param {any} order @returns {boolean} is it an `org-health` order to the session this module quiets */
const isQuieted = (order) => order?.cause === "org-health" && order?.session === QUIETED_SESSION && classAndKeyOf(order.causeKey) !== null;

/** @param {State} state @param {string} cls @param {number} now @returns {number} the distinct keys of `cls` seen inside the window, after dropping the older ones */
function churnOf(state, cls, now) {
  const seen = state.seen[cls] ?? {};
  for (const [key, at] of Object.entries(seen)) if (now - at >= WINDOW_MS) delete seen[key];
  if (Object.keys(seen).length === 0) delete state.seen[cls];
  return Object.keys(seen).length;
}

/** A class that has fallen back to its bound (or was not seen at all) may cross again. @param {State} state @param {number} now */
function resetFallenClasses(state, now) {
  for (const cls of new Set([...Object.keys(state.seen), ...Object.keys(state.crossed)])) {
    const rule = ORG_HEALTH_CLASSES[cls];
    if (rule?.severity === "digest" && churnOf(state, cls, now) <= rule.bound) delete state.crossed[cls];
  }
}

/** @param {State} state @param {string} cls @param {string} key @param {number} now */
function sighted(state, cls, key, now) {
  (state.seen[cls] ??= {})[key] = now;
}

/**
 * @param {State} state @param {{ class: string, key: string }} id @param {number} now @returns {"deliver" | { why: string }} the decision for one order
 */
function decide(state, { class: cls, key }, now) {
  const rule = ORG_HEALTH_CLASSES[cls] ?? PAGE;
  const ck = `${cls}\t${key}`;
  if (rule.severity === "digest") {
    const crossing = churnOf(state, cls, now) > /** @type {number} */ (rule.bound) && !state.crossed[cls];
    if (!crossing) return { why: state.crossed[cls] ? "digest class, already crossed" : "digest class" };
    state.crossed[cls] = true;
    return "deliver";
  }
  const last = state.delivered[ck];
  return last !== undefined && now - last < WINDOW_MS ? { why: "inside the window" } : "deliver";
}

/**
 * THE DECISION FOR EVERY ORDER OF ONE TICK, on `state` (mutated). Pure: no file is touched here.
 * @param {State} state @param {any[]} orders @param {number} now
 * @returns {{ delivered: any[], suppressed: Suppression[] }} every order that is not an `org-health` order to `ceo` is delivered, untouched
 */
export function applySuppression(state, orders, now) {
  const delivered = [], suppressed = [];
  resetFallenClasses(state, now); // BEFORE the decisions: a class that fell to its bound while no tick saw it may cross again on this one
  for (const order of orders) {
    const id = isQuieted(order) ? classAndKeyOf(order.causeKey) : null;
    if (id === null) { delivered.push(order); continue; }
    sighted(state, id.class, id.key, now);
    const ck = `${id.class}\t${id.key}`;
    const verdict = decide(state, id, now);
    if (verdict === "deliver") { delivered.push(order); state.delivered[ck] = now; state.counts[ck] = 0; continue; }
    state.counts[ck] = (state.counts[ck] ?? 0) + 1;
    state.pending[ck] = { class: id.class, key: id.key, count: state.counts[ck], lastAt: now };
    suppressed.push({ at: now, class: id.class, key: id.key, count: state.counts[ck], why: verdict.why });
  }
  return { delivered, suppressed };
}

/**
 * THE DIGEST: classes, keys and counts with a pointer to the log, never pasted content. `null` for a quiet window (nothing suppressed since the last one), which is no digest and no wake.
 * @param {State} state @param {number} now @param {{ log: string }} where @returns {string | null}
 */
export function digestText(state, now, where) {
  const entries = Object.values(state.pending);
  if (entries.length === 0) return null;
  /** @type {Map<string, Pending[]>} */
  const byClass = new Map();
  for (const e of entries) byClass.set(e.class, [...(byClass.get(e.class) ?? []), e]);
  const lines = [...byClass].sort(([a], [b]) => a.localeCompare(b)).map(([cls, es]) => {
    const latest = es.reduce((a, b) => (b.lastAt > a.lastAt ? b : a));
    const shown = latest.key.length > KEY_SHOWN_CHARS ? `${latest.key.slice(0, KEY_SHOWN_CHARS)}...` : latest.key;
    return `- \`${cls}\` (${ORG_HEALTH_CLASSES[cls]?.severity ?? "page"}): ${es.reduce((n, e) => n + e.count, 0)} ticks suppressed over ${es.length} key(s); newest \`${shown || "(whole class)"}\` at ${new Date(latest.lastAt).toISOString()}`;
  });
  return `ORG-HEALTH DIGEST (${new Date(now).toISOString()}): signals that did NOT wake you since the last one. Each line is a class, its suppressed ticks and its newest key; the full lines (class, key, count, time, why) are in \`${where.log}\`.\n${lines.join("\n")}`;
}

/** @param {State} state @param {number} now @returns {boolean} does a digest with content ride now */
const digestDue = (state, now) => Object.keys(state.pending).length > 0 && (state.digestRodeAt === null || now - state.digestRodeAt >= DIGEST_EVERY_MS);

/**
 * Append the digest to the FIRST order `ceo` receives, for any reason, when one is due; the gathered digest is then spent. With no order for `ceo` it is kept for the next that comes.
 * @param {State} state @param {any[]} orders @param {number} now @param {{ log: string }} where
 * @returns {{ orders: any[], digest: string | null }} `digest` is the text that rode (or `null`)
 */
export function ridingDigest(state, orders, now, where) {
  const at = orders.findIndex((o) => o?.session === QUIETED_SESSION);
  const text = digestText(state, now, where);
  if (at === -1 || text === null || !digestDue(state, now)) return { orders, digest: null };
  state.pending = {};
  state.digestRodeAt = now;
  return { orders: orders.map((o, i) => (i === at ? { ...o, prompt: `${o.prompt}\n\n${text}\n` } : o)), digest: text };
}

/** @param {string} path @param {(line: string) => void} log @returns {State} an unreadable file is an empty state, SAID: the next tick writes a fresh one */
function readState(path, log) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return emptyState();
    log(`org-health-suppression: cannot read ${path} (${String(/** @type {any} */ (err)?.message).split("\n")[0]}) -- starting empty.\n`);
    return emptyState();
  }
  try { return { ...emptyState(), ...JSON.parse(text) }; } catch (err) {
    log(`org-health-suppression: ${path} is not JSON (${String(/** @type {any} */ (err)?.message).split("\n")[0]}) -- starting empty.\n`);
    return emptyState();
  }
}

/** The log keeps its newest half when it passes the cap, so a standing signal cannot fill the disk. @param {string} path */
function capLog(path) {
  if (statSync(path).size <= LOG_CAP_BYTES) return;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  writeFileSync(path, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`);
}

/** @param {{ state: string, log: string, digest: string }} paths @param {State} state @param {{ suppressed: Suppression[], digest: string | null, now: number }} wrote */
function persist(paths, state, { suppressed, digest, now }) {
  mkdirSync(dirname(paths.state), { recursive: true });
  if (suppressed.length > 0) {
    appendFileSync(paths.log, suppressed.map((s) => JSON.stringify({ ...s, at: new Date(s.at).toISOString() })).join("\n") + "\n");
    capLog(paths.log);
  }
  const text = digest ?? digestText(state, now, { log: paths.log });
  if (text !== null) writeFileSync(paths.digest, `${text}\n`);
  writeFileSync(`${paths.state}.tmp`, JSON.stringify(state));
  renameSync(`${paths.state}.tmp`, paths.state);
}

/**
 * @param {string} dir @returns {{ state: string, log: string, digest: string }} the three entries, in the host's state directory
 */
export const suppressionPaths = (dir) => ({ state: join(dir, "org-health-suppression.json"), log: join(dir, "org-health-suppressed.ndjson"), digest: join(dir, "org-health-digest.md") });

/**
 * THE TICK'S ONE CALL: quiet the `org-health` orders to `ceo`, ride the digest on the first order `ceo` still receives, and write what was kept. Returns the orders to deliver.
 * NEVER THROWS: on any failure the orders come back unchanged and the failure is said on stderr (a state that cannot be written is a fault the tick should repeat, not hide).
 * @param {any[]} orders @param {{ now?: number, dir?: string, log?: (line: string) => void, env?: Record<string, string | undefined> }} [io]
 * @returns {any[]}
 */
export function quietOrgHealth(orders, { now = Date.now(), dir = stateEntryPath(""), log = (line) => process.stderr.write(line), env = process.env } = {}) {
  if (env[SWITCH_ENV] === "off") return orders;
  try {
    const paths = suppressionPaths(dir);
    const state = readState(paths.state, log);
    const { delivered, suppressed } = applySuppression(state, orders, now);
    const { orders: out, digest } = ridingDigest(state, delivered, now, { log: paths.log });
    persist(paths, state, { suppressed, digest, now });
    return out;
  } catch (err) {
    log(`org-health-suppression: could not run (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}) -- every order is delivered this tick.\n`);
    return orders;
  }
}
