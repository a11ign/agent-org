// no-token: gh -- importing `work-gate.ts` reaches `defaultRun`, and this file never lets it run: every tick is handed a fake `run` that counts its calls (and answers none of them) and a fake `release`.
/**
 * `src/work-gate/idle-hold-incidents.ts`, agent-org#571 (follows a11ign/a11ign#4661): THE GATE RAISES A HOLD ON A ROW NOBODY IS WORKING, because the take-time refusal in `pr-hold.ts`
 * cannot stop a hold taken before it, written by hand, or whose target it could not read. `idleHoldIncident` (`pr-hold-state.ts`) is the rule and is pinned by `pr-hold-idle-target.test.ts`;
 * THIS file pins its CALL SITE: the facts the tick already holds go in, an `org-health` order to `ceo` comes out, and the hold is left standing.
 *
 * THE SHAPE OF THE INCIDENT (a11ign/a11ign#4661): a pull request green and approved, held `--until closed #N`, #N `ready` and unclaimed with no pull request. Nothing would ever close #N.
 * The positive control below is that shape at 16 minutes; the two negative controls beside it are the same hold at 15 minutes and the same hold with `in-progress` on #N, so the signal is
 * not the output of a detector that fires on every held pull request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WAIT_MARKER } from "../wait-condition.ts";
import { decide, withPrOwners, waitTickFacts, orgHealthNow } from "../work-gate.ts";
import { idleHoldIncidents, idleHoldOrders } from "../work-gate/idle-hold-incidents.ts";
import { ORG_HEALTH_CLASSES } from "../work-gate/org-health-suppression.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW = Date.parse("2026-10-09T12:00:00Z");
const ISO = (ms: number) => new Date(ms).toISOString();

const HELD_PR = 550;
const TARGET = 4524;
const CLASS = "hold-on-idle-row";

/** The hold marker `pr:hold --until` writes, dated `minutes` before `NOW`: THE ONLY DATE A HOLD CARRIES, and so the age the detector reads. */
const marker = (minutes: number, condition = `closed #${TARGET}`) => ({ author: { login: "a11ign-ai-workers" }, createdAt: ISO(NOW - minutes * MINUTE_MS),
  body: `${WAIT_MARKER}\nHeld by \`ceo\`.\nWaiting-for: ${condition}` });

/** The held pull request: green, approved and carrying `hold:ceo`. */
const heldPr = ({ minutes = 16, condition = `closed #${TARGET}`, extra = {} }: { minutes?: number; condition?: string; extra?: Record<string, unknown> } = {}) => ({
  number: HELD_PR, labels: [{ name: "hold:ceo" }], body: "", comments: [marker(minutes, condition)], updatedAt: ISO(NOW - minutes * MINUTE_MS), ...extra });

/** The target row, open and last touched an hour ago (so its own clock does not start the count: the hold's does). */
const targetRow = (labels: string[] = ["ready"], extra: Record<string, unknown> = {}) => ({ number: TARGET, labels: labels.map((name) => ({ name })), body: "", comments: [],
  updatedAt: ISO(NOW - HOUR_MS), ...extra });

/** A pull request that DECLARES it closes the target, as the claim and the milestone clock read it. */
const closingPr = (extra: Record<string, unknown> = {}) => ({ number: 4600, labels: [], body: `Closes #${TARGET}`, comments: [], updatedAt: ISO(NOW - 5 * MINUTE_MS), ...extra });

/**
 * One gate tick over `prs` and `rows`. `run` is the tick's only way to a remote, so `calls` is the API cost of the tick and `released` is every hold the gate lifted: the detector must
 * leave both at what the tick would have cost without it (a target held in `rows` is read from the list, so ZERO calls).
 */
