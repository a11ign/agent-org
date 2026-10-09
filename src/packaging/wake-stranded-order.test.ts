// no-token: gh -- drives the queue's ended-target resolution through injected seams and a PATH stub for `herdr`; the tick's default GitHub reader is never reached (no fixture order names a row), and PATH here holds nothing else
/**
 * #2459: an authored order queued to a session that has ENDED is resolved, not kept for ever.
 *
 * Its own file, and not a block in `wake.test.ts`, because the acceptance job has no `gh` token and that file
 * reaches GitHub. Delivery takes an injected `run` and the holder lookup an injected reader, so no herdr, no
 * host and no GitHub are needed -- and where the tick itself is the subject, `herdr` is a stub on a PATH that
 * holds nothing else, so a GitHub read cannot happen by accident.
 *
 * THE POSITIVE CONTROLS ARE NAMED HERE, because an emptiness assertion ("no order to a gone target survives a
 * tick") passes on an empty queue:
 *   MUST be resolved:  "an order to an ENDED session ..." (the drop) and "... is re-addressed ..."
 *   MUST NOT be:       "ABSENT IS NOT ENDED ..." (never started) and "A HERDR THAT DOES NOT ANSWER ..." (blind)
 */
import { TSX_IMPORT } from "../tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACT_THRESHOLD_TOKENS, resolveEndedHandoffs, readHandoffs, handoffId, handoffBacklog, backlogReport, targetState,
  endedSessions, namedRefs, authorOf, holderOf, deliverHandoffs as settlingDeliverHandoffs, HANDOFF_STALE_MS, handoffQueuePath }
  from "../wake.ts";
/** #2546: a test that is not ABOUT the clear's five-second settle does not wait it; `wake-clear-settle.test.ts` pins the delay. */
const noSettle = () => {};
/** A transcript root that holds nothing: a per-row instance's order reads its own transcripts to decide `/compact` (#2688), and the default root is the
 * host's real `~/.claude/projects`, so the verdict would depend on who has been working on the host (#3549). */
const NO_TRANSCRIPTS = join(tmpdir(), "a11y-3549-no-transcripts");
const deliverHandoffs: typeof settlingDeliverHandoffs = (handoffs, agents, roster, deps) =>
  settlingDeliverHandoffs(handoffs, agents, roster, { ...deps, sleep: noSettle, contextRoot: NO_TRANSCRIPTS });

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-25T07:30:00Z");
const AT_TEARDOWN = Date.parse("2026-09-25T05:00:00Z");

const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));

/** The shape of the real entry: `prompt-session`'s attribution line, then the order. */
function order(session: string, text: string, ageHours = 7.1, extra: object = {}) {
  const prompt = `Sent to you by \`product-manager\` (reply by messaging that session, or on the row), through \`prompt:session\`:\n\n${text}`;
  return { id: handoffId(session, prompt), session, prompt, queuedAt: NOW - ageHours * HOUR, decision: false, ...extra };
}

function scratch<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "stranded-order-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Queue file with these entries, one JSON line each, as `prompt-session` leaves them. */
function queueWith(dir: string, entries: object[]) {
  const path = join(dir, "prompt-session-handoffs");
  writeFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return path;
}

const ENDED = new Map([["worker-12", AT_TEARDOWN]]);
const noHolder = () => { throw new Error("no lookup was expected"); };

