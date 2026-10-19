// agent-org#487 (Move 0 of a11ign/a11ign#4505): a wake event in the trace store says what the wake did, `wrote`, `no-op` or `escalated`, and which run did it, or `null` when the store cannot tell.
// no-token: gh -- every source is an injected fixture; nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub
//
// THE FIXTURE is one hour of one ledger (`2026-10-10T12`) and a handful of wakes of `ceo` in it, each with the turns the store would hold. A wake's window is from the second of its order to its
// last turn, so the `gh` calls and sends are placed by minute inside that span and one just outside it (a call of the NEXT wake's window, which must not count for this one).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { attributed } from "../prompt-session.ts";
import { HANDOFF_QUEUE_FILE } from "../wake/seat-reset.ts";
import { DIRECT_RECORD_FILE } from "../prompt-session.ts";
import { appendToStore, ghCommandsOf, hourOf, openStore, outcomeSplit, OUTCOME_QUIET_MS, readStore, repoWriteOf, sendsOfLogs, wakeOutcomes, countedHours } from "../trace/store.ts";
import { PROMPT_LOG_FILES, renderOutcomeSplit, settleWakeOutcomes, SETTLE_AFTER_MS } from "../trace/trace.ts";
import type { TraceEvent } from "../trace/store.ts";

const T0 = Date.parse("2026-10-10T12:00:00Z");
const minute = (n: number) => T0 + n * 60_000;
const NOW = minute(600);
const everyHour = () => true;
const noHour = () => false;

const wake = (id: string, at: number, session = "ceo", cause = "pr-green-unarmed"): TraceEvent => ({ id, kind: "wake", source: "wake-ledger", at: minute(at), session, row: null, pr: null, repo: null, cause, causeKey: null, wakeId: id });
/** A turn of a wake; `repoWrite` false and `ghCommands` 0 are a turn the current reader built that did neither, `undefined` one stored before it. */
const turn = (wakeId: string, at: number, extra: Partial<TraceEvent> = {}): TraceEvent => ({ id: `turn:${wakeId}:${at}`, kind: "turn", source: "transcript", at: minute(at), session: "ceo", row: null, pr: null, repo: null, cause: null,
  causeKey: null, wakeId, transcript: `run-${wakeId}`, repoWrite: false, ghCommands: 0, ...extra });
const call = (wakeId: string, at: number, command: string, exit = 0): TraceEvent => ({ id: `gh-call:${wakeId}:${at}:${command}`, kind: "gh_call", source: "gh-ledger", at: minute(at), session: "gh-ledger", row: null, pr: null, repo: null, cause: null,
  causeKey: null, wakeId: null, sessionId: `run-${wakeId}`, command, exit });
const outcomeOf = (events: TraceEvent[], id: string, options: { sends?: ReturnType<typeof sendsOfLogs>; readable?: (from: number, to: number) => boolean; now?: number; } = {}) =>
  wakeOutcomes({ events, sends: options.sends ?? [], readable: options.readable ?? everyHour, now: options.now ?? NOW }).find((event) => event.id === id);
/** The window closes on a later wake of the session, so no wake here is "still open". */
const closer = wake("closer", 300);

test("a wake whose session issued a write verb in its window is `wrote`", () => {
  for (const verb of ["issue edit", "issue comment", "pr review"]) {
    const events = [wake("w", 0), turn("w", 1), turn("w", 3), call("w", 2, "issue view"), call("w", 2, verb), closer];
    assert.equal(outcomeOf(events, "w")?.outcome, "wrote", verb);
  }
});

test("a write is `wrote` whichever source saw it: the turn's command text, or a file edit or push", () => {
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1, { touchedRows: [4880] }), closer], "w")?.outcome, "wrote");
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1, { repoWrite: true }), closer], "w")?.outcome, "wrote");
});

test("a wake whose session issued only reads is `no-op`", () => {
  const events = [wake("w", 0), turn("w", 1), turn("w", 3), call("w", 1, "issue view"), call("w", 2, "pr list"), call("w", 2, "auth git-credential"), closer];
  assert.equal(outcomeOf(events, "w")?.outcome, "no-op");
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1), closer], "w")?.outcome, "no-op", "a wake that issued no call at all, in an hour the ledger is whole for");
});

