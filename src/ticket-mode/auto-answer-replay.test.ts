// no-token: gh -- pure functions over a stub answerer and judge, and the checked-in replay result; no model is asked
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGREEMENT_BAR, judgementOf, judgePrompt, meetsBar, MIN_ANSWERED, publicResultOf, replay, replayCase, scoreOf, verdictOf, type CaseResult, type Judge, type PublicResult, type ReplayCase } from "./auto-answer-replay.ts";
import { SCHEMA } from "./config-schema.ts";
import { DEFAULT_AUTO_ANSWER, parseTicketSettings } from "./settings.ts";

const sources = [{ label: "the parent ticket A11-429", url: "https://linear.app/x/A11-429", text: "**Repository:** agent-org" }];
const asked = (over: Partial<ReplayCase> = {}): ReplayCase => ({ ticket: "A11-2", askedAt: "2026-11-01T00:00:00Z", question: "Which repository?", personAnswer: "agent-org", sources, ...over });
const sure = (answer: string, confidence = 0.95) => async () => JSON.stringify({ answer, confidence, sources: ["the parent ticket A11-429"] });
const agreeing: Judge = async (_q, person, auto) => ({ agrees: person === auto, why: "compared" });
const deps = (answer: string, confidence?: number) => ({ ask: sure(answer, confidence), model: "haiku", judge: agreeing, threshold: 0.9 });

/** `answered` answered results, `agreed` of them agreeing. */
const answeredResults = (answered: number, agreed: number): CaseResult[] => Array.from({ length: answered }, (_, at) => ({ ticket: `A11-${at}`, askedAt: "", result: "answered", answer: "a", confidence: 0.95, agrees: at < agreed, why: "" }));

test("A11-438: a replayed question goes through the live gate, prompt and threshold, and an answer is judged against the person's", async () => {
  assert.deepEqual(await replayCase(asked(), deps("agent-org")), { ticket: "A11-2", askedAt: "2026-11-01T00:00:00Z", result: "answered", answer: "agent-org", confidence: 0.95, agrees: true, why: "compared" });
  const other = await replayCase(asked(), deps("control"));
  assert.equal(other.result === "answered" && other.agrees, false, "a different answer does not agree");
  const low = await replayCase(asked(), deps("agent-org", 0.5));
  assert.equal(low.result, "parked", "under the threshold it is parked for a person, as on a live run");
  for (const item of ["outward", "access", "discard", "frozen", "legal"]) assert.equal((await replayCase(asked({ escalation: item }), deps("agent-org"))).result, "not-tried", item);
  assert.equal((await replayCase(asked({ escalation: "contradicts" }), deps("agent-org"))).result, "answered", "contradicts may be answered, as on a live run");
});

test("A11-438: an answerer that fails parks the question, and a judge that fails counts the answer as not agreeing", async () => {
  const failing = async (): Promise<string> => { throw new Error("claude exited 1\nmore"); };
  assert.deepEqual(await replayCase(asked(), { ...deps("x"), ask: failing }), { ticket: "A11-2", askedAt: "2026-11-01T00:00:00Z", result: "parked", why: "the answerer could not be asked (claude exited 1)" });
  const judged = await replayCase(asked(), { ...deps("agent-org"), judge: async () => { throw new Error("no reply"); } });
  assert.equal(judged.result === "answered" && judged.agrees, false);
});

test("A11-438: the replay stops before a question once the token cap is spent", async () => {
  let asks = 0;
  const counting = async () => { asks += 1; return JSON.stringify({ answer: "agent-org", confidence: 0.95, sources: ["the parent ticket A11-429"] }); };
  const results = await replay([asked(), asked(), asked()], { ...deps("x"), ask: counting }, () => asks >= 2);
  assert.equal(results.length, 2);
});

test("A11-438: the bar is 95% agreement on at least 20 answered questions", () => {
  assert.equal(AGREEMENT_BAR, 0.95);
  assert.equal(MIN_ANSWERED, 20);
  assert.equal(meetsBar(20, 19), true, "19 of 20 is 95%");
  assert.equal(meetsBar(20, 18), false, "18 of 20 is 90%");
  assert.equal(meetsBar(19, 19), false, "100% of too few");
});

