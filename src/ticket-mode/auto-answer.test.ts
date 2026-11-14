// no-token: gh -- pure functions and files in a temporary directory; no model is asked
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { answerPrompt, decide, mayAnswer, messageOf, replyOf, resultOf, SOURCE_CHARS, sourcesFor, type Source } from "./auto-answer.ts";
import type { Entry, Outcome } from "./queue/queue-entries-and-outcomes.ts";

const ON = { on: true, threshold: 0.9, model: "haiku" };
const ticket = { key: "A11-2", title: "t", description: "Do the thing.", url: "https://linear.app/x/A11-2", branch: "b", status: "s", statusOrder: 0, team: "A11", project: null, priority: 0 } as Entry["ticket"];
const run = (over: Partial<Entry> = {}): Entry => ({ ticket, repos: [], model: "sonnet", effort: "high", phase: "running", queuedAt: 0, workspace: "w1", ...over }) as Entry;
const asked = (escalation?: string): Outcome => ({ kind: "needs-human", reason: "Off the escalation list: which repository?", ...(escalation === undefined ? {} : { escalation }) });

test("A11-438: the answerer takes only a question on a live run, off the list or under reserved or contradicts, with the key on, and never the same question twice", () => {
  assert.equal(mayAnswer(ON, run(), asked()), true, "off the list");
  assert.equal(mayAnswer(ON, run(), asked("reserved")), true);
  assert.equal(mayAnswer(ON, run(), asked("contradicts")), true);
  for (const item of ["outward", "access", "discard", "frozen", "legal"]) assert.equal(mayAnswer(ON, run(), asked(item)), false, item);
  assert.equal(mayAnswer({ ...ON, on: false }, run(), asked()), false, "the key off");
  assert.equal(mayAnswer(undefined, run(), asked()), false, "no key: off");
  assert.equal(mayAnswer(ON, run({ workspace: undefined }), asked()), false, "no agent to send the answer to");
  assert.equal(mayAnswer(ON, run({ talk: true }), asked()), false, "a talk session's person is in its terminal");
  assert.equal(mayAnswer(ON, run({ batch: "B1" }), asked()), false, "a batch's run");
  assert.equal(mayAnswer(ON, run(), { kind: "needs-human", reason: "bad file", unreadable: true }), false, "an outcome the board could not read");
  assert.equal(mayAnswer(ON, run(), { kind: "checked", reason: "nothing to do" }), false);
  const answered = run({ autoAnswer: { question: "Off the escalation list: which repository?", answer: "agent-org", confidence: 0.95, sources: [], at: 1 } });
  assert.equal(mayAnswer(ON, answered, asked()), false, "the same question again wants a person");
});

test("A11-438: the sources are the ticket, its parent, both tickets' files, the run's repositories' docs and the other tickets' Decisions, in that order, empty ones left out", () => {
  const dir = tmpDir("auto-answer-");
  const ticketDir = join(dir, "ticket");
  mkdirSync(join(ticketDir, "parent"), { recursive: true });
  writeFileSync(join(ticketDir, "attachment-1-plan.md"), "The plan: step 1.");
  writeFileSync(join(ticketDir, "brief.md"), "the brief is the board's own words, not a source");
  writeFileSync(join(ticketDir, "parent", "attachment-1-epic.md"), "The epic's plan.");
  const folder = join(dir, "folder");
  mkdirSync(join(folder, "agent-org"), { recursive: true });
  writeFileSync(join(folder, "agent-org", "AGENTS.md"), "Run pnpm install.");
  const other = run({ ticket: { ...ticket, key: "A11-3", url: "https://linear.app/x/A11-3", description: "x\n\n## Decisions (the chairman, 2026-11-01)\n\n* **Question:** q\n* **Answer:** a\n" } });
  const empty = run({ ticket: { ...ticket, key: "A11-4", description: "" } });
  const sources = sourcesFor({ entry: run({ repos: ["agent-org"] }), parent: { key: "A11-1", description: "Lands in agent-org.", url: "https://linear.app/x/A11-1" }, ticketDir, folder, others: [run(), other, empty] });
  assert.deepEqual(sources.map(({ label }) => label), [
    "the ticket A11-2", "the parent ticket A11-1", "A11-2's file attachment-1-plan.md", "A11-1's file attachment-1-epic.md", "agent-org's AGENTS.md", "the Decisions of A11-3",
  ]);
  assert.equal(sources[1].url, "https://linear.app/x/A11-1");
  assert.ok(sources.at(-1)?.text.includes("* **Answer:** a"));
});