test("a wake whose session ran `prompt:session` to another session is `escalated`", () => {
  const events = [wake("w", 0), turn("w", 1), turn("w", 3), call("w", 2, "issue view"), closer];
  const sends = sendsOfLogs([`${JSON.stringify({ session: "orchestrator", sender: "ceo", sentAt: minute(2), prompt: "x", cleared: false })}\n`]);
  assert.equal(outcomeOf(events, "w", { sends })?.outcome, "escalated");
  const queued = sendsOfLogs([`${JSON.stringify({ id: "handoff/orchestrator/1", session: "orchestrator", prompt: attributed("take this", "ceo"), queuedAt: minute(2) })}\n`]);
  assert.equal(outcomeOf(events, "w", { sends: queued })?.outcome, "escalated", "a send queued for a busy seat names its sender in the text");
  const someoneElses = sendsOfLogs([`${JSON.stringify({ session: "orchestrator", sender: "product-manager", sentAt: minute(2) })}\n`]);
  assert.equal(outcomeOf(events, "w", { sends: someoneElses })?.outcome, "no-op", "another seat's send inside this window is not this wake's escalation");
});

test("a wake that wrote and escalated is `wrote`: the outcome says it wrote something", () => {
  const events = [wake("w", 0), turn("w", 1), call("w", 1, "issue comment"), closer];
  const sends = sendsOfLogs([`${JSON.stringify({ session: "orchestrator", sender: "ceo", sentAt: minute(1) })}\n`]);
  assert.equal(outcomeOf(events, "w", { sends })?.outcome, "wrote");
});

test("a wake whose ledger cannot be read is `null`, not `no-op`", () => {
  const events = [wake("w", 0), turn("w", 1), call("w", 1, "issue view"), closer];
  assert.equal(outcomeOf(events, "w", { readable: noHour })?.outcome, null, "an hour the store does not hold whole");
  const sends = sendsOfLogs([`${JSON.stringify({ session: "orchestrator", sender: "ceo", sentAt: minute(1) })}\n`]);
  assert.equal(outcomeOf(events, "w", { readable: noHour, sends })?.outcome, null, "a send is no proof it did not also write, in a ledger with a hole");
  // a hole cannot undo a write that was seen
  assert.equal(outcomeOf([...events, call("w", 1, "pr review")], "w", { readable: noHour })?.outcome, "wrote");
  assert.equal(outcomeOf([wake("w", 0), call("w", 1, "issue view"), closer], "w")?.outcome, undefined, "a wake with no turn in the store has no window to read: left absent");
});

test("a window that cannot rule out a write is `null`: a call the ledger keeps two words of, a turn stored before `repoWrite`, a send of an unnamed sender", () => {
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1), call("w", 1, "api graphql"), closer], "w")?.outcome, null, "`gh api` may be a mutation");
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1, { repoWrite: undefined }), closer], "w")?.outcome, null, "stored before the reader: absent says nothing");
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1, { transcript: undefined }), closer], "w")?.outcome, null, "no transcript id, no ledger lines to join");
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1), call("w", 1, "issue comment", 1), closer], "w")?.outcome, null, "a write that failed is not told");
  const unnamed = sendsOfLogs([`${JSON.stringify({ id: "handoff/ceo/2", session: "ceo", prompt: attributed("who?", null), queuedAt: minute(1) })}\n`]);
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1), closer], "w", { sends: unnamed })?.outcome, null, "it may be this session's escalation");
});

