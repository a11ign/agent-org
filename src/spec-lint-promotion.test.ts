// no-token: gh -- every `gh` call goes through an injected fake `run`; the provider is a fake `fetch`; the ledger is a temp directory
/**
 * agent-org#1017 (a11ign#5117): THE SPEC LINT AT PROMOTION, JEV'S READING OF WHAT WAS PROMOTED, AND THE LOG OF WHAT WAS REFUSED.
 *
 * `spec-lint.test.ts` pins the rules; this file pins the three WIRINGS, one block each, and every wiring has a twin: the same row with the one thing that
 * turns the wiring on repaired or removed. A wiring that always fires cannot pass its twin and one that never fires cannot pass its refusal.
 *   1. `promoteRefusalReason` asks the lint when `rows.specLint` is on, and `requireBlock` is the caller's reading of a build row.
 *   2. `spec-review` is a decision use; a spec scored under 3 is PROMOTED, labelled `spec:review` and wakes `product-manager`; no provider is no label.
 *   3. Each refusal is a failure-ledger line (row, field, rule).
 * The mutations run against this file are listed in the pull request's `.acceptance` file, one per wiring.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DECISION_USES, decisionSwitchesPath, decisionLogPathFrom, type DecisionDeps } from "./decision-provider.ts";
import { FAILURE_LEDGER_FILE, parseFailureLedger } from "./failure-ledger.ts";
import { parseHostConfig, SHADOW_COPY_MARKER, SHADOW_STATE_DIR_ENV } from "./host-config.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { SPEC_LINT_REFUSED_KIND } from "./failure-ledger.ts";
import { promoteAndReviewRow, promoteRefusalReason, promoteRow, readSpecLintFlag, recordSpecLintRefusals, reviewPromotedSpec, specLintDeps, type SpecLintAtPromotion } from "./row-file/roadmap-without-parent-refusal.ts";
import { SPEC_REVIEW_LABEL, SPEC_REVIEW_WAKE, type LintDeps } from "./spec-lint.ts";
import { freshState } from "./triage-provider.ts";
import { moduleSource } from "./lib/module-source.ts";

// --- fixtures -----------------------------------------------------------------------------------------------------------------

const ROW = 1017;
const TEST_FILE = "src/spec-lint-promotion.test.ts";
const GOOD = [
  "files:",
  "  - agent-org:src/row-file.ts",
  `  - path: agent-org:${TEST_FILE}`,
  "    new: true",
  "tests:",
  `  path: agent-org:${TEST_FILE}`,
  "  new: true",
  "  cases:",
  "    - given: \"a row whose spec case says `then: it works`\"",
  "      when: promoteRefusalReason runs with rows.specLint on",
  "      then: it returns a refusal naming `tests.cases[0].then`",
  `run: bash -c 'cd ~/repos/agent-org && npx rstest run ${TEST_FILE}'`,
  "out_of_scope:",
  "  - the retro's line for the refusals",
].join("\n");
const ASSERTION_FREE = GOOD.replace("then: it returns a refusal naming `tests.cases[0].then`", "then: it works");
assert.notEqual(ASSERTION_FREE, GOOD, "fixture drift: the assertion-free twin must differ from the good spec");

const PRESENT = new Set(["agent-org:src/row-file.ts"]);
const lintDeps = (over: Partial<LintDeps> = {}): LintDeps => ({ fileExists: (path) => PRESENT.has(path), onPath: () => true, shellParses: () => true, ...over });

const ACCEPTANCE = `bash -c 'AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts ${TEST_FILE}'`;
const OPEN_CHECK = "git grep -c \"specLintRefusalReason\" origin/main -- src | wc -l";
/** A row body that passes the claim template; `spec` and `marker` are what the lint wiring reads. `null` leaves either out. */
function body({ region = `agent-org:src/row-file.ts\nagent-org:${TEST_FILE}`, spec = GOOD as string | null, marker = `Tests-first: ${TEST_FILE}` as string | null } = {}): string {
  // The marker is ABOVE the Region: below it, it would be inside the Region section and its path read as a bare Region entry.
  return [
    marker === null ? "" : `${marker}\n`,
    `## Region\n\n\`\`\`\n${region}\n\`\`\`\n`,
    `## Acceptance\n\n\`\`\`bash\n${ACCEPTANCE}\n\`\`\`\n`,
    `## Open-check\n\n\`\`\`\n${OPEN_CHECK}\n\`\`\`\n`,
    spec === null ? "" : `\`\`\`spec\n${spec}\n\`\`\`\n`,
  ].filter((part) => part !== "").join("\n");
}