test("A11-438: a long source is cut, and says so", () => {
  const [only] = sourcesFor({ entry: run({ ticket: { ...ticket, description: "x".repeat(SOURCE_CHARS + 10) } }), parent: null, ticketDir: "/nowhere", folder: "/nowhere", others: [] });
  assert.ok(only.text.endsWith(`[... cut at ${SOURCE_CHARS} characters]`));
});

const SOURCES: readonly Source[] = [{ label: "the ticket A11-2", url: "https://linear.app/x/A11-2", text: "t" }, { label: "agent-org's AGENTS.md", text: "d" }];

test("A11-438: the prompt holds the question and every source under its label, and asks for one JSON object", () => {
  const prompt = answerPrompt("Which repository?", SOURCES);
  assert.ok(prompt.includes("<question>\nWhich repository?\n</question>"));
  assert.ok(prompt.includes(`<source label="the ticket A11-2">\nt\n</source>`) && prompt.includes(`<source label="agent-org's AGENTS.md">`));
  assert.match(prompt, /ONE JSON object/);
});

test("A11-438: a reply is read from a JSON object, with a fence or words around it; anything else is no reply", () => {
  assert.deepEqual(replyOf("```json\n{\"answer\": \" agent-org \", \"confidence\": 0.95, \"sources\": [\"the ticket A11-2\"]}\n```"), { answer: "agent-org", confidence: 0.95, sources: ["the ticket A11-2"] });
  for (const bad of ["agent-org", "{\"answer\": \"\", \"confidence\": 1, \"sources\": []}", "{\"answer\": \"a\", \"confidence\": 1.5, \"sources\": []}", "{\"answer\": \"a\", \"confidence\": 1, \"sources\": \"x\"}", "{nope}"]) {
    assert.equal(replyOf(bad), null, bad);
  }
});

test("A11-438: an answer at the threshold that cites a given source is answered, with that source's address; under it, or citing none, it is parked and says why", () => {
  const reply = (confidence: number, sources: readonly string[]) => JSON.stringify({ answer: "agent-org", confidence, sources });
  assert.deepEqual(decide(reply(0.9, ["the ticket A11-2", "made up"]), SOURCES, 0.9), { answered: { answer: "agent-org", confidence: 0.9, sources: [{ label: "the ticket A11-2", url: "https://linear.app/x/A11-2" }] } });
  assert.deepEqual(decide(reply(0.95, ["agent-org's AGENTS.md"]), SOURCES, 0.9), { answered: { answer: "agent-org", confidence: 0.95, sources: [{ label: "agent-org's AGENTS.md" }] } });
  assert.deepEqual(decide(reply(0.89, ["the ticket A11-2"]), SOURCES, 0.9), { parked: "the answerer was 89% sure, under the 90% it needs" });
  assert.deepEqual(decide(reply(0.99, ["made up"]), SOURCES, 0.9), { parked: "the answerer cited none of the sources it was given" });
  assert.deepEqual(decide("no idea", SOURCES, 0.9), { parked: "the answerer's reply could not be read" });
});

test("A11-438: the result of a headless claude run is its result text; other output is taken as it is", () => {
  assert.equal(resultOf("{\"type\":\"result\",\"result\":\"{\\\"answer\\\":1}\"}"), "{\"answer\":1}");
  assert.equal(resultOf("plain words"), "plain words");
});

test("A11-438: the run's message says the answer is automatic, quotes the question and the answer, lists the sources, and says it is not a person's decision", () => {
  const message = messageOf("Which repository?", { answer: "agent-org", confidence: 0.95, sources: [{ label: "the parent ticket A11-1", url: "https://linear.app/x/A11-1" }, { label: "agent-org's AGENTS.md" }] });
  assert.match(message, /answered your question automatically.*95% sure/);
  assert.ok(message.includes("> Which repository?") && message.includes("> agent-org"));
  assert.ok(message.includes("- the parent ticket A11-1 (https://linear.app/x/A11-1)\n- agent-org's AGENTS.md"));
  assert.match(message, /It is not a person's decision: list it under "Decisions made without a person"/);
});