test("a window whose turns issued `gh` commands and whose ledger holds no call of the session is `null`: the ledger did not record it (the 2026-10-09 04:21 writes)", () => {
  const issued = (n: number) => ({ ghCommands: n });
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1, issued(2)), closer], "w")?.outcome, null, "two `gh` commands, no ledger line: not a no-op");
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1, issued(2)), call("w", 1, "issue view"), closer], "w")?.outcome, "no-op", "the ledger recorded the session in the window");
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1, issued(0)), closer], "w")?.outcome, "no-op", "no `gh` command in the text and no line: nothing is missing");
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1, { ghCommands: undefined }), closer], "w")?.outcome, null, "stored before the reader: absent says nothing");
  assert.equal(outcomeOf([wake("w", 0), turn("w", 1, issued(2)), call("w", 400, "issue view"), closer], "w")?.outcome, null, "a call of another window does not vouch for this one");
});

test("a turn's `ghCommands`: a `gh` at the start of a command, in a pipeline, in a substitution, not a word in a path or a body", () => {
  const bash = (command: string) => [{ record: { message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } } }];
  assert.equal(ghCommandsOf(bash("gh issue view 4880 --json body") as never), 1);
  assert.equal(ghCommandsOf(bash("cd x && gh pr list; echo done | gh api user\nBODY=$(gh issue view 1)") as never), 3);
  assert.equal(ghCommandsOf(bash("git log --oneline && ls /home/agent/ghosts") as never), 0);
  assert.equal(ghCommandsOf([{ record: { message: { content: [{ type: "text", text: "gh issue view" }] } } }] as never), 0);
});

test("a call outside the wake's own span is not its call", () => {
  // w1's last turn is at minute 3; the write at minute 100 is in w2's window (91 to 101), which has its own turns, and w1 is quiet between its last turn and w2.
  const events = [wake("w1", 0), turn("w1", 1), turn("w1", 3), wake("w2", 90), turn("w2", 91), turn("w2", 101), call("w2", 100, "issue comment"), closer];
  assert.equal(outcomeOf(events, "w1")?.outcome, "no-op");
  assert.equal(outcomeOf(events, "w2")?.outcome, "wrote");
});

test("a window still open is left absent unless it has already written; a closed one is final", () => {
  const open = [wake("w", 0), turn("w", 1), call("w", 1, "issue view")];
  assert.equal(outcomeOf(open, "w", { now: minute(1) + OUTCOME_QUIET_MS - 1 }), undefined, "inside the quiet period, with no later wake");
  assert.equal(outcomeOf(open, "w", { now: minute(1) + OUTCOME_QUIET_MS })?.outcome, "no-op", "quiet long enough");
  assert.equal(outcomeOf([...open, call("w", 1, "pr merge")], "w", { now: minute(1) + 1 })?.outcome, "wrote", "a write is final at once");
});

test("the run id is the session id of the wake's first turn, and a settled wake is not rewritten", () => {
  const events = [wake("w", 0), turn("w", 5, { transcript: "second" }), turn("w", 1, { transcript: "first" }), closer];
  const [settled] = wakeOutcomes({ events, sends: [], readable: everyHour, now: NOW }).filter((event) => event.id === "w");
  assert.equal(settled.runId, "first");
  assert.deepEqual(wakeOutcomes({ events: events.map((event) => (event.id === "w" ? settled : event)), sends: [], readable: everyHour, now: NOW }).filter((event) => event.id === "w"), []);
});

test("an hour is whole only when, for each account with a call in it, the ledger has a count and the store holds every call it counted", () => {
  const account = (event: TraceEvent, name: string) => ({ ...event, account: name });
  const stored = [account(call("a", 1, "issue view"), "leads"), account(call("a", 2, "issue view"), "leads"), account(call("b", 61, "issue view"), "leads"),
    // 14:00: the store holds a call of an account the ledger has no count for (a trim before the rollup existed): a different account's lines must not vouch for it
    account(call("c", 121, "issue view"), "workers"), account(call("c", 122, "issue view"), "leads")];
  const ledgerCalls = new Map([[`${hourOf(minute(0))}\tleads`, 2], [`${hourOf(minute(60))}\tleads`, 3], [`${hourOf(minute(120))}\tleads`, 1], [`${hourOf(minute(180))}\tleads`, 1]]);
  const whole = countedHours({ ledgerCalls, events: stored });
  assert.deepEqual([...whole], [hourOf(minute(0))], "12:00 has all 2; 13:00 has 1 of 3; 14:00 holds a workers call with no count; 15:00 is counted and absent");
  assert.ok(!whole.has(hourOf(minute(240))), "an hour nothing is known of cannot be told whole");
});

