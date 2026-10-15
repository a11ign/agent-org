// no-token: gh -- pure: the account's pause over in-memory records and fixture state directories, `claimStalledOrders` over a fixture reading, and `deliver` against a recording herdr; nothing reaches `gh`, `git` or a Claude process
/**
 * agent-org#1307: WHEN THE CLAUDE ALLOWANCE IS SPENT, NO CLAUDE SEAT IS STARTED, PROMPTED OR CLAIMED FOR, AND CODEX REVIEWS GO ON.
 *
 * DRIVEN THROUGH `deliver`, the production entry, with the pause as an argument (`accountPause`) and a herdr that records every start. The first test
 * is the control in both directions: the same tick with the pause off starts the engineer, and with the pause on it starts only the Codex reviewer.
 * `claimStalledOrders` is driven with a release reading, so a claimed row is not released while the account is limited.
 *
 * FAIL CLOSED: a record that cannot be read holds with no end, and a flag that cannot be read is not off, so a recorded pause still holds under it.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_LIMIT_FLAG, UNREADABLE_RECORD, accountLimitFlag, accountLimitLogPath, nextLimit, pauseRefusal, pausedNow, readAccountLimits, tickAccountLimit,
  writeAccountLimits, ACCOUNT_LIMIT_FILE, type AccountLimit } from "./account-limit.ts";
import { claimStalledOrders } from "./claim-stall.ts";
import { deliver as settlingDeliver, freeLimitMenuSeats, limitMenuTick } from "./wake.ts";
import { isLimitMenu, tellBlocked } from "./worker-state.ts";
import { INSIDE } from "./review-trust.ts";
import { startedPanes } from "./packaging/started-pane.ts";
import { CANARY_STATE_FILE, emptyCanaryState, withMachineryFlag, type CanaryState } from "./org-health.ts";

/** A test that is not ABOUT the clear's five-second settle does not wait it. */
const noSettle = () => {};
const deliver: typeof settlingDeliver = (orders, agents, roster, deps) => settlingDeliver(orders, agents, roster, { ...deps, sleep: noSettle });

/** The account the seats share in these tests; the production key is the home directory, which a test does not depend on. */
const ACCOUNT = "account-a";
const NOW = Date.parse("2026-10-13T09:00:00Z");
const RESET = Date.parse("2026-10-13T11:00:00Z");
const LIMIT: AccountLimit = { limitedUntil: RESET, seenOn: "ceo", text: "You've hit your session limit · resets 11am (UTC)" };

const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const checkout = {
  git: (_c: string, a: string[]) => (a.join(" ").includes("rev-parse") ? `${"d".repeat(40)}\n` : ""),
  link: () => null, exists: () => true, root: "/reviews-root", repoRoot: "/primary",
};

