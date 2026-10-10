// #4755: the daily confidence reading's POST, over a fixture reading. The Telegram provider is the real one on a fetch that records the wire (the routing is read off the `chat_id` Telegram would have
// received, as `messaging/audience.test.ts` does); `gh` is a function that records its argv. Nothing here reaches the network, `gh`, `herdr` or `git`.
// no-token: none -- the token is a fixture string, the chat ids are made up, and no process is started
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createFakeProvider } from "./messaging/fake-provider.ts";
import { createLedger } from "./messaging/ledger.ts";
import { createSecret } from "./messaging/secret.ts";
import { AUDIENCE } from "./messaging/provider-contract.ts";
import { createTelegramProvider } from "./messaging/providers/telegram/send.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";
import { confidenceReading } from "./provider-confidence.ts";
import {
  CONFIDENCE_CONFIG, LOW_CONFIDENCE_LINE, POST_KIND, TRACKER_EPIC, postConfidenceReading, questionsOverTheLine, renderConfidencePost,
  type Delivery, type PostResult,
} from "./decision-confidence-post.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-10T08:00:00Z");
const TOKEN = "123456789:AAFk3x9Q-test_token_value_ZZ";
const ASK_CHAT = 4242;
const CHANNEL_CHAT = -1009876543210;
const REPO = "a11ign/a11ign";
const COMMENT_URL = `https://github.com/${REPO}/issues/${TRACKER_EPIC}#issuecomment-6100000001`;

const scratch = tmpDirForFile("decision-confidence-post-");
let nextLedger = 0;
const ledgerPath = () => join(scratch, `ledger-${nextLedger += 1}.jsonl`);

type Answer = Record<string, unknown>;
const given = (confidence: number): Answer => ({ value: "yes", confidence, fellBack: false });
const underFloor = (confidence: number): Answer => ({ value: "no", confidence, fellBack: true, asked: "yes", reason: `yes at ${confidence}, under the floor 0.7` });
const refused = (): Answer => ({ value: "no", fellBack: true, reason: "the API answered HTTP 422" });
const decision = (answers: Record<string, Answer>, at = NOW - HOUR) =>
  ({ use: "model-routing", id: "row-1", fields: ["title"], questions: Object.keys(answers), answers, via: "jev", fellBack: false, at });
const readingOf = (lines: unknown[], now = NOW) => confidenceReading(lines, { now, windowMs: DAY });
/** `asked` decisions of one question, `held` of them under the floor. */
const askedOf = (question: string, asked: number, held: number): unknown[] =>
  Array.from({ length: asked }, (_, index) => decision({ [question]: index < held ? underFloor(0.5) : given(0.9) }));
const SOME_READING = readingOf([...askedOf("score", 20, 7), ...askedOf("subsystems", 10, 1), decision({ covered: refused() })]);
const EMPTY = readingOf([]);

/** A fetch that records each request and answers every one with a fresh message id. */
function fakeTelegram() {
  const requests: { url: string; body: Record<string, any> }[] = [];
  let nextMessageId = 100;
  const fetchImpl = (async (url: string, init: { body: string }) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: nextMessageId += 1 } }), headers: { get: () => null } };
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function telegram({ channel }: { channel: boolean }) {
  const wire = fakeTelegram();
  const provider = createTelegramProvider({
    token: createSecret(TOKEN), chatId: ASK_CHAT, announcementsChatId: channel ? CHANNEL_CHAT : undefined, fetch: wire.fetch, sleep: async () => {}, log: () => {},
  });
  return { provider, requests: wire.requests };
}

const messenger = (provider: any, config?: Extract<Delivery, { via: "messenger" }>["config"]): Extract<Delivery, { via: "messenger" }> =>
  ({ via: "messenger", provider, ledger: createLedger({ path: ledgerPath(), now: () => NOW }), config });

/** A `gh` that records its argv. `present` is what the ask for the day's comment finds; posting answers with the comment's URL. */
function fakeGh(present = "") {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    return args[0] === "api" ? present : `${COMMENT_URL}\n`;
  };
  return { delivery: { via: "tracker", repo: REPO, run } as Extract<Delivery, { via: "tracker" }>, calls };
}