const on = (over: SpecLintAtPromotion = {}): SpecLintAtPromotion => ({ enabled: true, deps: lintDeps(), record: () => {}, ...over });
/** `promoteRefusalReason` of an EXISTING row (`filing` false: it has an issue number), with the absent-top-dir rule's clones taken off the disk so only the lint can refuse. */
const reasonOf = (text: string, specLint: SpecLintAtPromotion) => promoteRefusalReason(text, ROW, { code: [] }, specLint);

/** Everything stderr said while `fn` ran. */
async function withStderr<T>(fn: () => Promise<T> | T): Promise<{ result: T; stderr: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = write;
  }
}

/** A row on a fake `gh`: reads its body and labels, records every write in order, and can fail the label write. */
function fakeRow(options: { body: string | null; labels?: string[]; failLabelWrite?: boolean; status?: string } = { body: body() }) {
  const row = { labels: [...(options.labels ?? ["backlog", "lane:any"])], status: options.status ?? "Backlog" };
  const writes: string[] = [];
  const comments: string[] = [];
  const ensured: string[][] = [];
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]): string => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") return options.body ?? "";
    if (args[0] === "issue" && args[1] === "comment") { writes.push("comment"); comments.push(args[args.indexOf("--body") + 1]); return "https://github.com/a11ign/agent-org/issues/1017#issuecomment-1"; }
    if (args[0] === "api" && args.includes("PUT")) {
      if (options.failLabelWrite) throw new Error("HTTP 502: Bad gateway (github.com)");
      writes.push("labels");
      row.labels = args.filter((a) => a.startsWith("labels[]=")).map((a) => a.slice("labels[]=".length));
    }
    return "";
  };
  const deps = {
    run,
    fetchLabels: () => ({ number: ROW, title: "wire the spec lint", state: "OPEN" as const, labels: [...row.labels] }),
    fetchBoardStatus: () => row.status,
    moveStatus: (_n: number, status: string) => { row.status = status; writes.push(`status:${status}`); return { moved: true as const }; },
    ensureLabels: (labels: string[]) => { ensured.push([...labels]); },
  };
  return { row, deps, writes, comments, ensured, calls };
}

// --- the provider: a fake network behind the real `decide` ---------------------------------------------------------------------------

const KEY_PATH = "/fake/typesafe/key";
const HOST = { schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }], gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] } };
const JEV = { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.9 };
/** The API's own shape for a score: the level's position from zero, fractional, so the 1-based level `n` is sent as `n - 1 + 0.04`. */
const scoreReply = (level: number, confidence = 0.95) => ({ answers: { spec: { type: "score", score: level - 1 + 0.04, confidence } } });

function rig(opts: { triage?: unknown; switches?: string; reply?: { status?: number; body?: unknown; throws?: boolean } } = {}) {
  const dir = tmpDir("spec-lint-promotion-");
  if (opts.switches !== undefined) {
    mkdirSync(join(dir, ".agent-org"));
    writeFileSync(decisionSwitchesPath(dir), opts.switches);
  }
  const calls: { url: string; body: string }[] = [];
  const reply = opts.reply ?? { body: scoreReply(2) };
  const fetch = (async (url: string, init: { body?: string }) => {
    calls.push({ url, body: String(init?.body ?? "") });
    if (reply.throws) throw new Error("connection refused");
    return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, json: async () => reply.body };
  }) as unknown as typeof globalThis.fetch;
  const logPath = decisionLogPathFrom(join(dir, "state", "wake-ledger"));
  const decision: DecisionDeps = {
    host: parseHostConfig(JSON.stringify(opts.triage === undefined ? HOST : { ...HOST, triage: opts.triage })), fetch, state: freshState(), timeoutMs: 50,
    diagnostic: () => {}, readKey: () => "tsk-FAKE-0123456789", switchesPath: decisionSwitchesPath(dir), logPath, id: `a11ign/agent-org#${ROW}`, now: () => 1_000,
  };
  return { decision, calls, logPath };
}
const SWITCH_ON = JSON.stringify({ "spec-review": true });

