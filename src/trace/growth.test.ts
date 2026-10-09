// a11ign/a11ign#4073: `trace/growth.mjs`. Fixtures only: nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub (the one directory tree read is built under the temporary directory).
// no-token: gh -- every transcript below is a fixture; `requestsOf` and `summarise` are pure and call no `gh`
//
// THE FIXTURE `WORKER` is one seat's main thread, and the hand-computed figures are in the comments beside the assertion that uses them. Its cache reads are 0, 100, 150, 400, 410:
//   m0 cr 0    calls Read            the first request: no growth (`first`)
//   m1 cr 100  calls Bash            growth 100-0 = 100, written by m0, whose cause is the system prompt: `(start of window)`
//   m2 cr 150  calls Grep            growth 150-100 = 50, written by m1, caused by the tool m0 called: Read
//   m3 cr 400  calls Bash + Read     growth 400-150 = 250, written by m2, caused by the tool m1 called: Bash
//   m4 cr 410  calls nothing         growth 410-400 = 10, written by m3, caused by m2's tool: Grep
// A reading that blamed the tool called by the request BEFORE the one measured would call m3's 250 `Grep`; the assertions on it are the negative control of the attribution.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFINITIONS, MIXED, NOT_DERIVABLE, PROMPT, Request, SEVERAL_COMMANDS, START_OF_WINDOW, UNPARSED, commandName, commandOf, messagesOf, parseArgs, readGrowth, renderGrowth, requestsOf, sessionOfTranscript, summarise } from "./growth.ts";

const T0 = Date.parse("2026-10-05T00:00:00Z");
const stamp = (n: number) => new Date(T0 + n * 1000).toISOString();
const lines = (records: any[]) => `${records.map((record: any) => JSON.stringify(record)).join("\n")}\n`;

