// no-token: gh -- the wrapper is RUN here, against a stub `gh-real` the test writes (`A11Y_GH_REAL`); no real `gh` starts and
// nothing reaches the network or any account's config.
//
// #3466: THE `gh` WRAPPER RECORDS EVERY CALL, so the burner of a GraphQL pool can be named (#3448 asked for it by
// measurement, and nothing recorded per-call cost). THE WRAPPER IS RUN, NOT READ, with the two things it spends injected the way
// `host-units.test.ts` injects its account paths: the exec (`A11Y_GH_REAL`, a stub that prints what a call prints) and the
// clock (`A11Y_GH_LEDGER_NOW`). The positive control for every "a line was written" assertion is the stub's own marker: a
// wrapper that never reached the stub also writes nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callerScript, SESSION_SHELL, parseLedger, parseLine, renderReport, topCallers } from "../gh-ledger.mjs";
import { tmpDirForFile } from "../lib/tmp-fixture.ts";

const STUB_EXIT = 7; // a status nothing else here returns, so it can only have come from the stub
const NOW = "2026-10-04T14:00:00Z";
const WORKERS = "a11ign-ai-workers";
const COST = 3;
const GRAPHQL_BODY = `{"data":{"viewer":{"login":"x"}},"rateLimit":{"remaining":4990,"cost":${COST},"resetAt":"2026-10-04T15:00:00Z"}}`;

/**
 * The wrapper's own text, its `@@name@@` placeholders filled with paths nothing here uses: every one is overridden by an environment variable
 * (`A11Y_GH_REAL`, `GH_CONFIG_DIR`) in every call below. It is NOT rendered through `host-units.mjs`, which needs the project's git history, and
 * the acceptance job that runs this file has none.
 */
