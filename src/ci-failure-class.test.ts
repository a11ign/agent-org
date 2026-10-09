// #4632: a red check's failure class and route. A fake `fetch`, a fake `readKey`, a fake diagnostic and a state fixture only: no network, no real key, no corpus.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CI_FAILURE_CLASSES, MAX_ERROR_LINES, classLine, classifyCiFailure, fallbackClass, routeFor, trimErrorLines,
  type CiFailure, type CiFailureClass,
} from "./ci-failure-class.ts";
import { MAX_STATE_BYTES, type DecisionDeps } from "./decision-provider.ts";
import { parseHostConfig } from "./host-config.ts";
import { freshState } from "./triage-provider.ts";

const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const withTriage = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: "/fake/key", minConfidence: 0.9 };

const failure = (over: Partial<CiFailure> = {}): CiFailure => ({
  errorLines: ["AssertionError [ERR_ASSERTION]: expected 3, got 4", "    at src/thing.test.ts:12"],
  redOnMain: false, redOnOtherPrs: false, readsOutsideRepository: false, rateLimitOrRunnerLost: false, rerunAlready: false,
  ...over,
});

type Reply = { status?: number; body?: unknown; throws?: boolean };
function fakeFetch(r: Reply) {
  const calls: { body: any }[] = [];
  const fn = (async (_url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    if (r.throws) throw new Error("connection refused");
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const answer = (choice: string, confidence = 0.95) => ({ answers: { class: { type: "choice", choice, probabilities: {}, confidence } } });

function rig(opts: { triage?: unknown; on?: boolean; reply?: Reply; readKey?: (path: string) => string } = {}) {
  const net = fakeFetch(opts.reply ?? { body: answer("flaky") });
  const lines: string[] = [];
  const deps: DecisionDeps = {
    host: withTriage("triage" in opts ? opts.triage : JEV), fetch: net.fn, state: freshState(), timeoutMs: 50, diagnostic: (line) => lines.push(line),
    readKey: opts.readKey ?? (() => "FAKE-KEY"), switches: { "ci-failure-class": opts.on ?? true },
  };
  return { deps, net, lines };
}

test("the rule with no provider: red on main is another repository, a rate limit is infrastructure, everything else is the PR's own", () => {
  assert.equal(fallbackClass(failure()), "own-defect");
  assert.equal(fallbackClass(failure({ redOnMain: true })), "another-repository-changed");
  assert.equal(fallbackClass(failure({ rateLimitOrRunnerLost: true })), "infrastructure");
  // negative controls: a fact that is NOT the rule's trigger changes nothing
  assert.equal(fallbackClass(failure({ redOnOtherPrs: true, readsOutsideRepository: true, rerunAlready: true })), "own-defect");
  // a runner lost on main too is still not a repository that changed
  assert.equal(fallbackClass(failure({ redOnMain: true, rateLimitOrRunnerLost: true })), "infrastructure");
});

test("each class has its own route, and a flaky failure is rerun once and never a second time", () => {
  assert.deepEqual(CI_FAILURE_CLASSES.map((c) => routeFor(c, false)), ["owner", "rerun-once", "cross-repo-incident", "rerun-after-reset"]);
  assert.equal(routeFor("flaky", true), "owner");
  // the already-rerun fact moves only the flaky class
  for (const c of CI_FAILURE_CLASSES.filter((k) => k !== "flaky")) assert.equal(routeFor(c, true), routeFor(c, false));
});

test("provider absent: no triage block, or provider none, asks nobody and takes the rule", async () => {
  for (const triage of [undefined, { provider: "none" }]) {
    const { deps, net, lines } = rig({ triage });
    const out = await classifyCiFailure(failure({ redOnMain: true }), deps);
    assert.deepEqual([out.klass, out.route, out.via, out.fellBack], ["another-repository-changed", "cross-repo-incident", "none", true]);
    assert.equal(net.calls.length, 0);
    assert.deepEqual(lines, []);
  }
});

test("key missing: the rule, no request, and one diagnostic that does not name the path", async () => {
  const { deps, net, lines } = rig({ readKey: () => { throw new Error("ENOENT /fake/key"); } });
  const out = await classifyCiFailure(failure({ rateLimitOrRunnerLost: true }), deps);
  assert.deepEqual([out.klass, out.via], ["infrastructure", "none"]);
  assert.equal(net.calls.length, 0);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\/fake\/key/);
});

test("use switched off: the rule, no request; the same inputs switched on ask the provider (the positive control)", async () => {
  const off = rig({ on: false });
  const offOut = await classifyCiFailure(failure(), off.deps);
  assert.deepEqual([offOut.klass, offOut.via, offOut.reason], ["own-defect", "none", "the use is switched off"]);
  assert.equal(off.net.calls.length, 0);
  const on = rig({ on: true });
  await classifyCiFailure(failure(), on.deps);
  assert.equal(on.net.calls.length, 1);
});

test("provider on: its class and route win, for each of the four classes", async () => {
  for (const klass of CI_FAILURE_CLASSES) {
    const { deps, net } = rig({ reply: { body: answer(klass) } });
    const out = await classifyCiFailure(failure(), deps);
    assert.deepEqual([out.klass, out.route, out.via, out.fellBack, out.confidence], [klass, routeFor(klass, false), "jev", false, 0.95]);
    assert.equal(net.calls.length, 1);
  }
});

test("provider on: the request carries the trimmed state and the four criteria, and never an agent-written body", async () => {
  const { deps, net } = rig();
  await classifyCiFailure(failure({ redOnOtherPrs: true }), deps);
  const sent = net.calls[0].body;
  assert.deepEqual(Object.keys(sent.state).sort(), ["errorLines", "readsOutsideRepository", "rateLimitOrRunnerLost", "redOnMain", "redOnOtherPrs"].sort());
  assert.equal(sent.state.redOnOtherPrs, true);
  assert.deepEqual(Object.keys(sent.questions.class.criteria), [...CI_FAILURE_CLASSES]);
});

test("a flaky answer on a run already rerun routes to the owner and keeps the class", async () => {
  const { deps } = rig({ reply: { body: answer("flaky") } });
  const out = await classifyCiFailure(failure({ rerunAlready: true }), deps);
  assert.deepEqual([out.klass, out.route], ["flaky", "owner"]);
});

test("every way the provider can fail takes the rule: a refusal, a timeout, a thrown fetch, a malformed answer, a class that is none, a confidence under the floor", async () => {
  const cases: Record<string, Reply> = {
    refusal: { status: 403, body: {} },
    thrown: { throws: true },
    malformed: { body: { answers: { class: "flaky" } } },
    "not a class": { body: answer("a-fifth-class") },
    "under the floor": { body: answer("flaky", 0.89) },
  };
  for (const [name, reply] of Object.entries(cases)) {
    const { deps } = rig({ reply });
    const out = await classifyCiFailure(failure({ redOnMain: true }), deps);
    assert.deepEqual([out.klass, out.fellBack], ["another-repository-changed", true], name);
  }
  // the floor is the boundary: 0.9 is taken, 0.89 above is not
  const atFloor = await classifyCiFailure(failure({ redOnMain: true }), rig({ reply: { body: answer("flaky", 0.9) } }).deps);
  assert.deepEqual([atFloor.klass, atFloor.fellBack], ["flaky", false]);
});

test("trimming: at most 40 non-blank lines, colour codes stripped, each line cut, and the state fits the seam's limit", () => {
  const long = Array.from({ length: 100 }, (_, i) => `\u001b[31mline ${i}\u001b[0m ${"x".repeat(500)}`);
  const kept = trimErrorLines(["", "   ", ...long]);
  assert.ok(kept.length > 0 && kept.length <= MAX_ERROR_LINES);
  assert.ok(kept.every((l) => l.length <= 160 && !l.includes("\u001b")));
  assert.ok(kept[0].startsWith("line 0"));
  assert.ok(Buffer.byteLength(JSON.stringify({ errorLines: kept })) < MAX_STATE_BYTES);
  // the line cap binds on its own when the lines are short enough for the byte budget not to
  assert.equal(trimErrorLines(Array.from({ length: 100 }, (_, i) => `e${i}`)).length, MAX_ERROR_LINES);
  // negative control: a short, clean input is kept whole and in order
  assert.deepEqual(trimErrorLines(["a", "b"]), ["a", "b"]);
});

test("a huge error is trimmed to fit, so the provider is still asked rather than falling back on size", async () => {
  const { deps, net } = rig();
  const out = await classifyCiFailure(failure({ errorLines: Array.from({ length: 500 }, () => "y".repeat(400)) }), deps);
  assert.equal(net.calls.length, 1);
  assert.equal(out.via, "jev");
});

test("the line the order and the log carry names the class, the route and who chose", async () => {
  const rule = await classifyCiFailure(failure({ rateLimitOrRunnerLost: true }), rig({ on: false }).deps);
  assert.match(classLine(rule), /^CI failure class: infrastructure -> rerun-after-reset \(rule: the use is switched off\)$/);
  const jev = await classifyCiFailure(failure(), rig({ reply: { body: answer("flaky") } }).deps);
  assert.equal(classLine(jev), "CI failure class: flaky -> rerun-once (provider)");
});

test("the four classes are the four the row names", () => {
  const names: CiFailureClass[] = ["own-defect", "flaky", "another-repository-changed", "infrastructure"];
  assert.deepEqual([...CI_FAILURE_CLASSES], names);
});
