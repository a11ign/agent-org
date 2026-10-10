// no-token: gh -- agent-org#484. The adapter is handed a stub for `gh` and the source tests read files; nothing here spends a point or needs a token.
/**
 * agent-org#484 (Phase 0 of a11ign/a11ign#4505, ADR 0046): THE TICKET PORT, ITS GITHUB ADAPTER, AND THE ONE CONSUMER THAT CALLS THROUGH IT.
 *
 * Three claims, each with a case that can fail:
 *   1. the adapter makes the `gh` calls the gate made before (a read, a comment, a label edit and a board Status), against a stub;
 *   2. `port.ts` imports no adapter and names no `gh` call, and the source test that says so SEES a fixture that does (its positive control);
 *   3. `readRowsOffBoard` reads the tracker only through the port, and its facts are the ones it always returned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { githubTicketAdapter, labelOfFlag, OPEN_ITEMS_QUERY } from "./github-adapter.ts";
import type { ItemRef, PortEvent } from "./port.ts";
import { PROJECT_NUMBER } from "../board-snapshot-scope.ts";
import { readRowsOffBoard } from "../work-gate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCOPE = "a11ign/agent-org";
const ROW: ItemRef = { tracker: "github", scope: SCOPE, id: 484 };
/** The board a node says it is an item of, by number: the gate's own `PROJECT_NUMBER`, never a copy of it. */
const BOARD = PROJECT_NUMBER;

// --- stubs ---------------------------------------------------------------------------------------------------------------------------

type Calls = string[][];

/** A `gh` stub that answers each call from `answers` by the first matching predicate, and records every argv. */
function stub(answers: { when: (args: string[]) => boolean; reply: string | Error }[]) {
  const calls: Calls = [];
  const run = (args: string[]) => {
    calls.push(args);
    const answer = answers.find((a) => a.when(args));
    if (answer === undefined) throw new Error(`the stub was asked something it has no answer for: ${args.slice(0, 3).join(" ")}`);
    if (answer.reply instanceof Error) throw answer.reply;
    return answer.reply;
  };
  return { run, calls };
}

const isItemRead = (args: string[]) => args[0] === "api" && args[1] === "graphql" && args.some((a) => a.startsWith("number="));

/** One issue as the item query returns it. `status` is the Status on the board named by `board`. */
function issue({ labels = ["ready"], status = "Ready", board = BOARD, state = "OPEN", timeline = [] as unknown[], body = "A row." } = {}) {
  return { data: { repository: { issue: {
    number: 484, title: "A ticket port exists", body, state, createdAt: "2026-10-09T10:00:00Z", author: { login: "a11ign-ai-leads" },
    labels: { nodes: labels.map((name) => ({ name })) },
    projectItems: { nodes: [{ project: { number: board }, fieldValueByName: status === null ? null : { name: status } }] },
    parent: { number: 4505, repository: { nameWithOwner: "a11ign/a11ign" } },
    subIssues: { nodes: [] },
    blockedBy: { nodes: [{ number: 4510, state: "CLOSED", repository: { nameWithOwner: "a11ign/a11ign" } }, { number: 9, state: "OPEN", repository: { nameWithOwner: SCOPE } }] },
    closedByPullRequestsReferences: { nodes: [{ number: 700, repository: { nameWithOwner: SCOPE } }] },
    timelineItems: { nodes: timeline },
  } } } };
}

// --- 1. the adapter: the calls the gate made before -----------------------------------------------------------------------------------