const post = (delivery: Delivery, { reading = SOME_READING, providerDeclared = true, now = NOW } = {}): Promise<PostResult> =>
  postConfidenceReading({ reading, providerDeclared, delivery, now });
function posted(result: PostResult) {
  assert.ok(result.posted, `not posted: ${JSON.stringify(result)}`);
  return result;
}
/** THE DESTINATION ASSERTION the control turns: the one message went to the channel and not to the chairman's chat. */
function assertWentToTheChannel(requests: { body: Record<string, any> }[]): void {
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.body.chat_id, CHANNEL_CHAT, "the reading was not sent to the announcements channel");
}

test("with the channel configured, the reading goes to the channel and returns its message id", async () => {
  const { provider, requests } = telegram({ channel: true });
  const result = posted(await post(messenger(provider)));
  assertWentToTheChannel(requests);
  assert.equal(result.destination, "channel");
  assert.equal(result.ref, "101");
  assert.equal(requests[0]?.body.text, result.text);
});

test("with only the chairman chat configured, the announcement audience sends it there", async () => {
  const { provider, requests } = telegram({ channel: false });
  const result = posted(await post(messenger(provider)));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.body.chat_id, ASK_CHAT);
  assert.equal(result.destination, "chairman-chat");
});

test("with no messaging configured, it is one comment on the epic, carrying the day's marker", async () => {
  const { delivery, calls } = fakeGh();
  const result = posted(await post(delivery));
  assert.equal(result.destination, "tracker-comment");
  assert.equal(result.ref, "6100000001");
  const comment = calls.find((args) => args[0] === "issue");
  assert.deepEqual(comment?.slice(0, 4), ["issue", "comment", String(TRACKER_EPIC), "--repo"]);
  assert.equal(comment?.[4], REPO);
  const body = comment?.[6] ?? "";
  assert.ok(body.startsWith("<!-- decision-confidence-post: 2026-10-10 -->\n"), body);
  assert.ok(body.endsWith(result.text), "the comment is the same text the channel would have been sent");
});

test("CONTROL: the destination assertion fails when the kind is declared ask", async () => {
  // An ask names a row or declares why it has none (a11ign/a11ign#4745): without `rowLess` the core refuses it before the destination is ever in question.
  const declaredAsk = { kinds: { [POST_KIND]: { audience: AUDIENCE.ask, rowLess: "a daily reading belongs to no one row" } } };
  const wired = telegram({ channel: true });
  const { requests } = wired;
  // Without the asks' record: a kept ask also sends a pinned list, which is two more requests, and this control is about WHERE the reading went.
  const provider = { ...wired.provider, capabilities: { ...wired.provider.capabilities, edit: false, pin: false } };
  const result = posted(await post(messenger(provider, declaredAsk)));
  assert.throws(() => assertWentToTheChannel(requests), /not sent to the announcements channel/);
  assert.equal(requests[0]?.body.chat_id, ASK_CHAT, "declared ask, it lands in the chairman's chat even with the channel configured");
  assert.equal(result.destination, "chairman-chat");
  // and the positive control for the line above: the shipped declaration is the announcement one, which the first test has go to the channel
  assert.equal(CONFIDENCE_CONFIG.kinds[POST_KIND].audience, AUDIENCE.announcement);
});

test("one post per day through the messenger: a second run the same day sends nothing, the next day sends again", async () => {
  const { provider, requests } = telegram({ channel: true });
  const delivery = messenger(provider);
  posted(await post(delivery));
  const again = await post(delivery, { now: NOW + HOUR });
  assert.deepEqual(again, { posted: false, why: "already-posted" });
  assert.equal(requests.length, 1);
  posted(await post(delivery, { now: NOW + DAY }));
  assert.equal(requests.length, 2);
});

test("one post per day on the epic: a day whose marker comment is there posts nothing", async () => {
  const present = fakeGh("6100000001\n");
  assert.deepEqual(await post(present.delivery), { posted: false, why: "already-posted" });
  assert.deepEqual(present.calls.map((args) => args[0]), ["api"], "the ask is made and no comment is");
  const ask = present.calls[0]?.join(" ") ?? "";
  assert.ok(ask.includes(`issues/${TRACKER_EPIC}/comments`) && ask.includes("since=2026-10-10T00:00:00Z") && ask.includes("<!-- decision-confidence-post: 2026-10-10 -->"), ask);
  // the control: the same call with the day's comment absent DOES post, so "already-posted" above is the ask's answer and not a stuck branch
  const absent = fakeGh("");
  posted(await post(absent.delivery));
  assert.deepEqual(absent.calls.map((args) => args[0]), ["api", "issue"]);
});