function tick({ prs, rows, at = NOW }: { prs: Record<string, unknown>[]; rows: Record<string, unknown>[]; at?: number }) {
  const calls: string[][] = [];
  const released: [number, string][] = [];
  const run = (args: string[]): string => { calls.push(args); throw new Error("refused"); };
  const owners = withPrOwners(prs as never, rows as never, () => null);
  const decideArgs = { prs: owners, required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
  const decided = decide({ prs: owners, readyRows: [], openRows: rows } as never);
  const orders = orgHealthNow({ prsRead: prs, readyRead: [], openRowsRead: rows, decideArgs, decided } as never,
    { now: at, lastMergedAt: () => at - HOUR_MS, log: () => {}, readCopies: (() => []) as never, readCaptures: (() => undefined) as never,
      readWaits: ((args: never) => waitTickFacts({ ...(args as Parameters<typeof waitTickFacts>[0]), run })) as never,
      release: ((n: number, s: string) => { released.push([n, s]); return true; }) as never, teamAccess: () => undefined });
  const idle = (orders as { causeKey: string; session: string; subject: string; cause: string; discriminator: string; prompt: string }[])
    .filter((o) => o.causeKey.includes(`/org-health/${CLASS}@`));
  return { idle, calls, released };
}

// --- (1) the signal, and its two controls -------------------------------------------------------------------------------------

test("POSITIVE CONTROL: a pull request held `--until closed #N` for 16 minutes, #N open, unclaimed, with no open pull request closing it, is raised to `ceo` as `hold-on-idle-row`", () => {
  const { idle, released } = tick({ prs: [heldPr({ minutes: 16 })], rows: [targetRow()] });
  assert.equal(idle.length, 1, "exactly one signal");
  const [order] = idle;
  assert.equal(order.session, "ceo");
  assert.equal(order.cause, "org-health");
  assert.equal(order.subject, `${CLASS}-${HELD_PR}`);
  assert.match(order.prompt, new RegExp(`class \`${CLASS}\``));
  assert.match(order.prompt, new RegExp(`#${HELD_PR}`), "names the pull request");
  assert.match(order.prompt, new RegExp(`#${TARGET}`), "names the target");
  assert.match(order.prompt, /for 16 minutes/, "and says how long");
  assert.match(order.prompt, /DOES NOT LIFT/, "and that the gate leaves the hold standing");
  assert.deepEqual(released, [], "the hold is left standing: raising it never lifts it");
});

test("the detector's own result carries the class, the stable key, the pull request, the target and the minutes", () => {
  const found = idleHoldIncidents({ prs: [heldPr({ minutes: 16 })], facts: { items: { [`#${TARGET}`]: { state: "open", labels: ["ready"], resolvedAt: null, changedAt: NOW - HOUR_MS } } }, now: NOW, repo: "a11ign/agent-org" });
  assert.equal(found.length, 1);
  const [incident] = found;
  assert.equal(incident.class, CLASS);
  assert.equal(incident.pr.number, HELD_PR);
  assert.equal(incident.target.endsWith(`#${TARGET}`), true, incident.target);
  assert.equal(incident.minutes, 16);
  assert.match(incident.key, new RegExp(`^${CLASS}:`));
});

test("CONTROL: the same hold at 15 minutes yields no signal (strictly more than the bound), so the 16-minute signal is the age and not every held pull request", () => {
  assert.deepEqual(tick({ prs: [heldPr({ minutes: 15 })], rows: [targetRow()] }).idle, []);
  assert.equal(tick({ prs: [heldPr({ minutes: 16 })], rows: [targetRow()] }).idle.length, 1, "and one minute later it is one");
});

test("CONTROL: the same hold with `in-progress` on #N yields no signal; so does a `session:` label alone, and so does an open pull request that closes #N", () => {
  assert.deepEqual(tick({ prs: [heldPr()], rows: [targetRow(["ready", "in-progress"])] }).idle, [], "in-progress");
  assert.deepEqual(tick({ prs: [heldPr()], rows: [targetRow(["ready", "session:worker-9"])] }).idle, [], "a claim recorded before in-progress is still a claim");
  assert.deepEqual(tick({ prs: [heldPr(), closingPr()], rows: [targetRow()] }).idle, [], "a pull request that closes it is the row in flight");
  assert.equal(tick({ prs: [heldPr(), closingPr({ body: "Closes #1" })], rows: [targetRow()] }).idle.length, 1, "but one that closes some OTHER row is not");
});

test("a hold on a target that is already closed, or on a condition that is not `closed`, is not this class", () => {
  assert.deepEqual(idleHoldIncidents({ prs: [heldPr()], facts: { items: { [`#${TARGET}`]: { state: "closed", labels: [], resolvedAt: NOW - HOUR_MS, changedAt: NOW - HOUR_MS } } }, now: NOW, repo: "a11ign/agent-org" }), [], "closed");
  assert.deepEqual(tick({ prs: [heldPr({ condition: `merged #${TARGET}` })], rows: [targetRow()] }).idle, [], "`merged`");
  assert.deepEqual(tick({ prs: [heldPr({ condition: "manual" })], rows: [targetRow()] }).idle, [], "`manual` is counted and expires elsewhere");
});

// --- (2) one hold is one key ----------------------------------------------------------------------------------------------------

test("the same hold seen on two consecutive ticks yields ONE signal key, whatever the minutes say", () => {
  const first = tick({ prs: [heldPr({ minutes: 16 })], rows: [targetRow()], at: NOW });
  const second = tick({ prs: [heldPr({ minutes: 16 })], rows: [targetRow()], at: NOW + 2 * MINUTE_MS });
  assert.equal(first.idle.length, 1);
  assert.equal(second.idle.length, 1);
  assert.match(first.idle[0].prompt, /for 16 minutes/);
  assert.match(second.idle[0].prompt, /for 18 minutes/, "the age moved");
  assert.equal(second.idle[0].discriminator, first.idle[0].discriminator, "and the key did not");
  assert.equal(second.idle[0].causeKey, first.idle[0].causeKey);
});

test("CONTROL for the key: a hold RE-TAKEN (a new marker date) is a new key, so a fresh incident is not swallowed by the old one's window", () => {
  const was = tick({ prs: [heldPr({ minutes: 16 })], rows: [targetRow()] }).idle[0].causeKey;
  const retaken = tick({ prs: [heldPr({ minutes: 17 })], rows: [targetRow()] }).idle[0].causeKey;
  assert.notEqual(retaken, was);
});

test("two held pull requests on one idle target are two incidents, and the same incident given twice is raised once", () => {
  const other = { ...heldPr({ minutes: 20 }), number: 551, comments: [marker(20)] };
  assert.equal(tick({ prs: [heldPr(), other], rows: [targetRow()] }).idle.length, 2);
  const [incident] = idleHoldIncidents({ prs: [heldPr()], facts: { items: { [`#${TARGET}`]: { state: "open", labels: ["ready"], resolvedAt: null, changedAt: NOW - HOUR_MS } } }, now: NOW, repo: "a11ign/agent-org" });
  assert.equal(idleHoldOrders([incident, incident], { limit: 10 }).length, 1);
});

// --- (3) an unknown is silence ---------------------------------------------------------------------------------------------------

test("a target the tick could not read yields no signal and no throw", () => {
  // the target is not in the open rows and the tick's own read of it is refused (`run` throws): `facts.items` has no entry for it
  let unread: ReturnType<typeof tick> | undefined;
  assert.doesNotThrow(() => { unread = tick({ prs: [heldPr({ minutes: 60 })], rows: [] }); });
  assert.deepEqual(unread!.idle, []);
  assert.ok(unread!.calls.length > 0, "the control: the target WAS asked for, and the refusal is what made the detector silent");
  // and the detector alone, over every shape of "not read"
  const facts = { items: {} };
  assert.deepEqual(idleHoldIncidents({ prs: [heldPr({ minutes: 60 })], facts, now: NOW, repo: "a11ign/agent-org" }), []);
  assert.deepEqual(idleHoldIncidents({ prs: [heldPr({ minutes: 60 })], facts: null, now: NOW, repo: "a11ign/agent-org" }), [], "a refused wait read");
  assert.deepEqual(idleHoldIncidents({ prs: null, facts, now: NOW, repo: "a11ign/agent-org" }), [], "a refused pull request list");
  assert.deepEqual(idleHoldIncidents({ prs: [{ number: 1, labels: null, body: {}, comments: "x" } as never, null as never], facts, now: NOW, repo: "a11ign/agent-org", log: () => {} }), [], "a malformed one");
});

test("a hold with no date is an unknown age, and an unknown is never 'long enough'", () => {
  const undated = { ...heldPr({ minutes: 60 }), comments: [], body: `Waiting-for: closed #${TARGET}` };
  assert.deepEqual(tick({ prs: [undated], rows: [targetRow()] }).idle, []);
});

test("a hold whose target is itself an open pull request is silent: it has no claim vocabulary to be missing", () => {
  const targetPr = { number: TARGET, labels: [], body: "", comments: [], updatedAt: ISO(NOW - HOUR_MS) };
  assert.deepEqual(tick({ prs: [heldPr({ minutes: 60 }), targetPr], rows: [] }).idle, []);
});

// --- (4) what it costs and what it does not do ------------------------------------------------------------------------------------

test("it costs the tick NO API CALL: the target is read from the lists the wait read already holds, and the hold is never released", () => {
  const { idle, calls, released } = tick({ prs: [heldPr({ minutes: 60 })], rows: [targetRow()] });
  assert.equal(idle.length, 1, "the control: the incident is raised");
  assert.deepEqual(calls, [], "from a tick that made no call at all");
  assert.deepEqual(released, []);
});

test("the class is declared in the suppression table, as a page: one hold is one decision, and its key is stable", () => {
  assert.deepEqual(ORG_HEALTH_CLASSES[CLASS], { severity: "page" });
});