test("the send logs: a delivery, a queued order, an unnamed sender, and the gate's own notice", () => {
  const direct = [{ session: "orchestrator", sender: "ceo", sentAt: 1 }, { session: "ceo", sender: null, sentAt: 2 }, { session: "ceo", sender: "ceo", sentAt: 3 }].map((line) => JSON.stringify(line)).join("\n");
  const handoffs = [{ id: "h1", session: "ceo", prompt: attributed("a", "orchestrator"), queuedAt: 4 }, { id: "h2", session: "ceo", prompt: attributed("a", null), queuedAt: 5 },
    { id: "h3", session: "ceo", prompt: "YOU WERE INTERRUPTED. Your pane's last line reads", queuedAt: 6 }, { id: "h1", delivered: true, at: 7 }].map((line) => JSON.stringify(line)).join("\n");
  assert.deepEqual(sendsOfLogs([direct, handoffs, "not json"]), [{ from: "ceo", at: 1 }, { from: null, at: 2 }, { from: "orchestrator", at: 4 }, { from: null, at: 5 }]);
});

test("the trace names the two log files by the names the gate writes them under", () => {
  assert.deepEqual(PROMPT_LOG_FILES, [DIRECT_RECORD_FILE, HANDOFF_QUEUE_FILE]);
});

test("a turn's `repoWrite`: a file edit or a commit or a push, not a scratch note and not a read", () => {
  const block = (name: string, input: Record<string, unknown>) => [{ record: { message: { content: [{ type: "tool_use", name, input }] } } }];
  assert.equal(repoWriteOf(block("Edit", { file_path: "/home/agent/repos/x/src/a.ts" }) as never), true);
  assert.equal(repoWriteOf(block("Bash", { command: "cd x && git push origin HEAD" }) as never), true);
  assert.equal(repoWriteOf(block("Bash", { command: "git -C /home/agent/repos/x commit -m y" }) as never), true);
  assert.equal(repoWriteOf(block("Write", { file_path: "/tmp/claude-1000/s/scratchpad/c1.md" }) as never), false);
  assert.equal(repoWriteOf(block("Read", { file_path: "/home/agent/repos/x/src/a.ts" }) as never), false);
  assert.equal(repoWriteOf(block("Bash", { command: "git log --oneline && git status" }) as never), false);
});

test("trace prints the split per cause, `null` on its own line; the same events with the field removed print every wake under `null`", () => {
  const events = [
    wake("a", 0, "ceo", "pr-green-unarmed"), turn("a", 1), call("a", 1, "pr merge"),
    wake("b", 10, "ceo", "pr-green-unarmed"), turn("b", 11), call("b", 11, "pr view"),
    wake("c", 20, "product-manager", "row-off-board"), turn("c", 21),
    wake("d", 30, "product-manager", "row-off-board"), turn("d", 31, { repoWrite: undefined }),
    wake("e", 40, "product-manager", "answer-owed"), turn("e", 41),
    wake("z", 400, "ceo", "pr-green-unarmed"),
  ];
  const sends = sendsOfLogs([`${JSON.stringify({ session: "ceo", sender: "product-manager", sentAt: minute(41) })}\n`]);
  const settled = events.map((event) => wakeOutcomes({ events, sends, readable: everyHour, now: NOW }).find((corrected) => corrected.id === event.id) ?? event);
  const window = { from: minute(-1), to: minute(500) };
  const split = outcomeSplit({ events: settled, window });
  assert.deepEqual(split.total, { cause: "all causes", wakes: 6, wrote: 1, noOp: 2, escalated: 1, null: 2, unsettled: 1 }, "z has a turn-less window: absent counts as null, and as not yet settled");
  assert.deepEqual(split.byCause.map((row) => [row.cause, row.wakes, row.wrote, row.noOp, row.escalated, row.null]),
    [["pr-green-unarmed", 3, 1, 1, 0, 1], ["row-off-board", 2, 0, 1, 0, 1], ["answer-owed", 1, 0, 0, 1, 0]]);
  const printed = renderOutcomeSplit(split);
  assert.match(printed, /^wrote\s+1\s+16\.7%$/m);
  assert.match(printed, /^no-op\s+2\s+33\.3%$/m);
  assert.match(printed, /^escalated\s+1\s+16\.7%$/m);
  assert.match(printed, /^null\s+2\s+33\.3%$/m);

  // negative control: the same events with the field removed
  const stripped = settled.map((event) => {
    const { outcome: _outcome, runId: _runId, ...rest } = event;
    return rest;
  });
  const bare = renderOutcomeSplit(outcomeSplit({ events: stripped, window }));
  assert.match(bare, /^wrote\s+0\s+0\.0%$/m);
  assert.match(bare, /^no-op\s+0\s+0\.0%$/m);
  assert.match(bare, /^escalated\s+0\s+0\.0%$/m);
  assert.match(bare, /^null\s+6\s+100\.0%$/m, "every wake is under the null line");
  assert.match(bare, /of which not yet settled\s+6\b/);
});

