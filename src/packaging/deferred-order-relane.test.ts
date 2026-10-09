// no-token: gh -- `deliver` is driven through an injected `run`, the gate through `decide` with no reads, and the deferral record is a Map; nothing imported reaches the real `gh`
/**
 * #3465: A FINISHING ORDER DEFERRED PAST THE BOUND GOES TO A FREE ENGINEER WHERE ITS CAUSE ALLOWS, and is raised to `ceo` where it does not.
 *
 * #3448 bounded the wait at 15 minutes and reported it; the last sentence of its done-when 2 -- "re-laned to a free instance where the cause allows" -- was not
 * built, because no cause declared that any session could carry its order out. `draft-convinced-not-ready` with an attributed verdict now does (`mayRelane`).
 * THE BOUND IS WRITTEN OUT AS 15 MINUTES HERE, never as the constant, so a test built from it cannot move with it (`deferred-order-is-a-stall.test.ts`).
 *
 * Every "stays queued" is beside the "goes" it differs from in ONE field: 14 against 16 minutes, undeclared against declared, nobody free against somebody.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver as settlingDeliver, relaneTarget, relaneFacts, refusalReport } from "../wake.ts";
import { decide } from "../work-gate.ts";

const MINUTE = 60_000;
const T0 = 1_000_000_000_000;
const ROSTER = ["worker-capture", "worker-judge", "worker-tooling"];
const KEY = "product-manager/draft-convinced-not-ready/pr-3406/caf5b440";
const DECLARED = { session: "product-manager", causeKey: KEY, prompt: "Draft #3406 is convinced and still a draft.", mayRelane: true };
const UNDECLARED = { ...DECLARED, mayRelane: undefined };
const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const BUSY_PM = { "product-manager": "working", "worker-capture": "idle", "worker-judge": "working", "worker-tooling": "working" };
const since = (minutes: number) => ({ deferredSince: new Map([[KEY, T0 - minutes * MINUTE]]), now: T0 });
const noSettle = () => {};

/** One tick of `deliver` with the deferral record `minutes` old; returns who was prompted with what, and what was refused. */
function tick(order: Record<string, unknown>, spec: Record<string, string>, minutes: number | null) {
  const prompts: { to: string; text: string }[] = [];
  const recorded: { key: string; recipient?: string }[] = [];
  const result = settlingDeliver([order as never], agents(spec), ROSTER, {
    run: (args: string[]) => { if (args[3] === "prompt" && args[4] !== undefined && !args.includes("/clear")) prompts.push({ to: args[4], text: String(args[5] ?? "") }); return ""; },
    record: (key: string, recipient?: string) => { recorded.push({ key, recipient }); },
    sleep: noSettle, relane: minutes === null ? undefined : since(minutes) });
  return { ...result, prompts, recorded };
}