const order = (n: number, session = "worker-9") => ({ type: "user", timestamp: stamp(n), message: { role: "user", content: `<pasted_content id="a">You are \`${session}\`. Row #9.</pasted_content id="a">` } });
const prompt = (n: number) => ({ type: "user", timestamp: stamp(n), message: { role: "user", content: "carry on" } });
const results = (n: number, sidechain = false) => ({ type: "user", timestamp: stamp(n), isSidechain: sidechain, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const compaction = (n: number) => ({ type: "user", timestamp: stamp(n), isCompactSummary: true, message: { role: "user", content: "summary of the work so far" } });
const cleared = (n: number) => ({ type: "user", timestamp: stamp(n), isMeta: true, message: { role: "user", content: "<command-name>/clear</command-name>" } });
const boundary = (n: number) => ({ type: "system", subtype: "compact_boundary", timestamp: stamp(n) });
/** One API message; `blocks` > 1 writes it once per content block, as the harness does. `usage.cache_read_input_tokens` is what the fixture is about. */
const message = (n: number, { id, read, tools = [], commands = [], output = 5, sidechain = false, blocks = 1 }: { id: string; read: number; tools: string[]; blocks?: number; }) => Array.from({ length: blocks }, (_, block) => ({
  type: "assistant", timestamp: stamp(n + block / 10), isSidechain: sidechain,
  message: {
    id, model: "claude-sonnet-5-5", role: "assistant",
    content: [...tools.map((name, i) => ({ type: "tool_use", id: `u-${id}-${name}-${i}`, name, input: name === "Bash" && commands[i] !== undefined ? { command: commands[i] } : {} })), ...(tools.length === 0 ? [{ type: "text", text: "done" }] : [])],
    usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: 1000 },
  },
}));
/** A message and the result of its tool calls, which is what separates two requests in an ordinary run. */
const step = (n: number, spec: { id?: any; read?: any; tools?: any; sidechain?: any; commands?: any; output?: any; blocks?: any; }) => [...message(n, spec), ...(spec.tools?.length ? [results(n + 0.5, spec.sidechain)] : [])];

const WORKER = lines([
  order(0),
  ...step(1, { id: "m0", read: 0, tools: ["Read"] }),
  ...step(2, { id: "m1", read: 100, tools: ["Bash"] }),
  ...step(3, { id: "m2", read: 150, tools: ["Grep"] }),
  ...step(4, { id: "m3", read: 400, tools: ["Bash", "Read"] }),
  ...step(5, { id: "m4", read: 410 }),
]);
const byId = (requests: Request[]) => Object.fromEntries(requests.map((request: { id: any; }) => [request.id, request]));

test("a request's growth is the difference of consecutive cache reads, attributed to the tool before the request that wrote it", () => {
  const m = byId(requestsOf(WORKER, "worker-9"));
  assert.deepEqual([m.m1.growth, m.m2.growth, m.m3.growth, m.m4.growth], [100, 50, 250, 10]); // 100-0, 150-100, 400-150, 410-400, by hand
  assert.deepEqual([m.m1.tool, m.m2.tool, m.m3.tool, m.m4.tool], [START_OF_WINDOW, "Read", "Bash", "Grep"]);
  // NEGATIVE CONTROL: m3's 250 was written by m2 and caused by what m1 called. The tool called by m2 (Grep) is the one a literal reading would blame, and it is not the answer.
  assert.notEqual(m.m3.tool, "Grep");
  assert.notEqual(m.m2.tool, "Bash"); // nor does m1's own tool take m2's growth
});

test("a message written once per content block is one request, and its last block's usage is the one read", () => {
  const split = lines([order(0), ...message(1, { id: "a", read: 0, tools: ["Read"], blocks: 3 }), results(2), ...step(3, { id: "b", read: 70 })]);
  const requests = requestsOf(split, "worker-9");
  assert.equal(requests.length, 2); // three records, one id: a reader that summed records would double count
  assert.equal(requests[1].growth, 70);
  assert.equal(messagesOf([]).length, 0); // and an empty transcript has none, rather than throwing
});

test("parallel calls of two different tools are `mixed` with the names kept, and the same tool twice is that tool", () => {
  const m = byId(requestsOf(WORKER, "worker-9"));
  // x0 calls two different tools, x1 one, x2 the same tool twice:
  const longer = lines([order(0), ...step(1, { id: "x0", read: 0, tools: ["Read", "Bash"] }), ...step(2, { id: "x1", read: 10, tools: ["Bash"] }), ...step(3, { id: "x2", read: 20, tools: ["Bash", "Bash"] }), ...step(4, { id: "x3", read: 60 }), ...step(5, { id: "x4", read: 70 })]);
  const x = byId(requestsOf(longer, "worker-9"));
  assert.equal(x.x2.tool, MIXED); // x2's growth was written by x1 after x0's Read+Bash
  assert.deepEqual(x.x2.calls, ["Bash", "Read"]);
  assert.equal(x.x3.tool, "Bash"); // x1 called one tool
  assert.equal(x.x4.tool, "Bash"); // x2 called Bash twice: one distinct tool, not mixed
  assert.equal(m.m4.tool, "Grep"); // a one-tool request keeps its name (negative control: not mixed)
});

test("an order or a prompt between two requests is the cause, not the tool before it", () => {
  const interrupted = lines([order(0), ...step(1, { id: "p0", read: 0, tools: ["Read"] }), prompt(2), ...message(3, { id: "p1", read: 100, tools: ["Bash"] }), results(3.5), ...step(4, { id: "p2", read: 130 }), ...step(5, { id: "p3", read: 140 })]);
  const p = byId(requestsOf(interrupted, "worker-9"));
  assert.equal(p.p1.tool, START_OF_WINDOW);
  assert.equal(p.p2.tool, PROMPT); // p1 was written after a prompt followed p0's tool result: Read is not to blame
  assert.equal(p.p3.tool, "Bash"); // and p2 was written after p1's own tool result
});

test("the first request of a session and the first after a compaction or a clear have no growth: not derivable, never 0", () => {
  for (const [name, marker, why] of [["summary", compaction(3), NOT_DERIVABLE.AFTER_COMPACTION], ["boundary", boundary(3), NOT_DERIVABLE.AFTER_COMPACTION], ["clear", cleared(3), NOT_DERIVABLE.AFTER_CLEAR]]) {
    const text = lines([order(0), ...step(1, { id: "a", read: 5000, tools: ["Read"] }), ...step(2, { id: "b", read: 5200, tools: ["Bash"] }), marker, ...step(4, { id: "c", read: 0, tools: ["Bash"] }), ...step(5, { id: "d", read: 900 })]);
    const r = byId(requestsOf(text, "worker-9"));
    assert.equal(r.a.growth, null, name);
    assert.equal(r.a.reason, NOT_DERIVABLE.FIRST, name);
    assert.equal(r.c.growth, null, name); // 0 - 5200 would be -5200, and a "0" here would read as a request that grew nothing
    assert.equal(r.c.reason, why, name);
    assert.equal(r.d.growth, 900, name); // the window after the break is differenced against ITS first request, not against the one before the break
    assert.equal(r.d.tool, START_OF_WINDOW, name);
  }
  // NEGATIVE CONTROL: a request that really grew nothing is 0, which is a reading, and is not confused with the above.
  const flat = byId(requestsOf(lines([order(0), ...step(1, { id: "a", read: 100, tools: ["Read"] }), ...step(2, { id: "b", read: 100, tools: ["Bash"] })]), "worker-9"));
  assert.equal(flat.b.growth, 0);
  assert.equal(flat.b.reason, null);
});

test("a fall in cache read is not growth, and the request after it holds a rewrite of the window, not a tool result", () => {
  const expired = lines([order(0), ...step(1, { id: "a", read: 900, tools: ["Read"] }), ...step(2, { id: "b", read: 1000, tools: ["Bash"] }), ...step(3, { id: "c", read: 0, tools: ["Bash"] }), ...step(4, { id: "d", read: 1200, tools: ["Read"] }), ...step(5, { id: "e", read: 1300 })]);
  const r = byId(requestsOf(expired, "worker-9"));
  assert.equal(r.b.growth, 100);
  assert.deepEqual([r.c.growth, r.c.reason], [null, NOT_DERIVABLE.SHRANK]);
  assert.deepEqual([r.d.growth, r.d.reason], [null, NOT_DERIVABLE.REWRITTEN]); // 1200 - 0 is the whole window written back, and would otherwise be blamed on `Bash`
  assert.equal(r.e.growth, 100); // the read after that is ordinary again
});

test("sidechain requests are their own thread: not between the parent's, and not counted into its growth", () => {
  const withSide = lines([
    order(0),
    ...step(1, { id: "m0", read: 0, tools: ["Agent"] }),
    ...step(1.2, { id: "s0", read: 0, tools: ["Read"], sidechain: true }),
    ...step(1.4, { id: "s1", read: 90_000, tools: ["Read"], sidechain: true }),
    ...step(2, { id: "m1", read: 100, tools: ["Bash"] }),
    ...step(2.2, { id: "s2", read: 95_000, sidechain: true }),
    ...step(3, { id: "m2", read: 150, tools: ["Bash"] }),
    ...step(4, { id: "m3", read: 170 }),
  ]);
  const requests = requestsOf(withSide, "worker-9");
  const r = byId(requests);
  assert.deepEqual([r.m1.growth, r.m2.growth, r.m3.growth], [100, 50, 20]); // as if the subagent had never run: 100-0, 150-100, 170-150
  assert.deepEqual([r.m1.tool, r.m2.tool, r.m3.tool], [START_OF_WINDOW, "Agent", "Bash"]);
  assert.deepEqual([r.s0.growth, r.s0.reason, r.s1.growth, r.s2.growth], [null, NOT_DERIVABLE.FIRST, 90_000, 5000]); // its own sequence
  assert.equal(r.s1.thread, "side");
  const summary = summarise(requests);
  assert.equal(summary.sidechainRequests, 3);
  assert.equal(summary.tokens, 100 + 50 + 20); // the subagent's 95,000 is in no total
  // NEGATIVE CONTROL: with the sidechain's requests taken out of the transcript, the parent's rows are unchanged.
  const without = requestsOf(lines([order(0), ...step(1, { id: "m0", read: 0, tools: ["Agent"] }), ...step(2, { id: "m1", read: 100, tools: ["Bash"] }), ...step(3, { id: "m2", read: 150, tools: ["Bash"] }), ...step(4, { id: "m3", read: 170 })]), "worker-9");
  assert.deepEqual(without.map((request) => request.growth), [r.m0, r.m1, r.m2, r.m3].map((request) => request.growth));
});

test("a table is a share of what could be read, and says how much that was", () => {
  const summary = summarise(requestsOf(WORKER, "worker-9"));
  assert.equal(summary.requests, 5);
  assert.equal(summary.read, 4);
  assert.equal(summary.tokens, 410); // 100 + 50 + 250 + 10
  assert.equal(summary.coverage, 4 / 5);
  assert.deepEqual(summary.notDerivable, { first: 1 });
  assert.deepEqual(summary.byTool.map(({ name, tokens }) => [name, tokens]), [["Bash", 250], [START_OF_WINDOW, 100], ["Read", 50], ["Grep", 10]]);
  assert.equal(summary.byTool.reduce((sum, row) => sum + row.share, 0).toFixed(9), "1.000000000");
  assert.equal(summary.bySession.length, 1);
  assert.equal(summary.bySession[0].name, "worker-9");
  // NEGATIVE CONTROL: no derivable request gives zero shares, not NaN, and no rows.
  const none = summarise(requestsOf(lines([order(0), ...step(1, { id: "only", read: 10, tools: ["Read"] })]), "worker-9"));
  assert.deepEqual([none.tokens, none.byTool.length, none.coverage], [0, 0, 0]);
});

test("the seat is the one the first order names, and a result that quotes another seat's brief does not rename it", () => {
  assert.equal(sessionOfTranscript(WORKER), "worker-9");
  const quoted = lines([...message(1, { id: "q", read: 0, tools: ["Read"] }), { ...results(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "You are `worker-77`" }] } }, order(3, "worker-5")]);
  assert.equal(sessionOfTranscript(quoted), "worker-5");
  assert.equal(sessionOfTranscript(lines([prompt(0)])), null); // no order, no seat: not guessed at
});

