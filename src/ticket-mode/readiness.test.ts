import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { ExecResult } from "../plugins/manifest.ts";
import { createReadiness, LOW_READINESS, type ReadinessAnswer, READINESS_BOUNDS, readinessPath, readinessPrompt, readinessRoute, scoreOf } from "./readiness.ts";
import { headlessArgs } from "./headless-claude.ts";
import type { Ticket } from "./source.ts";

const NOW = Date.UTC(2026, 10, 14, 6);

/** A ticket as the page lists it, with `description`. */
const ticketOf = (key: string, description: string): Ticket => ({ key, title: `Title of ${key}`, description, url: "", branch: "", status: "Backlog", statusOrder: 1, team: "A11", project: null, priority: 0, parent: null });

/** A vague ticket: no acceptance criteria and no repository named. */
const VAGUE = ticketOf("A11-1", "Make the board nicer.");

/** The headless run's JSON result answering `reply`. */
const answered = (reply: unknown): ExecResult => ({ status: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(reply) }), stderr: "" });

const LOW = { score: 20, reasons: ["No acceptance criteria.", "No repository is named."] };

/** A scorer over a fresh state directory (or `dir`), asking a model that answers `reply` to every prompt, and what it was asked and said. */
function scorer({ reply = (): ExecResult => answered(LOW), dir = tmpDir("readiness-") }: { reply?: (prompt: string) => ExecResult | Promise<ExecResult>; dir?: string } = {}) {
  const prompts: string[] = [];
  const said: string[] = [];
  const readiness = createReadiness({ stateDir: dir, now: () => NOW, log: (line) => { said.push(line); }, ask: async (prompt) => { prompts.push(prompt); return reply(prompt); } });
  return { readiness, prompts, said, dir };
}

/** `POST /api/readiness` for `keys` over `readiness`, with the page's copies `tickets`. */
function post(readiness: ReturnType<typeof scorer>["readiness"], tickets: readonly Ticket[], keys = tickets.map(({ key }) => key), on = true): [number, ReadinessAnswer] {
  const answer = readinessRoute({ on, readiness, known: new Map(tickets.map((ticket) => [ticket.key, ticket])) }, "POST", "/api/readiness", { keys });
  assert.ok(answer !== undefined, "the route answers POST /api/readiness");
  return answer;
}

test("A11-443: a ticket with no acceptance criteria and no repository is scored low by the model, with its reasons, and is pending until then", async () => {
  const { readiness, prompts } = scorer();
  assert.deepEqual(post(readiness, [VAGUE]), [200, { on: true, scores: { "A11-1": { state: "pending" } } }], "the page is answered at once, without waiting for the model");
  await readiness.idle();
  assert.deepEqual(post(readiness, [VAGUE]), [200, { on: true, scores: { "A11-1": { state: "scored", score: 20, reasons: ["No acceptance criteria.", "No repository is named."], low: true } } }]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Acceptance criteria/);
  assert.match(prompts[0]!, /Repository/);
  assert.match(prompts[0]!, /Make the board nicer\./);
});

test("A11-443: a ticket whose description has not changed since it was scored is answered from the kept score, and the model is not asked again, even by a board started again", async () => {
  const first = scorer();
  post(first.readiness, [VAGUE]);
  await first.readiness.idle();
  post(first.readiness, [VAGUE]);
  post(first.readiness, [VAGUE]);
  assert.equal(first.prompts.length, 1, "opened again: no model call");
  const restarted = scorer({ dir: first.dir });
  assert.equal((post(restarted.readiness, [VAGUE])[1].scores["A11-1"] as { score?: number }).score, 20);
  assert.equal(restarted.prompts.length, 0, "the score is kept in the state directory, by the description's hash");
  assert.equal(JSON.parse(readFileSync(readinessPath(first.dir), "utf8")).scores["A11-1"].score, 20);
});

test("A11-443: a changed description is scored again, once", async () => {
  const { readiness, prompts } = scorer();
  post(readiness, [VAGUE]);
  await readiness.idle();
  const changed = ticketOf("A11-1", "Make the board nicer.\n\n## Acceptance criteria\n\nGiven a ticket, when the page opens, then it shows. **Repository:** agent-org");
  assert.deepEqual(post(readiness, [changed])[1].scores["A11-1"], { state: "pending" });
  post(readiness, [changed]);
  await readiness.idle();
  assert.equal(prompts.length, 2);
});

