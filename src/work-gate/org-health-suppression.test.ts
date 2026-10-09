// no-token: gh -- `org-health-suppression.mjs` reads and writes only a directory it is given (a temp one per test) and reaches nothing else (a11ign/a11ign#4065, #4055 move 1b).
//
// WHAT THE TESTS SHOW, each with its positive control beside it: a `page` class is delivered on first sight and not again inside the window (the control: it IS delivered again once the window has passed,
// and a different key is delivered at once); a `digest` class is never delivered by itself and is counted in the digest (the control: the same harness delivers it at the crossing); the crossing is
// once, and again only after a fall; a quiet window is no digest; and EVERY class a detector can emit is declared (the control: the discovery finds the classes it is known to hold).
// ONE HARNESS: `Tick` runs `quietOrgHealth` on a temp directory with a fake clock, so each negative differs from its positive by one fact.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { SIGNALS } from "../org-health.mjs";
import { CHURN_BOUND, DIGEST_EVERY_MS, ORG_HEALTH_CLASSES, SWITCH_ENV, WINDOW_MS, classAndKeyOf, quietOrgHealth, suppressionPaths } from "./org-health-suppression.mjs";

const T0 = Date.parse("2026-10-09T00:00:00Z");
const HOUR = 3_600_000;
const dirs = /** @type {string[]} */ ([]);
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** @param {string} cls @param {string} key @param {string} [session] */
const order = (cls: string, key: string, session: string = "ceo") => ({ session, cause: "org-health", subject: cls, discriminator: key, prompt: `ORG HEALTH: ${cls}`, causeKey: `${session}/org-health/${cls}@${key}` });
const other = (session = "ceo") => ({ session, cause: "pr-green", subject: "x", discriminator: "1", prompt: "a green PR", causeKey: `${session}/pr-green/1` });

