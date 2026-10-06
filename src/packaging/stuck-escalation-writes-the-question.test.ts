// no-token: gh -- every `gh` and `herdr` here is an injected seam (`run`, `ask`); nothing imported reaches the real one
/**
 * #3874: AN `answer:ceo` THE TICK PLACED IS A ROW WITH A COMMENT THAT SAYS WHAT IS ASKED.
 *
 * `escalateStuck` labelled #3289 `answer:ceo` as the tick's own account and wrote nothing, so `ceo` found no question, guessed one, and the
 * worker read the guess as an answer to a question it never asked. The key was then recorded as escalated, and every later tick said
 * `ALREADY ESCALATED` for the rest of the day.
 *
 * Mutations, each confirmed to break its own tests: delete the `ask.post(...)` line in `escalateStuck` and "writes the question" goes red;
 * swap it to after `target.place` and the ordering test goes red; delete the `reaskCleared` call and the re-ask tests go red; make
 * `labelRemoval` ignore `REASK_AFTER_MS` and "inside the hour" goes red; make it treat a `labeled` last event as a removal and "is ON the row"
 * goes red; drop the marker check and "once" goes red; drop `ask` from `escalationMemory` and the production-wiring test goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalateStuck, escalationMemory, sessionStateOf, MAX_DELIVERIES, REASK_AFTER_MS } from "../wake.mjs";

const KEY = "worker-3289/answer-owed/row-3289";
const STUCK = [`${KEY}: delivered 6 times and the cause is still true`];
const T0 = Date.parse("2026-10-06T17:51:43Z");
const MIN = 60_000;

type Memory = NonNullable<Parameters<typeof escalateStuck>[3]>;
type Event = [string, string, string];
type Comment = [number, string, string, boolean];

/** One escalation against a fake row: `events` and `comments` are what `gh api` would print, one JSON array per line. */
function escalate(stuck: string[], { memory = {}, events = [], comments = [], state = "idle", now = T0, failPost = false }: {
  memory?: Memory; events?: Event[]; comments?: Comment[]; state?: string; now?: number; failPost?: boolean } = {}) {
  const calls: string[][] = [];
  const posted: { row: number; body: string }[] = [];
  const order: string[] = [];
  const recorded: string[] = [];
  const log: string[] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "issue") order.push(`label:${args.join(" ")}`);
    if (args[0] === "api" && args.some((a) => a.endsWith("/events"))) return events.map((e) => JSON.stringify(e)).join("\n");
    if (args[0] === "api" && args.some((a) => a.endsWith("/comments"))) return comments.map((c) => JSON.stringify(c)).join("\n");
    return "";
  };
  const ask = { post: (row: number, body: string) => {
    if (failPost) throw new Error("HTTP 502 from gh");
    posted.push({ row, body }); order.push("comment");
  }, stateOf: () => state, now: () => now };
  const labelled = escalateStuck(stuck, run, (l: string) => log.push(l), { ask, record: (k: string) => recorded.push(k), ...memory });
  const edits = calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  return { calls, edits, posted, order, recorded, labelled, log: log.join("") };
}

test("an escalation writes the question: the label call AND exactly one comment naming the cause, the deliveries and that nobody acted", () => {
  const { edits, posted, labelled, recorded } = escalate(STUCK);
  assert.deepEqual(edits, [["issue", "edit", "3289", "--add-label", "answer:ceo"]], "POSITIVE CONTROL: the label call is made");
  assert.deepEqual(labelled, [3289]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].row, 3289);
  assert.ok(posted[0].body.includes(KEY), "the cause key");
  assert.ok(posted[0].body.includes(`delivered ${MAX_DELIVERIES} times`), "the delivery count");
  assert.ok(posted[0].body.includes("no session has acted on it"));
  assert.match(posted[0].body, /`worker-3289` is idle as this is written/, "the target's state at the moment");
  assert.match(posted[0].body, /`ceo` can answer it/, "who can answer");
  assert.deepEqual(recorded, [KEY]);
});

test("the comment is written BEFORE the label, so a label never stands without it", () => {
  const { order } = escalate(STUCK);
  assert.deepEqual(order, ["comment", "label:issue edit 3289 --add-label answer:ceo"]);
});