test("A11-443: a ticket asked for again while its score is being made starts no second call, and no more than two calls run at once", async () => {
  let running = 0;
  let most = 0;
  const { readiness, prompts } = scorer({ reply: async () => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((done) => setTimeout(done, 5));
    running -= 1;
    return answered(LOW);
  } });
  const tickets = ["A11-1", "A11-2", "A11-3", "A11-4"].map((key) => ticketOf(key, `Ticket ${key}`));
  post(readiness, tickets);
  post(readiness, tickets);
  await readiness.idle();
  assert.equal(prompts.length, 4);
  assert.equal(most, 2);
});

test("A11-443: an answer for an older description that ends after the newer one's is dropped, so the newer score stands and is not asked for again", async () => {
  const slow = new Map<string, (answer: ExecResult) => void>();
  const { readiness, prompts } = scorer({ reply: (prompt) => new Promise((done) => { slow.set(prompt.includes("first") ? "old" : "new", done); }) });
  post(readiness, [ticketOf("A11-1", "The first text.")]);
  post(readiness, [ticketOf("A11-1", "The second text.")]);
  await new Promise((done) => setTimeout(done, 1));
  slow.get("new")!(answered({ score: 80, reasons: [] }));
  await new Promise((done) => setTimeout(done, 1));
  slow.get("old")!(answered(LOW));
  await readiness.idle();
  assert.deepEqual(post(readiness, [ticketOf("A11-1", "The second text.")])[1].scores["A11-1"], { state: "scored", score: 80, reasons: [], low: false });
  assert.equal(prompts.length, 2);
});

test("A11-443: a score under LOW_READINESS is low", async () => {
  const { readiness } = scorer({ reply: () => answered({ score: LOW_READINESS - 1, reasons: [] }) });
  post(readiness, [VAGUE]);
  await readiness.idle();
  assert.equal((post(readiness, [VAGUE])[1].scores["A11-1"] as { low?: boolean }).low, true);
});

test("A11-443: a call that fails is kept as failed and said, and is not tried again until the description changes", async () => {
  const { readiness, prompts, said } = scorer({ reply: () => ({ status: 1, stdout: "", stderr: "claude: the allowance is spent" }) });
  post(readiness, [VAGUE]);
  await readiness.idle();
  const [, answer] = post(readiness, [VAGUE]);
  assert.equal(answer.scores["A11-1"]?.state, "failed");
  assert.equal(prompts.length, 1);
  assert.deepEqual(said, ["the readiness of A11-1 could not be scored: the model's answer could not be read (exit 1): claude: the allowance is spent"]);
});

test("A11-443: a ticket with no description is scored 0 without asking the model", () => {
  const { readiness, prompts } = scorer();
  assert.deepEqual(post(readiness, [ticketOf("A11-1", "  \n")])[1].scores["A11-1"], { state: "scored", score: 0, reasons: ["The ticket has no description."], low: true });
  assert.equal(prompts.length, 0);
});

test("A11-443: while tickets.readiness is off the route answers off and asks the model nothing", async () => {
  const { readiness, prompts } = scorer();
  assert.deepEqual(post(readiness, [VAGUE], ["A11-1"], false), [200, { on: false, scores: {} }]);
  await readiness.idle();
  assert.equal(prompts.length, 0);
});

test("A11-443: a ticket the page has no copy of is left out, keys that are not a list are refused, and another route is not this one's", () => {
  const { readiness } = scorer();
  assert.deepEqual(post(readiness, [], ["A11-9"]), [200, { on: true, scores: {} }]);
  assert.throws(() => readinessRoute({ on: true, readiness, known: new Map() }, "POST", "/api/readiness", { keys: "A11-1" }), /keys must be a list/);
  assert.equal(readinessRoute({ on: true, readiness, known: new Map() }, "GET", "/api/readiness", {}), undefined);
});

test("A11-443: a score is a whole number from 0 to 100 with at most three one-line reasons, and a reply without one is none", () => {
  assert.deepEqual(scoreOf('```json\n{"score": 140.6, "reasons": ["a\\n b", 3, "c", "d", "e"]}\n```'), { score: 100, reasons: ["a b", "c", "d"] });
  assert.deepEqual(scoreOf('{"score": -4}'), { score: 0, reasons: [] });
  assert.equal(scoreOf('{"reasons": []}'), null);
  assert.equal(scoreOf("I cannot tell."), null);
});

test("A11-443: the score is asked of the cheap model, headless, with no tool and a spend bound", () => {
  assert.deepEqual(headlessArgs(READINESS_BOUNDS), ["-p", "--output-format", "json", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none", "--max-turns", "2", "--max-budget-usd", "0.1"]);
  assert.match(readinessPrompt(VAGUE), /^Ticket A11-1: Title of A11-1$/m);
});
