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
 * goes red; drop the marker check and "once" goes red; ignore a pending comment (`commentAwaitsLabel` always false) and both retry tests go red; drop `ask` from `escalationMemory` and the production-wiring test goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalateStuck, escalationMemory, sessionStateOf, MAX_DELIVERIES, REASK_AFTER_MS } from "../wake.ts";

const KEY = "worker-3289/answer-owed/row-3289";
const STUCK = [`${KEY}: delivered 6 times and the cause is still true`];
const T0 = Date.parse("2026-10-06T17:51:43Z");
const MIN = 60_000;

type Memory = NonNullable<Parameters<typeof escalateStuck>[3]>;
type Event = [string, string, string];
type Comment = [number, string, string, boolean];

/** What the fake row remembers between ticks: its label events, and its comments with the body each was posted with. */
type Row = { events: Event[]; comments: { id: number; login: string; at: string; body: string; marked: boolean }[] };

/** A row holding `events` and `comments` as `gh api` would have printed them (`marked` is what the fixture says; a posted body is checked for the marker). */
const rowOf = (events: Event[] = [], comments: Comment[] = []): Row =>
  ({ events, comments: comments.map(([id, login, at, marked]) => ({ id, login, at, body: "", marked })) });

/** One escalation against a fake row, which `row` lets a second tick share: a posted comment lands on it and a label edit that succeeds adds a `labeled` event. */
function escalate(stuck: string[], { memory = {}, row = rowOf(), state = "idle", now = T0, failPost = false, failLabel = false }: {
  memory?: Memory; row?: Row; state?: string; now?: number; failPost?: boolean; failLabel?: boolean } = {}) {
  const calls: string[][] = [];
  const posted: { row: number; body: string }[] = [];
  const order: string[] = [];
  const recorded: string[] = [];
  const log: string[] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "issue") {
      if (failLabel) throw new Error("HTTP 502 from gh (label)");
      order.push(`label:${args.join(" ")}`);
      row.events.push(["labeled", "a11ign-ai-workers", new Date(now).toISOString()]);
    }
    if (args[0] === "api" && args.some((a) => a.endsWith("/events"))) return row.events.map((e) => JSON.stringify(e)).join("\n");
    if (args[0] === "api" && args.some((a) => a.endsWith("/comments"))) {
      const marker = JSON.parse(/contains\((".*")\)/.exec(args.join(" "))![1]);
      return row.comments.map((c) => JSON.stringify([c.id, c.login, c.at, c.marked || c.body.includes(marker)])).join("\n");
    }
    return "";
  };
  const ask = { post: (rowNumber: number, body: string) => {
    if (failPost) throw new Error("HTTP 502 from gh");
    posted.push({ row: rowNumber, body }); order.push("comment");
    row.comments.push({ id: 7000 + row.comments.length, login: "a11ign-ai-workers", at: new Date(now).toISOString(), body, marked: false });
  }, stateOf: () => state, now: () => now };
  const labelled = escalateStuck(stuck, run, (l: string) => log.push(l), { ask, record: (k: string) => recorded.push(k), ...memory });
  const edits = calls.filter((c) => c[0] === "issue" && c[1] === "edit");
  return { calls, edits, posted, order, recorded, labelled, row, log: log.join("") };
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
  const { edits, posted, log } = escalate(STUCK, { memory: { escalated: new Set([KEY]) }, row: rowOf([["labeled", "a11ign-ai-workers", "2026-10-06T17:49:31Z"]]) });
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
  return escalate(STUCK, { memory: { escalated: new Set([KEY]) }, row: rowOf(events, comments) });
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

test("asked ONCE: after a re-ask and its label, a second removal finds the marker older than itself and writes nothing more", () => {
  const marked: Comment = [9, "a11ign-ai-workers", new Date(T0 - 170 * MIN).toISOString(), true];
  const relabelled: Event = ["labeled", "a11ign-ai-workers", new Date(T0 - 169 * MIN).toISOString()];
  const { posted, edits } = reask(61, [answer(T0 - 61 * MIN - 4_000), marked], [labelled, removedAt(200), relabelled, removedAt(61)]);
  assert.deepEqual([posted, edits], [[], []]);
});

test("a label that is ON the row (its last event is `labeled`) is an open question and is not asked again", () => {
  // The label went ON two hours ago, so only its last event being `labeled` keeps this quiet, never the hour.
  const onTwoHoursAgo: Event = ["labeled", "a11ign-ai-workers", new Date(T0 - 120 * MIN).toISOString()];
  const { posted, edits } = reask(61, [], [removedAt(180), onTwoHoursAgo]);
  assert.deepEqual([posted, edits], [[], []]);
});

test("a re-ask whose comment fails is logged and not hidden, and no label is added", () => {
  const { edits, log } = escalate(STUCK, { memory: { escalated: new Set([KEY]) }, row: rowOf([labelled, removedAt(61)]), failPost: true });
  assert.deepEqual(edits, []);
  assert.match(log, /COULD NOT ASK AGAIN #3289/);
});

test("a label that fails AFTER the comment landed is retried as the label alone: one comment across both ticks, then the label and the record (review of #328)", () => {
  const first = escalate(STUCK, { failLabel: true });
  assert.equal(first.posted.length, 1, "POSITIVE CONTROL: the comment landed on the first tick");
  assert.match(first.log, /COULD NOT ESCALATE #3289: HTTP 502 from gh \(label\)/);
  assert.deepEqual(first.recorded, [], "not recorded, so the retry is possible");

  const retry = escalate(STUCK, { row: first.row, now: T0 + 2 * MIN });
  assert.deepEqual(retry.posted, [], "the question is already on the row");
  assert.deepEqual(retry.edits, [["issue", "edit", "3289", "--add-label", "answer:ceo"]]);
  assert.deepEqual(retry.recorded, [KEY]);
});

test("a new run of the same cause is NOT mistaken for that pending comment: a marker older than the label's last event is answered history", () => {
  const first = escalate(STUCK);
  const later = escalate(STUCK, { row: first.row, now: T0 + 5 * MIN });
  assert.equal(later.posted.length, 1, "the earlier comment was followed by its label, so this run asks afresh");
});

test("a re-ask whose label fails is retried as the label alone, with no second comment", () => {
  const first = escalate(STUCK, { memory: { escalated: new Set([KEY]) }, row: rowOf([labelled, removedAt(61)], [answer(T0 - 61 * MIN - 4_000)]), failLabel: true });
  assert.equal(first.posted.length, 1, "POSITIVE CONTROL: the re-ask comment landed");
  assert.match(first.log, /COULD NOT ASK AGAIN #3289/);
  const retry = escalate(STUCK, { memory: { escalated: new Set([KEY]) }, row: first.row });
  assert.deepEqual(retry.posted, []);
  assert.deepEqual(retry.edits, [["issue", "edit", "3289", "--add-label", "answer:ceo"]]);
  assert.match(retry.log, /ASKED AGAIN #3289/);
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