test("a comment that fails is a COULD NOT ESCALATE with no label and no record, so the next tick retries", () => {
  const { edits, recorded, log, labelled } = escalate(STUCK, { failPost: true });
  assert.deepEqual([edits, recorded, labelled], [[], [], []]);
  assert.match(log, /COULD NOT ESCALATE #3289: HTTP 502/);
});

test("a key already escalated makes neither the label call nor a comment (positive control above)", () => {
  const { edits, posted, log } = escalate(STUCK, { memory: { escalated: new Set([KEY]) }, events: [["labeled", "a11ign-ai-workers", "2026-10-06T17:49:31Z"]] });
  assert.deepEqual([edits, posted], [[], []]);
  assert.match(log, /ALREADY ESCALATED #3289/);
});

test("a cause that cannot be escalated (target null) makes neither call", () => {
  const { calls, posted, log } = escalate(["worker-9/some-cause/not-a-subject: delivered 6 times"]);
  assert.deepEqual([calls, posted], [[], []]);
  assert.match(log, /cannot be escalated/);
});

test("a filed row for a keyed repository carries its own body, so no second comment is written", () => {
  const { posted } = escalate(["ceo/trunk-red/pr-foo#12/abcd1234: delivered 6 times"], { memory: { repoOf: () => null } });
  assert.deepEqual(posted, [], "repoOf null: not escalated at all, and nothing is commented");
});

const REMOVED_BY = "a11ign-ai-leads";
const labelled: Event = ["labeled", "a11ign-ai-workers", "2026-10-06T17:49:31Z"];
const removedAt = (minutesAgo: number): Event => ["unlabeled", REMOVED_BY, new Date(T0 - minutesAgo * MIN).toISOString()];
const answer = (at: number): Comment => [4242, REMOVED_BY, new Date(at).toISOString(), false];

/** The same escalated key, `minutesAgo` after its label was removed, with `comments` on the row. */
function reask(minutesAgo: number, comments: Comment[] = [answer(T0 - minutesAgo * MIN - 4_000)], events: Event[] = [labelled, removedAt(minutesAgo)]) {
  return escalate(STUCK, { memory: { escalated: new Set([KEY]) }, events, comments });
}

test("a label removed an hour ago with the cause still true is asked again: one comment with the elapsed time and the earlier answer's id, and the label back", () => {
  const { posted, edits, log } = reask(61);
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /^<!-- stuck-reask: worker-3289\/answer-owed\/row-3289 -->/);
  assert.match(posted[0].body, /removed by @a11ign-ai-leads 61 minutes ago/);
  assert.match(posted[0].body, /their earlier answer is comment 4242/);
  assert.deepEqual(edits, [["issue", "edit", "3289", "--add-label", "answer:ceo"]]);
  assert.match(log, /ASKED AGAIN #3289 .*61 minutes ago/);
});

test("the earlier answer is the removing account's LAST comment before the removal, not a later or another account's", () => {
  const at = T0 - 61 * MIN;
  const comments: Comment[] = [[1, REMOVED_BY, new Date(at - 600_000).toISOString(), false], [2, "someone-else", new Date(at - 1_000).toISOString(), false],
    [3, REMOVED_BY, new Date(at - 4_000).toISOString(), false], [4, REMOVED_BY, new Date(at + 60_000).toISOString(), false]];
  assert.match(reask(61, comments).posted[0].body, /earlier answer is comment 3\b/);
});

test("a removal with no comment of the remover's before it is said so, and still asked", () => {
  assert.match(reask(61, []).posted[0].body, /no comment of theirs came before it/);
});

test("inside the hour a removed label is still an answer: nothing is written (the other side of the 60-minute boundary)", () => {
  const { posted, edits } = reask(59);
  assert.deepEqual([posted, edits], [[], []]);
  assert.equal(REASK_AFTER_MS, 60 * MIN);
});

test("asked ONCE: a comment carrying the marker already on the row means nothing more is written", () => {
  const marked: Comment = [9, "a11ign-ai-workers", new Date(T0 - 30 * MIN).toISOString(), true];
  const { posted, edits } = reask(61, [answer(T0 - 61 * MIN - 4_000), marked]);
  assert.deepEqual([posted, edits], [[], []]);
});

test("a label that is ON the row (its last event is `labeled`) is an open question and is not asked again", () => {
  // The label went ON two hours ago, so only its last event being `labeled` keeps this quiet, never the hour.
  const onTwoHoursAgo: Event = ["labeled", "a11ign-ai-workers", new Date(T0 - 120 * MIN).toISOString()];
  const { posted, edits } = reask(61, [], [removedAt(180), onTwoHoursAgo]);
  assert.deepEqual([posted, edits], [[], []]);
});

test("a re-ask whose comment fails is logged and not hidden, and no label is added", () => {
  const { edits, log } = escalate(STUCK, { memory: { escalated: new Set([KEY]) }, events: [labelled, removedAt(61)], failPost: true });
  assert.deepEqual(edits, []);
  assert.match(log, /COULD NOT ASK AGAIN #3289/);
});

test("PRODUCTION WIRING: the memory the tick hands escalateStuck carries the asker, so a real escalation is never label-only", () => {
  const memory = escalationMemory("/nonexistent/ledger-3874", () => null);
  assert.equal(typeof memory.ask.post, "function");
  assert.equal(typeof memory.ask.stateOf, "function");
  assert.equal(typeof memory.ask.now, "function");
});

test("the target's state is read from herdr the way notReadyWhy reads it, and its absence never stops the escalation", () => {
  const herdr = (status: string) => () => JSON.stringify({ result: { agent: { agent_status: status, interactive_ready: true } } });
  assert.equal(sessionStateOf("worker-3289", herdr("blocked")), "blocked");
  assert.equal(sessionStateOf("worker-3289", herdr("working")), "working");
  assert.match(sessionStateOf("worker-3289", () => { throw new Error("herdr down"); }), /^unreadable \(herdr down\)/);
  assert.equal(sessionStateOf("engineers", () => { throw new Error("must not be asked"); }), "a pool, not a session");
});
