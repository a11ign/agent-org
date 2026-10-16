// no-token: gh -- the wrapper is RUN here against a stub `gh-real` the test writes (`A11Y_GH_REAL`), and the retry against a stub `gh` first on PATH;
// no real `gh` starts and nothing reaches the network or any account's config.
//
// (#4898) A RATE LIMIT NEVER STOPS A SESSION. Three claims, each with its positive control beside it:
//   1. a rate-limit refusal of a WRITE is queued, not failed (the wrapper exits 75, the entry holds the call whole), while a read, a success and
//      any other failure are exactly what they were;
//   2. the gate's retry makes the call after the reset and not before, and what happens when it is refused again or fails otherwise;
//   3. a pool past 70% of its hour leaves ONE ledger incident naming the callers that spent it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpDir, tmpDirForFile } from "./lib/tmp-fixture.ts";
import {
  ALARM_FRACTION, NO_CALLER, NO_VERDICT, POOL_POINTS, QUEUED_EXIT, QUEUE_DIR, alarmLine, attachFollowUps, callerScript, dueCalls, ghQueueTick, parseLedger, parseRollup,
  perHour, perHourCallers, poolAlarms, readGroups, readQueue, recordPoolAlarms, refusalKind, renderByQuery, renderByRead, retryDue, rollupPathOf, settle, topQueries, topSpender, verdictOf, UNNAMED_QUERY, type QueuedCall, type RunQueued,
} from "./gh-ledger.ts";

const WRAPPER_TEXT = readFileSync(fileURLToPath(new URL("../host/gh", import.meta.url)), "utf8");
const WRAPPER = (() => {
  const rendered = join(tmpDirForFile("gh-ledger-render-"), "gh");
  writeFileSync(rendered, WRAPPER_TEXT.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

const GRAPHQL_REFUSAL = "GraphQL: API rate limit already exceeded for user ID 328832207.";
const REST_REFUSAL = "gh: API rate limit exceeded for user ID 328832207. (HTTP 403)";
const SECONDARY_REFUSAL = "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)";
const NOT_A_RATE_LIMIT = ["gh: Could not resolve to a PullRequest with the number of 999. (HTTP 404)", "gh: Validation Failed (HTTP 422)", "exit status 1", ""];

/**
 * A host with a stub `gh-real`. The stub logs every call it gets (its arguments, the directory it ran in and its stdin) to `calls`, answers a
 * call that carries `-i` (the wrapper's probe) with the headers `HEADERS` names, and otherwise prints `REPLY` to stderr and exits `REPLY_STATUS`.
 */
const host = ({ reply = "", status = 0, headers = "" }: { reply?: string; status?: number; headers?: string; } = {}) => {
  const root = tmpDir("gh-ledger-4898-");
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, "hosts.yml"), "github.com:\n    user: a11ign-ai-workers\n    oauth_token: not-a-token\n");
  const calls = join(root, "calls");
  const mode = join(root, "mode");
  writeFileSync(mode, `${status}\n${reply}\n`);
  writeFileSync(join(root, "headers"), headers);
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh",
    // the wrapper's probe is `api -i graphql ...`; the `-i` it puts AFTER `graphql` on a call of its own (agent-org#1395) is that call, answered as it is
    `if [ "$2" = -i ]; then cat "${root}/headers"; exit 0; fi`,
    `{ printf 'ARGS'; for a in "$@"; do printf '<%s>' "$a"; done; printf '\\nCWD %s\\nIN ' "$PWD"; cat 2>/dev/null; printf '\\n--\\n'; } >> "${calls}"`,
    `st=$(sed -n 1p "${mode}"); sed -n '2,$p' "${mode}" >&2; exit "$st"`, ""].join("\n"), { mode: 0o755 });
  const env = { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, HERDR_WORKSPACE_ID: "w9", A11Y_GH_READ_CACHE: "off", A11Y_GH_LEDGER: join(cfg, "gh-calls.tsv") };
  const run = (extra: Record<string, string>, input: string, ...args: string[]) => {
    const r = spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", env: { ...env, ...extra }, input, cwd: root });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout };
  };
  const set = (next: { reply?: string; status?: number; headers?: string; }) => {
    if (next.reply !== undefined || next.status !== undefined) writeFileSync(mode, `${next.status ?? status}\n${next.reply ?? reply}\n`);
    if (next.headers !== undefined) writeFileSync(join(root, "headers"), next.headers);
  };
  return { root, cfg, env, run, set, ledger: env.A11Y_GH_LEDGER, queue: join(cfg, QUEUE_DIR), calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : ""), stub };
};

const inOneHour = () => Math.floor(Date.now() / 1000) + 1800;

// (a11ign/a11ign#4148 residual) WHO SPENT THE POOL, PER HOUR. Two claims, in the last section of this file: the caller reaches the ledger WITH its script's
// name (the unit's `--import` preload is taken out before the 160-character cut), and the hourly rollup carries that script, so `--per-hour --top` can say
// which caller spent an hour the raw ledger no longer holds.

// ---- 1. a refused write is queued, not failed -----------------------------------------------------------------------------

test("#4898: a primary rate-limit refusal of a WRITE exits 75, says QUEUED, keeps the refusal text, and holds the call whole", () => {
  const reset = inOneHour();
  const h = host({ reply: GRAPHQL_REFUSAL, status: 1, headers: `HTTP/2.0 403 Forbidden\nX-Ratelimit-Reset: ${reset}\n\n` });
  const r = h.run({}, "", "issue", "comment", "12", "--body", "line one\nline two\n", "--repo", "a11ign/a11ign");
  assert.equal(r.status, QUEUED_EXIT);
  assert.match(r.stderr, /GraphQL: API rate limit already exceeded/, "the refusal itself is still printed, unchanged");
  assert.match(r.stderr, /QUEUED, NOT SENT/);
  assert.match(r.stderr, /do not repeat the command and do not ask a human/);
  const [call, ...rest] = readQueue(h.queue);
  assert.equal(rest.length, 0);
  assert.deepEqual(call.argv, ["issue", "comment", "12", "--body", "line one\nline two\n", "--repo", "a11ign/a11ign"], "arguments round-trip, newlines and all");
  assert.equal(call.kind, "primary");
  assert.equal(call.resource, "graphql");
  assert.equal(call.resetAtS, reset + 5, "the reset is the probe's header, plus the margin");
  assert.equal(call.cwd, h.root);
  assert.equal(call.workspace, "w9");
  assert.ok(dueCalls([call], (reset + 4) * 1000).length === 0 && dueCalls([call], (reset + 5) * 1000).length === 1, "due exactly at the reset");
  const ledger = parseLedger(readFileSync(join(h.cfg, "gh-calls.tsv"), "utf8"));
  assert.deepEqual(ledger.map((e) => e.resource), ["graphql?", "queue"], "the real refusal is recorded as the call it was, then the queue event");
  assert.equal(ledger[0].status, 1);
});