/** A host's files: one ledger with its lines, a store holding the events, the two prompt logs. Hour 12 is whole in the store; hour 13's wake has a ledger line the store never ingested. */
function host() {
  const dir = tmpDir("trace-outcome-");
  mkdirSync(join(dir, "gh"), { recursive: true });
  const line = (time: string, command: string, session: string) => `${time}\ta11ign-ai-leads\tgraphql?\t\t0\t${command}\tw1\tzsh -c gh\t${session}\n`;
  const ledger = join(dir, "gh", "gh-calls.tsv");
  writeFileSync(ledger, line("2026-10-10T12:01:00Z", "issue view", "run-a") + line("2026-10-10T13:01:00Z", "issue view", "run-b") + line("2026-10-10T13:02:00Z", "pr view", "run-b"));
  const logs = PROMPT_LOG_FILES.map((name) => join(dir, name));
  for (const log of logs) writeFileSync(log, "");
  const store = openStore(join(dir, "events.ndjson"));
  const at = (time: string) => Date.parse(time);
  const events = [
    { ...wake("a", 0, "ceo"), at: at("2026-10-10T12:00:05Z") }, { ...turn("a", 0, { transcript: "run-a" }), at: at("2026-10-10T12:01:30Z") },
    { ...wake("a2", 0, "ceo"), at: at("2026-10-10T12:30:00Z") }, { ...turn("a2", 0, { transcript: "run-a2" }), at: at("2026-10-10T12:31:00Z") },
    { ...wake("b", 0, "ceo"), at: at("2026-10-10T13:00:05Z") }, { ...turn("b", 0, { transcript: "run-b" }), at: at("2026-10-10T13:03:00Z") },
    { ...wake("b2", 0, "ceo"), at: at("2026-10-10T13:30:00Z") },
    { ...call("a", 0, "issue view"), at: at("2026-10-10T12:01:00Z"), account: "a11ign-ai-leads" },
    // hour 13: the ledger counted two calls, the store ingested one
    { ...call("b", 0, "issue view"), at: at("2026-10-10T13:01:00Z"), account: "a11ign-ai-leads" },
  ] as TraceEvent[];
  appendToStore(store, events);
  const read = () => Object.fromEntries(readStore(store.path).filter((event) => event.kind === "wake").map((event) => [event.id, event]));
  return { dir, store, ledger, logs, read };
}