test("A11-438: the score counts the cases, the tried, the answered and the agreed, and the verdict says the agreement, the sample and by how much it misses", () => {
  const met = scoreOf(answeredResults(20, 19));
  assert.deepEqual(met, { cases: 20, tried: 20, answered: 20, agreed: 19, agreement: 0.95, meetsBar: true });
  assert.equal(verdictOf(met), "Agreement 95% (19 of 20), 20 answered of 20 tried, from 20 past questions. It meets the 95% bar on at least 20 answered, so the key is on by default.");
  const under = scoreOf([...answeredResults(20, 18), { ticket: "A11-9", askedAt: "", result: "parked", why: "" }, { ticket: "A11-8", askedAt: "", result: "not-tried", why: "" }]);
  assert.deepEqual(under, { cases: 22, tried: 21, answered: 20, agreed: 18, agreement: 0.9, meetsBar: false });
  assert.equal(verdictOf(under), "Agreement 90% (18 of 20), 20 answered of 21 tried, from 22 past questions. The key stays off: 5 points under the 95% bar.");
  assert.equal(verdictOf(scoreOf(answeredResults(4, 3))), "Agreement 75% (3 of 4), 4 answered of 4 tried, from 4 past questions. The key stays off: 20 points under the 95% bar, 16 answered short of the 20 the bar is read on.");
  assert.equal(verdictOf(scoreOf(answeredResults(38, 36))), "Agreement 94.7% (36 of 38), 38 answered of 38 tried, from 38 past questions. The key stays off: 0.3 points under the 95% bar.", "never rounded up to the bar it misses");
  assert.equal(verdictOf(scoreOf(answeredResults(25, 24))), "Agreement 96% (24 of 25), 25 answered of 25 tried, from 25 past questions. It meets the 95% bar on at least 20 answered, so the key is on by default.");
  assert.equal(verdictOf(scoreOf([])), "No agreement to read: the answerer answered none of 0 tried, from 0 past questions. The key stays off: the bar needs 20 answered at 95%.");
});

test("A11-438: the judge's prompt carries the question and both answers, and its reply is read only as the object it asks for", () => {
  const prompt = judgePrompt("Which repository?", "agent-org", "control");
  for (const part of ["<question>\nWhich repository?", "<person_answer>\nagent-org", "<automatic_answer>\ncontrol"]) assert.ok(prompt.includes(part), part);
  assert.deepEqual(judgementOf("```json\n{\"agrees\": true, \"why\": \"same\"}\n```"), { agrees: true, why: "same" });
  assert.equal(judgementOf("{\"agrees\": \"yes\", \"why\": \"same\"}"), null);
  assert.equal(judgementOf("no"), null);
});

test("A11-438: the checked-in result carries no question, answer or reason, only keys, what came of each, how sure and whether it agreed", () => {
  const results: CaseResult[] = [...answeredResults(1, 1), { ticket: "A11-9", askedAt: "t", result: "parked", why: "the answerer was 40% sure" }];
  const full = { ranAt: "r", sha: "s", model: "haiku", judgeModel: "sonnet", threshold: 0.9, capped: false, score: scoreOf(results), verdict: "v", results };
  assert.deepEqual(publicResultOf(full).results, [{ ticket: "A11-0", askedAt: "", result: "answered", confidence: 0.95, agrees: true }, { ticket: "A11-9", askedAt: "t", result: "parked" }]);
  assert.deepEqual(scoreOf(publicResultOf(full).results), full.score, "the score reads the same from it");
});

const stored = JSON.parse(readFileSync(new URL("../../evals/auto-answer/result.json", import.meta.url), "utf8")) as PublicResult;

test("A11-438: the key is on by default exactly when the stored replay meets the bar, and the stored score and verdict are the ones its results give", () => {
  assert.deepEqual(stored.score, scoreOf(stored.results), "the stored score is its results' score");
  assert.ok(stored.verdict.startsWith(verdictOf(stored.score)), "the stored verdict is its score's");
  assert.equal(DEFAULT_AUTO_ANSWER, stored.score.meetsBar, "the default follows the replay");
  assert.equal(parseTicketSettings({ clones: { "agent-org": "/repos/agent-org" } }, "/home/me").autoAnswer?.on, stored.score.meetsBar, "a host file with no tickets.autoAnswer reads the default");
  assert.equal(SCHEMA.find(({ key }) => key === "tickets.autoAnswer")?.default, String(stored.score.meetsBar), "the Settings page shows the same default");
});