test("#484 adapter: readItem asks ONE graphql call for the issue and returns the port's own vocabulary", () => {
  const { run, calls } = stub([{ when: isItemRead, reply: JSON.stringify(issue({ labels: ["in-progress", "lane:any", "answer:ceo", "out-of-release", "needs-triage"], status: "In progress",
    body: "Not-before: 2026-10-20\nWaiting-for: closed #4510\n" })) }]);
  const item = githubTicketAdapter({ run, scope: SCOPE }).readItem(ROW)!;
  assert.equal(calls.length, 1, "one call");
  assert.deepEqual(calls[0].slice(0, 2), ["api", "graphql"]);
  assert.ok(calls[0].includes("owner=a11ign") && calls[0].includes("name=agent-org") && calls[0].includes("number=484"), `aimed at the row: ${calls[0].join(" ")}`);
  assert.equal(item.state, "in-progress");
  assert.deepEqual([...item.flags].sort(), ["answer-owed:ceo", "lane:any", "out-of-release"], "labels become flags; a label that is not one is not carried");
  assert.deepEqual(item.relations.blockedBy.map((r) => `${r.scope}#${r.id}`), [`${SCOPE}#9`], "a CLOSED blocker is not a blocker");
  assert.deepEqual(item.relations.parent, { tracker: "github", scope: "a11ign/a11ign", id: 4505 });
  assert.deepEqual(item.relations.linkedChanges, [{ host: "github", id: `${SCOPE}#700` }]);
  assert.equal(item.relations.notBefore, "2026-10-20");
  assert.ok(item.relations.waitingFor.some((w) => w.includes("4510")), `the wait is data: ${item.relations.waitingFor.join("|")}`);
  assert.equal(item.events[0].kind, "item-opened");
});

test("#484 adapter: a refused, errored or other-scope read is `null`, never an empty item", () => {
  const refuse = githubTicketAdapter({ scope: SCOPE, run: () => { throw new Error("HTTP 403"); } });
  assert.equal(refuse.readItem(ROW), null);
  const errored = githubTicketAdapter({ scope: SCOPE, run: () => JSON.stringify({ ...issue(), errors: [{ message: "boom" }] }) });
  assert.equal(errored.readItem(ROW), null, "errors beside data are refused (#555)");
  const wrongScope = stub([]);
  assert.equal(githubTicketAdapter({ run: wrongScope.run, scope: SCOPE }).readItem({ ...ROW, scope: "other/repo" }), null);
  assert.equal(wrongScope.calls.length, 0, "an item of another scope is not read through this adapter, and no call is made");
  // The control: the same adapter shape reads a healthy answer.
  const healthy = githubTicketAdapter({ scope: SCOPE, run: () => JSON.stringify(issue()) });
  assert.equal(healthy.readItem(ROW)?.state, "ready");
});

test("#484 adapter: postDecision is ONE `issue comment` whose body ends in the role and run, and returns the comment id", () => {
  const { run, calls } = stub([{ when: (a) => a[0] === "issue" && a[1] === "comment",
    reply: `https://github.com/${SCOPE}/issues/484#issuecomment-4417\n` }]);
  const id = githubTicketAdapter({ run, scope: SCOPE }).postDecision(ROW, { role: "ceo", runId: "run-7", kind: "ruling", text: "The interface is ruled.\n" });
  assert.equal(id, "4417");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ["issue", "comment", "484", "--repo", SCOPE]);
  assert.equal(calls[0][5], "--body");
  const lines = calls[0][6].split("\n");
  assert.equal(lines[0], "The interface is ruled.");
  assert.equal(lines.at(-1), "<!-- decided-by: ceo run: run-7 -->", "the LAST line is host/gh's own grammar, so the wrapper does not stamp it twice (agent-org#486)");
  assert.ok(lines.includes("<!-- decision-kind: ruling -->"));
});

test("#484 adapter: a header that cannot be written truthfully is refused before any call", () => {
  const { run, calls } = stub([]);
  const adapter = githubTicketAdapter({ run, scope: SCOPE });
  for (const bad of [{ role: "", runId: "r" }, { role: "ceo --> <!--", runId: "r" }, { role: "ceo", runId: "x".repeat(65) }]) {
    assert.throws(() => adapter.postDecision(ROW, { kind: "ruling", text: "t", ...bad }), /must be 1-64 characters/);
  }
  assert.equal(calls.length, 0, "nothing was sent");
});