test("an order to an ENDED session is dropped with a RECORD, and stops counting as waiting", () => scratch((dir) => {
  const dead = order("worker-12", "PR #2444 has a mutation-line problem; please fix");
  const bare = order("worker-12", "an order that names nothing at all");
  const path = queueWith(dir, [bare]);
  const before = readFileSync(path, "utf8");

  const out = resolveEndedHandoffs([bare], { agents: agents({ "worker-11": "idle" }), ended: ENDED,
    holder: noHolder, queuePath: path, now: NOW });

  assert.deepEqual(out.settled, [bare.id], "THE POSITIVE CONTROL: the ended-target order IS resolved (non-empty)");
  const after = readFileSync(path, "utf8");
  assert.ok(after.startsWith(before), "the log is only ever APPENDED to: the order's own line is untouched");
  const record = JSON.parse(after.slice(before.length).trim());
  assert.equal(record.dropped, bare.id, "a distinct `dropped` entry, carrying the order id");
  assert.equal(record.delivered, undefined, "and NOT a `delivered` line, because nothing was delivered");
  assert.equal(record.session, "worker-12", "the target");
  assert.equal(record.author, "product-manager", "the author the order carries");
  assert.equal(record.ageMs, 7.1 * HOUR, "the age");
  assert.match(record.reason, /target ended/, "the reason");
  assert.equal(record.prompt, bare.prompt, "a drop loses no text: it is in the record");
  assert.deepEqual(readHandoffs(path), [], "the fold retires it, so it no longer counts as waiting");
  assert.equal(handoffBacklog(readHandoffs(path), NOW).length, 0);
  assert.match(out.lines.join(""), /"worker-12" has ENDED[^\n]*no addressee/, "said as GONE, not as busy");
  assert.doesNotMatch(out.lines.join(""), /never idle|inbox|BETWEEN TASKS/);
  assert.ok(dead.id !== bare.id, "fixture sanity: two different orders");
}));

test("an order that names a row is RE-ADDRESSED to the live session holding it, before any drop", () => scratch((dir) => {
  const named = order("worker-12", "PR #2444 is dead; the fix is in #2449", 7.1, { decision: true });
  const path = queueWith(dir, [named]);
  const asked: number[] = [];
  const holder = (ref: number) => {
    asked.push(ref);
    return ref === 2444 ? { open: false, sessions: ["worker-12"] } : { open: true, sessions: ["worker-14"] };
  };

  const out = resolveEndedHandoffs([named], { agents: agents({ "worker-14": "working" }), ended: ENDED, holder,
    queuePath: path, now: NOW });

  assert.deepEqual(out.settled, [named.id]);
  assert.deepEqual(asked, [2444, 2449], "the closed row is skipped, the next reference is asked");
  const waiting = readHandoffs(path);
  assert.equal(waiting.length, 1, "exactly one order waits: the old one is retired, the new one queued");
  assert.equal(waiting[0].session, "worker-14");
  assert.equal(waiting[0].queuedAt, named.queuedAt, "the wait is still measured from when the author first asked");
  assert.equal(waiting[0].decision, true, "an ask stays an ask");
  assert.match(waiting[0].prompt, /Re-addressed by the tick: this was written for "worker-12", which has ended/);
  assert.match(waiting[0].prompt, /Sent to you by `product-manager`/, "and the original author still travels in it");
  const log = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const drop = log.find((l) => l.dropped);
  assert.equal(drop.reroutedTo, "worker-14", "the record says where it went");
  assert.equal(drop.prompt, null, "and does not copy a text that lives on in the new entry");
  assert.match(out.lines.join(""), /RE-ADDRESSED[^\n]*held by live "worker-14"/);
}));