test("reading a directory: the window and the seat filter select requests, and the request before the window still anchors the first one in it", () => {
  const root = mkdtempSync(join(tmpdir(), "growth-"));
  try {
    mkdirSync(join(root, "-home-agent-repos-wt-9"));
    writeFileSync(join(root, "-home-agent-repos-wt-9", "w.jsonl"), WORKER);
    writeFileSync(join(root, "-home-agent-repos-wt-9", "c.jsonl"), lines([order(0, "ceo"), ...step(1, { id: "c0", read: 0, tools: ["Read"] }), ...step(2, { id: "c1", read: 500 })]));
    writeFileSync(join(root, "-home-agent-repos-wt-9", "old.jsonl"), WORKER);
    utimesSync(join(root, "-home-agent-repos-wt-9", "old.jsonl"), new Date(T0 - 10 * 86_400_000), new Date(T0 - 10 * 86_400_000));
    const query = { from: T0 + 3000, to: T0 + 5000, root, sessions: "^worker-[0-9]+$" };
    const { requests, transcripts } = readGrowth(query);
    assert.deepEqual(requests.map((request) => request.id), ["m2", "m3"]); // m4 is at +5s, the window's end, which is exclusive
    assert.equal(requests[0].growth, 50); // 150-100: m1, before the window, is what m2 is differenced against
    assert.equal(transcripts, 1); // w.jsonl; the ceo's is another seat, and old.jsonl was last written before the window
    assert.equal(readGrowth({ ...query, sessions: "^ceo$" }).transcripts, 1); // NEGATIVE CONTROL: the filter is the pattern's, not a fixed one
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the arguments name a window and refuse an empty or backwards one", () => {
  assert.deepEqual(parseArgs(["--from=2026-10-01T00:00:00Z", "--to=2026-10-02T00:00:00Z", "--root=/x"]),
    { from: Date.parse("2026-10-01T00:00:00Z"), to: Date.parse("2026-10-02T00:00:00Z"), root: "/x", sessions: "^worker-[0-9]+$" });
  assert.throws(() => parseArgs(["--to=2026-10-02T00:00:00Z"]), /--from and --to/);
  assert.throws(() => parseArgs(["--from=2026-10-02T00:00:00Z", "--to=2026-10-01T00:00:00Z"]), /from < to/);
});

test("the report names its window, its population and what it could not read", () => {
  const text = renderGrowth(summarise(requestsOf(WORKER, "worker-9")), { from: T0, to: T0 + 86_400_000, root: "/r", sessions: "^worker-[0-9]+$", transcripts: 1 });
  assert.match(text, /Window 2026-10-05T00:00:00\.000Z to 2026-10-06T00:00:00\.000Z/);
  assert.match(text, /5 main-thread requests; growth was derivable for 4 \(80\.0%\) and totals 410 tokens\. Not derivable: first 1\./);
  assert.match(text, /\| Bash \| 1 \| 250 \| 61\.0% \| 250 \|/);
  assert.ok(DEFINITIONS.some((definition) => definition.includes("never 0")));
});

test("a marker resets the window of the thread it is written in: a subagent's own compaction or clear is not derivable, and neither thread's is the other's", () => {
  const side = (marker: string|{ type: string; timestamp: string; isCompactSummary: boolean; message: { role: string; content: string; }; }|{ type: string; timestamp: string; isMeta: boolean; message: { role: string; content: string; }; }|{ type: string; subtype: string; timestamp: string; }) => ({ ...marker, isSidechain: true });
  const run = (marker: string|{ type: string; timestamp: string; isCompactSummary: boolean; message: { role: string; content: string; }; }|{ type: string; timestamp: string; isMeta: boolean; message: { role: string; content: string; }; }|{ type: string; subtype: string; timestamp: string; }) => byId(requestsOf(lines([
    order(0),
    ...step(1, { id: "m0", read: 0, tools: ["Agent"] }),
    ...step(1.2, { id: "s0", read: 100, tools: ["Read"], sidechain: true }),
    marker,
    ...step(1.6, { id: "s1", read: 110, tools: ["Read"], sidechain: true }),
    ...step(2, { id: "m1", read: 100, tools: ["Bash"] }),
    ...step(3, { id: "m2", read: 150 }),
  ]), "worker-9"));
  for (const [name, marker, why] of [["summary", compaction(1.4), NOT_DERIVABLE.AFTER_COMPACTION], ["boundary", boundary(1.4), NOT_DERIVABLE.AFTER_COMPACTION], ["clear", cleared(1.4), NOT_DERIVABLE.AFTER_CLEAR]]) {
    const own = run(side(marker));
    assert.deepEqual([own.s1.growth, own.s1.reason], [null, why], name); // 110 - 100 would be 10 tokens of growth from before the reset
    assert.deepEqual([own.m1.growth, own.m2.growth], [100, 50], name); // and the parent is unreset by it
    // NEGATIVE CONTROL: the same marker written in the parent's thread leaves the subagent's window alone and resets the parent's.
    const parents = run(marker);
    assert.deepEqual([parents.s1.growth, parents.s1.reason], [10, null], name);
    assert.deepEqual([parents.m1.growth, parents.m1.reason], [null, why], name);
  }
});

// THE BY-COMMAND FIXTURE `SHELL`: every request's writer is a Bash call with a command of its own, one per kind the row names. Cache reads rise by 10 each request, so each request's growth is 10 and
// the command that wrote it is the one called two requests before. Request k is therefore blamed on the command of request k-2 (see the attribution comment at the top of `growth.mjs`).
const COMMANDS = ["git status", "gh issue view 12 --json title", "gh pr list --state open", "grep -rn foo src | head -20", "cd /tmp/x && git log -3", "S=/tmp/y; sed -n '1,5p' f", "echo \"unclosed", "git status", "git diff", "ls", "ls"];
const SHELL = lines([
  order(0),
  ...COMMANDS.flatMap((command, i) => step(i + 1, { id: `b${i}`, read: i * 10, tools: ["Bash"], commands: [command] })),
  ...step(COMMANDS.length + 1, { id: "tail0", read: COMMANDS.length * 10 }),
  ...step(COMMANDS.length + 2, { id: "tail1", read: COMMANDS.length * 10 + 10 }),
]);

test("the first command of a Bash call names it: `gh` and `git` by their first subcommand, a chain by its first command, setup skipped, and what cannot be read is (unparsed)", () => {
  const named = Object.fromEntries(COMMANDS.map((command) => [command, commandName(command)]));
  assert.equal(named["git status"], "git status");
  assert.equal(named["gh issue view 12 --json title"], "gh issue");
  assert.equal(named["gh pr list --state open"], "gh pr");
  assert.equal(named["grep -rn foo src | head -20"], "grep"); // a pipe is its first command, not `head`
  assert.equal(commandName("ls && rm x"), "ls");
  assert.equal(named["cd /tmp/x && git log -3"], "git log"); // `cd` is setup: the row's unskipped reading put 48% of a week's Bash growth under `cd`
  assert.equal(named["S=/tmp/y; sed -n '1,5p' f"], "sed"); // and so is a bare assignment
  assert.equal(named["echo \"unclosed"], UNPARSED); // an open quote is unreadable, and is not `echo`
  assert.deepEqual([commandName("git -C /w log"), commandName("gh -R a/b pr view 3"), commandName("/usr/bin/git diff"), commandName("FOO=1 pnpm run lint"), commandName("(pnpm install 2>&1 | tail)")], ["git log", "gh pr", "git diff", "pnpm run", "pnpm install"]);
  assert.deepEqual([commandName("node -e 'x'"), commandName("node src/a.mjs"), commandName("cd /x"), commandName(""), commandName("$(foo)")], ["node -e", "node a.mjs", "cd", UNPARSED, UNPARSED]);
  // NEGATIVE CONTROL: the quotes hide an operator, so a `|` inside them does not end the command.
  assert.equal(commandName("grep -n 'a|b' f"), "grep");
  assert.equal(commandName("git commit -m \"a; b\""), "git commit");
});

test("parallel Bash calls of different commands are `(several commands)`, and the same command twice is that command", () => {
  const request = (commands: string[]) => ({ commands });
  assert.equal(commandOf(request(["git status", "gh pr list"])), SEVERAL_COMMANDS);
  assert.equal(commandOf(request(["git status", "git status -s"])), "git status");
  assert.equal(commandOf(request([])), UNPARSED);
});

test("--by-command splits the Bash row, and its rows SUM to the Bash line of the table over the same requests", () => {
  const requests = requestsOf(SHELL, "worker-9");
  const summary = summarise(requests);
  const bash = summary.byTool.find((row) => row.name === "Bash");
  const sum = (rows: any[], field: string) => rows.reduce((total: any, row: { [x: string]: any; }) => total + row[field], 0);
  assert.equal(sum(summary.byCommand, "tokens"), bash.tokens);
  assert.equal(sum(summary.byCommand, "requests"), bash.requests);
  assert.equal(summary.bashTokens, bash.tokens);
  // by hand: b0 is the first request and b1's writer was the system prompt, so b2..b10 and tail0, tail1 (11 requests of 10 tokens) are blamed on the commands of b0..b10, in order, and `ls` was called twice.
  const named = Object.fromEntries(summary.byCommand.map((row) => [row.name, row.requests]));
  assert.deepEqual(named, { "git status": 2, "gh issue": 1, "gh pr": 1, grep: 1, "git log": 1, sed: 1, [UNPARSED]: 1, "git diff": 1, ls: 2 });
  assert.equal(sum(summary.byCommand, "share").toFixed(9), "1.000000000"); // a share of the Bash growth, so the rows are all of it
  // NEGATIVE CONTROL: a by-command list that lost one row does not sum to the Bash line, and the printed sum check says so; the assertions above are a check and not an identity.
  const lossy = { ...summary, byCommand: summary.byCommand.slice(1) };
  assert.notEqual(sum(lossy.byCommand, "tokens"), bash.tokens);
  assert.match(renderGrowth(lossy, { from: T0, to: T0 + 86_400_000, root: "/r", sessions: "x", transcripts: 1, byCommand: true }), /NOT EQUAL/);
  assert.match(renderGrowth(summary, { from: T0, to: T0 + 86_400_000, root: "/r", sessions: "x", transcripts: 1, byCommand: true }), /: EQUAL\./);
});

test("without --by-command the printed table is the one it always was; with it, the same text plus the Bash section", () => {
  const summary = summarise(requestsOf(WORKER, "worker-9"));
  const reading = { from: T0, to: T0 + 86_400_000, root: "/r", sessions: "^worker-[0-9]+$", transcripts: 1 };
  const plain = renderGrowth(summary, reading);
  assert.doesNotMatch(plain, /Bash by command/);
  const split = renderGrowth(summary, { ...reading, byCommand: true });
  assert.match(split, /## Bash by command/);
  assert.equal(split.replace(/## Bash by command[\s\S]*?(?=## By session)/, ""), plain); // nothing else moves
});

test("the command refuses a flag it does not know and names --by-command as one it does", () => {
  const root = mkdtempSync(join(tmpdir(), "growth-cli-"));
  try {
    mkdirSync(join(root, "p"));
    writeFileSync(join(root, "p", "s.jsonl"), SHELL);
    const run = (...flags: (string|undefined)[]) => spawnSync(process.execPath, [new URL("./growth.ts", import.meta.url).pathname, `--from=${stamp(0)}`, `--to=${stamp(100)}`, `--root=${root}`, ...flags], { encoding: "utf8" });
    const split = run("--by-command");
    assert.equal(split.status, 0, split.stderr);
    assert.match(split.stdout, /\| git status \| 2 \|/);
    assert.match(split.stdout, /: EQUAL\./);
    const typo = run("--by-comand");
    assert.notEqual(typo.status, 0);
    assert.match(typo.stderr, /--by-comand/);
    assert.match(typo.stderr, /--by-command/); // and it is the suggestion, which is how a flag the guard knows reads
    assert.doesNotMatch(run().stdout, /Bash by command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