test("#4898: POSITIVE CONTROLS -- the same write that succeeds, a refused READ, and a failure that is no rate limit are all left exactly as they were", () => {
  const ok = host({ status: 0 });
  assert.equal(ok.run({}, "", "issue", "comment", "12", "--body", "x").status, 0);
  assert.equal(readQueue(ok.queue).length, 0, "a success is not queued");
  assert.match(ok.calls(), /ARGS<issue><comment><12>/, "the stub ran: this is a real answer, not a wrapper that refuses everything");

  const read = host({ reply: GRAPHQL_REFUSAL, status: 1 });
  const readResult = read.run({}, "", "pr", "view", "12", "--json", "state");
  assert.equal(readResult.status, 1, "a refused READ passes through: its answer is wanted now");
  assert.doesNotMatch(readResult.stderr, /QUEUED/);
  assert.equal(readQueue(read.queue).length, 0);

  for (const reply of NOT_A_RATE_LIMIT) {
    const other = host({ reply, status: 1 });
    assert.equal(other.run({}, "", "issue", "comment", "12", "--body", "x").status, 1, `"${reply}" is a failure and stays one`);
    assert.equal(readQueue(other.queue).length, 0);
  }
});

test("#4898 (review): a GraphQL MUTATION in an input file is a write and is queued; a QUERY in one, beside it, is not", () => {
  const MUTATION = '{"query":"mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id } } }"}';
  const QUERY = '{"query":"query { viewer { login } }"}';
  const attempt = (args: string[], files: Record<string, string>, stdin = "") => {
    const h = host({ reply: GRAPHQL_REFUSAL, status: 1, headers: `X-Ratelimit-Reset: ${inOneHour()}\n` });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(h.root, name), text);
    const r = h.run({}, stdin, "api", "graphql", ...args);
    return { status: r.status, held: readQueue(h.queue) };
  };
  const input = attempt(["--input", "mutation.json"], { "mutation.json": MUTATION });
  assert.equal(input.status, QUEUED_EXIT, "`--input mutation.json` is a write, which the argument list alone does not show");
  assert.notEqual(input.held[0].argv[3], "mutation.json", "and the file travels with the call, since the caller's copy may be gone");
  assert.equal(readFileSync(input.held[0].argv[3], "utf8"), MUTATION);
  assert.equal(attempt(["--input=mutation.json"], { "mutation.json": MUTATION }).status, QUEUED_EXIT);
  assert.equal(attempt(["-F", "query=@m.graphql"], { "m.graphql": "mutation { x }" }).status, QUEUED_EXIT, "a field read from a file");
  assert.equal(attempt(["--field=query=@m.graphql"], { "m.graphql": "mutation { x }" }).status, QUEUED_EXIT);
  assert.equal(attempt(["--input", "-"], {}, MUTATION).status, QUEUED_EXIT, "a body on stdin cannot be read first, so it is not shown to be a query");
  assert.equal(attempt(["--input", "absent.json"], {}).status, QUEUED_EXIT, "nor can one that is not there");
  assert.equal(attempt(["-f", "query=mutation { x }"], {}).status, QUEUED_EXIT, "CONTROL: the word in the arguments was always enough");

  const query = attempt(["--input", "query.json"], { "query.json": QUERY });
  assert.equal(query.status, 1, "CONTROL: a query in an input file is a read, passed through and not held");
  assert.equal(query.held.length, 0);
  assert.equal(attempt(["-F", "query=@q.graphql"], { "q.graphql": "query { viewer { login } }" }).status, 1);
});

test("#4898: the wrapper and `refusalKind` agree on every fixture -- one list of phrases in two languages cannot drift unseen", () => {
  const fixtures = [GRAPHQL_REFUSAL, REST_REFUSAL, SECONDARY_REFUSAL, "gh: HTTP 429: Too Many Requests", "You have triggered an abuse detection mechanism",
    "was submitted too quickly", ...NOT_A_RATE_LIMIT];
  const decided: [string, boolean][] = [];
  for (const reply of fixtures) {
    const h = host({ reply, status: 1 });
    decided.push([reply, h.run({}, "", "issue", "comment", "1", "--body", "x").status === QUEUED_EXIT]);
  }
  for (const [reply, queued] of decided) assert.equal(queued, refusalKind(reply) !== null, `wrapper and refusalKind disagree on: ${reply}`);
  assert.equal(decided.filter(([, queued]) => queued).length, 6, "POSITIVE CONTROL: six of the fixtures are refusals and were queued");
  assert.equal(refusalKind(SECONDARY_REFUSAL), "secondary");
  assert.equal(refusalKind(REST_REFUSAL), "primary");
});

test("#4898: a secondary limit waits the declared seconds; a probe that gives no header waits the hour; a body file and a stdin travel with the call", () => {
  const before = Math.floor(Date.now() / 1000);
  const secondary = host({ reply: SECONDARY_REFUSAL, status: 1 });
  secondary.run({ A11Y_GH_QUEUE_SECONDARY_SECONDS: "300" }, "", "issue", "comment", "1", "--body", "x");
  const [s] = readQueue(secondary.queue);
  assert.equal(s.kind, "secondary");
  assert.ok(s.resetAtS >= before + 300 && s.resetAtS <= before + 310, `a secondary limit is the declared 300 s, read ${s.resetAtS - before}`);

  const blind = host({ reply: REST_REFUSAL, status: 1, headers: "" });
  blind.run({}, "", "issue", "comment", "1", "--body", "x");
  const [b] = readQueue(blind.queue);
  assert.equal(b.resource, "core");
  assert.ok(b.resetAtS >= before + 3600 && b.resetAtS <= before + 3610, "no usable header is the hour, the longest a primary pool waits");

  const body = host({ reply: GRAPHQL_REFUSAL, status: 1, headers: `X-Ratelimit-Reset: ${inOneHour()}\n` });
  const scratch = join(body.root, "body.md");
  writeFileSync(scratch, "the PR body");
  body.run({}, "piped stdin", "issue", "create", "--body-file", scratch, "--title", "t", "--body-file", "-");
  const [c] = readQueue(body.queue);
  const copy = c.argv[c.argv.indexOf("--body-file") + 1];
  assert.notEqual(copy, scratch, "the argument names the queue's copy, since the caller's scratch file will be gone");
  assert.equal(readFileSync(copy, "utf8"), "the PR body");
  assert.equal(readFileSync(join(c.dir, `${c.id}.stdin`), "utf8"), "piped stdin");
});

test("#4898: a queue that cannot be written, `A11Y_GH_QUEUE=off` and the gate's own retry all leave the refusal as it was", () => {
  const blocked = host({ reply: GRAPHQL_REFUSAL, status: 1, headers: `X-Ratelimit-Reset: ${inOneHour()}\n` });
  writeFileSync(join(blocked.cfg, QUEUE_DIR), "a file where the directory should be");
  const r = blocked.run({}, "", "issue", "comment", "1", "--body", "x");
  assert.equal(r.status, 1, "the refusal's own status: nothing is claimed that is not true");
  assert.doesNotMatch(r.stderr, /QUEUED/);
  for (const env of [{ A11Y_GH_QUEUE: "off" }, { A11Y_GH_QUEUE_RETRY: "1" }] as Record<string, string>[]) {
    const h = host({ reply: GRAPHQL_REFUSAL, status: 1 });
    assert.equal(h.run(env, "", "issue", "comment", "1", "--body", "x").status, 1);
    assert.equal(readQueue(h.queue).length, 0);
  }
});

// ---- 2. the gate's retry after the reset completes it ------------------------------------------------------------------------