// =================================================================================================================================
// WIRING 1: THE LINT AT PROMOTION
// =================================================================================================================================

test("1. MUTATION TARGET: with rows.specLint on, an assertion-free case refuses the promotion and the refusal names `tests.cases[0].then`", () => {
  const reason = reasonOf(body({ spec: ASSERTION_FREE }), on());
  assert.ok(reason !== null, "the assertion-free case is refused");
  assert.match(reason, /REFUSING to promote -- #1017's `spec` block fails the spec lint \(rows\.specLint\)/);
  assert.match(reason, /tests\.cases\[0\]\.then \(no-assertion\)/, "the field is named, because a refusal that names none cannot be acted on");
});

test("1. TWIN: the same row promotes with the flag off, and with the flag absent from a checkout's declaration", () => {
  assert.equal(reasonOf(body({ spec: ASSERTION_FREE }), on({ enabled: false })), null, "off: the promotion is what it was");
  const checkout = tmpDir("spec-lint-flag-");
  assert.equal(readSpecLintFlag(checkout), false, "no declaration at all is a project that never declared the flag");
  mkdirSync(join(checkout, ".agent-org"));
  writeFileSync(join(checkout, ".agent-org", "project.json"), JSON.stringify({ rows: { testsFirst: true } }));
  assert.equal(readSpecLintFlag(checkout), false, "a declaration without `rows.specLint` is absent, and absent is off");
  writeFileSync(join(checkout, ".agent-org", "project.json"), "{ not json");
  assert.equal(readSpecLintFlag(checkout), false, "an unreadable declaration is not a declaration that turned the flag on");
  writeFileSync(join(checkout, ".agent-org", "project.json"), JSON.stringify({ rows: { specLint: true } }));
  assert.equal(readSpecLintFlag(checkout), true, "and the flag is read when it is declared: the positive control for the three above");
  assert.equal(reasonOf(body({ spec: ASSERTION_FREE }), { ...on(), enabled: readSpecLintFlag(checkout) })?.includes("tests.cases[0].then"), true);
});

test("1. CONTROL: the good spec is promoted with the flag on, so the refusal above is the lint's and not a fixture that always refuses", () => {
  assert.equal(reasonOf(body(), on()), null);
});

test("1. MUTATION TARGET: requireBlock is true for a source-file Region with a `Tests-first:` or `spec` marker, and only then", () => {
  const missing = /is a build row and carries no fenced `spec` block/;
  const noBlock = (over: Parameters<typeof body>[0]) => reasonOf(body({ spec: null, ...over }), on());
  assert.match(String(noBlock({})), missing, "source file + Tests-first, no block: refused");
  assert.match(String(noBlock({ marker: "## Spec\n\nsee below" })), missing, "source file + a `Spec` heading, no block: refused");
  assert.match(String(noBlock({ marker: "**Spec:** a table" })), missing, "source file + `Spec:`, no block: refused");
  // The twins: each removes exactly one half of the rule.
  assert.equal(noBlock({ marker: null }), null, "a source Region with NO marker is a decomposition or investigation row: exempt by saying nothing");
  assert.equal(noBlock({ region: "agent-org:docs/notes.md", marker: "Tests-first: src/x.test.ts" }), null, "a Region naming no source file is not a build row");
  assert.equal(noBlock({ region: `agent-org:${TEST_FILE}` }), null, "a Region of only test files builds no source");
  assert.equal(noBlock({ region: "agent-org:src/row-file.ts\nagent-org:src/spec-lint.ts" }) !== null, true, "two source files: still a build row (the positive control for the exemptions)");
});

test("1. MUTATION TARGET: a Region prefix with no root on this machine is unchecked (`null`), never a refusal", () => {
  // `specLintDeps({})` has no checkout for any prefix, so every file's existence is `null`: could not tell.
  const unrooted = specLintDeps({});
  assert.equal(unrooted.fileExists("agent-org:src/never-heard-of-it.ts"), null);
  assert.equal(reasonOf(body(), on({ deps: unrooted })), null, "the good spec names files nothing can be asked about, and that is not a finding");
  // The twin: a root that CAN answer, and answers `false`, is a finding. Without it the case above would pass for a lint that checks nothing.
  const rooted = lintDeps({ fileExists: () => false });
  assert.match(String(reasonOf(body(), on({ deps: rooted }))), /files\[0\] \(file-absent\)|file-absent/);
});

test("1. MUTATION TARGET: file existence is read from origin/main, not the working tree (a stale checkout must not refuse a file that exists)", () => {
  const root = tmpDir("spec-lint-origin-");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", env: sandboxGitEnv() });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "on-main.ts"), "export {};\n");
  git("add", "-A");
  git("commit", "-q", "-m", "on main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  // The checkout is behind: a file was added to origin/main that the working tree has not pulled, and one is in the working tree that main lacks.
  writeFileSync(join(root, "src", "only-in-the-tree.ts"), "export {};\n");
  const deps = specLintDeps({ "": root });
  assert.equal(deps.fileExists("src/on-main.ts"), true, "on origin/main: exists");
  assert.equal(deps.fileExists("src/only-in-the-tree.ts"), false, "in the working tree only: not on origin/main, so absent (this is what a worker's PR will be checked against)");
  unlinkSync(join(root, "src", "on-main.ts"));
  assert.equal(deps.fileExists("src/on-main.ts"), true, "deleted from the working tree but still on origin/main: still exists, which is why the tree is not asked");
});

test("1. the promote act itself refuses (exit 1) and writes nothing, and the refusal is the lint's, with the flag on", () => {
  const fake = fakeRow({ body: body({ spec: ASSERTION_FREE }) });
  const { result: code, stderr } = syncWithStderr(() => promoteRow([`--promote=${ROW}`, "--session=worker-agent-org-1017"], { ...fake.deps, specLint: on() }));
  assert.equal(code, 1);
  assert.match(stderr, /tests\.cases\[0\]\.then \(no-assertion\)/);
  assert.deepEqual(fake.writes, [], "a refused promotion moved no Status and wrote no label");
  assert.deepEqual(fake.row.labels, ["backlog", "lane:any"]);
});

test("1. TWIN: the same row, flag off, is promoted through the act: Status moved and one label write", () => {
  const fake = fakeRow({ body: body({ spec: ASSERTION_FREE }) });
  const { result: code } = syncWithStderr(() => promoteRow([`--promote=${ROW}`, "--session=worker-agent-org-1017"], { ...fake.deps, specLint: on({ enabled: false }) }));
  assert.equal(code, 0);
  assert.deepEqual(fake.writes, ["status:Ready", "labels"]);
  assert.ok(fake.row.labels.includes("ready"));
});

function syncWithStderr<T>(fn: () => T): { result: T; stderr: string } {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    return { result: fn(), stderr };
  } finally {
    process.stderr.write = write;
  }
}

// =================================================================================================================================
// WIRING 3: THE LOG OF THE REFUSALS
// =================================================================================================================================

test("3. MUTATION TARGET: a refusal is told to `record` as (row, field, rule), once per finding, and a clean or unchecked row is told nothing", () => {
  const told: [number, { field: string; rule: string }[]][] = [];
  const record: SpecLintAtPromotion["record"] = (n, findings) => { told.push([n, findings.map(({ field, rule }) => ({ field, rule }))]); };
  assert.notEqual(reasonOf(body({ spec: ASSERTION_FREE }), on({ record })), null);
  assert.deepEqual(told, [[ROW, [{ field: "tests.cases[0].then", rule: "no-assertion" }]]]);
  told.length = 0;
  reasonOf(body(), on({ record }));
  reasonOf(body({ spec: ASSERTION_FREE }), on({ record, enabled: false }));
  assert.deepEqual(told, [], "a clean spec and a flag that is off are not refusals, so nothing is logged");
  reasonOf(body({ spec: null }), on({ record }));
  assert.deepEqual(told, [[ROW, [{ field: "spec", rule: "no-block" }]]], "a build row with no block is refused, and is logged as `spec` / `no-block`");
});

test("3. MUTATION TARGET: the ledger line is `<kind>\\t<ts ms>\\t#<row> <field> <rule>`, which the failure ledger's own reader parses", () => {
  const dir = tmpDir("spec-lint-ledger-");
  const logPath = join(dir, FAILURE_LEDGER_FILE);
  recordSpecLintRefusals(ROW, [{ field: "tests.cases[0].then", rule: "no-assertion" }, { field: "run", rule: "run-misses-tests" }], { logPath, now: 1_700_000_000_000 });
  const text = readFileSync(logPath, "utf8");
  assert.equal(text, [
    `${SPEC_LINT_REFUSED_KIND}\t1700000000000\t#1017 tests.cases[0].then no-assertion`,
    `${SPEC_LINT_REFUSED_KIND}\t1700000000000\t#1017 run run-misses-tests`,
    "",
  ].join("\n"));
  assert.deepEqual(parseFailureLedger(text).map((entry) => entry.classKey), [SPEC_LINT_REFUSED_KIND, SPEC_LINT_REFUSED_KIND]);
  assert.equal(SPEC_LINT_REFUSED_KIND, "spec-lint-refused");
});

test("3. MUTATION TARGET: the promote act logs its own refusal to the failure ledger of the state directory (the default `record` is wired in)", () => {
  const state = tmpDir("spec-lint-state-");
  writeFileSync(join(state, SHADOW_COPY_MARKER), "");
  const fake = fakeRow({ body: body({ spec: ASSERTION_FREE }) });
  const before = process.env[SHADOW_STATE_DIR_ENV];
  process.env[SHADOW_STATE_DIR_ENV] = state;
  try {
    const { result: code } = syncWithStderr(() => promoteRow([`--promote=${ROW}`], { ...fake.deps, specLint: { enabled: true, deps: lintDeps() } }));
    assert.equal(code, 1);
  } finally {
    if (before === undefined) delete process.env[SHADOW_STATE_DIR_ENV];
    else process.env[SHADOW_STATE_DIR_ENV] = before;
  }
  const ledger = join(state, FAILURE_LEDGER_FILE);
  assert.ok(existsSync(ledger), "the refusal reached the ledger without the caller passing a `record`");
  const entries = parseFailureLedger(readFileSync(ledger, "utf8"));
  assert.deepEqual(entries.map(({ classKey, ref }) => [classKey, ref]), [[SPEC_LINT_REFUSED_KIND, "#1017 tests.cases[0].then no-assertion"]]);
});

// =================================================================================================================================
// WIRING 2: JEV'S SPEC REVIEW
// =================================================================================================================================

test("2. `spec-review` is a decision use, so the seam can switch it and a host can leave it off", () => {
  assert.ok((DECISION_USES as readonly string[]).includes("spec-review"));
});

test("2. MUTATION TARGET: a spec Jev scores below 3 stays Ready, carries `spec:review`, and `product-manager` is woken (comment first, then ONE label write)", async () => {
  const fake = fakeRow({ body: body(), labels: ["ready", "lane:any"] });
  const r = rig({ triage: JEV, switches: SWITCH_ON, reply: { body: scoreReply(2) } });
  const verdict = await reviewPromotedSpec(ROW, { enabled: true, ...fake.deps, decision: r.decision });
  assert.equal(r.calls.length, 1, "the provider was asked once");
  assert.ok(r.calls[0].body.includes("files:"), "and it was shown the spec block");
  assert.equal(verdict?.warn, true);
  assert.deepEqual(fake.writes, ["comment", "labels"], "the comment that ASKS comes first (the wake guard wants the newest comment to ask the session something), then one label set");
  assert.deepEqual(fake.row.labels, ["ready", "lane:any", SPEC_REVIEW_LABEL, `answer:${SPEC_REVIEW_WAKE}`], "the row's own labels are carried, and the two are added");
  assert.match(fake.comments[0], new RegExp(`${SPEC_REVIEW_WAKE}:`), "the comment names the session it asks");
  assert.match(fake.comments[0], /\?/, "and asks something");
  assert.deepEqual(fake.ensured, [[SPEC_REVIEW_LABEL, `answer:${SPEC_REVIEW_WAKE}`]], "both labels were made to exist before they were written");
  assert.ok(!fake.calls.some((args) => args.includes("--add-label") || args.includes("--remove-label")), "no delta form: the set is one PUT");
});

test("2. TWIN: a spec Jev scores 3 or more is not labelled, and nobody is woken", async () => {
  for (const level of [3, 5]) {
    const fake = fakeRow({ body: body(), labels: ["ready"] });
    const r = rig({ triage: JEV, switches: SWITCH_ON, reply: { body: scoreReply(level) } });
    const verdict = await reviewPromotedSpec(ROW, { enabled: true, ...fake.deps, decision: r.decision });
    assert.equal(r.calls.length, 1, `score ${level}: the provider was asked, so a no-warning is a reading and not an unasked question`);
    assert.equal(verdict?.warn, false);
    assert.deepEqual(fake.writes, [], `score ${level}: nothing was written`);
  }
});

test("2. MUTATION TARGET: a provider that is down, absent, switched off, low in confidence or answering garbage promotes with NO label and NO comment", async () => {
  const cases: [string, Parameters<typeof rig>[0]][] = [
    ["connection refused", { triage: JEV, switches: SWITCH_ON, reply: { throws: true } }],
    ["HTTP 503", { triage: JEV, switches: SWITCH_ON, reply: { status: 503, body: {} } }],
    ["no provider declared", { switches: SWITCH_ON }],
    ["the `spec-review` use is not switched on", { triage: JEV, reply: { body: scoreReply(1) } }],
    ["a low-confidence answer is the fallback, not a reading", { triage: JEV, switches: SWITCH_ON, reply: { body: scoreReply(1, 0.1) } }],
  ];
  for (const [name, options] of cases) {
    const fake = fakeRow({ body: body(), labels: ["ready"] });
    const r = rig(options);
    const verdict = await reviewPromotedSpec(ROW, { enabled: true, ...fake.deps, decision: r.decision });
    assert.equal(verdict?.warn, false, name);
    assert.deepEqual(fake.writes, [], `${name}: no comment and no label`);
    assert.deepEqual(fake.row.labels, ["ready"], name);
  }
  // The control for the loop above: the same rig with a provider that answers low DOES warn, so the cases are not passing on a rig that cannot.
  const fake = fakeRow({ body: body(), labels: ["ready"] });
  const verdict = await reviewPromotedSpec(ROW, { enabled: true, ...fake.deps, decision: rig({ triage: JEV, switches: SWITCH_ON, reply: { body: scoreReply(1) } }).decision });
  assert.equal(verdict?.warn, true);
});

test("2. with the use switched off or no provider the provider is never asked (fetch zero times)", async () => {
  const off = rig({ triage: JEV, reply: { body: scoreReply(1) } });
  await reviewPromotedSpec(ROW, { enabled: true, ...fakeRow({ body: body() }).deps, decision: off.decision });
  assert.equal(off.calls.length, 0);
  const none = rig({ switches: SWITCH_ON });
  await reviewPromotedSpec(ROW, { enabled: true, ...fakeRow({ body: body() }).deps, decision: none.decision });
  assert.equal(none.calls.length, 0);
});

test("2. MUTATION TARGET: with rows.specLint off, or a row with no spec block, Jev is not asked at all", async () => {
  let asked = 0;
  const ask = async () => { asked += 1; return { value: 1, fellBack: false }; };
  const off = fakeRow({ body: body() });
  assert.equal(await reviewPromotedSpec(ROW, { enabled: false, ...off.deps, ask }), null);
  const none = fakeRow({ body: body({ spec: null }) });
  assert.equal(await reviewPromotedSpec(ROW, { enabled: true, ...none.deps, ask }), null);
  assert.equal(asked, 0);
  assert.deepEqual([...off.writes, ...none.writes], []);
  // The twin: the same ask, flag on and a block present, is asked and warns.
  const live = fakeRow({ body: body(), labels: ["ready"] });
  assert.equal((await reviewPromotedSpec(ROW, { enabled: true, ...live.deps, ask }))?.warn, true);
  assert.equal(asked, 1);
});

test("2. MUTATION TARGET: a row already carrying `spec:review` is not commented on or woken again (the promote act is idempotent)", async () => {
  const fake = fakeRow({ body: body(), labels: ["ready", SPEC_REVIEW_LABEL, `answer:${SPEC_REVIEW_WAKE}`] });
  const verdict = await reviewPromotedSpec(ROW, { enabled: true, ...fake.deps, ask: async () => ({ value: 1, fellBack: false }) });
  assert.equal(verdict?.warn, true, "the reading is still reported");
  assert.deepEqual(fake.writes, [], "and nothing is written a second time");
});

test("2. MUTATION TARGET: a write that fails is said on stderr and never thrown; the promotion stands", async () => {
  const fake = fakeRow({ body: body(), labels: ["ready"], failLabelWrite: true });
  const { result, stderr } = await withStderr(() => reviewPromotedSpec(ROW, { enabled: true, ...fake.deps, ask: async () => ({ value: 1, fellBack: false }) }));
  assert.equal(result, null);
  assert.match(stderr, /#1017 is promoted, and Jev's reading of its spec could not be acted on/);
  assert.match(stderr, /HTTP 502/);
  // An `ask` that throws is no reading and no warning either, and is not an error.
  const thrown = fakeRow({ body: body(), labels: ["ready"] });
  const verdict = await reviewPromotedSpec(ROW, { enabled: true, ...thrown.deps, ask: async () => { throw new Error("boom"); } });
  assert.equal(verdict?.warn, false);
  assert.deepEqual(thrown.writes, []);
});

// =================================================================================================================================
// THE ACT AS `main` RUNS IT: promote, then read
// =================================================================================================================================

test("2. MUTATION TARGET: `promoteAndReviewRow` promotes first, then reads the spec: a score under 3 is a Ready row WITH the label, and the exit code is 0", async () => {
  const fake = fakeRow({ body: body() });
  const r = rig({ triage: JEV, switches: SWITCH_ON, reply: { body: scoreReply(2) } });
  const { result: code, stderr } = await withStderr(() => promoteAndReviewRow([`--promote=${ROW}`, "--session=worker-agent-org-1017"], {
    ...fake.deps, specLint: on(), review: { decision: r.decision },
  }));
  assert.equal(code, 0, "a warning never changes the exit code");
  assert.deepEqual(fake.writes, ["status:Ready", "labels", "comment", "labels"], "the promotion's own writes, THEN the warning's");
  assert.ok(["ready", SPEC_REVIEW_LABEL, `answer:${SPEC_REVIEW_WAKE}`].every((label) => fake.row.labels.includes(label)), `labels: ${fake.row.labels.join(",")}`);
  assert.match(stderr, /warning -- #1017 is Ready and now carries `spec:review`/);
});

test("2. a refused promotion is not read by Jev, and a provider that is down promotes with no label", async () => {
  const refused = fakeRow({ body: body({ spec: ASSERTION_FREE }) });
  const r = rig({ triage: JEV, switches: SWITCH_ON, reply: { body: scoreReply(1) } });
  const { result: refusedCode } = await withStderr(() => promoteAndReviewRow([`--promote=${ROW}`], { ...refused.deps, specLint: on(), review: { decision: r.decision } }));
  assert.equal(refusedCode, 1);
  assert.equal(r.calls.length, 0, "the lint refused, so Jev was not asked");
  assert.deepEqual(refused.writes, []);

  const down = fakeRow({ body: body() });
  const dead = rig({ triage: JEV, switches: SWITCH_ON, reply: { throws: true } });
  const { result: code } = await withStderr(() => promoteAndReviewRow([`--promote=${ROW}`], { ...down.deps, specLint: on(), review: { decision: dead.decision } }));
  assert.equal(code, 0);
  assert.deepEqual(down.writes, ["status:Ready", "labels"], "promoted, and nothing after it");
  assert.ok(!down.row.labels.includes(SPEC_REVIEW_LABEL));
});

test("2. MUTATION TARGET: `main`'s `--promote=` branch runs `promoteAndReviewRow` and not the bare act (the one wiring a test cannot inject into: `main` reads `process.argv`)", () => {
  const source = moduleSource("row-file.ts");
  assert.ok(source.includes("process.exitCode = await promoteAndReviewRow(argv);"), "main reads the spec of a row it promoted");
  assert.ok(!source.includes("process.exitCode = promoteRow(argv);"), "and has no second, bare promotion that skips the reading");
});