test("#484 adapter: changeState is ONE label edit, then the board Status, and says it changed something", () => {
  const { run, calls } = stub([
    { when: isItemRead, reply: JSON.stringify(issue({ labels: ["ready", "lane:any"], status: "Ready" })) },
    { when: (a) => a[0] === "issue" && a[1] === "edit", reply: "" },
    { when: (a) => a[0] === "project" && a[1] === "item-edit", reply: "" },
  ]);
  const changed = githubTicketAdapter({ run, scope: SCOPE }).changeState(ROW, { state: "in-progress", addFlags: ["answer-owed:ceo"], removeFlags: ["lane:any"] });
  assert.equal(changed, true);
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(" ")), ["api graphql", "issue edit", "project item-edit"], "read, ONE edit, the Status last");
  assert.deepEqual(calls[1], ["issue", "edit", "484", "--repo", SCOPE, "--add-label", "in-progress,answer:ceo", "--remove-label", "ready,lane:any"],
    "the add and the remove are ONE edit; the old state label leaves with the new one's arrival");
  assert.deepEqual(calls[2].slice(-4), ["--field", "Status", "--value", "In progress"], "the same call `moveProjectStatus` makes");
  assert.ok(calls[2].includes(`https://github.com/${SCOPE}/issues/484`));
});

test("#484 adapter: changeState to the state the item is already in writes nothing and returns false", () => {
  const { run, calls } = stub([{ when: isItemRead, reply: JSON.stringify(issue({ labels: ["ready"], status: "Ready" })) }]);
  const adapter = githubTicketAdapter({ run, scope: SCOPE });
  assert.equal(adapter.changeState(ROW, { state: "ready" }), false);
  assert.equal(adapter.changeState(ROW, {}), false, "an empty change is not a change");
  assert.equal(calls.filter((c) => c[0] !== "api").length, 0, "no write was made");
  // The positive control for the emptiness above: the same stub, asked for a different state, DOES write (and fails here because it has no answer for it).
  assert.throws(() => adapter.changeState(ROW, { state: "parked" }), /no answer for/);
});

test("#484 adapter: a changeState whose read failed throws and writes nothing", () => {
  const { run, calls } = stub([{ when: isItemRead, reply: new Error("HTTP 502") }]);
  assert.throws(() => githubTicketAdapter({ run, scope: SCOPE }).changeState(ROW, { state: "ready" }), /could not read/);
  assert.equal(calls.length, 1);
});

test("#484 adapter: `chairman-priority` is a property of WHO added the label, decided in the adapter (ADR 0046 decision 2)", () => {
  const labeled = (login: string) => [{ __typename: "LabeledEvent", createdAt: "2026-10-09T11:00:00Z", actor: { login }, label: { name: "priority:chairman" } }];
  const read = (login: string, logins: string[]) => githubTicketAdapter({ scope: SCOPE, chairmanLogins: logins,
    run: () => JSON.stringify(issue({ labels: ["priority:chairman"], timeline: labeled(login) })) }).readItem(ROW)!;
  assert.deepEqual(read("DanBeckDev", ["DanBeckDev"]).flags, ["chairman-priority"]);
  assert.deepEqual(read("a11ign-ai-leads", ["DanBeckDev"]).flags, [], "added by someone else: not the chairman's");
  assert.deepEqual(read("DanBeckDev", []).flags, [], "no configured chairman, no chairman rows");
  assert.equal(labelOfFlag("chairman-priority"), "priority:chairman", "and the write side spells it the same");
});

test("#484 adapter: subscribe delivers a published hint to a matching handler only, and cancels", () => {
  const adapter = githubTicketAdapter({ scope: SCOPE, run: () => "" });
  const seen: string[] = [];
  const cancel = adapter.subscribe({ kinds: ["state-changed"], ref: ROW }, (e: PortEvent) => seen.push(e.kind));
  const event = (kind: PortEvent["kind"], id = 484): PortEvent => ({ kind, ref: { ...ROW, id }, at: "2026-10-10T00:00:00Z", actor: null });
  adapter.publish(event("state-changed"));
  adapter.publish(event("flag-added"));
  adapter.publish(event("state-changed", 485));
  assert.deepEqual(seen, ["state-changed"], "another kind and another item are not delivered");
  cancel();
  adapter.publish(event("state-changed"));
  assert.deepEqual(seen, ["state-changed"], "a cancelled handler hears nothing");
});

// --- 2. the source test --------------------------------------------------------------------------------------------------------------

const SPAWNERS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]);
/** `exec` is also what a regular expression is run with (`/x/.exec(s)`), so it counts only as a bare call, which is how it is imported from `child_process`. */
const BARE_ONLY = new Set(["exec"]);
const CHILD_PROCESS = /^(node:)?child_process$/;