const entryIn = (dir: string, over: Partial<QueuedCall> & { id: string }): QueuedCall => {
  mkdirSync(dir, { recursive: true });
  const call = { dir, argv: ["issue", "comment", "7", "--body", "hello"], then: [], queuedAtS: 1_000_000, resetAtS: 1_000_600, attempts: 0, kind: "primary" as const,
    resource: "graphql", cwd: "", workspace: "-", session: "-", ...over };
  writeFileSync(join(dir, `${call.id}.argv`), call.argv.map((a) => `${a}\0`).join(""));
  writeFileSync(join(dir, `${call.id}.meta`), `queuedAt\t${call.queuedAtS}\nresetAt\t${call.resetAtS}\nattempts\t${call.attempts}\nkind\t${call.kind}\nresource\t${call.resource}\ncwd\t${call.cwd}\nworkspace\t${call.workspace}\nsession\t${call.session}\n`);
  if (over.then) attachFollowUps({ dir, id: call.id }, over.then);
  return call;
};
const AT = (seconds: number) => seconds * 1000;
const recorder = (answer: (argv: string[]) => { status: number | null; stderr: string }) => {
  const seen: string[][] = [];
  const run: RunQueued = (_call, argv) => { seen.push(argv); return answer(argv); };
  return { seen, run };
};

test("#4898: the retry makes nothing BEFORE the reset and makes the call AFTER it, once, and clears it", () => {
  const dir = join(tmpDirForFile("gh-queue-retry-"), "q1");
  entryIn(dir, { id: "1000000-1" });
  const early = recorder(() => ({ status: 0, stderr: "" }));
  assert.deepEqual(retryDue(dir, { nowMs: AT(1_000_599), run: early.run }), []);
  assert.equal(early.seen.length, 0, "nothing is made before the reset");
  assert.equal(readQueue(dir).length, 1, "and the entry is still there");

  const late = recorder(() => ({ status: 0, stderr: "" }));
  const outcomes = retryDue(dir, { nowMs: AT(1_000_600), run: late.run });
  assert.deepEqual(late.seen, [["issue", "comment", "7", "--body", "hello"]], "the same arguments, made once");
  assert.deepEqual(outcomes.map((o) => o.event), ["completed"]);
  assert.equal(readQueue(dir).length, 0);
  assert.deepEqual(readdirSync(dir), [], "every file of the entry is gone");
});

test("#4898: follow-ups run after a success, in order, and NEVER after a refusal; one that fails does not stop the next", () => {
  const dir = join(tmpDirForFile("gh-queue-then-"), "q2");
  const steps = [["pr", "merge", "--auto", "--merge"], ["label", "create", "session:x"], ["pr", "edit", "--add-label", "session:x"]];
  entryIn(dir, { id: "1000000-2", argv: ["pr", "create", "--title", "t"], then: steps });
  const refused = recorder(() => ({ status: 1, stderr: REST_REFUSAL }));
  const again = retryDue(dir, { nowMs: AT(1_000_700), run: refused.run });
  assert.deepEqual(refused.seen, [["pr", "create", "--title", "t"]], "only the call itself: the arm of a PR that does not exist is never made");
  assert.deepEqual(again.map((o) => o.event), ["requeued"]);

  const [held] = readQueue(dir);
  assert.equal(held.attempts, 1);
  assert.equal(held.resetAtS, 1_000_700 + 240, "backs off: 120 s doubled for the second attempt");
  assert.deepEqual(held.then, steps, "the follow-ups stay with it");
  assert.equal(held.queuedAtS, 1_000_000, "the age is kept, so a call that keeps being refused still ages out");

  const ok = recorder((argv) => (argv[0] === "label" ? { status: 1, stderr: "label exists" } : { status: 0, stderr: "" }));
  const done = retryDue(dir, { nowMs: AT(held.resetAtS), run: ok.run });
  assert.deepEqual(ok.seen, [["pr", "create", "--title", "t"], ...steps], "the call, then each follow-up, in order");
  assert.equal(done[0].event, "completed");
  assert.match(done[0].detail, /follow-up\(s\) FAILED: label create/);
  assert.equal(readQueue(dir).length, 0);
});

test("#4898: a failure that is no rate limit, and a call too old, are kept in failed/ with the reason and are NOT made again", () => {
  const dir = join(tmpDirForFile("gh-queue-fail-"), "q3");
  entryIn(dir, { id: "1000000-3" });
  const notFound = recorder(() => ({ status: 1, stderr: "gh: Could not resolve to an Issue (HTTP 404)" }));
  const [outcome] = retryDue(dir, { nowMs: AT(1_000_700), run: notFound.run });
  assert.equal(outcome.event, "failed");
  assert.equal(readQueue(dir).length, 0);
  assert.match(readFileSync(join(dir, "failed", "1000000-3.why"), "utf8"), /exit 1: gh: Could not resolve/);
  assert.ok(existsSync(join(dir, "failed", "1000000-3.argv")), "the call is kept for a person to read");

  entryIn(dir, { id: "1000000-4" });
  const stale = recorder(() => ({ status: 0, stderr: "" }));
  const [old] = retryDue(dir, { nowMs: AT(1_000_000 + 7 * 3600), run: stale.run });
  assert.equal(old.event, "failed");
  assert.equal(stale.seen.length, 0, "a write seven hours old is not made on a guess");

  entryIn(dir, { id: "1000000-5" });
  const killed = recorder(() => ({ status: null, stderr: "" }));
  assert.match(retryDue(dir, { nowMs: AT(1_000_700), run: killed.run })[0].detail, /may have been sent, so it is not made again/);
});

test("#4898: a torn entry (no meta, or no argv) is skipped, never guessed at; at most `limit` calls are made in one tick, oldest first", () => {
  const dir = join(tmpDirForFile("gh-queue-torn-"), "q4");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1-1.argv"), "issue\0comment\0"); // no meta: the wrapper died between the two
  writeFileSync(join(dir, "1-2.meta"), "queuedAt\t1\nresetAt\t2\n"); // no argv
  assert.deepEqual(readQueue(dir), []);
  for (const [n, queuedAtS] of [[3, 1_000_300], [4, 1_000_100], [5, 1_000_200]]) entryIn(dir, { id: `1-${n}`, queuedAtS, resetAtS: 1_000_400 });
  const r = recorder(() => ({ status: 0, stderr: "" }));
  const outcomes = retryDue(dir, { nowMs: AT(1_001_000), run: r.run, limit: 2 });
  assert.deepEqual(outcomes.map((o) => o.id), ["1-4", "1-5"], "the two oldest");
  assert.deepEqual(readQueue(dir).map((c) => c.id), ["1-3"]);
});