test("settling: a batch is written once the oldest wake is old enough, a wake in a whole hour is told, one in an hour the store is short of is `null`", () => {
  const h = host();
  const young = Date.parse("2026-10-10T12:00:05Z") + SETTLE_AFTER_MS - 1;
  const early = settleWakeOutcomes({ store: h.store, ghLedgers: [h.ledger], promptLogs: h.logs, now: young });
  assert.equal(early.settled, 0, "the oldest is not three hours old: nothing is written");
  assert.ok(early.pending >= 2, "but the batch is known");
  assert.equal(h.read().a.outcome, undefined, "and the store is as it was");

  const done = settleWakeOutcomes({ store: h.store, ghLedgers: [h.ledger], promptLogs: h.logs, now: Date.parse("2026-10-10T18:00:00Z") });
  const wakes = h.read();
  assert.equal(wakes.a.outcome, "no-op");
  assert.equal(wakes.a.runId, "run-a");
  assert.equal(wakes.a2.outcome, "no-op", "hour 12 is whole: a call-less wake in it is a told no-op");
  assert.equal(wakes.b.outcome, null, "hour 13 is short one ledger line in the store");
  assert.equal(wakes.b.runId, "run-b");
  assert.equal(wakes.b2.outcome, undefined, "no turn in the store: nothing to read");
  assert.deepEqual([done.settled, done.noOp, done.unknown, done.failed], [3, 2, 1, []]);
  assert.equal(done.countedHours, 1);
  assert.equal(settleWakeOutcomes({ store: h.store, ghLedgers: [h.ledger], promptLogs: h.logs, now: Date.parse("2026-10-10T19:00:00Z") }).settled, 0, "a second run changes nothing");
});

test("settling: the production readability scan ends for the final wake of a session (no wake after it) and a wake with no readable start is `null`, not whole", () => {
  const h = host();
  const at = (time: string) => Date.parse(time);
  // `a` closes on `a2`, `b` on `b2`; `z` is a session's LAST wake with a turn, so nothing bounds its window but its own last turn. Its hour (12) is whole in the ledger.
  appendToStore(h.store, [
    { ...wake("z", 0, "pm"), at: at("2026-10-10T12:10:00Z") }, { ...turn("z", 0, { transcript: "run-z", session: "pm" }), at: at("2026-10-10T12:11:00Z") },
    { ...wake("n", 0, "qa"), at: Number.NaN }, { ...turn("n", 0, { transcript: "run-n", session: "qa" }), at: at("2026-10-10T12:12:00Z") },
  ] as TraceEvent[]);
  const started = Date.now();
  const done = settleWakeOutcomes({ store: h.store, ghLedgers: [h.ledger], promptLogs: h.logs, now: at("2026-10-10T18:00:00Z") });
  assert.ok(Date.now() - started < 5_000, "the scan is bounded by the wake's own last turn");
  const wakes = h.read();
  assert.equal(wakes.z.outcome, "no-op", "a final wake in a whole hour is told, with the same scan the ingest runs");
  assert.equal(wakes.z.runId, "run-z");
  assert.equal(wakes.n.outcome, null, "a wake whose start is not a time is never read as a whole hour");
  assert.deepEqual(done.failed, []);
});

test("settling: a host with no ledger file writes nothing, so its wakes print under `null` and a store with duplicate ids is not compacted behind the detector's back", () => {
  const h = host();
  const bare = settleWakeOutcomes({ store: h.store, ghLedgers: [join(h.dir, "gh", "absent.tsv")], promptLogs: h.logs, now: Date.parse("2026-10-10T18:00:00Z") });
  assert.deepEqual([bare.settled, bare.pending, bare.failed], [0, 0, []]);
  assert.equal(h.read().a.outcome, undefined);
});

test("settling: a `prompt:session` log that cannot be read derives nothing and says so; an unreadable ledger is the ledger report's failure, not this one's", () => {
  const h = host();
  const now = Date.parse("2026-10-10T18:00:00Z");
  mkdirSync(join(h.dir, "a-directory"));
  const bad = settleWakeOutcomes({ store: h.store, ghLedgers: [h.ledger], promptLogs: [join(h.dir, "a-directory")], now });
  assert.equal(bad.settled, 0);
  assert.match(bad.failed.join("\n"), /prompt:session log cannot be read/);
  const ledgerless = settleWakeOutcomes({ store: h.store, ghLedgers: [join(h.dir, "a-directory")], promptLogs: h.logs, now });
  assert.deepEqual([ledgerless.settled, ledgerless.failed], [0, []]);
  assert.equal(h.read().a.outcome, undefined, "no wake was told from the sources that did read");
});