const engineerOrder = { session: "engineers", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131", prompt: "Ready row #2131 is unclaimed." };
const decisionOrder = { session: "ceo", cause: "state-reading", causeKey: "ceo/state-reading/1", prompt: "Decide the open question." };
const reviewOrder = { session: "reviewer-18", cause: "draft-awaiting-verdict", causeKey: "reviewer-18/draft-awaiting-verdict/pr-18/abc12345", prompt: "Draft #18 is green with no verdict at its head.", trust: INSIDE };

/** A herdr that opens a workspace and starts whatever it is asked to, recording every call. */
function recordingHerdr() {
  const calls: string[] = [];
  const pane = startedPanes();
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    const answered = pane(args);
    if (answered !== null) return answered;
    if (args.includes("workspace") && args.includes("create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return { run, started: () => calls.filter((c) => c.includes("agent start")), prompted: () => calls.filter((c) => c.includes("agent send") || c.includes("agent prompt")) };
}

// --- THE TRANSITION: said once on entering and once on leaving, and nothing per tick ---------------------------------------------------------

test("entering: a limit seen with no pause holding is said once, and the record holds until its reset", () => {
  const { next, events } = nextLimit(undefined, LIMIT, NOW, ACCOUNT);
  assert.deepEqual(next, LIMIT);
  assert.deepEqual(events.map((e) => e.kind), ["enter"]);
  assert.match(events[0].line, /^Claude allowance spent on "ceo" until 2026-10-13T11:00:00\.000Z: Claude work is paused account-wide/);
});

test("holding: the next ticks with the same limit say nothing, and the pause is still there", () => {
  let prev: AccountLimit | undefined = LIMIT;
  for (const at of [NOW + 60_000, NOW + 120_000, RESET - 1]) {
    const step = nextLimit(prev, LIMIT, at, ACCOUNT);
    assert.deepEqual(step.events, [], `no line at ${new Date(at).toISOString()}`);
    prev = step.next;
  }
  assert.deepEqual(prev, LIMIT);
});

test("leaving: at its reset, with no limit seen, the pause is said once as ended and its record is dropped", () => {
  const { next, events } = nextLimit(LIMIT, null, RESET, ACCOUNT);
  assert.equal(next, undefined);
  assert.deepEqual(events.map((e) => e.kind), ["leave"]);
  assert.deepEqual(nextLimit(undefined, null, RESET + 60_000, ACCOUNT), { next: undefined, events: [] }, "and not said again");
});

test("a session still showing the old message after its reset is not a new limit: the pause is left once", () => {
  const { next, events } = nextLimit(LIMIT, LIMIT, RESET, ACCOUNT);
  assert.equal(next, undefined);
  assert.deepEqual(events.map((e) => e.kind), ["leave"]);
});

test("refused again after the reset: the old pause is left and the new one entered, with the new reset time", () => {
  const again: AccountLimit = { limitedUntil: RESET + 3_600_000, seenOn: "worker-7", text: "You've hit your session limit · resets 12pm (UTC)" };
  const { next, events } = nextLimit(LIMIT, again, RESET + 60_000, ACCOUNT);
  assert.deepEqual(next, again);
  assert.deepEqual(events.map((e) => e.kind), ["leave", "enter"]);
  assert.match(events[1].line, /until 2026-10-13T12:00:00\.000Z/);
});

test("a newer reset while holding extends the pause silently", () => {
  const later: AccountLimit = { ...LIMIT, limitedUntil: RESET + 1_800_000 };
  const { next, events } = nextLimit(LIMIT, later, NOW, ACCOUNT);
  assert.deepEqual(next, later);
  assert.deepEqual(events, []);
});

// --- THE RECORD AND THE FLAG --------------------------------------------------------------------------------------------------------------

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "account-limit-"));
}
const flagOn = (on: boolean): CanaryState => withMachineryFlag(emptyCanaryState(), { name: ACCOUNT_LIMIT_FLAG, on });