test("a quiet day is still one message, saying so", async () => {
  const { provider, requests } = telegram({ channel: true });
  const result = posted(await post(messenger(provider), { reading: EMPTY }));
  assert.equal(requests.length, 1);
  assert.match(result.text, /no provider decisions in the window/);
});

test("no provider declared posts nothing: no message, no ledger line, no comment, and the delivery is never asked", async () => {
  // POSITIVE CONTROL for every emptiness below: the same inputs with `providerDeclared: true` post, in the first three tests of this file.
  const { provider, requests } = telegram({ channel: true });
  const viaMessenger = messenger(provider);
  assert.deepEqual(await post(viaMessenger, { providerDeclared: false }), { posted: false, why: "no-provider" });
  assert.equal(requests.length, 0);
  assert.deepEqual(viaMessenger.ledger.read(), []);
  const gh = fakeGh();
  assert.deepEqual(await post(gh.delivery, { providerDeclared: false }), { posted: false, why: "no-provider" });
  assert.deepEqual(gh.calls, []);
});

test("the text asks the chairman nothing: no question mark, even from a question named with one", async () => {
  const reading = readingOf([decision({ "is it routed?": given(0.9) }), decision({ score: underFloor(0.4) })]);
  const text = renderConfidencePost(reading);
  assert.ok(!text.includes("?"), text);
  // positive control: the name was in the reading and is in the text, so the absence above is the removal and not a row that never rendered
  assert.ok(reading.rows.some((row) => row.question.includes("?")));
  assert.match(text, /is it routed/);
  const { provider, requests } = telegram({ channel: true });
  await post(messenger(provider), { reading });
  assert.ok(!String(requests[0]?.body.text).includes("?"));
  assert.equal(requests[0]?.body.reply_markup, undefined, "an announcement carries no button");
});

test("per use and question: the decisions asked, the share under the floor, the mean and the median", () => {
  const text = renderConfidencePost(readingOf([decision({ score: given(0.9) }), decision({ score: underFloor(0.5) }), decision({ score: given(0.7) }), decision({ score: refused() })]));
  assert.match(text, /model-routing\/score: 4 asked, 25% under floor 0\.7, mean 0\.70, median 0\.70, 1 other fallback/);
  assert.match(text, /4 decisions asked in the window\./);
});

test("the names over #4750's line are the ones past 30% of at least 20, and the edges are on both sides", () => {
  const over = (...parts: unknown[][]) => questionsOverTheLine(readingOf(parts.flat()));
  assert.deepEqual(LOW_CONFIDENCE_LINE, { minDecisions: 20, share: 0.3 });
  assert.deepEqual(over(askedOf("a", 20, 7)), ["model-routing/a"], "20 at 35%: over");
  assert.deepEqual(over(askedOf("a", 20, 6)), [], "20 at exactly 30%: not over");
  assert.deepEqual(over(askedOf("a", 19, 19)), [], "19 at 100%: too few decisions to say");
  assert.match(renderConfidencePost(SOME_READING), /Over the line \(more than 30% under the floor on at least 20 asked\): model-routing\/score\./);
  assert.match(renderConfidencePost(EMPTY), /Told, not asked/);
  assert.match(renderConfidencePost(readingOf(askedOf("a", 5, 5))), /No question is over the line/);
});

test("a send the provider could not make is not a post, and says what happened", async () => {
  const fake = createFakeProvider();
  fake.failNext(new Error("telegram is down"));
  const result = await post(messenger(fake));
  assert.deepEqual(result, { posted: false, why: "not-sent", detail: "failed" });
  assert.equal(fake.sent.length, 0);
});

test("lines the reading could not read are said in the post and are not dropped", () => {
  const text = renderConfidencePost(readingOf(["not json", JSON.stringify(decision({ score: given(0.9) }))]));
  assert.match(text, /1 log line could not be read and is not in this reading\./);
});