test("#4898 END TO END: a refused `gh` write is queued by the wrapper, the gate's tick makes it after the reset from its own directory with its stdin, and clears it", () => {
  const reset = inOneHour();
  const h = host({ reply: GRAPHQL_REFUSAL, status: 1, headers: `X-Ratelimit-Reset: ${reset}\n` });
  // The gate's `gh` is the same wrapper, first on PATH, against the same stub, and the account whose queue it is is named by the directory it was found in.
  const home = join(h.root, "home");
  const account = join(home, "workers", "gh");
  mkdirSync(account, { recursive: true });
  writeFileSync(join(account, "hosts.yml"), "github.com:\n    user: a11ign-ai-workers\n    oauth_token: not-a-token\n");
  const bin = join(h.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nA11Y_GH_REAL=${h.stub} A11Y_GH_READ_CACHE=off A11Y_GH_LEDGER=${join(account, "gh-calls.tsv")} exec sh ${WRAPPER} "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);

  const first = spawnSync("sh", [WRAPPER, "issue", "comment", "7", "--body-file", "-"], { encoding: "utf8", input: "the comment", cwd: h.root,
    env: { PATH: process.env.PATH ?? "", A11Y_GH_REAL: h.stub, GH_CONFIG_DIR: account, HERDR_WORKSPACE_ID: "w9", A11Y_GH_READ_CACHE: "off", A11Y_GH_LEDGER: join(account, "gh-calls.tsv") } });
  assert.equal(first.status, QUEUED_EXIT);
  assert.equal(readQueue(join(account, QUEUE_DIR)).length, 1);
  const before = h.calls();

  const tickEnv = { PATH: `${bin}:${process.env.PATH}`, A11Y_GH_QUEUE_HOME: home };
  const saved = { ...process.env };
  Object.assign(process.env, tickEnv);
  try {
    assert.deepEqual(ghQueueTick({ home, nowMs: (reset + 4) * 1000 }), [], "before the reset: nothing is asked of GitHub");
    assert.equal(h.calls(), before);

    h.set({ reply: "", status: 0 }); // the limit is over
    const said = ghQueueTick({ home, nowMs: (reset + 6) * 1000 });
    assert.equal(said.length, 1);
    assert.match(said[0], /completed .* \[issue comment\]/);
  } finally {
    for (const key of Object.keys(tickEnv)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
  const made = h.calls().slice(before.length);
  assert.match(made, /ARGS<issue><comment><7><--body-file><->/, "the same call");
  assert.match(made, new RegExp(`CWD ${h.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "from the directory it was made in");
  assert.match(made, /IN the comment/, "with the stdin it was given");
  assert.equal(readQueue(join(account, QUEUE_DIR)).length, 0);
  assert.equal(ghQueueTick({ home, nowMs: (reset + 600) * 1000 }).length, 0, "and it is made once");
});

// ---- 3. the 70% alarm ---------------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-10-10T22:00:00Z");
const ledgerLine = (minutesAgo: number, over: Partial<{ account: string; resource: string; cost: number | ""; status: number; command: string; caller: string }> = {}) => {
  const f = { account: "a11ign-ai-workers", resource: "graphql", cost: 1 as number | "", status: 0, command: "pr list", caller: "node /x/src/work-gate.ts", ...over };
  const time = new Date(NOW - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [time, f.account, f.resource, f.cost, f.status, f.command, "w1", f.caller, "-"].join("\t");
};
const spent = (points: number, over: Parameters<typeof ledgerLine>[1] = {}, minutesAgo = 10) => ledgerLine(minutesAgo, { ...over, cost: points });

test("#4898: a pool alarms at 70% of its hour and not a point before; the line names the callers that spent it", () => {
  const under = parseLedger([spent(2000, { caller: "node /x/src/work-gate.ts" }), spent(1499, { caller: "node /x/src/work-tick.ts", command: "issue list" })].join("\n"));
  assert.deepEqual(poolAlarms(under, { nowMs: NOW }), [], "3499 of 5000 is one under the line");

  const at = parseLedger([spent(2000, { caller: "node /x/src/work-gate.ts" }), spent(1499, { caller: "node /x/src/work-tick.ts", command: "issue list" }),
    spent(1, { caller: "zsh -c source /home/a/.claude/shell-snapshots/snapshot-zsh-1-x.sh gh pr view" }, 5)].join("\n"));
  const [alarm] = poolAlarms(at, { nowMs: NOW });
  assert.equal(POOL_POINTS * ALARM_FRACTION, 3500, "the line the test names is the row's 70% of 5,000");
  assert.equal(alarm.used, 3500, "exactly the line: 70% is IN");
  assert.deepEqual(alarm.top.map((t) => [t.caller, t.points]), [["work-gate.ts", 2000], ["work-tick.ts", 1499], ["(a session's shell)", 1]]);
  const said = alarmLine(alarm, NOW);
  assert.match(said, /3500\/5000 graphql points \(70%\)/);
  assert.match(said, /top callers: work-gate\.ts \[pr list\] 2000; work-tick\.ts \[issue list\] 1499/);
  const [parsed] = parseLedger(said);
  assert.equal(parsed.resource, "incident", "an incident spends no point and is read back by the ledger's own parser");
  assert.equal(parsed.command, "pool-70pct graphql");
});

test("#4898: the alarm is per identity and per pool, counts only the last hour, and ignores cache hits, incidents and the queue's own lines", () => {
  const entries = parseLedger([
    spent(3600, { account: "a11ign-ai-workers" }),
    spent(3600, { account: "a11ign-ai-leads" }, 61), // an hour and a minute ago: outside
    spent(3600, { account: "a11ign-ai-leads", resource: "cache" }),
    spent(3600, { account: "a11ign-ai-leads", resource: "incident" }),
    spent(3600, { account: "a11ign-ai-leads", resource: "queue" }),
    ...Array.from({ length: 3600 }, () => ledgerLine(20, { account: "app:workers", resource: "core", cost: "" })), // a REST call is one point each
  ].join("\n"));
  const alarms = poolAlarms(entries, { nowMs: NOW });
  assert.deepEqual(alarms.map((a) => `${a.account}/${a.resource}/${a.used}`), ["a11ign-ai-workers/graphql/3600", "app:workers/core/3600"]);
});

test("#4898: the incident is written once an hour per pool, to the ledger itself, and again when the hour has passed", () => {
  const dir = tmpDirForFile("gh-alarm-");
  const ledger = join(dir, "gh-calls.tsv");
  writeFileSync(ledger, `${spent(3600)}\n`);
  assert.equal(recordPoolAlarms(ledger, NOW).length, 1);
  assert.equal(recordPoolAlarms(ledger, NOW + 5 * 60_000).length, 0, "not again within the hour: one alarm per pool, not one per tick");
  const lines = readFileSync(ledger, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /\tincident\t/);
  assert.equal(recordPoolAlarms(join(dir, "none.tsv"), NOW).length, 0, "no ledger is nothing to alarm on");

  appendLine(ledger, spent(3600, {}, 1), NOW + 61 * 60_000);
  assert.equal(recordPoolAlarms(ledger, NOW + 61 * 60_000).length, 1, "a pool still past the line an hour later alarms again");

  // and through the gate's tick, in a home that has a workers ledger
  const home = join(dir, "home");
  mkdirSync(join(home, "workers", "gh"), { recursive: true });
  writeFileSync(join(home, "workers", "gh", "gh-calls.tsv"), `${spent(3600)}\n`);
  const said = ghQueueTick({ home, nowMs: NOW });
  assert.equal(said.length, 1);
  assert.match(said[0], /pool alarm in .*workers\/gh: 3600\/5000 graphql points \(72%\)/);
});

/** Appends a spend line at an offset from NOW rather than from the fixture's clock (the line's own time, not its age). */
function appendLine(path: string, _line: string, at: number) {
  const time = new Date(at - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const existing = readFileSync(path, "utf8");
  writeFileSync(path, `${existing}${[time, "a11ign-ai-workers", "graphql", 3600, 0, "pr list", "w1", "node /x/src/work-gate.ts", "-"].join("\t")}\n`);
}

// ---- 4. (#4148 residual) the ledger names WHO spent the pool, and the hourly rollup keeps the name --------------------------------------

const LEDGER_CLI = fileURLToPath(new URL("./gh-ledger.ts", import.meta.url));
const ACCOUNT = "a11ign-ai-workers";

/** One ledger line as `host/gh` writes it (nine fields), for a hand-made ledger. */
const written = (time: string, caller: string, over: { resource?: string; cost?: number | ""; command?: string } = {}) =>
  [time, ACCOUNT, over.resource ?? "graphql?", over.cost ?? "", "0", over.command ?? "pr list", "-", caller, "-"].join("\t");

/** `gh-ledger.ts <ledger> --per-hour [--top n]` as a person runs it. */
const readHours = (ledger: string, ...flags: string[]) => {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ledger, "--per-hour", ...flags], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("#4148 residual: a unit started under the crash-exit preload arrives at the ledger WITH its script's name, though preload and path are over 160 characters", () => {
  const h = host();
  // The real shape of a unit: `node --import file:///.../src/lib/crash-exit.ts src/work-gate.ts`. The directory is padded to 110 characters so the
  // preload alone pushes the script's name past the 160th wherever the suite's temp directory is, as the ~100 characters of preload do ahead of the
  // script on the host; the script is named relative to the unit's directory, so that WITHOUT the preload the whole line stays under the cut.
  const base = join(h.root, "units");
  const dir = join(base, "u".repeat(Math.max(1, 110 - base.length - 1)));
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  const preload = join(dir, "src", "lib", "crash-exit.ts");
  writeFileSync(preload, "export {};\n");
  writeFileSync(join(dir, "src", "work-gate.ts"), 'import { spawnSync } from "node:child_process";\nconst r = spawnSync("sh", [process.env.WRAPPER_UNDER_TEST ?? "", "pr", "list"], { stdio: "ignore" });\nprocess.exit(r.status ?? 1);\n');
  const argv = [process.execPath, "--import", pathToFileURL(preload).href, "src/work-gate.ts"];
  const whole = argv.join(" ");
  const bare = [process.execPath, "src/work-gate.ts"].join(" ");
  assert.ok(whole.length > 160 && whole.indexOf("work-gate.ts") >= 160, `POSITIVE CONTROL: the preload must push the name past the cut, or this proves nothing (${whole.indexOf("work-gate.ts")} of ${whole.length})`);
  assert.ok(bare.length < 160, "POSITIVE CONTROL: without its preload the same unit fits, so the preload is what lost the name");
  const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, env: { ...h.env, WRAPPER_UNDER_TEST: WRAPPER }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [entry, ...rest] = parseLedger(readFileSync(h.ledger, "utf8"));
  assert.equal(rest.length, 0, "one call, one line");
  assert.ok(entry.caller.length <= 160, "the cut is still there");
  assert.doesNotMatch(entry.caller, /--import/, "the preload is not what the ledger keeps");
  assert.equal(callerScript(entry.caller), "work-gate.ts", `the script's name reached the reader (caller: ${entry.caller})`);
});

/** Callers of every shape the host sees, read by `callerScript` and, in awk, by the wrapper's rollup: the two must name the same script for each. */
const CALLERS = [
  "/home/agent/.local/opt/node-v24.21.0-linux-x64/bin/node --import file:///home/agent/repos/agent-org/src/lib/crash-exit.ts /home/agent/repos/agent-org/src/work-gate.ts --json",
  "/home/agent/.local/bin/node --import=./src/lib/crash-exit.ts src/work-tick.ts",
  "/home/agent/.local/bin/node  /home/agent/repos/agent-org/src/work-gate.ts",
  "/usr/bin/node -e /* work-gate.ts runBatch */ const { execFile } = require(\"node:child_process\");",
  "/usr/bin/node --import /home/agent/repos/x/register.ts --test /x/src/foo.test.ts",
  "zsh -c source /home/agent/.claude/shell-snapshots/snapshot-zsh-1760000000000-ab12cd.sh && gh pr list",
  "node /x/data.json /x/y/run.mjs", "bash /x/y/deploy.sh now", "python3 /x/tool.py --x", "node scripts/ci-health.ts", "node /x/a.test.ts.bak",
  "herdr server", "claude --model sonnet --effort high", "node", "",
];

test("#4148 residual: the rollup the wrapper writes carries each caller's SCRIPT, the one `callerScript` names, and `--per-hour --top` reads it", () => {
  const h = host();
  const hour = "2026-10-10T18";
  writeFileSync(h.ledger, `${CALLERS.map((c, i) => written(`${hour}:${String(i).padStart(2, "0")}:00Z`, c)).join("\n")}\n`);
  // A bound of one byte drops EVERY line into the rollup, the one this call writes among them.
  const r = h.run({ A11Y_GH_LEDGER_MAX_BYTES: "1", A11Y_GH_LEDGER_NOW: `${hour}:59:00Z`, LEDGER_CALLER: "node /x/src/trigger.ts" }, "", "pr", "list");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(h.ledger, "utf8"), "", "POSITIVE CONTROL: the trim dropped every line, so the rollup is the only place the callers are");
  const rollup = parseRollup(readFileSync(rollupPathOf(h.ledger), "utf8"));
  const expected = new Map<string, number>();
  for (const c of [...CALLERS, "node /x/src/trigger.ts"]) expected.set(callerScript(c), (expected.get(callerScript(c)) ?? 0) + 1);
  assert.deepEqual(new Map(rollup.map((row) => [row.caller, row.calls])), expected, "awk and `callerScript` name the same script for every shape of caller");
  assert.ok(rollup.every((row) => row.hour === hour && row.account === ACCOUNT && row.resource === "graphql" && row.floor === row.calls && row.read === 0));
  assert.equal(expected.get("work-gate.ts"), 3, "CONTROL: the shapes that carry the gate's name (past a preload, double-spaced, in an inline program) all land on it");
  const said = readHours(h.ledger, "--top", "2");
  assert.match(said, new RegExp(`^${hour}Z +${CALLERS.length + 1} calls +0 points read +${CALLERS.length + 1} floor points$`, "m"));
  assert.match(said, /^ +3 floor points \( +0 read\) +3 calls +work-gate\.ts$/m);
  assert.equal(said.split("\n").filter((l) => /^ {4}/.test(l)).length, 2, "--top 2 names two callers for the hour");
  assert.doesNotMatch(readHours(h.ledger), /work-gate/, "without --top the reading is the one it always was");
});

test("#4148 residual: a six-field rollup line is read as it always was, kept six fields by the next trim, and named for what it is: a caller nobody recorded", () => {
  const h = host();
  const old = `2026-10-10T17\t${ACCOUNT}\tgraphql\t400\t0\t400\n2026-10-10T17\t${ACCOUNT}\tcore\t7\t0\t0\n`;
  writeFileSync(rollupPathOf(h.ledger), `${old}2026-10-10T17\t${ACCOUNT}\tgraphql\t40\t0\t40\twork-tick.ts\n`);
  assert.deepEqual(parseRollup(readFileSync(rollupPathOf(h.ledger), "utf8")).map((r) => r.caller), [undefined, undefined, "work-tick.ts"]);
  writeFileSync(h.ledger, `${written("2026-10-10T17:30:00Z", "node /x/src/work-tick.ts")}\n${written("2026-10-10T17:31:00Z", "node /x/src/work-tick.ts")}\n`);
  const r = h.run({ A11Y_GH_LEDGER_MAX_BYTES: "1", A11Y_GH_LEDGER_NOW: "2026-10-10T17:40:00Z", LEDGER_CALLER: "node /x/src/work-tick.ts" }, "", "pr", "list");
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(rollupPathOf(h.ledger), "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
  assert.deepEqual(lines.filter((f) => f.length === 6).map((f) => f.slice(2).join(" ")).sort(), ["core 7 0 0", "graphql 400 0 400"], "the six-field lines are kept as they were");
  assert.deepEqual(lines.filter((f) => f.length === 7).map((f) => f.slice(2).join(" ")), ["graphql 43 0 43 work-tick.ts"], "and the caller's own row adds to its own row only");
  const rollup = parseRollup(readFileSync(rollupPathOf(h.ledger), "utf8"));
  const [hour] = perHourCallers([], rollup, { account: ACCOUNT, resource: "graphql" });
  assert.deepEqual(hour.callers.map((c) => [c.caller, c.calls]), [[NO_CALLER, 400], ["work-tick.ts", 43]]);
  assert.deepEqual(perHour([], rollup, { account: ACCOUNT, resource: "graphql" }), [{ hour: "2026-10-10T17", calls: 443, read: 0, floor: 443 }], "the hour's total never depended on the caller");
  assert.match(readHours(h.ledger, "--account", ACCOUNT, "--resource", "graphql", "--top", "5"), /^ +400 floor points \( +0 read\) +400 calls +\(caller not recorded\)$/m);
});

// #4148 residual (agent-org#742): --by-read. A ledger line as `host/gh` writes it with its verdict (the 10th field); `cache` omitted = a line from before it.
const READ_DIGEST = "3f9a01bc";
const readLine = (cache: string | undefined, over: { resource?: string; command?: string; caller?: string; time?: string; cost?: number | "" } = {}) =>
  [over.time ?? "2026-10-10T17:00:00Z", ACCOUNT, over.resource ?? "graphql?", over.cost ?? 1, "0", over.command ?? "pr list", "w1",
    over.caller ?? "node /x/src/work-gate.ts", "-", ...(cache === undefined ? [] : [cache])].join("\t");

test("#4148 residual: verdictOf reads the wrapper's verdict and refuses any other shape", () => {
  assert.deepEqual(verdictOf("miss-generation-moved:3f9a01bc:77d0e2a4:a11ign_a11ign"),
    { outcome: "miss", why: "generation-moved", argv: "3f9a01bc", repository: "a11ign_a11ign" });
  assert.deepEqual(verdictOf("hit-ttl:3f9a01bc:77d0e2a4:default"), { outcome: "hit", why: "ttl", argv: "3f9a01bc", repository: "default" });
  assert.equal(verdictOf("-"), null, "a call the cache did not look at has no verdict");
  assert.equal(verdictOf("miss-absent:3f9a01bc:77d0e2a4:a11ign_a11ign\tinjected"), null, "a tab inside the field is refused, never guessed");
  assert.equal(verdictOf("miss-absent:3F9A01BC:77d0e2a4:a11ign_a11ign"), null, "digests are lowercase hex only");
});

test("#4148 residual: --by-read groups reads by caller, subcommand, repository and argument digest, whatever their key digests", () => {
  const entries = parseLedger([
    readLine(`miss-generation-moved:${READ_DIGEST}:77d0e2a4:a11ign_a11ign`),
    readLine(`miss-absent:${READ_DIGEST}:11111111:a11ign_a11ign`),
    readLine(`miss-absent:${READ_DIGEST}:22222222:a11ign_a11ign`),
    readLine(`miss-absent:deadbeef:22222222:a11ign_a11ign`, { command: "issue view" }),
  ].join("\n"));
  const report = readGroups(entries);
  assert.equal(report.groups.length, 2, "three key digests on one question are one group; another question is another");
  const [same, other] = report.groups;
  assert.deepEqual([same.caller, same.command, same.repository, same.digest], ["work-gate.ts", "pr list", "a11ign_a11ign", READ_DIGEST]);
  assert.equal(same.calls, 3);
  assert.deepEqual(same.misses, { "generation-moved": 1, absent: 2 });
  assert.deepEqual([other.command, other.digest, other.calls], ["issue view", "deadbeef", 1]);
  assert.deepEqual([report.calls, report.misses, report.hits, report.unknown, report.uncached], [4, 4, 0, 0, 0]);
});

test("#4148 residual: --by-read counts a hit with the group its call made, and under --resource only when that call spent the pool named", () => {
  const hit = readLine(`hit-ttl:${READ_DIGEST}:77d0e2a4:a11ign_a11ign`, { resource: "cache", cost: "" });
  const entries = parseLedger([readLine(`miss-absent:${READ_DIGEST}:77d0e2a4:a11ign_a11ign`), hit].join("\n"));
  assert.deepEqual(readGroups(entries).groups.map((g) => [g.calls, g.hits]), [[2, 1]], "the hit joins its group");
  assert.deepEqual(readGroups(entries, { resource: "graphql" }).groups.map((g) => [g.calls, g.hits]), [[2, 1]], "its call spent graphql, so the hit is in scope");
  const coreOnly = parseLedger(readLine(`hit-ttl:${READ_DIGEST}:77d0e2a4:a11ign_a11ign`, { resource: "cache", cost: "" }));
  assert.deepEqual(readGroups(coreOnly, { resource: "graphql" }).groups, [], "a hit whose group spent no graphql is not a graphql read");
  assert.deepEqual(readGroups(entries, { resource: "core" }).groups, [], "and nothing spent core here");
});

test("#4148 residual: a line with no 10th field is counted as (no verdict), with its caller and command intact", () => {
  const entries = parseLedger([readLine(undefined), readLine(`miss-absent:${READ_DIGEST}:77d0e2a4:a11ign_a11ign`)].join("\n"));
  const report = readGroups(entries);
  assert.equal(report.unknown, 1);
  const [unknown] = report.groups.filter((g) => g.unknown > 0);
  assert.deepEqual([unknown.caller, unknown.command, unknown.repository, unknown.digest, unknown.unknown], ["work-gate.ts", "pr list", NO_VERDICT, "-", 1]);
  const text = renderByRead(report);
  assert.match(text.split("\n")[0], /: 0 hits, 1 misses, 1 with no verdict; 0 calls the cache did not look at$/);
  assert.match(text, /^ {5}1 calls +0 hits {2}work-gate\.ts {2}\[pr list\] {2}\(no verdict\) {2}- {2}misses: \(no verdict\) 1$/m);
});

test("#4148 residual: a '-' line (the cache did not look) is counted only as uncached, never as a read", () => {
  const report = readGroups(parseLedger(readLine("-")));
  assert.deepEqual([report.calls, report.groups.length, report.uncached], [0, 0, 1]);
  assert.equal(renderByRead(report), "gh ledger: no reads recorded; 1 calls the cache did not look at\n");
});

test("#4148 residual: a hostile verdict field holding a tab is refused as (no verdict), and the fields around it are read as they were", () => {
  const hostile = readLine(`miss-absent:${READ_DIGEST}:77d0e2a4:a11ign_a11ign\tinjected`, { command: "api repos/x", caller: "node /x/src/work-tick.ts", cost: 3 });
  const [entry] = parseLedger(hostile);
  assert.deepEqual([entry.command, entry.caller, entry.cost, entry.status, entry.resource], ["api repos/x", "node /x/src/work-tick.ts", 3, 0, "graphql?"], "the other fields are not shifted");
  const report = readGroups([entry]);
  assert.deepEqual([report.misses, report.unknown, report.groups[0].repository, report.groups[0].digest], [0, 1, NO_VERDICT, "-"], "it is not a miss, and nothing is guessed from it");
});

test("#4148 residual: renderByRead prints the header with the window and the scope, and says so when there are no reads", () => {
  const report = readGroups(parseLedger([readLine(`miss-absent:${READ_DIGEST}:77d0e2a4:a11ign_a11ign`), readLine("-")].join("\n")), { account: ACCOUNT, resource: "graphql" });
  assert.equal(renderByRead(report, { account: ACCOUNT, resource: "graphql" }),
    `gh ledger reads: 1 reads, 2026-10-10T17:00:00Z .. 2026-10-10T17:00:00Z, account ${ACCOUNT}, resource graphql: 0 hits, 1 misses, 0 with no verdict; 1 calls the cache did not look at\n` +
    `     1 calls       0 hits  work-gate.ts  [pr list]  a11ign_a11ign  ${READ_DIGEST}  misses: absent 1\n`);
  assert.equal(renderByRead(readGroups([]), { account: ACCOUNT }), `gh ledger: no reads recorded, account ${ACCOUNT}; 0 calls the cache did not look at\n`);
});

// ---- (a11ign#4777) the app-token mint, run through the wrapper -------------------------------------------------------------------------
// The wrapper is rendered with a `managers` App declared, and the minter is a stub the test writes; `gh-real` prints the `GH_TOKEN` it was
// handed, so the test sees which token the call went out on, and the incident line is read back from the ledger.
const APP_WRAPPER = (() => {
  const rendered = join(tmpDirForFile("gh-ledger-4777-render-"), "gh");
  const declared = `case "$1" in managers) app_id=1; app_key=/nonexistent/managers.pem; app_inst=2; app_slug=a11ign-managers ;; *) return 1 ;; esac`;
  writeFileSync(rendered, WRAPPER_TEXT.replace(/@@([A-Za-z0-9]+)@@/g, (_, name: string) => (name === "appDeclared" ? declared : `/nonexistent/${name}`)), { mode: 0o755 });
  return rendered;
})();

/** One `pr list` through the wrapper as `managers`, with a minter whose body is `minter` (sh). Returns the stdout and the incident lines. */
function appCall(minter: string) {
  const root = tmpDir("gh-ledger-4777-");
  mkdirSync(join(root, "cfg"));
  writeFileSync(join(root, "cfg", "hosts.yml"), "github.com:\n    user: a11ign-ai-leads\n    oauth_token: not-a-token\n");
  const stub = join(root, "gh-real");
  writeFileSync(stub, "#!/bin/sh\necho \"token=${GH_TOKEN:-none}\"\n", { mode: 0o755 });
  const script = join(root, "mint.sh");
  writeFileSync(script, `#!/bin/sh\ncat > /dev/null\n${minter}\n`, { mode: 0o755 });
  const ledger = join(root, "cfg", "gh-calls.tsv");
  // a manager's list is read from the gate's snapshot unless it names a short --limit and light --json (#1517): the call is that form
  const r = spawnSync("sh", [APP_WRAPPER, "pr", "list", "--json", "number", "--limit", "30"], { encoding: "utf8", cwd: root, env: {
    PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: join(root, "cfg"), HERDR_WORKSPACE_ID: "w9", AGENT_ORG_GH_ROLE: "managers",
    A11Y_APP_ROLES: "managers", A11Y_APP_TOKEN_DIR: join(root, "tokens"), A11Y_APP_NODE: "sh", A11Y_APP_TOKEN_SCRIPT: script,
    A11Y_GH_READ_CACHE: "off", A11Y_GH_LEDGER: ledger,
  } });
  const incidents = existsSync(ledger) ? parseLedger(readFileSync(ledger, "utf8")).filter((e) => e.resource === "incident") : [];
  return { stdout: r.stdout, incidents };
}

test("a11ign#4777: a token the minter prints is used when it carries dots, as GitHub's installation tokens do, and a mint that worked is no incident", () => {
  const call = appCall("printf %s 'ghs_ab.cd-ef_12.34'");
  assert.equal(call.stdout, "token=ghs_ab.cd-ef_12.34\n", "the call went out on the App's minted token, not the account's");
  assert.deepEqual(call.incidents, [], "no incident for a mint that worked");
});

test("a11ign#4777: a mint that exits with nothing on stderr is an incident that names its exit status, never the bare 'no reason given'", () => {
  const call = appCall("exit 124");
  assert.equal(call.stdout, "token=none\n", "the call went through as the account, as it always did");
  assert.equal(call.incidents.length, 1, "one incident for the one failed mint");
  const caller = call.incidents[0]?.caller ?? "";
  assert.match(caller, /app-token managers failed, fell back to the account: nothing on stderr \(exit 124\)$/);
  assert.doesNotMatch(caller, /no reason given/);
});

test("a11ign#4777: the reason is the first stderr line that says anything, with a token-shaped word blanked, and the exit status follows it", () => {
  const call = appCall("printf '\\nminter: POST answered 401 for ghs_secret.word-1\\n' >&2; exit 1");
  assert.equal(call.incidents.length, 1, "one incident");
  const caller = call.incidents[0]?.caller ?? "";
  assert.match(caller, /fell back to the account: minter: POST answered 401 for <token> \(exit 1\)$/, "the blank first line is skipped and the exit status is named");
  assert.doesNotMatch(caller, /ghs_secret/, "a token is never written to the ledger");
});

test("a11ign#4777: a minter that exits 0 but prints no usable token is an incident that says so, with its real exit status", () => {
  const call = appCall("exit 0");
  assert.equal(call.stdout, "token=none\n");
  assert.equal(call.incidents.length, 1, "one incident");
  assert.match(call.incidents[0]?.caller ?? "", /exited 0 but printed no usable token \(exit 0\)$/);
});

test("#1482: a counter-less line between two readings of ONE reset window is shared out between them, with another window's readings in between", () => {
  const COUNTED = (time: string, used: number, reset: number) => [time, "app:scheduler", "graphql", "", "0", "api graphql", "-", "/usr/bin/node /x/src/work-gate.ts", "-", "-", String(used), String(reset)].join("\t");
  const PR_LIST = (time: string) => [time, "app:scheduler", "graphql?", "", "0", "pr list", "-", "/usr/bin/node /x/src/work-gate.ts", "-", "-", "-", "-"].join("\t");
  // window A resets at 1791925000 and window B at 1791928600, and the pool's counter is read in both. The `pr list` sits between A's two readings
  // (A moved 100 -> 104) and B's reading sits between them too (B moved 500 -> 530): one account, two windows, the same movement either side.
  const entries = parseLedger([
    COUNTED("2026-10-13T20:00:00Z", 100, 1791925000),
    COUNTED("2026-10-13T20:00:30Z", 500, 1791928600),
    PR_LIST("2026-10-13T20:01:00Z"),
    COUNTED("2026-10-13T20:01:30Z", 104, 1791925000),
    COUNTED("2026-10-13T20:02:00Z", 530, 1791928600),
  ].join("\n"));
  const settled = settle(entries);
  assert.deepEqual(settled.map((e) => e.cost), [null, null, 2, 2, 30],
    "A's 4 points are shared between the `pr list` and the reading that closed the gap; B's 30 are its own reading's, the only call in its gap; the two baselines stay floors");
  assert.deepEqual(settled.map((e) => e.settled), [undefined, undefined, "shared", "shared", "read"]);
});

test("#1482: another window's BASELINE between a counter-less line and the next reading of its own window does not clear the line's share (agent-org#1500 review)", () => {
  const COUNTED = (time: string, used: number, reset: number) => [time, "app:scheduler", "graphql", "", "0", "api graphql", "-", "/usr/bin/node /x/src/work-gate.ts", "-", "-", String(used), String(reset)].join("\t");
  const PR_LIST = (time: string) => [time, "app:scheduler", "graphql?", "", "0", "pr list", "-", "/usr/bin/node /x/src/work-gate.ts", "-", "-", "-", "-"].join("\t");
  // A baseline, the `pr list`, then B's FIRST reading (its baseline), then A's second reading: A moved 100 -> 104 across the `pr list`, so the 4 points are
  // shared between it and A's reading. B's baseline is a floor and does not take the line; B's later reading is its own 30 points, and the line is not its.
  const entries = parseLedger([
    COUNTED("2026-10-13T20:00:00Z", 100, 1791925000),
    PR_LIST("2026-10-13T20:00:30Z"),
    COUNTED("2026-10-13T20:00:45Z", 500, 1791928600),
    COUNTED("2026-10-13T20:01:00Z", 104, 1791925000),
    COUNTED("2026-10-13T20:02:00Z", 530, 1791928600),
  ].join("\n"));
  const settled = settle(entries);
  assert.deepEqual(settled.map((e) => e.cost), [null, 2, null, 2, 30]);
  assert.deepEqual(settled.map((e) => e.settled), [undefined, "shared", undefined, "shared", "read"]);
});

// ---- agent-org#1618: a ledger line names the read -------------------------------------------------------------------------------------------------------------------------------

const ISSUE_CLOSERS = '{ repository(owner: "a11ign", name: "agent-org") { issue(number: 7) { closedByPullRequestsReferences(first: 20) { nodes { number state mergedAt } } } } }';
const commandsOf = (ledger: string) => parseLedger(readFileSync(ledger, "utf8")).map((e) => e.command);

test("agent-org#1618: the wrapper names the read an `api graphql` call made, in the command field, and the reader takes the name off it", () => {
  const h = host();
  assert.equal(h.run({}, "", "api", "graphql", "-f", `query=${ISSUE_CLOSERS}`).status, 0);
  assert.equal(h.run({}, "", "api", "graphql", "-f", "query=query ClosedRows($o:String!){ repository(owner:$o){ issues(first:100){ nodes{ id } } } }", "-f", "o=a").status, 0);
  assert.equal(h.run({}, "", "api", "graphql", "-F", "query=query{ rateLimit{cost} repositoryOwner(login:\"x\"){ projectV2(number:3){ items(first:100){ nodes{ id } } } } }").status, 0);
  const file = join(h.root, "q.graphql");
  writeFileSync(file, "{ viewer { login } }");
  assert.equal(h.run({}, "", "api", "graphql", "-F", `query=@${file}`).status, 0);
  assert.equal(h.run({}, "", "pr", "list").status, 0);
  assert.deepEqual(commandsOf(h.ledger), [
    "api graphql repository.issue.closedByPullRequestsReferences",
    "api graphql ClosedRows",
    "api graphql repositoryOwner.projectV2.items",
    "api graphql viewer",
    "pr list",
  ]);
  const entries = parseLedger(readFileSync(h.ledger, "utf8"));
  assert.deepEqual(entries.map((e) => e.query), ["repository.issue.closedByPullRequestsReferences", "ClosedRows", "repositoryOwner.projectV2.items", "viewer", undefined], "`pr list` carries no query key");
  assert.equal(entries[0].resource, "graphql", "naming the read leaves the call priced as the pool's");
});

test("agent-org#1618: a graphql call whose body the wrapper cannot read stays `api graphql` -- never a guess -- and a name cannot carry a tab or text of the query", () => {
  const h = host();
  const body = join(h.root, "body.json");
  writeFileSync(body, JSON.stringify({ query: ISSUE_CLOSERS }));
  assert.equal(h.run({}, "", "api", "graphql", "--input", body).status, 0);
  assert.equal(h.run({}, "", "api", "graphql", "-F", "query=@/nonexistent/q.graphql").status, 0);
  assert.equal(h.run({}, "", "api", "graphql", "-f", "query=this is not a query").status, 0);
  assert.equal(h.run({}, "", "api", "graphql", "-f", "query={ evil\tfield\n(x:\"; rm -rf /\") { a } }").status, 0);
  const lines = readFileSync(h.ledger, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 4, "one call, one line, whatever the query held");
  assert.deepEqual(commandsOf(h.ledger).slice(0, 3), ["api graphql", "api graphql", "api graphql"]);
  assert.ok(commandsOf(h.ledger)[3].split(" ").every((w, i) => i < 2 || /^[A-Za-z0-9_.]*$/.test(w)), "only identifiers reach the line");
  assert.ok(lines.every((l) => l.split("\t").length === 12), "the field count is the one every older reader expects");
});

test("agent-org#1618: a line from before the name was kept still parses, as the unnamed read", () => {
  const old = ["2026-10-16T13:00:00Z", "app:scheduler", "graphql", "", "0", "api graphql", "-", "node /x/src/work-gate.ts", "-", "-", "10", "99"].join("\t");
  const fresh = ["2026-10-16T13:00:01Z", "app:scheduler", "graphql", "", "0", "api graphql repository.issues", "-", "node /x/src/work-gate.ts", "-", "-", "12", "99"].join("\t");
  const [a, b] = parseLedger(`${old}\n${fresh}\n`);
  assert.deepEqual([a.command, a.query, a.used, a.reset], ["api graphql", undefined, 10, 99], "the old line is the entry it always was");
  assert.deepEqual([b.command, b.query, b.used, b.reset], ["api graphql repository.issues", "repository.issues", 12, 99], "the counter is still taken off the END of a named line");
});

test("agent-org#1618: topQueries ranks the reads by points inside the window, counts a nameless call as such, and `topSpender` says which read", () => {
  const T = (min: number) => new Date(NOW - min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const line = (min: number, command: string, cost: number | "") => [T(min), ACCOUNT, "graphql", cost, "0", command, "w1", "node /x/src/work-gate.ts", "-"].join("\t");
  const entries = parseLedger([
    line(30, "api graphql repository.issues", 4), line(29, "api graphql repository.issues", 4), line(28, "api graphql viewer", 1),
    line(27, "api graphql", 2), line(26, "pr list", 1), line(200, "api graphql repository.issues", 500),
  ].join("\n"));
  const rows = topQueries(entries, { account: ACCOUNT, since: NOW - 60 * 60_000, until: NOW });
  assert.deepEqual(rows.map((r) => [r.query, r.calls, r.points]), [["repository.issues", 2, 8], [UNNAMED_QUERY, 1, 2], ["viewer", 1, 1]], "`pr list` is not a graphql call by name, and the old call outside the window is not counted");
  assert.deepEqual(topQueries(entries, { account: "someone-else" }), []);
  const spender = topSpender(entries, { account: ACCOUNT, now: NOW });
  assert.match(`${spender?.command}`, /^api graphql repository\.issues$/, "the spender is the read, not `api graphql`");
  const text = renderByQuery(rows, { account: ACCOUNT, since: NOW - 60 * 60_000, until: NOW });
  assert.match(text, /4 graphql calls, 11 points in .*account a11ign-ai-workers\n/);
  assert.match(text, /8 pts .*2 calls .*repository\.issues\n/);
  assert.match(renderByQuery([]), /no graphql calls/);
});

test("agent-org#1618: `--by-query` is the command that prints the table for a window", () => {
  const h = host();
  assert.equal(h.run({}, "", "api", "graphql", "-f", `query=${ISSUE_CLOSERS}`).status, 0);
  const run = (...flags: string[]) => spawnSync(process.execPath, [LEDGER_CLI, h.ledger, "--by-query", ...flags], { encoding: "utf8" });
  const all = run();
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /1 graphql calls, 1 points/);
  assert.match(all.stdout, /repository\.issue\.closedByPullRequestsReferences\n$/);
  assert.match(run("--since", "2999-01-01T00:00:00Z").stdout, /no graphql calls/, "the window bounds the table");
  assert.equal(run("--since", "not a time").status, 2);
});