/** Every place `source` imports a module, as the specifier. Static, re-exported and dynamic. */
function importsOf(source: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) out.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true));
  return out;
}

/** What in `source` is a `gh` call: the child-process module, a call to a spawner, or the string `gh` as a command. Comments are prose, and are not read. */
function ghFindings(source: string): string[] {
  const found: string[] = [];
  for (const spec of importsOf(source)) if (CHILD_PROCESS.test(spec)) found.push(`imports ${spec}`);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const bare = ts.isIdentifier(node.expression) ? node.expression.text : "";
      const member = ts.isPropertyAccessExpression(node.expression) && !BARE_ONLY.has(node.expression.name.text) ? node.expression.name.text : "";
      const callee = bare || member;
      if (SPAWNERS.has(callee)) found.push(`calls ${callee}()`);
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && /^gh(\s|$)/.test(node.text)) found.push(`names the command ${JSON.stringify(node.text)}`);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true));
  return found;
}

const adapterImportsOf = (source: string) => importsOf(source).filter((spec) => /(^|\/)[a-z-]*adapter(\.ts)?$/.test(spec));

const SELF = "github-adapter.ts"; // the adapter is the one file here that may speak `gh`'s vocabulary, so it is excluded from the walk BY NAME, in code
const portSource = readFileSync(join(HERE, "port.ts"), "utf8");

test("#484 port.ts names no `gh` call and imports no adapter", () => {
  assert.deepEqual(ghFindings(portSource), []);
  assert.deepEqual(adapterImportsOf(portSource), []);
  assert.deepEqual(importsOf(portSource), [], "it imports nothing at all: a type file with a dependency is a type file with a coupling");
});

test("#484 no file under src/ticket-port other than the adapter spawns `gh` or imports one", () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== SELF);
  assert.ok(files.includes("port.ts"), "the walk sees port.ts: an empty walk would pass for the wrong reason");
  for (const file of files) {
    const source = readFileSync(join(HERE, file), "utf8");
    assert.deepEqual(ghFindings(source), [], `${file} spawns gh`);
    assert.deepEqual(adapterImportsOf(source), [], `${file} imports an adapter`);
  }
  // The adapter does not spawn either: `run` is handed in. Its own vocabulary is arguments, so the source test sees none of it as a spawn.
  assert.deepEqual(ghFindings(readFileSync(join(HERE, SELF), "utf8")), [], "the adapter takes `run`; the gate's own spawner is the only one");
});

/** The tracker's CLI, kept out of a call-shaped literal so this file is not itself charged for spawning it (the fixtures below are the only place it is named). */
const GH = "gh";

test("#484 NEGATIVE CONTROL: the source test reports a port file that spawns `gh` or imports its adapter", () => {
  const spawning = [
    ["execFileSync of gh", `import { execFileSync } from "node:child_process";\nexport const read = () => execFileSync(${JSON.stringify(GH)}, ["issue", "list"]);\n`, ["imports node:child_process", "calls execFileSync()", 'names the command "gh"']],
    ["a bare spawn", `import cp from "child_process";\nexport const go = () => cp.spawnSync("sh", ["-c", "x"]);\n`, ["imports child_process", "calls spawnSync()"]],
    ["the command as a template", "export const cmd = (n: number) => `gh issue view ${n}`;\n", ['names the command "gh issue view "']],
  ] as const;
  for (const [name, source, expected] of spawning) {
    assert.deepEqual(ghFindings(source), expected, `${name} is reported`);
  }
  assert.deepEqual(adapterImportsOf(`import { githubTicketAdapter } from "./github-adapter.ts";\nexport const x = githubTicketAdapter;\n`), ["./github-adapter.ts"]);
  assert.deepEqual(adapterImportsOf(`export * from "./other-adapter.ts";\n`), ["./other-adapter.ts"], "a re-export is an import");
  assert.deepEqual(adapterImportsOf(`const a = await import("./github-adapter.ts");\n`), ["./github-adapter.ts"], "a dynamic import is one");
  // And the marker is not a blanket: prose about `gh` and a clean port are not reported.
  assert.deepEqual(ghFindings(`// gh is what the adapter runs\nexport interface P { readItem(ref: string): string | null }\n`), []);
  assert.deepEqual(ghFindings("export const id = (s: string) => /#(\\d+)/.exec(s)?.[1];\n"), [], "a regular expression's `exec` is not a spawn");
  assert.deepEqual(ghFindings(`import { exec } from "node:child_process";\nexec("gh issue list");\n`), ["imports node:child_process", "calls exec()", 'names the command "gh issue list"'], "and the imported one is");
});