/** A temp state directory and a clock; `tick(orders, atMs)` is what the gate calls, with what it wrote on stderr kept. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "org-health-suppression-"));
  dirs.push(dir);
  const said = /** @type {string[]} */ ([]);
  const paths = suppressionPaths(dir);
  const tick = (/** @type {any[]} */ orders: any[], /** @type {number} */ now: number) => quietOrgHealth(orders, { now, dir, log: (line) => said.push(line) });
  const logLines = () => (existsSync(paths.log) ? readFileSync(paths.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { dir, said, paths, tick, logLines };
}

test("a page class is delivered on first sight; the same (class, key) inside the window is not, and ONE suppression is logged with its count", () => {
  const { tick, logLines, said } = harness();
  assert.equal(tick([order("api-pool-low", "a11ign-ai-workers/graphql")], T0).length, 1, "POSITIVE: first sight wakes");
  assert.equal(tick([order("api-pool-low", "a11ign-ai-workers/graphql")], T0 + 5 * 60_000).length, 0, "the same key five minutes later does not");
  assert.deepEqual(logLines().map((l) => [l.class, l.key, l.count, l.at, l.why]),
    [["api-pool-low", "a11ign-ai-workers/graphql", 1, new Date(T0 + 5 * 60_000).toISOString(), "inside the window"]]);
  assert.equal(tick([order("api-pool-low", "a11ign-ai-workers/graphql")], T0 + 10 * 60_000).length, 0);
  assert.equal(logLines().at(-1).count, 2, "the count rises with each suppression");
  assert.deepEqual(said, [], "NOTHING per suppression on stderr: a repeated line is offered as a fault of its own");
});

test("the same class with a DIFFERENT key is delivered, and the same key is delivered again once the window has passed", () => {
  const { tick } = harness();
  tick([order("release-run-failed", "111")], T0);
  assert.equal(tick([order("release-run-failed", "222")], T0 + 60_000).length, 1, "a new key of the class wakes");
  assert.equal(tick([order("release-run-failed", "111")], T0 + 60_000 * 2).length, 0, "the old key does not");
  assert.equal(tick([order("release-run-failed", "111")], T0 + WINDOW_MS + 1).length, 1, "CONTROL: past the window the same key wakes again, so the empty results above are a wired pass");
});

test("a timestamp in the key is not part of it, and the member list is sorted: a pool's reset time and the order of a list do not mint a new wake", () => {
  assert.deepEqual(classAndKeyOf("ceo/org-health/api-pool-low@a11ign-ai-workers/graphql/2026-10-05T03:18:35Z"), { class: "api-pool-low", key: "a11ign-ai-workers/graphql" });
  assert.deepEqual(classAndKeyOf("ceo/org-health/red-pr-unattended@2026-10-02T17"), { class: "red-pr-unattended", key: "" });
  assert.deepEqual(classAndKeyOf("ceo/org-health/github-incident/djlmxz2zd0j7"), { class: "github-incident", key: "djlmxz2zd0j7" });
  assert.deepEqual(classAndKeyOf("ceo/org-health/stale-wait@#3390:#3408"), { class: "stale-wait", key: "#3390:#3408" });
  assert.equal(classAndKeyOf("ceo/pr-green/1"), null, "not an org-health causeKey");
  assert.equal(classAndKeyOf("ceo/org-health/overdue@pr#2,pr#1")?.key, classAndKeyOf("ceo/org-health/overdue@pr#1,pr#2")?.key);
  const { tick } = harness();
  tick([order("api-pool-low", "p/graphql/2026-10-05T03:18:35Z")], T0);
  assert.equal(tick([order("api-pool-low", "p/graphql/2026-10-05T04:18:35Z")], T0 + 60_000).length, 0, "the same pool with a later reset time is the same signal");
  assert.equal(tick([order("api-pool-low", "q/graphql/2026-10-05T04:18:35Z")], T0 + 120_000).length, 1, "CONTROL: another pool is not");
});

test("a digest class is never delivered by itself and appears in the digest with its count; the digest rides the next order ceo receives, once", () => {
  const { tick, paths } = harness();
  const overdue = order("overdue", "pr#1,pr#2");
  assert.equal(tick([overdue], T0).length, 0, "a digest class does not wake");
  assert.equal(tick([overdue], T0 + 60_000).length, 0);
  assert.equal(existsSync(paths.digest), true);
  assert.match(readFileSync(paths.digest, "utf8"), /`overdue` \(digest\): 2 ticks suppressed over 1 key\(s\)/);
  const [ridden, ...rest] = tick([other("ceo")], T0 + 2 * 60_000);
  assert.equal(rest.length, 0);
  assert.match(ridden.prompt, /^a green PR\n\nORG-HEALTH DIGEST/);
  assert.match(ridden.prompt, /`overdue` \(digest\): 2 ticks suppressed over 1 key\(s\)/, "both ticks that held it are counted");
  assert.match(ridden.prompt, /org-health-suppressed\.ndjson/, "a pointer to the log, not pasted content");
  assert.doesNotMatch(tick([other("ceo")], T0 + 3 * 60_000)[0].prompt, /DIGEST/, "spent: the next order carries none");
});

test("a quiet window produces no digest and no wake, and a digest rides no order that is not for ceo", () => {
  const { tick, paths } = harness();
  assert.deepEqual(tick([], T0), []);
  assert.equal(existsSync(paths.digest), false, "nothing suppressed, no digest file");
  tick([order("overdue", "pr#1")], T0 + 60_000);
  assert.equal(tick([other("engineers")], T0 + 120_000)[0].prompt, "a green PR", "CONTROL: a digest is pending, and an order to another session is untouched");
  assert.match(tick([other("ceo")], T0 + 180_000)[0].prompt, /DIGEST/, "the same digest rides the first ceo order");
  assert.deepEqual(tick([], T0 + 2 * HOUR), [], "and an hour with nothing new has nothing to ride");
});

test("the digest rides at most once per DIGEST_EVERY, and what is gathered meanwhile waits for the next", () => {
  const { tick } = harness();
  tick([order("overdue", "pr#1")], T0);
  assert.match(tick([other()], T0 + 1000)[0].prompt, /DIGEST/);
  tick([order("stale-wait", "#1:#2")], T0 + 2000);
  assert.doesNotMatch(tick([other()], T0 + 3000)[0].prompt, /DIGEST/, "inside the hour: gathered, not sent");
  assert.match(tick([other()], T0 + 1000 + DIGEST_EVERY_MS)[0].prompt, /`stale-wait`/, "CONTROL: an hour later it rides");
});

test("a digest class whose churn passes the bound is delivered ONCE at the crossing, and again only after it has fallen and crossed again", () => {
  const { tick } = harness();
  const keys = (/** @type {number} */ n: number, /** @type {string} */ p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const woke = (/** @type {string} */ key: string, /** @type {number} */ at: number) => tick([order("overdue", key)], at).length;
  for (const [i, k] of keys(CHURN_BOUND, "a").entries()) assert.equal(woke(k, T0 + i * 1000), 0, `key ${i + 1} of ${CHURN_BOUND}: at the bound, not past it`);
  assert.equal(woke("a-cross", T0 + 20_000), 1, "POSITIVE: the key that takes the class past the bound wakes");
  assert.equal(woke("a-after", T0 + 21_000), 0, "NEGATIVE: not again while it stays above");
  assert.equal(woke("a-after2", T0 + 22_000), 0);
  const later = T0 + WINDOW_MS + HOUR;
  for (const [i, k] of keys(CHURN_BOUND, "b").entries()) assert.equal(woke(k, later + i * 1000), 0, "fell to the bound: quiet again");
  assert.equal(woke("b-cross", later + 20_000), 1, "and crossing AGAIN wakes again");
});

test("only org-health orders to ceo are touched: another cause for ceo and the same signal to a first reader pass through unchanged", () => {
  const { tick, logLines } = harness();
  const mine = [order("overdue", "pr#1"), order("row-without-exactly-one-state", "1m", "product-manager"), other("ceo")];
  const out = tick(mine, T0);
  assert.deepEqual(out[0], mine[1], "product-manager's order is untouched");
  assert.equal(out.length, 2, "the digest class to ceo is held");
  assert.match(out[1].prompt, /^a green PR\n\nORG-HEALTH DIGEST[^]*`overdue`/, "and ceo's PR order is the one that carries its digest");
  assert.deepEqual(logLines().map((l) => [l.class, l.why]), [["overdue", "digest class"]], "the held order is logged; the two passed through are not");
});

test("a class in no table is delivered (a new detector is loud), and the failure to read or write state delivers every order and says so", () => {
  const { tick } = harness();
  assert.equal(tick([order("a-detector-nobody-declared", "x")], T0).length, 1);
  assert.equal(tick([order("a-detector-nobody-declared", "x")], T0 + 1000).length, 0, "it is quieted like a page class once seen");
  const said = /** @type {string[]} */ ([]);
  const blocked = mkdtempSync(join(tmpdir(), "org-health-suppression-"));
  dirs.push(blocked);
  mkdirSync(join(blocked, "org-health-suppression.json"));
  const orders = [order("overdue", "pr#1")];
  assert.deepEqual(quietOrgHealth(orders, { now: T0, dir: blocked, log: (l) => said.push(l) }), orders, "FAIL OPEN: the order is delivered");
  assert.match(said.join(""), /org-health-suppression: (cannot read|could not run)/);
});

test("a state file that is not JSON is replaced, and said", () => {
  const { tick, paths, said } = harness();
  tick([order("api-pool-low", "p")], T0);
  writeFileSync(paths.state, "{not json");
  assert.equal(tick([order("api-pool-low", "p")], T0 + 1000).length, 1, "an unreadable state is empty: the order is delivered, never lost");
  assert.match(said.join(""), /is not JSON/);
  assert.equal(JSON.parse(readFileSync(paths.state, "utf8")).delivered["api-pool-low\tp"], T0 + 1000);
});

test("the log keeps its newest half past the cap: a standing signal cannot fill the disk", () => {
  const { tick, paths, logLines } = harness();
  tick([order("api-pool-low", "p")], T0);
  writeFileSync(paths.log, `${JSON.stringify({ at: "2020-01-01T00:00:00.000Z", class: "old", key: "", count: 1, why: "x" }).padEnd(1000, " ")}\n`.repeat(1100));
  assert.ok(statSync(paths.log).size > 1_000_000, "CONTROL: the log starts above the cap");
  tick([order("api-pool-low", "p")], T0 + 1000);
  assert.ok(statSync(paths.log).size < 1_000_000);
  assert.equal(logLines().at(-1).class, "api-pool-low", "the newest line is kept");
});

test("the A11IGN_ORG_HEALTH_SUPPRESSION=off switch restores the old behaviour: the digest class that is held by default is delivered, and nothing is written", () => {
  const { dir, paths } = harness();
  const orders = [order("overdue", "pr#1")];
  assert.deepEqual(quietOrgHealth(orders, { now: T0, dir, env: { [SWITCH_ENV]: "off" } }), orders);
  assert.equal(existsSync(paths.state), false);
  assert.deepEqual(quietOrgHealth(orders, { now: T0, dir, env: {} }), [], "CONTROL: without it the same call holds the order");
});

// ---- every class is declared -------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The 18 classes the trace store showed `ceo` for 2026-10-01T08:40Z..10-08T08:40Z (`cause: org-health`, class = the causeKey text before its first `@`, `/` or `:`): the Open-check's own command. */
const OBSERVED_CLASSES = ["overdue", "runner-behind-newest-release", "order-deferred-too-long", "stale-wait", "idle-with-open-rows", "row-without-exactly-one-state", "stale-wait-order", "api-pool-low",
  "wait-without-reason", "release-run-failed", "board-disagrees-with-reality", "red-pr-unattended", "fleet-idle-while-work-waits", "no-merge-while-work-exists", "team-access-drifted", "copies-drifted",
  "fleet-auto-off-refusing", "github-incident"];

/** @param {string} dir @returns {string[]} every non-test `.mjs` under `dir` */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "fixtures" ? [] : sourcesUnder(path);
    return name.endsWith(".mjs") && !name.includes(".test.") ? [path] : [];
  });
}