test("#3465: a declared order deferred 16 minutes goes to the free engineer, and at 14 it does not", () => {
  const sixteen = tick(DECLARED, BUSY_PM, 16);
  assert.deepEqual(sixteen.refused, [], "POSITIVE CONTROL: over the bound it is delivered, not refused");
  assert.equal(sixteen.prompts.length, 1);
  assert.equal(sixteen.prompts[0].to, "worker-capture", "the one free engineer, and not the busy owner");
  assert.match(sixteen.prompts[0].text, /RE-LANED TO YOU: "product-manager" has been busy for 16 minutes/);
  assert.match(sixteen.prompts[0].text, /Draft #3406 is convinced/, "and it carries the order it re-lanes, whole");
  assert.deepEqual(sixteen.recorded, [{ key: KEY, recipient: "worker-capture" }], "the ledger says who was woken, as a fallback delivery's does (#2356)");

  const fourteen = tick(DECLARED, BUSY_PM, 14);
  assert.deepEqual(fourteen.prompts, [], "under the bound the owner's queue is still the answer");
  assert.deepEqual(fourteen.refused, [`${KEY}: "product-manager" is working`]);
  assert.deepEqual(tick(DECLARED, BUSY_PM, 15).prompts, [], "exactly 15 is not yet over, as the report and the signal read it");
});

test("#3465: an UNDECLARED cause stays queued however long it has waited, and is raised as before", () => {
  const stuck = tick(UNDECLARED, BUSY_PM, 600);
  assert.deepEqual(stuck.prompts, [], "ten hours, one free engineer, and nothing moves it: only the cause may say it can");
  assert.deepEqual(stuck.refused, [`${KEY}: "product-manager" is working`]);
  const report = refusalReport(stuck.refused, (keys: string[]) => new Map(keys.map((k) => [k, 600 * MINUTE])));
  assert.equal(report.undelivered.length, 1, "...and over the bound it is `nowhere to go`, the #3448 reading");
  assert.match(report.undelivered[0], /deferred 600 min, over the 15-minute limit/);
});

test("#3465: a declared order with NO free engineer stays queued, SAYS SO, and keeps its age counting", () => {
  const nobody = tick(DECLARED, { ...BUSY_PM, "worker-capture": "working" }, 16);
  assert.deepEqual(nobody.prompts, []);
  assert.equal(nobody.refused.length, 1);
  assert.match(nobody.refused[0], /"product-manager" is working; not re-laned: no engineer is idle \(worker-capture=working, worker-judge=working, worker-tooling=working\)/);
  // The refusal must still be read as a seat WAITING ITS TURN: a different shape would drop it from the deferral record, and the wait would start again at zero.
  const report = refusalReport(nobody.refused, (keys: string[]) => new Map(keys.map((k) => [k, 16 * MINUTE])));
  assert.match(report.undelivered[0], /deferred 16 min, over the 15-minute limit for a seat mid-turn/, "raised by the bound, not lost as an unclassified fault");
  const young = refusalReport(tick(DECLARED, { ...BUSY_PM, "worker-capture": "working" }, 10).refused, (keys: string[]) => new Map(keys.map((k) => [k, 10 * MINUTE])));
  assert.equal(young.deferred.length, 1, "and a young one is only DEFERRED, as before");
});

test("#3465: what is not re-laned -- an engineer the tick may not offer the order, an order not deferred, and no record at all", () => {
  const ineligible = settlingDeliver([DECLARED as never], agents(BUSY_PM), ROSTER, {
    run: () => "", sleep: noSettle, relane: since(16), ineligibleReason: (label: string) => (label === "worker-capture" ? "holds its one row (#2407)" : null) });
  assert.deepEqual(ineligible.sent, [], "an engineer the roster would refuse is not a free instance");
  assert.match(ineligible.refused[0], /not re-laned: no engineer is idle and allowed to claim \(worker-capture=holds its one row \(#2407\)/);

  assert.equal(relaneTarget(DECLARED, { deferredSince: new Map(), now: T0, live: agents(BUSY_PM), roster: ROSTER }), null,
    "a key the waker has not seen deferred has no age, so nothing is old enough");
  assert.equal(relaneTarget(DECLARED, { now: T0, live: agents(BUSY_PM), roster: ROSTER }), null, "and with no record at all nothing is re-laned");
  assert.equal(tick(DECLARED, BUSY_PM, null).prompts.length, 0, "`deliver` without the record behaves as it did before this row");
  assert.equal(relaneTarget({ ...DECLARED, session: "engineers" }, { ...since(16), live: agents(BUSY_PM), roster: ROSTER }), null, "an order already for the pool has nowhere further to go");
});

test("#3465: an unreadable deferral record re-lanes nothing and SAYS SO, rather than guessing an age", () => {
  const dir = mkdtempSync(join(tmpdir(), "relane-"));
  const origin = process.cwd();
  // The log line keeps the first 160 characters of the error, and the error names the record's PATH before what was wrong with it. Under an agent session's
  // long TMPDIR an absolute path alone fills that, and the `not "<causeKey>\t<ms>"` the assertion reads is cut away. So the ledger is given RELATIVE to a working
  // directory inside `dir`: the path the message names is then `./wake-deferred`, whatever TMPDIR is (#3792).
  process.chdir(dir);
  try {
    const lines: string[] = [];
    const log = (line: string) => { lines.push(line); };
    const ledger = "ledger";
    const missing = relaneFacts(ledger, log);
    assert.equal(missing?.deferredSince.size, 0, "POSITIVE CONTROL: a MISSING record is no history, not a fault (ENOENT), and the facts are returned");
    assert.deepEqual(lines, []);
    writeFileSync(join(dir, "wake-deferred"), `${KEY}\tnot-a-number\n`);
    assert.equal(relaneFacts(ledger, log), undefined, "a malformed one is NOT no history: a wrong age would hand an owner's order away");
    assert.match(lines.join(""), /re-laning UNKNOWN -- .*not "<causeKey>\\t<ms>".*nothing is re-laned this tick/);
    writeFileSync(join(dir, "wake-deferred"), `${KEY}\t${T0 - 16 * MINUTE}\n`);
    assert.equal(relaneFacts(ledger, log)?.deferredSince.get(KEY), T0 - 16 * MINUTE, "and a well-formed one is read as written");
  } finally {
    process.chdir(origin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3465: the gate declares only the ATTRIBUTED ready-flip re-laneable -- a verdict the author signed is a human's to look at", () => {
  const HEAD = "abc12345deadbeefcafe000011112222";
  const pr = (by: string) => ({ number: 4, isDraft: true, headRefOid: HEAD, author: { login: "worker-judge" }, labels: [],
    statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    comments: [{ body: `Review of #4 at \`${HEAD.slice(0, 8)}\`, by \`${by}\`: convinced.` }] });
  // `decide`'s declared return type names only the fields every order has; these two are the ones this order adds.
  type FlippableOrder = ReturnType<typeof decide>[number] & { mayRelane?: boolean, action?: { kind: string } };
  const [attributed] = decide({ prs: [pr("reviewer")], readyRows: [] }) as FlippableOrder[];
  assert.equal(attributed.cause, "draft-convinced-not-ready", "POSITIVE CONTROL: the order exists");
  assert.equal(attributed.mayRelane, true);
  assert.equal(attributed.action?.kind, "ready", "and it is the one the gate flips itself: the declaration and the action share a condition");
  const [selfSigned] = decide({ prs: [pr("worker-judge")], readyRows: [] }) as FlippableOrder[];
  assert.equal(selfSigned.cause, "draft-convinced-not-ready");
  assert.equal(selfSigned.mayRelane, undefined, "a self-signed verdict is not declared");
});