test("a holder that is not LIVE is not a home: the order is dropped, with the references it looked at named", () => scratch((dir) => {
  const named = order("worker-12", "see #2444");
  const path = queueWith(dir, [named]);
  const out = resolveEndedHandoffs([named], { agents: agents({ "worker-11": "idle" }), ended: ENDED,
    holder: () => ({ open: true, sessions: ["worker-99"] }), queuePath: path, now: NOW });
  assert.deepEqual(out.settled, [named.id]);
  assert.deepEqual(readHandoffs(path), []);
  assert.match(out.lines.join(""), /DROPPED[^\n]*names #2444, none open and held by a live session/);
}));

test("a lookup that CANNOT ASK drops nothing: an order is dropped only when GitHub said nobody holds it", () => scratch((dir) => {
  const named = order("worker-12", "see #2444");
  const path = queueWith(dir, [named]);
  const before = readFileSync(path, "utf8");
  const out = resolveEndedHandoffs([named], { agents: agents({ "worker-11": "idle" }), ended: ENDED,
    holder: () => null, queuePath: path, now: NOW });
  assert.deepEqual(out.settled, []);
  assert.equal(readFileSync(path, "utf8"), before, "the queue is byte-identical");
  assert.match(out.lines.join(""), /ORDER KEPT[^\n]*could not read who holds #2444/);
}));

test("ABSENT IS NOT ENDED: an order to a target that has never existed stays queued -- the twin of the drop", () => scratch((dir) => {
  // `reviewer-<n>` is started by the gate AFTER an order for it may already be queued.
  const first = order("reviewer-2500", "PR #2500 is ready for your review");
  const path = queueWith(dir, [first]);
  const before = readFileSync(path, "utf8");
  const state = targetState("reviewer-2500", agents({ "worker-11": "idle" }), ENDED);
  assert.equal(state, "absent", "never existed is a THIRD state, neither live nor ended");

  const out = resolveEndedHandoffs([first], { agents: agents({ "worker-11": "idle" }), ended: ENDED,
    holder: noHolder, queuePath: path, now: NOW });

  assert.deepEqual(out.settled, [], "THE CONTROL: this one MUST NOT be resolved, and it was not");
  assert.deepEqual(out.lines, []);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(readHandoffs(path).length, 1);
}));

test("a label that STARTED AGAIN after its ending is not ended: spare labels are reused", () => {
  const cycles = [{ role: "worker-12", at: AT_TEARDOWN }, { role: "?", at: 0 }];
  assert.deepEqual([...endedSessions({ cycles, endings: [], registries: [] })], [["worker-12", AT_TEARDOWN]]);
  assert.equal(endedSessions({ cycles, endings: [], registries: [{ "worker-12": { spawnedAt: AT_TEARDOWN } }] }).size,
    0, "registered at the ending's own instant (registerSpawn stamps both with one `now`)");
  assert.equal(endedSessions({ cycles, endings: [], registries: [{ "worker-12": { spawnedAt: AT_TEARDOWN - 1 } }] }).size,
    1, "a registration OLDER than the ending is the instance that ended");
  const endings = [{ session: "reviewer-2444", at: "2026-09-25T05:00:00.000Z" }];
  assert.ok(endedSessions({ cycles: [], endings, registries: [] }).has("reviewer-2444"), "reviewer endings count too");
  assert.equal(endedSessions({ cycles: [], endings: [{ session: "reviewer-9", at: "not a date" }], registries: [] }).size, 0,
    "an ending whose time cannot be read is no evidence");
});

test("a LIVE target is never touched, busy or idle: #1966 still holds", () => scratch((dir) => {
  const mine = order("worker-11", "a report");
  const path = queueWith(dir, [mine]);
  const before = readFileSync(path, "utf8");
  for (const status of ["working", "idle"]) {
    const out = resolveEndedHandoffs([mine], { agents: agents({ "worker-11": status }), ended: new Map([["worker-11", 1]]),
      holder: noHolder, queuePath: path, now: NOW });
    assert.deepEqual(out.settled, [], status);
  }
  assert.equal(readFileSync(path, "utf8"), before);
  const busy = deliverHandoffs([mine], agents({ "worker-11": "working" }), ["worker-11"], { run: () => "", now: NOW });
  assert.deepEqual(busy.ids, [], "a busy session is still refused, and the order stays");
  assert.match(busy.refused.join(""), /"worker-11" is working/);
  const idle = deliverHandoffs([mine], agents({ "worker-11": "idle" }), ["worker-11"], { run: () => "", now: NOW });
  assert.deepEqual(idle.ids, [mine.id], "and an idle one still receives it");
}));

test("the backlog line stops giving the wrong advice for a session that is not there", () => {
  const gone = order("worker-12", "an order", 7.1);
  const live = order("worker-11", "an order", 7.1);
  assert.ok(NOW - Number(gone.queuedAt) >= HANDOFF_STALE_MS, "fixture is stale");
  const say = (h: typeof gone, present: Record<string, string>) =>
    backlogReport(handoffBacklog([h], NOW), agents(present)).join("");

  const forGone = say(gone, { "worker-11": "working" });
  assert.match(forGone, /no session is labelled "worker-12"[^\n]*no addressee/);
  assert.match(forGone, /NOT a busy session's unread inbox/);
  assert.doesNotMatch(forGone, /never idle|inbox is not being read/, "the sentence for a session that exists is not said");

  const forLive = say(live, { "worker-11": "working" });
  assert.match(forLive, /a session that is never idle never receives one/, "POSITIVE CONTROL: it is still said for a live one");
  assert.doesNotMatch(forLive, /no addressee/);
  assert.match(backlogReport(handoffBacklog([gone], NOW)).join(""), /never idle/, "with no agent list nothing is known");
});

test("namedRefs, authorOf and holderOf read what an order says and what GitHub answers", () => {
  assert.deepEqual(namedRefs("PR #2444 and #2449, again #2444; not a/b#3 or C#5 or &#39; or ##7"), [2444, 2449]);
  assert.equal(authorOf("Sent to you by `orchestrator` (reply ...), through"), "orchestrator");
  assert.equal(authorOf("Sent to you by a caller `prompt:session` could not identify"), null);
  const answer = (out: string) => () => out;
  assert.deepEqual(holderOf(7, answer('{"state":"open","labels":["in-progress","session:worker-14","lane:any"]}')),
    { open: true, sessions: ["worker-14"] });
  assert.deepEqual(holderOf(7, answer('{"state":"closed","labels":[]}')), { open: false, sessions: [] });
  assert.deepEqual(holderOf(99999, () => { throw Object.assign(new Error("x"), { stderr: "gh: Not Found (HTTP 404)" }); }),
    { open: false, sessions: [] }, "a reference that does not exist holds nothing, and must not keep an order for ever");
  assert.equal(holderOf(7, () => { throw Object.assign(new Error("x"), { stderr: "HTTP 502" }); }), null,
    "a GitHub that would not say is UNKNOWN, never `nobody`");
});

// --- THE TICK ITSELF, RUN AS A PROCESS, because a seam is what a deleted call goes around ---

const WAKE_ENTRY = fileURLToPath(new URL("../wake.ts", import.meta.url));
const STUB_MODE = 0o755;

/** `herdr` listing these workspaces, or refusing outright for `null`. */
const herdr = (present: string[] | null) => (present === null
  ? "#!/bin/sh\nexit 1\n"
  : "#!/bin/sh\ncase \"$*\" in\n  *'workspace list') printf '%s' "
    + `'${JSON.stringify({ result: { workspaces: present.map((label) => ({ label, agent_status: "idle" })) } })}'`
    + " ;;\n  *) : ;;\nesac\n");

/** One real tick over `queued`, with `spare-cycles` recording `worker-12`'s teardown beside the ledger. */
function tick(present: string[] | null, queued: object[], { teardown = true } = {}) {
  return scratch((dir) => {
    writeFileSync(join(dir, "herdr"), herdr(present));
    chmodSync(join(dir, "herdr"), STUB_MODE);
    const ledger = join(dir, "wake-ledger");
    const queue = queueWith(dir, queued);
    if (teardown) {
      writeFileSync(join(dir, "spare-cycles"),
        `${JSON.stringify({ role: "worker-12", row: 2444, at: AT_TEARDOWN, clean: true, why: "ended" })}\n`);
    }
    const before = readFileSync(queue, "utf8");
    // PATH is the stub's directory ALONE: no `gh` exists to be reached.
    const ran = spawnSync(process.execPath, [...TSX_IMPORT, WAKE_ENTRY, `--ledger=${ledger}`], {
      input: "", encoding: "utf8",
      // The host declaration is found through $AGENT_ORG_HOST, and HOME is a scratch dir with none beside it.
      env: { HOME: dir, PATH: dir, AGENT_ORG_HOST: process.env.AGENT_ORG_HOST } });
    const after = readFileSync(queue, "utf8");
    return { ...ran, before, after, waiting: readHandoffs(handoffQueuePath(ledger)), left: existsSync(queue) };
  });
}

// The real entry's `queuedAt` is wall-clock, so the fixture ages are measured from the real clock here.
const real = (session: string, text: string) => order(session, text, 7.1, { queuedAt: Date.now() - 7.1 * HOUR });

test("THE TICK drops an order to an ENDED session and says so -- the entry point, not the functions it calls", () => {
  const dead = real("worker-12", "an order about a PR that merged");
  const ran = tick(["worker-11"], [dead]);
  assert.ok(ran.after.length > ran.before.length, "THE POSITIVE CONTROL: the queue GREW by a record (non-empty case)");
  assert.deepEqual(ran.waiting, [], "the order no longer waits");
  assert.match(ran.stderr, /DROPPED handoff\/worker-12\/[0-9a-f]{8}: "worker-12" has ENDED/);
  assert.doesNotMatch(ran.stderr, /never idle|UNDELIVERED|no workspace labelled/, "and the refusal that repeated for ever is gone");
  assert.equal(ran.status, 0, "nothing is left with nowhere to go, so the tick is quiet");
});

test("THE TICK KEEPS an order to a target that never existed, and does not call it a busy inbox", () => {
  const first = real("reviewer-2500", "PR #2500 is ready for review");
  const ran = tick(["worker-11"], [first]);
  assert.equal(ran.after, ran.before, "THE CONTROL: not dropped");
  assert.equal(ran.waiting.length, 1);
  assert.doesNotMatch(ran.stderr, /has ENDED/, "and is never CALLED ended, which a rule that drops every missing label would say");
  assert.match(ran.stderr, /NO workspace is labelled "reviewer-2500"/);
  assert.match(ran.stderr, /no session is labelled "reviewer-2500"[^\n]*NOT a busy session's unread inbox/);
  assert.match(ran.stderr, /UNDELIVERED [^\n]*no workspace labelled "reviewer-2500"/, "still refused, still retried");
  assert.equal(ran.status, 1);
});

test("A HERDR THAT DOES NOT ANSWER CLASSIFIES NOTHING: no order is dropped on a blip", () => {
  const dead = real("worker-12", "an order about a PR that merged");
  const ran = tick(null, [dead]);
  assert.match(ran.stderr, /CANNOT ASK: herdr did not answer/, "the tick took the blind exit");
  assert.equal(ran.after, ran.before, "and the queue is byte-identical: the ended-target fixture was NOT dropped");
  assert.equal(ran.waiting.length, 1);
  assert.doesNotMatch(ran.stderr, /DROPPED|RE-ADDRESSED/);
  assert.equal(ran.status, 2);
  // The same queue and the same teardown record, with herdr answering: it IS dropped. Without this the
  // assertion above passes against a tick that never drops anything.
  assert.deepEqual(tick(["worker-11"], [dead]).waiting, []);
});

test("no teardown record, no drop: the ended-session signal is the record and nothing else", () => {
  const dead = real("worker-12", "an order about a PR that merged");
  const ran = tick(["worker-11"], [dead], { teardown: false });
  assert.equal(ran.after, ran.before);
  assert.equal(ran.waiting.length, 1);
});

/** #3549: a transcript under `$HOME/.claude/projects` that says `worker-11`'s last turn read more than the compact threshold. */
function overThresholdHome(): string {
  const home = mkdtempSync(join(tmpdir(), "a11y-3549-home-"));
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "p", "t.jsonl"), `${[
    JSON.stringify({ type: "user", message: { role: "user", content: "You are `worker-11`, an org session in this repository." } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5",
      usage: { input_tokens: 5, cache_read_input_tokens: COMPACT_THRESHOLD_TOKENS + 1, cache_creation_input_tokens: 0, output_tokens: 12 } } }),
  ].join("\n")}\n`);
  return home;
}

/** Whether `deliverTo` made herdr see a `/compact` while `$HOME` holds that transcript. */
function compactsFromHostTranscript(deliverTo: (run: (args: string[]) => string) => unknown): boolean {
  const home = overThresholdHome();
  const realHome = process.env.HOME;
  process.env.HOME = home;
  const calls: string[] = [];
  try {
    deliverTo((args) => { calls.push(args.join(" ")); return "{}"; });
  } finally {
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
  return calls.some((call) => call.includes("/compact"));
}


test("#3549 THE WRAPPER DOES NOT READ THE HOST'S TRANSCRIPTS: an over-threshold transcript under $HOME is not acted on, and IS through the default", () => {
  assert.equal(compactsFromHostTranscript((run) => deliverHandoffs([order("worker-11", "a report")], agents({ "worker-11": "idle" }), ["worker-11"], { run, now: NOW })), false, "the wrapper's empty root: nothing to compact");
  assert.equal(compactsFromHostTranscript((run) => settlingDeliverHandoffs([order("worker-11", "a report")], agents({ "worker-11": "idle" }), ["worker-11"], { run, now: NOW, sleep: noSettle })), true,
    "POSITIVE CONTROL: the default root WOULD have read it, so the line above is the wrapper's doing and not an unreadable fixture");
});