/** Every `org-health/<class>` a source spells as a literal causeKey: the three order sources that do not go through `SIGNALS`. */
const literalClasses = () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const found = new Set(/** @type {string[]} */ ([]));
  for (const file of sourcesUnder(src)) for (const m of readFileSync(file, "utf8").matchAll(/org-health\/([a-z][a-z-]*[a-z])(?=[@/:`"'$])/g)) found.add(m[1]);
  return found;
};

test("EVERY class an org-health order can carry is declared in the table, so a new detector cannot page (or stay silent) by accident", () => {
  const declared = new Set(Object.keys(ORG_HEALTH_CLASSES));
  const wanted = new Map([...Object.values(SIGNALS).map((c) => [c, "SIGNALS"]), ...OBSERVED_CLASSES.map((c) => [c, "the trace store's 18"]), ...[...literalClasses()].map((c) => [c, "a literal causeKey"])]);
  assert.deepEqual([...wanted].filter(([cls]) => !declared.has(cls)), [], "a class missing from ORG_HEALTH_CLASSES");
  for (const [cls, rule] of Object.entries(ORG_HEALTH_CLASSES)) assert.ok(rule.severity === "page" || (rule.severity === "digest" && rule.bound > 0), `${cls} has a severity`);
});

test("POSITIVE CONTROL for the discovery: it finds the classes it is known to hold, and the observed list is the 18 the row names", () => {
  const literal = literalClasses();
  for (const known of ["github-incident", "ruling-not-taken", "chairman-ask-raised-order", "stale-wait-order"]) assert.ok(literal.has(known), `the scan finds ${known}`);
  assert.equal(OBSERVED_CLASSES.length, 18);
  assert.equal(new Set(OBSERVED_CLASSES).size, 18);
  assert.ok(Object.values(SIGNALS).length >= 20, "SIGNALS is not empty");
  assert.equal(Object.values(ORG_HEALTH_CLASSES).filter((r) => r.severity === "page").length > 0 && Object.values(ORG_HEALTH_CLASSES).filter((r) => r.severity === "digest").length > 0, true);
});