test("#484 adapter: readOpenItems is `null` for a refused read, an answer with errors, a malformed page and a list still paging at the cap", () => {
  const page = (body: unknown) => () => JSON.stringify(body);
  const nodes = [{ number: 1, title: "row 1", createdAt: "2026-09-26T08:00:00Z", projectItems: { totalCount: 0, nodes: [] } }];
  const rateLimit = { limit: 5000, remaining: 4000, resetAt: "2026-10-10T13:00:00Z" };
  const budgets: unknown[] = [];
  const refusals: [string, (args: string[]) => string][] = [
    ["a refused call", () => { throw new Error("HTTP 403"); }],
    ["errors beside data", page({ errors: [{ message: "x" }], data: { rateLimit, repository: { issues: { nodes, pageInfo: { hasNextPage: false } } } } })],
    ["a page with no node list", page({ data: { rateLimit, repository: { issues: {} } } })],
    ["output that is not JSON", () => "not json"],
    ["a list still paging at the cap", page({ data: { rateLimit, repository: { issues: { nodes, pageInfo: { hasNextPage: true, endCursor: "c" } } } } })],
  ];
  for (const [name, run] of refusals) {
    const adapter = githubTicketAdapter({ run, scope: SCOPE });
    assert.equal(adapter.readOpenItems({ onBudget: (b) => budgets.push(b) }), null, `${name} is "could not ask", never an empty board`);
  }
  assert.equal(budgets.length, 1, "only the capped list had answered a first page, so only it told the tick a budget");
  const clean = githubTicketAdapter({ run: page({ data: { rateLimit, repository: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } }), scope: SCOPE });
  assert.deepEqual(clean.readOpenItems(), [], "an answer that really is empty is an empty list, which is not `null`");
});

// --- 3. the consumer -----------------------------------------------------------------------------------------------------------------

test("#484 consumer: readRowsOffBoard reads the tracker only through the port, and its facts are unchanged", () => {
  const node = (number: number, projects: number[]) => ({ number, title: `row ${number}`, createdAt: "2026-09-26T08:00:00Z",
    projectItems: { totalCount: projects.length, nodes: projects.map((n) => ({ project: { number: n } })) } });
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4000, resetAt: "2026-10-10T13:00:00Z" }, viewer: { login: "a11ign-ai-leads" },
      repository: { issues: { nodes: [node(1, [BOARD]), node(2, [])], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  };
  const pools: unknown[] = [];
  const facts = readRowsOffBoard(run, pools as never);
  assert.deepEqual(facts, [
    { number: 1, title: "row 1", createdMs: Date.parse("2026-09-26T08:00:00Z"), onBoard: true },
    { number: 2, title: "row 2", createdMs: Date.parse("2026-09-26T08:00:00Z"), onBoard: false },
  ]);
  assert.equal(calls.length, 1, "one call for fewer than a page of rows, as before");
  assert.ok(calls[0].includes(`query=${OPEN_ITEMS_QUERY}`), "the query is the adapter's");
  assert.equal(pools.length, 1, "the budget the answer named reached the tick");
});

test("#484 consumer: work-gate.ts no longer names the off-board query or its paging; it asks through the port", () => {
  const source = readFileSync(join(HERE, "..", "work-gate.ts"), "utf8");
  const start = source.indexOf("export function readRowsOffBoard(");
  assert.ok(start > 0, "the function is still exported from work-gate.ts, where its callers import it");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /githubTicketAdapter\(/);
  assert.match(body, /readOpenItems\(/);
  assert.doesNotMatch(body, /"graphql"|projectItems|hasNextPage/, "the GitHub vocabulary is the adapter's");
});
