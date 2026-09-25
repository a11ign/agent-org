// no-token: gh -- drives `deliver`, `escalateStuck` and the tick through an injected `run` and a PATH stub for `herdr`; PATH holds nothing else, so the tick's default GitHub reader cannot be reached (and its absence is what the escalation assertions read)
/**
 * #2256: a session OUT OF ALLOWANCE cannot answer, so a prompt sent to it is not a delivery.
 *
 * Overnight 2026-09-23/24 every `claude` session answered every prompt with
 * `You've hit your weekly limit · resets 8am (Europe/London)`. The ledger counted each send, eleven causes reached
 * six, and two rows were labelled `needs:chairman` for an outage. The fixtures below carry that sentence as the
 * transcript wrote it (both measured forms), and the tick is run as a process, because a seam is what a deleted call
 * goes around.
 *
 * POSITIVE CONTROLS, named because "nothing was recorded / nothing was escalated" passes on an empty run:
 *   the same six deliveries to a HEALTHY session DO reach the cap ("SIX DELIVERIES ... HEALTHY"), the same
 *   escalation for a healthy session DOES go to gh ("... a healthy session's stuck cause"), and the tick DOES wake
 *   a healthy session and write its ledger line ("THE TICK ... a healthy").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitResetAt, sessionAllowance, unavailableReason, deliver, deliverHandoffs, escalateStuck, deliveryCounts,
  poolEngineerReason, MAX_DELIVERIES, LIMIT_UNREADABLE_HOLD_MS }
  from "../wake.mjs";

const HOUR = 3_600_000;
const SESSION = "5f0c8e3a-1b2d-4c6e-9a7f-0123456789ab";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

// --- fixtures -----------------------------------------------------------------------------------------------------

function scratch<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "limited-session-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const say = (role: "assistant" | "user", text: string, at: number, extra: object = {}) => JSON.stringify(
  { type: role, timestamp: new Date(at).toISOString(), message: { role, content: role === "user" ? text : [{ type: "text", text }] }, ...extra });

/** A home directory whose `.claude/projects/<dir>/<id>.jsonl` holds these lines. */
function homeWith(dir: string, lines: string[], id = SESSION) {
  const project = join(dir, ".claude", "projects", "-home-agent-repos-a11y-witness");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${id}.jsonl`), `${lines.join("\n")}\n`);
  return dir;
}

/** `herdr agent get` for one session, as the real CLI shapes it. */
const agentGet = (label: string, over: object = {}) => JSON.stringify({ result: { agent: {
  agent: "claude", agent_session: { kind: "id", value: SESSION }, agent_status: "idle", name: label, ...over } } });

const WRITTEN = Date.parse("2026-09-23T21:58:11.993Z"); // the measured line's own timestamp
const SHORT = "You've hit your weekly limit · resets 8am (Europe/London)";
const RESETS = Date.parse("2026-09-24T07:00:00Z");       // 8am BST, the next one after WRITTEN
const at = (iso: string) => Date.parse(iso);

// --- the reset time -----------------------------------------------------------------------------------------------

test("limitResetAt reads BOTH measured forms to the instant the allowance returns", () => {
  assert.equal(limitResetAt(SHORT, WRITTEN), RESETS, "short form, written at 22:58 London: the NEXT 8am");
  assert.equal(limitResetAt(SHORT, at("2026-09-24T02:00:00Z")), RESETS, "written before that day's 8am: the same day's");
  assert.equal(limitResetAt("You've hit your weekly limit · resets Sep 17, 8am (Europe/London)", at("2026-09-13T20:00:00Z")),
    at("2026-09-17T07:00:00Z"), "the dated form, from the Sep 17 outage");
  assert.equal(limitResetAt(SHORT, at("2026-12-10T22:00:00Z")), at("2026-12-11T08:00:00Z"), "in winter London is UTC");
  assert.equal(limitResetAt("You've hit your weekly limit · resets 3:30pm (America/New_York)", at("2026-09-24T10:00:00Z")),
    at("2026-09-24T19:30:00Z"), "another zone, and minutes");
  assert.equal(limitResetAt("You've hit your weekly limit · resets Jan 2, 8am (Europe/London)", at("2026-12-30T12:00:00Z")),
    at("2027-01-02T08:00:00Z"), "a month name that has already passed this year is next year's");
});

test("limitResetAt says null for what is not a reading, and never a wrong instant", () => {
  assert.equal(limitResetAt("resets 8am (Europe/London)", WRITTEN), null, "not the limit sentence");
  assert.equal(limitResetAt(`Here is the message: "${SHORT}" and then more`, WRITTEN), null, "a QUOTED sentence is not one");
  assert.equal(limitResetAt("You've hit your weekly limit · resets 13am (Europe/London)", WRITTEN), null, "an hour that is not one");
  assert.equal(limitResetAt("You've hit your weekly limit · resets Foo 17, 8am (Europe/London)", WRITTEN), null);
  assert.equal(limitResetAt("You've hit your weekly limit · resets 8am (Mars/Olympus)", WRITTEN), null, "a zone the host does not know");
});

// --- the state of a session ---------------------------------------------------------------------------------------

function allowance(lines: string[], now: number, over: { get?: string | Error; id?: string } = {}) {
  return scratch((dir) => {
    const home = homeWith(dir, lines, over.id);
    const get = over.get ?? agentGet("worker-capture");
    const run = () => { if (get instanceof Error) throw get; return get; };
    return sessionAllowance("worker-capture", { run, home, now });
  });
}

test("a session whose LAST word is the limit message is limited, until the reset", () => {
  const lines = [say("user", "do the row", WRITTEN - 1000), say("assistant", SHORT, WRITTEN)];
  const during = allowance(lines, WRITTEN + 3 * HOUR);
  assert.deepEqual(during, { state: "limited", until: RESETS, text: SHORT }, "POSITIVE CONTROL for every `clear` below");
  assert.equal(allowance(lines, RESETS).state, "clear", "AT the reset it is no longer limited: the message on screen is stale");
  assert.equal(allowance(lines, RESETS + HOUR).state, "clear");
});

test("anything said AFTER the message means the session answered, with no clock needed", () => {
  const limited = [say("assistant", SHORT, WRITTEN)];
  assert.equal(allowance([...limited, say("assistant", "Row #2253 claimed.", WRITTEN + 1000)], WRITTEN + 2000).state, "clear");
  assert.equal(allowance([...limited, say("user", "hello?", WRITTEN + 1000)], WRITTEN + 2000).state, "clear",
    "a prompt in flight is a working session, which the status check already refuses");
  assert.equal(allowance([...limited, JSON.stringify({ type: "file-history-snapshot" }),
    say("assistant", "sub-agent chatter", WRITTEN + 5, { isSidechain: true })], WRITTEN + 2000).state, "limited",
    "bookkeeping and sub-agent lines are not the conversation");
});

test("a session QUOTING the sentence is not limited", () => {
  const quoted = say("assistant", `The overnight line was "${SHORT}" and I have fixed it.`, WRITTEN);
  assert.equal(allowance([quoted], WRITTEN + HOUR).state, "clear");
  const continued = say("assistant", `${SHORT} -- I will note that on the row and carry on.`, WRITTEN);
  assert.equal(allowance([continued], WRITTEN + HOUR).state, "clear", "the sentence with MORE after it is a paragraph, not the message");
  const led = say("assistant", `Note: ${SHORT}`, WRITTEN);
  assert.equal(allowance([led], WRITTEN + HOUR).state, "clear", "and with words BEFORE it");
  assert.equal(allowance([say("assistant", SHORT, WRITTEN)], WRITTEN + HOUR).state, "limited", "POSITIVE CONTROL: the bare sentence is");
});

test("the last entry is found in a transcript far longer than the tail that is read", () => {
  const filler = Array.from({ length: 400 }, (_, i) => say("assistant", `${"x".repeat(400)} ${i}`, WRITTEN - 10_000 + i));
  assert.ok(filler.join("\n").length > 128 * 1024, "THE CONTROL: the file is bigger than the 64 KiB tail");
  assert.equal(allowance([...filler, say("assistant", SHORT, WRITTEN)], WRITTEN + HOUR).state, "limited");
});

test("a matched message with a reset that cannot be read holds the session for an hour, not for ever", () => {
  const odd = "You've hit your weekly limit · resets 8am (Mars/Olympus)";
  const lines = [say("assistant", odd, WRITTEN)];
  assert.equal(allowance(lines, WRITTEN + LIMIT_UNREADABLE_HOLD_MS - 1).state, "limited");
  assert.equal(allowance(lines, WRITTEN + LIMIT_UNREADABLE_HOLD_MS).state, "clear");
});

test("CANNOT TELL is never CLEAR: herdr, the id and the JSON that fail are `unknown`, a codex seat and a quiet one are clear", () => {
  const lines = [say("assistant", SHORT, WRITTEN)];
  const now = WRITTEN + HOUR;
  assert.equal(allowance(lines, now, { get: new Error("herdr: no such agent") }).state, "unknown");
  assert.equal(allowance(lines, now, { get: "not json" }).state, "unknown");
  assert.equal(allowance(lines, now, { get: agentGet("worker-capture", { agent_session: { value: "../../etc/passwd" } }) }).state, "unknown",
    "and nothing that is not a session id is let into a path");
  assert.equal(allowance(lines, now, { get: agentGet("reviewer-2", { agent: "codex" }) }).state, "clear",
    "a codex reviewer's allowance is another one");
  assert.equal(allowance(lines, now, { id: OTHER }).state, "clear", "no transcript for THIS session id: it has said nothing");
  assert.equal(unavailableReason("worker-capture", { run: () => { throw new Error("no"); }, home: "/nonexistent", now }), null,
    "and `unknown` reaches the deliverer as today's behaviour, not as a refusal");
});

// --- delivery -----------------------------------------------------------------------------------------------------

const CAUSE = "worker-capture/verdict-not-convinced/pr-2253/a308b8b6";
const orderTo = (session: string, causeKey = CAUSE) => ({ session, causeKey, prompt: "PR #2253 has a Region line to correct" });

/** A `run` that records every herdr call and answers `agent get` from `states`. */
function herdrRun(states: Record<string, string>) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const i = args.indexOf("get");
    return i >= 0 && args[i - 1] === "agent" ? (states[args[i + 1]] ?? agentGet(args[i + 1])) : "";
  };
  return { run, calls, prompts: () => calls.filter((c) => c.includes("prompt") && !c.includes("/clear")) };
}

/**
 * Six ticks of the outage: the same cause offered, its counts re-read from the ledger each time. A standing seat is
 * `/clear`ed and then waits five real seconds for it to settle, so the deliveries that SUCCEED go to a per-row
 * instance (`worker-2500`), which is not cleared; the refused ones are refused before any of that.
 */
function outage(dir: string, home: string, now: number, seat = "worker-capture") {
  const ledger = join(dir, "wake-ledger");
  const herdr = herdrRun({});
  const seen = { sent: [] as string[], refused: [] as string[], stuck: [] as string[] };
  for (let tick = 0; tick < MAX_DELIVERIES + 1; tick++) {
    const unavailable = (label: string) => unavailableReason(label, { run: herdr.run, home, now });
    const out = deliver([orderTo(seat, `${seat}/verdict-not-convinced/pr-2253/a308b8b6`)], [{ label: seat, status: "idle" }], [], {
      run: herdr.run, unavailable, counts: deliveryCounts(ledger),
      record: (key) => appendFileSync(ledger, `${now}\t${key}\n`) });
    seen.sent.push(...out.sent); seen.refused.push(...out.refused); seen.stuck.push(...out.stuck);
  }
  return { ...seen, herdr, ledger: existsSync(ledger) ? readFileSync(ledger, "utf8") : "" };
}

test("SIX DELIVERIES to a HEALTHY session reach the cap -- the control the outage run is read against", () => scratch((dir) => {
  const home = homeWith(dir, [say("assistant", "Row claimed.", WRITTEN)]);
  const ran = outage(dir, home, WRITTEN + HOUR, "worker-2500");
  assert.equal(ran.sent.length, MAX_DELIVERIES, "six went");
  assert.equal(ran.ledger.trim().split("\n").length, MAX_DELIVERIES, "six were counted");
  assert.equal(ran.stuck.length, 1, "and the seventh tripped the breaker");
}));

test("SIX DELIVERIES to a LIMITED session write no ledger line, trip nothing and send nothing, and each says why", () => scratch((dir) => {
  const home = homeWith(dir, [say("assistant", SHORT, WRITTEN)]);
  const ran = outage(dir, home, WRITTEN + HOUR);
  assert.equal(ran.ledger, "", "zero ledger entries");
  assert.deepEqual(ran.stuck, [], "so the breaker cannot trip");
  assert.deepEqual(ran.sent, []);
  assert.equal(ran.herdr.prompts().length, 0, "and no prompt reached the pane -- not even a /clear");
  assert.equal(ran.herdr.calls.filter((c) => c.includes("/clear")).length, 0);
  assert.equal(ran.refused.length, MAX_DELIVERIES + 1, "one honest line per attempt");
  assert.match(ran.refused[0], /^worker-capture\/verdict-not-convinced\/pr-2253\/a308b8b6: "worker-capture" is out of usage allowance until 2026-09-24T07:00:00.000Z \("You've hit your weekly limit · resets 8am \(Europe\/London\)"\) -- nothing sent and nothing counted as a delivery$/);
}));

test("the limited session is offered work again once its allowance is back", () => scratch((dir) => {
  const home = homeWith(dir, [say("assistant", SHORT, WRITTEN)]);
  const ran = outage(dir, home, RESETS + 60_000, "worker-2500");
  assert.equal(ran.sent.length, MAX_DELIVERIES, "a stale message does not hold the seat");
}));

test("a POOL order goes past a limited engineer to the next, and is refused only when all are", () => {
  const states = { "worker-4": agentGet("worker-4", { agent_session: { value: SESSION } }), "worker-6": agentGet("worker-6", { agent_session: { value: OTHER } }) };
  scratch((dir) => {
    homeWith(dir, [say("assistant", SHORT, WRITTEN)], SESSION);
    homeWith(dir, [say("assistant", "working", WRITTEN)], OTHER);
    const herdr = herdrRun(states);
    const unavailable = (label: string) => unavailableReason(label, { run: herdr.run, home: dir, now: WRITTEN + HOUR });
    const idle = [{ label: "worker-4", status: "idle" }, { label: "worker-6", status: "idle" }];
    const order = { session: "engineers", causeKey: "engineers/ready-row-unclaimed/2500", prompt: "claim #2500" };
    const ineligibleReason = poolEngineerReason(() => null, unavailable);
    const out = deliver([order], idle, ["worker-4", "worker-6"], { run: herdr.run, ineligibleReason, unavailable, record: () => {} });
    assert.match(out.sent[0], /^worker-6 <- engineers\/ready-row-unclaimed\/2500/, "the limited seat is skipped, the next takes it");
    const none = deliver([order], idle.slice(0, 1), ["worker-4"], { run: herdr.run, ineligibleReason, unavailable, record: () => {} });
    assert.deepEqual(none.sent, [], "POSITIVE CONTROL: with only the limited seat, nothing goes");
    assert.match(none.refused[0], /worker-4=out of usage allowance|"worker-4" is out of usage allowance/);
  });
  assert.equal(poolEngineerReason(() => "holds a row", () => "limited")("x"), "holds a row", "eligibility speaks first");
  assert.equal(poolEngineerReason(() => null, () => null)("x"), null);
});

test("an AUTHORED order to a limited session stays queued, and lands once the session answers", () => scratch((dir) => {
  const home = homeWith(dir, [say("assistant", SHORT, WRITTEN)]);
  const herdr = herdrRun({});
  const handoff = { id: "handoff/worker-2500/ab12cd34", session: "worker-2500", prompt: "Please fix the Region line", queuedAt: WRITTEN, decision: false };
  const dropped: string[][] = [];
  const attempt = (now: number) => deliverHandoffs([handoff], [{ label: "worker-2500", status: "idle" }], [], {
    run: herdr.run, queuePath: "queue", drop: (_p: string, ids: readonly string[]) => { dropped.push([...ids]); },
    now, unavailable: (label: string) => unavailableReason(label, { run: herdr.run, home, now }) });
  const held = attempt(WRITTEN + HOUR);
  assert.deepEqual(held.ids, [], "nothing was carried, so nothing is retired from the queue");
  assert.equal(held.refused.length, 1);
  assert.deepEqual(dropped, [[]]);
  const landed = attempt(RESETS + 1000);
  assert.equal(landed.ids.length, 1, "POSITIVE CONTROL: after the reset the same order is carried");
}));

// --- the escalation -----------------------------------------------------------------------------------------------

test("escalateStuck does not label a row whose session is out of allowance, and says so on the log, not on the row", () => {
  const stuck = [`${CAUSE}: delivered 6 times and the cause is still true`];
  const gh: string[][] = [];
  const ghRun = (args: string[]) => { gh.push(args); return ""; };
  const log: string[] = [];
  const recorded: string[] = [];
  const memory = (unavailable: (l: string) => string | null) => ({ unavailable, record: (k: string) => { recorded.push(k); } });
  const labelled = escalateStuck(stuck, ghRun, (l) => log.push(l),
    memory((l) => (l === "worker-capture" ? `"${l}" is out of usage allowance until 07:00` : null)));
  assert.deepEqual(labelled, []);
  assert.equal(gh.length, 0, "no `gh issue edit`");
  assert.equal(recorded.length, 0, "and no memory of having escalated, so it can escalate once the session is back");
  assert.match(log.join(""), /^NOT ESCALATED #2253 \(worker-capture\/verdict-not-convinced\/pr-2253\/a308b8b6\) -- "worker-capture" is out of usage allowance until 07:00; a session that cannot answer is not a row that needs a chairman\n$/);

  const healthy = escalateStuck(stuck, ghRun, () => {}, memory(() => null));
  assert.deepEqual(healthy, [2253], "POSITIVE CONTROL: a healthy session's stuck cause is still escalated");
  assert.deepEqual(gh, [["issue", "edit", "2253", "--add-label", "needs:chairman"]]);
  assert.deepEqual(recorded, [CAUSE]);
});

test("a stuck cause addressed to the POOL is not asked about", () => {
  const asked: string[] = [];
  const labelled = escalateStuck(["engineers/ready-row-unclaimed/1433: x"], () => "", () => {},
    { unavailable: (l) => { asked.push(l); return "never"; } });
  assert.equal(asked.length, 0, "`engineers` is not a session");
  assert.deepEqual(labelled, [], "and a row-less cause is skipped as before (the key names no row)");
  const pooled = escalateStuck(["engineers/ready-row-unclaimed/row-1433: x"], () => "", () => {}, { unavailable: (l) => { asked.push(l); return "never"; } });
  assert.equal(asked.length, 0, "even when it names a row");
  assert.deepEqual(pooled, [1433], "the pool cause escalates as it always did");
});

// --- THE TICK ITSELF, RUN AS A PROCESS ----------------------------------------------------------------------------

const WAKE_ENTRY = fileURLToPath(new URL("../wake.mjs", import.meta.url));
const STUB_MODE = 0o755;

/** `herdr` on a PATH that holds nothing else: lists `worker-capture` idle, answers `agent get`, logs every prompt. */
function stubHerdr(dir: string) {
  const list = JSON.stringify({ result: { workspaces: [{ label: "worker-capture", agent_status: "idle" }] } });
  // `printf` is a shell builtin; `cat` is not on a PATH that holds only this directory.
  writeFileSync(join(dir, "herdr"), "#!/bin/sh\ncase \"$*\" in\n"
    + `  *'workspace list') printf '%s' '${list}' ;;\n`
    + `  *'agent get'*) printf '%s' '${agentGet("worker-capture")}' ;;\n`
    + `  *'agent prompt'*) echo "$1 $2 $3 $4 $5 $6" >> '${dir}/prompts' ;;\n`
    + "  *) : ;;\nesac\n");
  chmodSync(join(dir, "herdr"), STUB_MODE);
}

/** One real tick over one named order. `seed` lines are written to the ledger first (epoch ms, key). */
function tick(transcript: string[], seed: Array<[number, string]> = []) {
  return scratch((dir) => {
    stubHerdr(dir);
    homeWith(dir, transcript);
    const ledger = join(dir, "wake-ledger");
    if (seed.length > 0) writeFileSync(ledger, seed.map(([t, k]) => `${t}\t${k}\n`).join(""));
    const ran = spawnSync(process.execPath, [WAKE_ENTRY, `--ledger=${ledger}`], {
      input: `${JSON.stringify(orderTo("worker-capture"))}\n`, encoding: "utf8", env: { HOME: dir, PATH: dir } });
    const prompts = existsSync(join(dir, "prompts")) ? readFileSync(join(dir, "prompts"), "utf8") : "";
    return { ...ran, ledger: existsSync(ledger) ? readFileSync(ledger, "utf8") : "", prompts };
  });
}

// The dated form, three days ahead: a reset that is in the future whatever hour the suite runs at.
const AHEAD = new Date(Date.now() + 3 * 24 * HOUR);
const AHEAD_LINE = `You've hit your weekly limit · resets ${AHEAD.toLocaleString("en-US", { month: "short", timeZone: "Europe/London" })} `
  + `${AHEAD.toLocaleString("en-US", { day: "numeric", timeZone: "Europe/London" })}, 8am (Europe/London)`;