test("the record is written whole and read back by account; no file is no record, and a file that is not a record is unreadable", () => {
  const dir = stateDir();
  try {
    const path = join(dir, ACCOUNT_LIMIT_FILE);
    assert.deepEqual(readAccountLimits(path), {}, "absent: no record");
    writeAccountLimits(path, { [ACCOUNT]: LIMIT });
    assert.deepEqual(readAccountLimits(path), { [ACCOUNT]: LIMIT });
    assert.equal(readFileSync(path, "utf8").split("\n")[0], "{");
    writeFileSync(path, "not json");
    assert.equal(readAccountLimits(path), null, "malformed: unreadable, which is not the same as no record");
    writeFileSync(path, "[]");
    assert.equal(readAccountLimits(path), null, "an array is not a record");
    writeFileSync(path, JSON.stringify({ [ACCOUNT]: { limitedUntil: "soon" } }));
    assert.equal(readAccountLimits(path), null, "an entry without a numeric reset is not a record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the flag is default off: a limited record holds nothing until `gate.accountLimitPause` is on", () => {
  const dir = stateDir();
  try {
    writeAccountLimits(join(dir, ACCOUNT_LIMIT_FILE), { [ACCOUNT]: LIMIT });
    assert.equal(pausedNow(NOW, dir, flagOn(false), ACCOUNT), null, "flag off");
    assert.equal(pausedNow(NOW, dir, { flags: {}, samples: [], memo: {} }, ACCOUNT), null, "flag absent");
    assert.deepEqual(pausedNow(NOW, dir, flagOn(true), ACCOUNT), LIMIT, "flag on");
    assert.equal(pausedNow(RESET, dir, flagOn(true), ACCOUNT), null, "and it ends by itself at the reset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the record is kept per account: another account's pause holds nothing for this one", () => {
  const dir = stateDir();
  try {
    writeAccountLimits(join(dir, ACCOUNT_LIMIT_FILE), { "account-b": LIMIT });
    assert.equal(pausedNow(NOW, dir, flagOn(true), ACCOUNT), null);
    assert.deepEqual(pausedNow(NOW, dir, flagOn(true), "account-b"), LIMIT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable record holds Claude work with no end, until the file is repaired or the flag is off", () => {
  const dir = stateDir();
  try {
    const path = join(dir, ACCOUNT_LIMIT_FILE);
    writeFileSync(path, "{ not json");
    const held = pausedNow(RESET + 86_400_000, dir, flagOn(true), ACCOUNT);
    assert.ok(held !== null, "held, whatever the time");
    assert.equal(held?.seenOn, UNREADABLE_RECORD);
    assert.match(pauseRefusal(held!), /account-limit\.json cannot be read/);
    writeFileSync(path, JSON.stringify({ [ACCOUNT]: { limitedUntil: "soon" } }));
    assert.ok(pausedNow(NOW, dir, flagOn(true), ACCOUNT) !== null, "a file that is not a record holds too");
    writeAccountLimits(path, {});
    assert.equal(pausedNow(NOW, dir, flagOn(true), ACCOUNT), null, "repaired: no limit recorded, so no pause");
    writeFileSync(path, "{ not json");
    assert.equal(pausedNow(NOW, dir, flagOn(false), ACCOUNT), null, "flag off releases it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown flag (its canary state cannot be read) is not off: a recorded pause still holds, and a flag read OFF releases it", () => {
  const dir = stateDir();
  try {
    writeAccountLimits(join(dir, ACCOUNT_LIMIT_FILE), { [ACCOUNT]: LIMIT });
    writeFileSync(join(dir, CANARY_STATE_FILE), "{ not json");
    assert.equal(accountLimitFlag(dir), "unknown");
    assert.deepEqual(pausedNow(NOW, dir, undefined, ACCOUNT), LIMIT, "unknown: the recorded pause holds");
    assert.equal(accountLimitFlag(dir, flagOn(false)), "off");
    assert.equal(pausedNow(NOW, dir, flagOn(false), ACCOUNT), null, "read OFF: released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tick says a limit once, writes its record under the account, and an unreadable record holds without being rewritten", () => {
  const dir = stateDir();
  try {
    const said: string[] = [];
    const say = (line: string) => said.push(line);
    assert.equal(tickAccountLimit(null, NOW, say, dir, ACCOUNT), null, "nothing seen, nothing held");
    assert.equal(tickAccountLimit(LIMIT, NOW, say, dir, ACCOUNT)?.limitedUntil, RESET);
    assert.equal(tickAccountLimit(LIMIT, NOW + 60_000, say, dir, ACCOUNT)?.limitedUntil, RESET);
    assert.equal(said.length, 1, "said once, on entering");
    assert.deepEqual(readAccountLimits(join(dir, ACCOUNT_LIMIT_FILE)), { [ACCOUNT]: LIMIT });
    assert.equal(readFileSync(accountLimitLogPath(dir), "utf8").trim().split("\n").length, 1, "logged once");
    writeFileSync(join(dir, ACCOUNT_LIMIT_FILE), "{ not json");
    assert.equal(tickAccountLimit(null, NOW, say, dir, ACCOUNT)?.seenOn, UNREADABLE_RECORD);
    assert.equal(readFileSync(join(dir, ACCOUNT_LIMIT_FILE), "utf8"), "{ not json", "the unreadable file is left as it is");
    assert.equal(said.length, 1, "no line for the unreadable record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- DONE-WHEN 1: THROUGH `deliver` ---------------------------------------------------------------------------------------------------------

test("CONTROL: with no pause, the same tick starts the engineer and the Codex reviewer", () => {
  const herdr = recordingHerdr();
  const got = deliver([engineerOrder, decisionOrder, reviewOrder], agents({ ceo: "working" }), [], { run: herdr.run, checkout, hostLoad: () => ({ load: 4, cores: 16 }) } as never);
  assert.ok(got.sent.some((line) => line.startsWith("worker-2131 <- engineers/")), got.sent.join("\n"));
  assert.ok(herdr.started().length >= 2, "the engineer and the reviewer were started");
});

test("with one limited session recorded: a ready row, a decision order and a green unreviewed PR claim nothing, start no Claude process and prompt no Claude seat, and DO start the Codex reviewer", () => {
  const herdr = recordingHerdr();
  const servedByRun: string[] = [];
  const got = deliver([engineerOrder, decisionOrder, reviewOrder], agents({ ceo: "working" }), [], {
    run: herdr.run, checkout, hostLoad: () => ({ load: 4, cores: 16 }), accountPause: LIMIT,
    serve: (order: { causeKey: string; }) => { servedByRun.push(order.causeKey); return { runId: "run-1", tier: "sonnet" } as never; },
  } as never);
  assert.deepEqual(servedByRun, [], "no `claude -p` decision run is asked for while limited");
  assert.deepEqual(got.sent.map((line) => line.split(" ")[0]), ["reviewer-18"], "only the reviewer is sent: " + got.sent.join(" | "));
  assert.equal(got.refused.length, 2, "the engineer and the decision order are refused");
  assert.ok(got.refused.every((line) => line.includes("account's Claude allowance is spent on \"ceo\"")), got.refused.join("\n"));
  assert.equal(herdr.started().length, 1, "one process started, and it is the reviewer's");
  assert.ok(herdr.started()[0].includes("reviewer-18") || herdr.started()[0].includes("reviewer"), herdr.started()[0]);
  assert.deepEqual(herdr.prompted().filter((c) => !c.includes("reviewer")), [], "no prompt to a Claude seat");
});

test("after `limitedUntil` the same tick claims and starts again, from the record that is still on disk", () => {
  const dir = stateDir();
  try {
    writeAccountLimits(join(dir, ACCOUNT_LIMIT_FILE), { [ACCOUNT]: LIMIT });
    const herdr = recordingHerdr();
    const before = deliver([engineerOrder], agents({ ceo: "working" }), [], {
      run: herdr.run, checkout, hostLoad: () => ({ load: 4, cores: 16 }), accountPause: pausedNow(RESET - 1, dir, flagOn(true), ACCOUNT),
    } as never);
    assert.equal(before.sent.length, 0, "one millisecond before the reset the engineer is still refused");
    const after = deliver([engineerOrder], agents({ ceo: "working" }), [], {
      run: herdr.run, checkout, hostLoad: () => ({ load: 4, cores: 16 }), accountPause: pausedNow(RESET, dir, flagOn(true), ACCOUNT),
    } as never);
    assert.equal(after.sent.length, 1, "at the reset the pause is gone, so the engineer is started: " + after.refused.join(" | "));
    assert.equal(herdr.started().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- DONE-WHEN 2: A CLAIMED ROW IS NOT RELEASED WHILE LIMITED ------------------------------------------------------------------------------

test("a claimed row is not released by claim-stall while the account is limited, and is released when it is not", () => {
  const facts = { row: 2407, session: "worker-7", branch: "agent/x", worktree: "/wt/x", claimedAt: NOW - 3_600_000, openPrs: 0, ownPrs: [] };
  const reading = { kind: "release", why: "stalled", lastMoveAt: NOW - 3_600_000, idleMs: 3_600_000, nudgedAt: NOW - 1_800_000 };
  const readings = [{ facts: facts as never, reading: reading as never }];
  assert.equal(claimStalledOrders(readings, NOW, true).length, 0, "limited: the claim is kept");
  assert.equal(claimStalledOrders(readings, NOW, false).length, 1, "not limited: the stalled claim is released as it always was");
});

// --- DONE-WHEN 1, THE MUTATION: the spawn refusal is the thing that holds the first test ----------------------------------------------------
// `deliver` refuses a non-reviewer order at `targetFor` while `accountPause` is set. Remove that check and the limited test above starts the
// engineer and the Claude decision seat, and goes red; restored, it is green again.

// --- agent-org#1412: A SEAT PARKED ON THE LIMIT MENU IS FREED ONCE ITS RESET HAS PASSED, AND IS NOT TOLD THE DECLARE-OR-DECIDE TEXT ------------
// The menu's wording is the row's quote; no capture of the real screen exists in the repo, so the fixture is that quote, not a recording.

/** The menu as the row quotes it: the question, and the two options the detector needs on the screen. */
const MENU = "What do you want to do?\n  1. Stop and wait for limit to reset\n  2. Wait here\n  3. Switch to usage credits";
const SESSION = "11111111-2222-3333-4444-555555555555";
/** Said at 08:00Z, so its reset is 11:00Z (NOW is before it, PAST after it). */
const SAID = "You've hit your session limit · resets 11am (UTC)";
const WRITTEN = Date.parse("2026-10-13T08:00:00Z");
const PAST = Date.parse("2026-10-13T12:00:00Z");

const quiet = () => {};

/** Every directory the menu tests make, removed when the file is done: the run checks that nothing is left in TMPDIR. */
const madeDirs: string[] = [];
after(() => { for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true }); });
function madeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

/** A home whose transcript for {@link SESSION} last says `text`, written at `writtenAt`. */
function homeSaying(text: string, writtenAt: number): string {
  const home = madeDir("limit-menu-home-");
  mkdirSync(join(home, ".claude", "projects", "proj"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "proj", `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "assistant", timestamp: new Date(writtenAt).toISOString(), message: { content: text } })}\n`);
  return home;
}

/** A herdr for one seat: `agent get` names a claude session, `agent read` shows `pane` (throws for `null`), and every `send-keys` is recorded. */
function seatHerdr(pane: string | null, { refuseKeys = false }: { refuseKeys?: boolean } = {}) {
  const calls: string[] = [];
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    if (args.includes("get")) return JSON.stringify({ result: { agent: { agent: "claude", agent_session: { value: SESSION } } } });
    if (args.includes("read")) {
      if (pane === null) throw new Error("no pane");
      return pane;
    }
    if (args.includes("send-keys") && refuseKeys) throw new Error("send-keys refused");
    return "{}";
  };
  return { run, keys: () => calls.filter((c) => c.includes("send-keys")) };
}

test("the limit menu needs BOTH of its options on the screen: a quote of one is not the menu, and a pane that could not be read is not", () => {
  assert.equal(isLimitMenu(MENU), true);
  assert.equal(isLimitMenu("1. Stop and wait for limit to reset"), false);
  assert.equal(isLimitMenu(null), false);
});

test("CONTROL: a blocked seat on the limit menu whose reset has passed gets exactly one `esc`, and the freeing is said once", () => {
  const herdr = seatHerdr(MENU);
  const said: string[] = [];
  const freed = freeLimitMenuSeats(agents({ "worker-1": "blocked" }), { run: herdr.run, home: homeSaying(SAID, WRITTEN), now: PAST,
    say: (line) => said.push(line), state: flagOn(true) });
  assert.deepEqual(freed, ["worker-1"]);
  assert.deepEqual(herdr.keys(), ["--session org agent send-keys worker-1 esc"], "the one key is `esc`: never `enter`, never a digit");
  assert.deepEqual(said, ["freed 1 seats from the limit menu: worker-1"]);
});

test("a menu seat whose reset has NOT come is left alone: no key, and nothing said", () => {
  const herdr = seatHerdr(MENU);
  const said: string[] = [];
  const freed = freeLimitMenuSeats(agents({ "worker-1": "blocked" }), { run: herdr.run, home: homeSaying(SAID, WRITTEN), now: NOW,
    say: (line) => said.push(line), state: flagOn(true) });
  assert.deepEqual(freed, []);
  assert.deepEqual(herdr.keys(), []);
  assert.deepEqual(said, []);
});

test("a blocked seat on another question, not the menu, gets neither `esc` nor limit handling, even with a past reset", () => {
  const herdr = seatHerdr("Which branch should I use?\n(y/n)");
  const freed = freeLimitMenuSeats(agents({ "worker-1": "blocked" }), { run: herdr.run, home: homeSaying(SAID, WRITTEN), now: PAST, say: quiet,
    state: flagOn(true) });
  assert.deepEqual(freed, []);
  assert.deepEqual(herdr.keys(), []);
});

test("only a `blocked` seat is freed: a working seat that shows the menu is not touched", () => {
  const herdr = seatHerdr(MENU);
  const freed = freeLimitMenuSeats(agents({ "worker-1": "working" }), { run: herdr.run, home: homeSaying(SAID, WRITTEN), now: PAST, say: quiet,
    state: flagOn(true) });
  assert.deepEqual(freed, []);
  assert.deepEqual(herdr.keys(), []);
});

test("a menu seat whose last word is no longer the limit message (it has answered since) is not freed", () => {
  const herdr = seatHerdr(MENU);
  const freed = freeLimitMenuSeats(agents({ "worker-1": "blocked" }), { run: herdr.run, home: homeSaying("Done.", WRITTEN), now: PAST, say: quiet,
    state: flagOn(true) });
  assert.deepEqual(freed, []);
  assert.deepEqual(herdr.keys(), []);
});

test("the flag OFF frees nothing, even a menu seat with a past reset; a pane that cannot be read frees nothing", () => {
  const off = seatHerdr(MENU);
  assert.deepEqual(freeLimitMenuSeats(agents({ "worker-1": "blocked" }), { run: off.run, home: homeSaying(SAID, WRITTEN), now: PAST, say: quiet,
    state: flagOn(false) }), []);
  assert.deepEqual(off.keys(), []);
  const unreadable = seatHerdr(null);
  assert.deepEqual(freeLimitMenuSeats(agents({ "worker-1": "blocked" }), { run: unreadable.run, home: homeSaying(SAID, WRITTEN), now: PAST, say: quiet,
    state: flagOn(true) }), []);
  assert.deepEqual(unreadable.keys(), []);
});

test("a seat whose `esc` is refused is not counted as freed, and nothing is said", () => {
  const herdr = seatHerdr(MENU, { refuseKeys: true });
  const said: string[] = [];
  const freed = freeLimitMenuSeats(agents({ "worker-1": "blocked" }), { run: herdr.run, home: homeSaying(SAID, WRITTEN), now: PAST,
    say: (line) => said.push(line), state: flagOn(true) });
  assert.deepEqual(freed, []);
  assert.deepEqual(said, []);
});

// --- THE SAME SEAT, TOLD BY THE TICK: a menu seat is not sent the declare-or-decide text, and is not reported untold ----------------------

test("CONTROL: a blocked worker on the limit menu is neither told nor reported untold, in one tick or the next", () => {
  const path = join(madeDir("blocked-told-"), "blocked-told.json");
  const sent: string[] = [];
  const reported: string[] = [];
  const roster = [{ label: "worker-1", status: "blocked" }];
  const tell = () => tellBlocked({ roster, path, send: (label) => sent.push(label), report: (line) => reported.push(line),
    onLimitMenu: (label) => label === "worker-1" });
  assert.deepEqual(tell(), { sent: [], untold: [] });
  assert.deepEqual(tell(), { sent: [], untold: [] });
  assert.deepEqual(sent, [], "no declare-or-decide text is typed into the menu");
  assert.deepEqual(reported, [], "no `stopped on a question` repeat");
});

test("a blocked worker NOT on the menu is still told, once: the menu skip does not swallow the ordinary stall", () => {
  const path = join(madeDir("blocked-told-"), "blocked-told.json");
  const sent: string[] = [];
  const roster = [{ label: "worker-2", status: "blocked" }];
  const result = tellBlocked({ roster, path, send: (label) => sent.push(label), onLimitMenu: () => false });
  assert.deepEqual(sent, ["worker-2"]);
  assert.deepEqual(result, { sent: ["worker-2"], untold: [] });
});

// --- THE TICK'S OWN STEP, AND THE DEFAULT READERS: `limitMenuTick` is what `main` calls; a fake `herdr` on PATH answers the production reads -------

/** The state directory a tick writes its record to: a fresh, empty one, so the record is the test's own. */
const tickDir = () => madeDir("limit-menu-state-");

/**
 * Runs `body` with a `herdr` first on PATH and HOME set to `home`, so the production readers (`defaultRun`, `paneOf`) run as they do in a tick. The fake
 * answers `agent get` with a claude session, `agent read` with `pane`, and logs every call; it returns the body's result with those calls.
 */
function withFakeHerdr<T>(pane: string, home: string, body: () => T): { result: T; calls: string[] } {
  const bin = madeDir("limit-menu-bin-");
  const log = join(bin, "calls.log");
  const paneFile = join(bin, "pane.txt");
  const got = JSON.stringify({ result: { agent: { agent: "claude", agent_session: { value: SESSION } } } });
  writeFileSync(paneFile, pane);
  writeFileSync(join(bin, "herdr"), [
    "#!/bin/sh",
    `echo "$*" >> "${log}"`,
    'case "$*" in',
    `  *" get "*) echo '${got}' ;;`,
    `  *" read "*) cat "${paneFile}" ;;`,
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.HOME = home;
  try {
    const result = body();
    return { result, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("CONTROL, through the tick's own step: a menu seat whose reset has passed gets exactly one `esc`, no pause holds, and the freeing is said once", () => {
  const herdr = seatHerdr(MENU);
  const said: string[] = [];
  const pause = limitMenuTick(agents({ "worker-1": "blocked" }), { now: PAST, run: herdr.run, home: homeSaying(SAID, WRITTEN), dir: tickDir(),
    say: (line) => said.push(line), state: flagOn(true) });
  assert.equal(pause, null, "the reset has passed, so no account pause holds");
  assert.deepEqual(herdr.keys(), ["--session org agent send-keys worker-1 esc"], "the one key is `esc`");
  assert.deepEqual(said, ["freed 1 seats from the limit menu: worker-1"]);
});

test("through the tick's own step: before the reset the pause holds, the menu seat is left alone, and no key is sent", () => {
  const herdr = seatHerdr(MENU);
  const said: string[] = [];
  const pause = limitMenuTick(agents({ "worker-1": "blocked" }), { now: NOW, run: herdr.run, home: homeSaying(SAID, WRITTEN), dir: tickDir(),
    say: (line) => said.push(line), state: flagOn(true) });
  assert.equal(pause?.limitedUntil, RESET, "the account pause holds until the reset");
  assert.deepEqual(herdr.keys(), [], "no key is sent to the seat while the pause holds");
  assert.equal(said.length, 1, "only the pause's entering is said, not the freeing");
  assert.match(said[0], /^Claude allowance spent on/);
});

test("through the tick's own step: with the flag OFF nothing is freed and no pause holds, whatever the menu shows", () => {
  const herdr = seatHerdr(MENU);
  const pause = limitMenuTick(agents({ "worker-1": "blocked" }), { now: PAST, run: herdr.run, home: homeSaying(SAID, WRITTEN), dir: tickDir(),
    say: quiet, state: flagOn(false) });
  assert.equal(pause, null);
  assert.deepEqual(herdr.keys(), []);
});

test("the default herdr readers, through a fake `herdr` on PATH: the tick frees a menu seat whose reset has passed with exactly one `esc`", () => {
  const said: string[] = [];
  const { result, calls } = withFakeHerdr(MENU, homeSaying(SAID, WRITTEN), () => limitMenuTick(agents({ "worker-1": "blocked" }),
    { now: PAST, dir: tickDir(), say: (line) => said.push(line), state: flagOn(true) }));
  assert.equal(result, null);
  assert.deepEqual(calls.filter((call) => call.includes(" send-keys ")), ["--session org agent send-keys worker-1 esc"],
    "the production reader names the seat, and the only key is `esc`");
  assert.deepEqual(said, ["freed 1 seats from the limit menu: worker-1"]);
});

test("the default pane reader, through a fake `herdr` on PATH: a blocked worker on the menu is neither told nor untold, and one on another question is told once", () => {
  const tell = (pane: string) => withFakeHerdr(pane, homeSaying(SAID, WRITTEN), () => {
    const path = join(madeDir("blocked-told-"), "blocked-told.json");
    const sent: string[] = [];
    const roster = [{ label: "worker-1", status: "blocked" }];
    const first = tellBlocked({ roster, path, send: (label) => sent.push(label), report: quiet });
    const second = tellBlocked({ roster, path, send: (label) => sent.push(label), report: quiet });
    return { sent, first, second };
  });
  const onMenu = tell(MENU);
  assert.deepEqual(onMenu.result, { sent: [], first: { sent: [], untold: [] }, second: { sent: [], untold: [] } });
  const otherQuestion = tell("Which branch should I use?\n(y/n)");
  assert.deepEqual(otherQuestion.result.sent, ["worker-1"], "the ordinary stall is told once");
  assert.equal(otherQuestion.calls.some((call) => call.includes(" read worker-1")), true, "the pane is read through the default reader");
});

test("#1412 THE TICK CALLS IT: `main` takes its pause from `limitMenuTick`, and no second copy of the freeing sits beside it (a SOURCE pin on placement only: `main` is not driven whole by any test)", () => {
  const source = readFileSync(new URL("./wake.ts", import.meta.url), "utf8");
  assert.equal(source.split("const accountPause = limitMenuTick(agents);").length - 1, 1, "one call, in `main`");
  assert.doesNotMatch(source, /if \(accountPause === null\) freeLimitMenuSeats/, "the freeing is not called from `main` a second way");
});
