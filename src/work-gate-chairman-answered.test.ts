// no-token: gh -- every `gh` here is the injected `run` seam `readChairmanBlocked` takes, and the clock is a fixture; nothing reaches `gh`, `git` or the network
/**
 * a11ign/a11ign#3390: A `needs:chairman` ROW THE CHAIRMAN HAS ANSWERED SINCE IT WAS LABELLED ORDERS `ceo` TO TAKE THE LABEL OFF OR RE-ASK.
 *
 * #3228 was labelled 2026-10-03T14:05:56Z; the chairman's session commented at 2026-10-04T10:17:05Z; `ceo` had recorded the answer at 09:39Z
 * without taking the label off, and it stood for hours after. `readChairmanBlocked` listed `number,title,updatedAt` and the daily reminder
 * covered the whole set, so an answered row and an unanswered one were indistinguishable.
 *
 * THE FAKE `gh` ANSWERS THE THREE READS THE REAL ONE IS ASKED, in the shape the reader's `--jq` projects them: the label list, the row's
 * `labeled` events (one ISO time per line) and its comments (one `{author, at, body}` object per line). Every clock is a fixture, so none of
 * this can pass or fail by the hour it runs.
 *
 * POSITIVE CONTROLS: (1) and (5) are the non-empty cases the emptiness of (2)-(4) is read against, and the property test at the end puts
 * all of them in one fixture so "and no other row" is read against rows that DO fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, readChairmanBlocked, chairmanReadsRefused, CHAIRMAN_LOGINS } from "./work-gate.ts";

const T0 = "2026-10-03T14:05:56Z"; // #3228 labelled
const T1 = "2026-10-04T10:17:05Z"; // the chairman's session commented
const T2 = "2026-10-04T11:00:00Z"; // the label applied AGAIN, after T1
const EARLIER = "2026-10-03T09:00:00Z";
const CHAIRMAN = CHAIRMAN_LOGINS[0];
const PROVENANCE_LINE = "Chairman answered via Telegram, verified id, message 4417, 2026-10-04T10:15:00Z: A (Yes)";

type Comment = { author: string, at: string, body: string };
type Row = { number: number, labelled: string[], comments: Comment[] };

/** A `gh` that knows rows by number: `refuse` lists the numbers whose per-row reads throw, as a refused `gh` does. */
function fakeGh(rows: Row[], { refuse = [] as number[], listRefused = false } = {}) {
  return (args: string[]): string => {
    if (listRefused) throw new Error("gh: HTTP 403");
    if (args[0] === "issue") {
      return JSON.stringify(rows.map((r) => ({ number: r.number, title: `row ${r.number}`, updatedAt: T1 })));
    }
    const number = Number(/issues\/(\d+)\//.exec(args[1])?.[1]);
    if (refuse.includes(number)) throw new Error("gh: HTTP 403");
    const row = rows.find((r) => r.number === number);
    if (!row) throw new Error(`the fake knows no row ${number}`);
    if (args[1].endsWith("/events")) return row.labelled.map((t) => `${t}\n`).join("");
    if (args[1].endsWith("/comments")) return row.comments.map((c) => `${JSON.stringify(c)}\n`).join("");
    throw new Error(`the fake answers no ${args.join(" ")}`);
  };
}

const answeredOrders = (rows: Row[], gh = fakeGh(rows)) => {
  const chairmanBlocked = readChairmanBlocked(gh);
  assert.ok(chairmanBlocked, "the fixture's read must not be refused");
  return decide({ prs: [], readyRows: [], chairmanBlocked, nowMs: 0 })
    .filter((order: { cause: string }) => order.cause === "chairman-answered");
};

const by = (author: string, at: string, body = "ok"): Comment => ({ author, at, body });

test("(1) POSITIVE CONTROL: the #3228 shape -- a chairman comment after the label -- orders ceo, naming the row and both times", () => {
  const orders = answeredOrders([{ number: 3228, labelled: [T0], comments: [by(CHAIRMAN, T1)] }]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].session, "ceo");
  assert.match(orders[0].prompt, /#3228/);
  assert.ok(orders[0].prompt.includes(T0) && orders[0].prompt.includes(T1), "the two timestamps the check compared are in the order");
  assert.match(orders[0].prompt, /--remove-label/, "the remedy is a command, not a sentence");
  assert.match(orders[0].prompt, /re-ask|apply it again/i, "and so is the other branch: the label applied again after the answer");
});

test("(2) the same row relabelled AFTER the chairman's comment yields none -- the label's newest event wins", () => {
  assert.deepEqual(answeredOrders([{ number: 3228, labelled: [T0, T2], comments: [by(CHAIRMAN, T1)] }]), []);
});

test("(3) a chairman comment OLDER than the label yields none", () => {
  assert.deepEqual(answeredOrders([{ number: 3228, labelled: [T0], comments: [by(CHAIRMAN, EARLIER)] }]), []);
});

test("(4) a newer comment by anyone but the chairman, the org's own bot accounts included, yields none", () => {
  const strangers = ["a11ign-ai-leads", "a11ign-ai-workers", "a11ign-bot", "github-actions[bot]", "someone-else"];
  const comments = strangers.map((who) => by(who, T1, "I have recorded the chairman's answer."));
  assert.deepEqual(answeredOrders([{ number: 3228, labelled: [T0], comments }]), []);
});

test("(5) POSITIVE CONTROL: the answer comment carrying the provenance line, written by a bot, with the label still on, yields one", () => {
  const orders = answeredOrders([{ number: 3228, labelled: [T0], comments: [by("a11ign-ai-leads", T1, PROVENANCE_LINE)] }]);
  assert.equal(orders.length, 1);
  assert.match(orders[0].prompt, /#3228/);
});

test("(5b) a provenance line quoted LATER in a comment is not the line: only a comment that opens with it is an answer", () => {
  const quoted = by("a11ign-ai-leads", T1, `Noted. For the record:\n> ${PROVENANCE_LINE}`);
  assert.deepEqual(answeredOrders([{ number: 3228, labelled: [T0], comments: [quoted] }]), []);
});

test("(6) two different chairman events on one row give two different cause keys; the same event twice gives the same one", () => {
  const first = answeredOrders([{ number: 3228, labelled: [T0], comments: [by(CHAIRMAN, T1)] }])[0];
  const again = answeredOrders([{ number: 3228, labelled: [T0], comments: [by(CHAIRMAN, T1)] }])[0];
  const next = answeredOrders([{ number: 3228, labelled: [T0], comments: [by(CHAIRMAN, T1), by(CHAIRMAN, T2)] }])[0];
  assert.equal(again.causeKey, first.causeKey, "the same event is the same question, or wake re-asks it as new");
  assert.notEqual(next.causeKey, first.causeKey, "a newer chairman event is a new one");
  assert.match(first.causeKey, /^ceo\/chairman-answered\/row-3228\//, "keyed on the row, so a stuck one escalates to the row");
});

test("(7) a refused read yields no orders and is REPORTED as refused, never as an empty set", () => {
  const rows = [{ number: 3228, labelled: [T0], comments: [by(CHAIRMAN, T1)] }];
  const chairmanBlocked = readChairmanBlocked(fakeGh(rows, { refuse: [3228] }));
  assert.ok(chairmanBlocked, "the label list itself was read; only the row's timeline was refused");
  assert.deepEqual(chairmanReadsRefused(chairmanBlocked), [3228]);
  assert.deepEqual(decide({ prs: [], readyRows: [], chairmanBlocked, nowMs: 0 }).filter((o: { cause: string }) => o.cause === "chairman-answered"), []);
  assert.equal(readChairmanBlocked(fakeGh(rows, { listRefused: true })), null, "and a refused LIST stays null, which is not []");
  assert.deepEqual(chairmanReadsRefused(readChairmanBlocked(fakeGh(rows))!), [], "CONTROL: the same fixture unrefused reports none");
});

test("(8) the property: every row whose newest chairman event is newer than its newest label event is named, and no other", () => {
  const rows: Row[] = [
    { number: 1, labelled: [T0], comments: [by(CHAIRMAN, T1)] },                                   // answered
    { number: 2, labelled: [T0, T2], comments: [by(CHAIRMAN, T1)] },                               // re-asked
    { number: 3, labelled: [T0], comments: [] },                                                   // never answered
    { number: 4, labelled: [T0], comments: [by("a11ign-ai-leads", T1, PROVENANCE_LINE)] },         // answered, bot-written
    { number: 5, labelled: [T0], comments: [by("a11ign-bot", T1)] },                               // a bot only
    { number: 6, labelled: [], comments: [by(CHAIRMAN, T1)] },                                     // no label event readable
  ];
  const named = answeredOrders(rows).map((o: { causeKey: string }) => Number(/row-(\d+)\//.exec(o.causeKey)?.[1]));
  assert.deepEqual(named.sort(), [1, 4], "row 6 has no label time to compare with: it is refused, not guessed");
  assert.deepEqual(chairmanReadsRefused(readChairmanBlocked(fakeGh(rows))!), [6], "and it is REPORTED, so the silence is not mistaken for 'not answered'");
});

test("rows read without a timeline (every older caller of `decide`) yield no chairman-answered order", () => {
  const bare = [{ number: 63, title: "row 63", updatedAt: T0 }];
  const orders = decide({ prs: [], readyRows: [], chairmanBlocked: bare, nowMs: 0 });
  assert.deepEqual(orders.filter((o: { cause: string }) => o.cause === "chairman-answered"), []);
});