const RECENT = Date.now() - 60_000;

test("THE TICK wakes a healthy session and writes its ledger line -- the control for the two below", () => {
  const ran = tick([say("assistant", "Row claimed.", RECENT)]);
  assert.match(ran.stdout, /WOKE worker-capture <- worker-capture\/verdict-not-convinced\/pr-2253\/a308b8b6/);
  assert.equal(ran.ledger.trim().split("\n").length, 1, "one delivery recorded");
  assert.match(ran.prompts, /agent prompt worker-capture/);
  assert.equal(ran.status, 0);
});

test("THE TICK sends nothing to a limited session, records nothing, and says why in one line", () => {
  const ran = tick([say("assistant", AHEAD_LINE, RECENT)]);
  assert.equal(ran.ledger, "", "no ledger entry");
  assert.equal(ran.prompts, "", "no prompt, no /clear");
  assert.equal(ran.stdout, "", "nothing woken");
  assert.match(ran.stderr, /^UNDELIVERED worker-capture\/verdict-not-convinced\/pr-2253\/a308b8b6: "worker-capture" is out of usage allowance until \d{4}-\d\d-\d\dT0[78]:00:00\.000Z \("You've hit your weekly limit/m);
  assert.equal(ran.stderr.match(/out of usage allowance/g)?.length, 1, "said once");
  assert.equal(ran.status, 1, "ATTENTION, as for any order with nowhere to go");
});

test("THE TICK does not escalate a cause that was offered six times when its session is out of allowance now", () => {
  const key = CAUSE;
  const seed: Array<[number, string]> = [85, 70, 55, 40, 30, 25].map((m) => [Date.now() - m * 60_000, key]);
  const limited = tick([say("assistant", AHEAD_LINE, RECENT)], seed);
  assert.match(limited.stderr, /STUCK worker-capture\/verdict-not-convinced\/pr-2253\/a308b8b6: delivered 6 times/, "THE CAP WAS REACHED");
  assert.match(limited.stderr, /NOT ESCALATED #2253 .* is out of usage allowance/);
  assert.doesNotMatch(limited.stderr, /ESCALATED #2253 ->|COULD NOT ESCALATE/, "and nothing tried to label the row");

  const healthy = tick([say("assistant", "Row claimed.", RECENT)], seed);
  assert.match(healthy.stderr, /COULD NOT ESCALATE #2253/, "POSITIVE CONTROL: for a healthy session the tick does try (there is no gh on this PATH)");
  assert.doesNotMatch(healthy.stderr, /NOT ESCALATED/);
});