const WRAPPER = (() => {
  const text = readFileSync(fileURLToPath(new URL("../../host/gh", import.meta.url)), "utf8");
  const rendered = join(tmpDirForFile("gh-ledger-render-"), "gh");
  writeFileSync(rendered, text.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

/**
 * A stub `gh-real`: prints a fixed body and a fixed stderr line, echoes its arguments and stdin, and exits as told. `STUB_BODY`
 * is what stdout carries for a graphql call, so a test chooses whether the response names a cost.
 */
const host = () => {
  const root = mkdtempSync(join(tmpdir(), "gh-ledger-3466-"));
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, "hosts.yml"), `github.com:\n    user: ${WORKERS}\n    oauth_token: not-a-token\n`);
  const stub = join(root, "gh-real");
  writeFileSync(stub, [
    "#!/bin/sh",
    `echo "$$" > "${root}/stub.pid"`,
    `[ -n "$STUB_SLEEP" ] && sleep "$STUB_SLEEP"`,
    `printf 'args=%s\\n' "$*"`,
    `[ "$1 $2" = "api graphql" ] && printf '%s' "$STUB_BODY"`,
    `[ -n "$STUB_STDIN" ] && printf 'stdin=%s\\n' "$(cat)"`,
    `echo "stderr-line" >&2`,
    `exit \${STUB_STATUS:-0}`, ""].join("\n"), { mode: 0o755 });
  const ledger = join(cfg, "gh-calls.tsv");
  const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg,
    // (#4148) the read cache is OFF here: this file pins the LEDGER, and a cached read repeats stdout but not the stderr of the call that filled it (`gh-read-cache.test.ts` pins that)
    A11Y_GH_LEDGER_NOW: NOW, A11Y_GH_READ_CACHE: "off", STUB_BODY: GRAPHQL_BODY, ...extra });
  const run = (extra: Record<string, string>, ...args: string[]) => {
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", env: env(extra), input: "" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  /** The same call with NO wrapper: the stub run directly, which is what the wrapper must be indistinguishable from. */
  const direct = (extra: Record<string, string>, ...args: string[]) => {
    const r = spawnSync("sh", [stub, ...args], { encoding: "utf8", env: env(extra), input: "" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const lines = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean) : []);
  return { root, cfg, ledger, env, run, direct, lines };
};

test("#3466: a `gh api graphql` call appends ONE line naming account, resource, cost, status and the CALLER", () => {
  const h = host();
  try {
    writeFileSync(join(h.root, "fake-caller.sh"), `#!/bin/sh\nsh "${WRAPPER}" api graphql -f query='{rateLimit{cost}}'\n`);
    // A SHORT path, from inside its directory: the ledger keeps the first 160 characters of the parent's cmdline, so an absolute path under a long TMPDIR would cut the script's name away.
    const r = spawnSync("sh", ["fake-caller.sh"], { cwd: h.root, encoding: "utf8", env: h.env({ HERDR_WORKSPACE_ID: "w3" }) });
    assert.equal(r.stdout, `args=api graphql -f query={rateLimit{cost}}\n${GRAPHQL_BODY}`, "POSITIVE CONTROL: the stub ran and its output came through");
    assert.equal(h.lines().length, 1, "one call, one line");
    const entry = parseLine(h.lines()[0]);
    assert.ok(entry, "the line is one the reader parses");
    assert.deepEqual({ ...entry, caller: callerScript(entry.caller) }, {
      time: NOW, account: WORKERS, resource: "graphql", cost: COST, status: 0, command: "api graphql", workspace: "w3",
      caller: "fake-caller.sh" });
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3589: the line carries the session id of the session that made the call as its LAST field, Claude's first, then Codex's, and `-` (read as no id) when there is none", () => {
  const h = host();
  try {
    const CLAUDE = "593792d3-21f4-4deb-baa9-12403b79ecfe";
    const CODEX = "01a109e5-898a-7183-9545-94bb9ea0c2b3";
    h.run({ CLAUDE_CODE_SESSION_ID: CLAUDE }, "pr", "list");
    h.run({ CODEX_THREAD_ID: CODEX }, "pr", "list");
    h.run({ CLAUDE_CODE_SESSION_ID: CLAUDE, CODEX_THREAD_ID: CODEX }, "pr", "list");
    h.run({}, "pr", "list");
    h.run({ CLAUDE_CODE_SESSION_ID: "a b\tc;$(x)" }, "pr", "list");
    const raw = h.lines();
    assert.equal(raw.length, 5, "POSITIVE CONTROL: every call wrote a line");
    assert.ok(raw.every((l) => l.split("\t").length === 9), "nine fields on every line, so a hostile id cannot add or remove one");
    assert.deepEqual(raw.map((l) => l.split("\t")[8]), [CLAUDE, CODEX, CLAUDE, "-", "abcx"], "the id is the last field; only [A-Za-z0-9-] survive (`a b<tab>c;$(x)` leaves `abcx`)");
    assert.deepEqual(h.lines().map((l) => parseLine(l)?.sessionId), [CLAUDE, CODEX, CLAUDE, undefined, "abcx"], "the reader reads it, and a `-` is no id");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3589: a line written BEFORE the id was added (8 fields) still parses, to the same entry it always did, and a 9-field line is the same entry plus the id", () => {
  const OLD = ["2026-10-04T14:00:00Z", WORKERS, "graphql", "3", "0", "api graphql", "w3", "/usr/bin/zsh -c source /home/agent/.claude/shell-snapshots/snapshot-zsh-1-a.sh"].join("\t");
  const before = { time: "2026-10-04T14:00:00Z", account: WORKERS, resource: "graphql", cost: 3, status: 0, command: "api graphql", workspace: "w3",
    caller: "/usr/bin/zsh -c source /home/agent/.claude/shell-snapshots/snapshot-zsh-1-a.sh" };
  assert.deepEqual(parseLine(OLD), before, "exactly the entry of before: no `sessionId` key, not even an undefined one");
  assert.deepEqual(parseLine(`${OLD}\tsess-1`), { ...before, sessionId: "sess-1" });
  assert.deepEqual(parseLine(`${OLD}\t-`), before, "a `-` is the wrapper's 'no id'");
  assert.equal(parseLedger(`${OLD}\n${OLD}\tsess-1\n`).length, 2, "a ledger holding both generations of line reads both");
});

test("#3466: the cost is the response's, SUMMED over pages, and absent when the query never asked for it", () => {
  const h = host();
  try {
    h.run({ STUB_BODY: `${GRAPHQL_BODY}${GRAPHQL_BODY}` }, "api", "graphql", "--paginate");
    h.run({ STUB_BODY: '{"data":{"cost":99}}' }, "api", "graphql");
    assert.deepEqual(h.lines().map((l) => parseLine(l)?.cost), [COST * 2, null],
      "two pages sum; a body whose only `cost` is DATA (not under rateLimit) is no reading");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3466: the pool is read off the command where gh says it, and MARKED inferred where it does not", () => {
  const h = host();
  try {
    for (const args of [["api", "repos/a/b/pulls"], ["pr", "list"], ["issue", "view", "1"], ["run", "list"]]) h.run({}, ...args);
    assert.deepEqual(h.lines().map((l) => { const e = parseLine(l); return [e?.command, e?.resource, e?.cost]; }), [
      ["api repos/a/b/pulls", "core", null], ["pr list", "graphql?", null], ["issue view", "graphql?", null], ["run list", "other", null]]);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3466: a FAILED call still appends, with its exit status", () => {
  const h = host();
  try {
    const r = h.run({ STUB_STATUS: String(STUB_EXIT) }, "api", "graphql");
    assert.equal(r.status, STUB_EXIT, "POSITIVE CONTROL: the failure is the stub's, passed through");
    assert.equal(parseLine(h.lines()[0] ?? "")?.status, STUB_EXIT);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3466: the file is TRIMMED at its bound, keeping the newest whole lines", () => {
  const h = host();
  try {
    const max = 600;
    const CALLS = 30;
    for (let i = 0; i < CALLS; i += 1) h.run({ A11Y_GH_LEDGER_MAX_BYTES: String(max), A11Y_GH_LEDGER_NOW: `2026-10-04T14:00:${String(i).padStart(2, "0")}Z` }, "pr", "list");
    const text = readFileSync(h.ledger, "utf8");
    assert.ok(text.length <= max, `the file stays within its bound (${text.length} <= ${max})`);
    const entries = parseLedger(text);
    assert.equal(entries.length, text.split("\n").filter(Boolean).length, "every line left is a whole line the reader parses");
    assert.ok(entries.length > 1 && entries.length < CALLS, "POSITIVE CONTROL: it was trimmed, and not to nothing");
    assert.equal(entries[entries.length - 1].time, "2026-10-04T14:00:29Z", "the NEWEST call survives");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3466: output and exit status are BYTE-IDENTICAL with the ledger, without it, and with no wrapper at all", () => {
  const h = host();
  try {
    const cases: Array<[Record<string, string>, string[]]> = [
      [{}, ["api", "graphql", "-f", "query=x"]],
      [{ STUB_STATUS: String(STUB_EXIT) }, ["api", "graphql"]],
      [{ STUB_STATUS: "1" }, ["pr", "view", "9", "--json", "title"]],
      [{}, ["api", "repos/a/b", "--jq", ".name"]],
    ];
    for (const [extra, args] of cases) {
      const bare = h.direct(extra, ...args);
      assert.equal(bare.stderr, "stderr-line\n", "POSITIVE CONTROL: the stub wrote on both streams");
      assert.deepEqual(h.run(extra, ...args), bare, `ledger on: ${args.join(" ")}`);
      assert.deepEqual(h.run({ ...extra, A11Y_GH_LEDGER: "off" }, ...args), bare, `ledger off: ${args.join(" ")}`);
    }
    assert.equal(h.lines().length, cases.length, "the ledger-on runs wrote one line each, and the `off` runs none");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3466: stdin reaches gh-real, as it did when the wrapper exec'd it", () => {
  const h = host();
  try {
    const r = spawnSync("sh", [WRAPPER, "api", "graphql", "--input", "-"], { encoding: "utf8", env: h.env({ STUB_STDIN: "1" }), input: "piped-body" });
    assert.match(r.stdout, /stdin=piped-body/);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3466: a ledger that CANNOT be written never fails or alters the call", () => {
  const h = host();
  try {
    const bare = h.direct({}, "api", "graphql");
    for (const ledger of [join(h.root, "no", "such", "dir", "gh-calls.tsv"), h.root /* a directory */]) {
      assert.deepEqual(h.run({ A11Y_GH_LEDGER: ledger }, "api", "graphql"), bare, `ledger at ${ledger}`);
    }
    const failing = h.run({ A11Y_GH_LEDGER: h.root, STUB_STATUS: String(STUB_EXIT) }, "api", "graphql");
    assert.equal(failing.status, STUB_EXIT, "and the call's OWN failure is still the status, not the ledger's");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3466: a signal to the wrapper reaches gh-real (the wrapper no longer exec's it)", async () => {
  const h = host();
  try {
    const child = spawn("sh", [WRAPPER, "api", "graphql"], { env: h.env({ STUB_SLEEP: "30" }), stdio: ["ignore", "pipe", "pipe"] });
    const pidFile = join(h.root, "stub.pid");
    for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) await new Promise((ok) => setTimeout(ok, 50));
    assert.ok(existsSync(pidFile), "POSITIVE CONTROL: the stub started");
    const stubPid = Number(readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    await new Promise((ok) => child.on("exit", ok));
    await new Promise((ok) => setTimeout(ok, 200));
    assert.throws(() => process.kill(stubPid, 0), { code: "ESRCH" }, "the stub was ended with the wrapper, not left running");
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test("#3466: the report ranks callers by points, floors an unread graphql call at one, and counts what was READ", () => {
  const line = (caller: string, command: string, resource: string, cost: string, status = 0, account = "leads") =>
    [NOW, account, resource, cost, status, command, "w6", `node /x/src/${caller} --json`].join("\t");
  const entries = parseLedger([
    line("board-snapshot.mjs", "api graphql", "graphql", "1"), line("board-snapshot.mjs", "api graphql", "graphql", "1"),
    line("work-gate.mjs", "pr list", "graphql?", "", 1), line("work-gate.mjs", "pr list", "graphql?", ""),
    line("work-gate.mjs", "pr list", "graphql?", ""), line("poll.mjs", "api repos/a/b", "core", ""),
    line("other.mjs", "api graphql", "graphql", "40", 0, "workers"), "half a line\twith too few fields", ""].join("\n"));
  assert.equal(entries.length, 7, "the half line is skipped, not guessed at");
  assert.deepEqual(topCallers(entries, { account: "leads" }).map((r) => [r.caller, r.points, r.measured, r.calls, r.failed]), [
    ["work-gate.mjs", 3, 0, 3, 1], ["board-snapshot.mjs", 2, 2, 2, 0], ["poll.mjs", 0, 0, 1, 0]]);
  assert.deepEqual(topCallers(entries, { resource: "graphql" }).map((r) => r.caller), ["other.mjs", "work-gate.mjs", "board-snapshot.mjs"],
    "`graphql?` is the graphql pool for the report; core is not");
  assert.match(renderReport(entries, { account: "leads" }), /3 pts \(\s*0 read\)\s+3 calls\s+1 failed\s+work-gate\.mjs/);
  assert.equal(renderReport([]), "gh ledger: no calls recorded\n", "an empty ledger says so rather than printing an empty table");
});

test("#3590: callerScript names the UNIT behind a preload, and a session's shell for what it is, on lines copied from the ledger", () => {
  const cases: Array<[string, string, string]> = [
    ["--import file:// form", "/usr/bin/node --import file:///home/agent/repos/agent-org/src/lib/crash-exit.mjs /home/agent/repos/agent-org/src/work-gate.mjs", "work-gate.mjs"],
    ["--import= form", "/usr/bin/node --import=./src/lib/crash-exit.mjs src/work-tick.mjs", "work-tick.mjs"],
    ["a shell snapshot", "/usr/bin/zsh -c source /home/agent/.claude/shell-snapshots/snapshot-zsh-1791159858645-879xil.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL", SESSION_SHELL],
    ["two preloads, the second named like a script", "/usr/bin/node --import x.mjs --import=y.mjs z.mjs", "z.mjs"],
    ["no preload, the unchanged case", "node /x/src/work-gate.mjs --json", "work-gate.mjs"],
    ["no script at all", "herdr agent prompt", "herdr"],
  ];
  assert.deepEqual(cases.map(([, caller]) => callerScript(caller)), cases.map(([, , want]) => want), cases.map(([name]) => name).join(" / "));
  assert.equal(new Set(["snapshot-zsh-1-a.sh", "snapshot-zsh-2-b.sh"].map((f) => callerScript(`/usr/bin/zsh -c source /h/.claude/shell-snapshots/${f}`))).size, 1, "two session processes are ONE caller, not a name each");
});
