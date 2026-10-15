// no-token: gh -- the wrapper is RUN here, against a stub `gh-real` the test writes (`A11Y_GH_REAL`); no real `gh` starts and
// nothing reaches the network or any account's config.
//
// #4148: THE INSTRUMENT THE GRAPHQL-HOUR READINGS USE. `gh-ledger.ts --per-hour` buckets ONE account's ONE resource by UTC hour, keeps the points the responses
// REPORTED apart from the one-point FLOOR, and an hourly rollup that `host/gh` writes as the 2 MiB trim drops lines keeps a reading for an hour the ledger no longer
// holds. IT GUARDS THE INSTRUMENT, NOT THE SAVING: the saving is read off the live ledger, on the row.
//
// THE POSITIVE CONTROL for "the rollup survives the trim" is the ledger ALONE: after the trim it holds fewer lines than were written, so a rollup that counted nothing
// would show up as a total short of what the wrapper was called.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callerScript, parseLedger, parseRollup, perHour, renderPerHour, rollupPathOf, settle, spenderPhrase, topSpender } from "../gh-ledger.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";
import { workGateSource } from "../lib/work-gate-source.ts";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health-auto-off-refusal.test.ts` says why): `org-health.ts` resolves the checkout it serves when it is imported, and with no
// `$AGENT_ORG_HOST` that is wherever the suite happens to be run from, which refuses. The host file is set FIRST and the tool imported AFTER it, so the acceptance command as written runs.
const SCRATCH = tmpDirForFile("gh-per-hour-project-");
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/org-health/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture",
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { poolLowReading } = await import("../org-health.ts");

const WORKERS = "a11ign-ai-workers";
const LEADS = "a11ign-ai-leads";
const COST = 3;
const COSTED_BODY = `{"data":{},"rateLimit":{"remaining":4990,"cost":${COST},"resetAt":"2026-10-08T15:00:00Z"}}`;

/** One ledger line as `host/gh` writes it (nine fields); `cost` is the field a costed response fills. */
const line = (time: string, { account = WORKERS, resource = "graphql", cost = "", command = "pr list", caller = "/usr/bin/node /x/src/work-gate.ts" } = {}) =>
  [time, account, resource, cost, "0", command, "-", caller, "-"].join("\t");

test("#4148: --per-hour buckets one account's one resource by UTC hour, with the points READ apart from the floor", () => {
  const entries = parseLedger([
    line("2026-10-08T13:00:00Z"), line("2026-10-08T13:59:59Z"), line("2026-10-08T13:30:00Z", { cost: "5" }),
    line("2026-10-08T14:00:00Z", { resource: "graphql?" }),
    line("2026-10-08T13:10:00Z", { resource: "core" }), line("2026-10-08T13:11:00Z", { account: LEADS }),
  ].join("\n"));
  const hours = perHour(entries, [], { account: WORKERS, resource: "graphql" });
  assert.deepEqual(hours, [
    { hour: "2026-10-08T13", calls: 3, read: 5, floor: 7 }, // two unreported (1 + 1) and one that reported 5
    { hour: "2026-10-08T14", calls: 1, read: 0, floor: 1 }, // `graphql?` is the same pool, inferred
  ]);
  assert.equal(renderPerHour(hours).split("\n").filter(Boolean).length, 2, "one line per hour");
  assert.match(renderPerHour(hours), /^2026-10-08T13Z +3 calls +5 points read +7 floor points$/m);
  assert.match(renderPerHour([]), /no calls recorded/, "an account with nothing says so rather than printing an empty reading");
});

test("#4148: the rollup is ADDED to the ledger's lines, so an hour present in both is one reading and not two", () => {
  const rollup = parseRollup("2026-10-08T13\t" + WORKERS + "\tgraphql\t10\t4\t12\nnot a rollup line\n2026-10-08T13\t" + WORKERS + "\tgraphql\tx\t1\t1\n");
  assert.equal(rollup.length, 1, "a malformed row is skipped, as a half ledger line is");
  const hours = perHour(parseLedger(line("2026-10-08T13:50:00Z")), rollup, { account: WORKERS, resource: "graphql" });
  assert.deepEqual(hours, [{ hour: "2026-10-08T13", calls: 11, read: 4, floor: 13 }]);
});

/** The wrapper's text with its placeholders filled; every path it uses is overridden by an environment variable below. */
const WRAPPER = (() => {
  const text = readFileSync(fileURLToPath(new URL("../../host/gh", import.meta.url)), "utf8");
  const rendered = join(tmpDirForFile("gh-per-hour-render-"), "gh");
  writeFileSync(rendered, text.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

const host = () => {
  const root = tmpDir("gh-per-hour-4148-");
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, "hosts.yml"), `github.com:\n    user: ${WORKERS}\n    oauth_token: not-a-token\n`);
  const stub = join(root, "gh-real");
  // (agent-org#1395) answers the `-i` the wrapper puts after `graphql` as `gh` does, with the pool's counter `STUB_USED` names, and no head when none is named
  writeFileSync(stub, ["#!/bin/sh",
    `[ "$3" = -i ] && [ -n "$STUB_USED" ] && printf 'HTTP/2.0 200 OK\\r\\nX-Ratelimit-Resource: graphql\\r\\nX-Ratelimit-Used: %s\\r\\nX-Ratelimit-Reset: 1791925000\\r\\n\\r\\n' "$STUB_USED"`,
    `[ "$1 $2" = "api graphql" ] && printf '%s' "$STUB_BODY"`, "exit 0", ""].join("\n"), { mode: 0o755 });
  const ledger = join(cfg, "gh-calls.tsv");
  const extra: Record<string, string> = {};
  const call = (now: string, ...args: string[]) => spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", input: "",
    env: { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, A11Y_GH_LEDGER_NOW: now, A11Y_GH_LEDGER_MAX_BYTES: "1500", A11Y_GH_READ_CACHE: "off", STUB_BODY: COSTED_BODY, ...extra } });
  return { ledger, call, extra };
};

test("#4148: a rollup written as the trim drops lines keeps every hour: the ledger plus the rollup count every call made", () => {
  const h = host();
  const hours = ["2026-10-08T13", "2026-10-08T14", "2026-10-08T15"];
  let written = 0;
  for (const hour of hours) {
    for (let i = 0; i < 6; i += 1) {
      const r = h.call(`${hour}:0${i}:00Z`, "api", "graphql", "-f", "query=query{viewer{login}}"); // costed: 3 points read
      assert.equal(r.status, 0);
      written += 1;
      const r2 = h.call(`${hour}:1${i}:00Z`, "pr", "list"); // uncosted graphql?: 1 point floor
      assert.equal(r2.status, 0);
      written += 1;
    }
  }
  const kept = parseLedger(readFileSync(h.ledger, "utf8"));
  assert.ok(kept.length < written, `POSITIVE CONTROL: the trim must have dropped lines (${kept.length} kept of ${written}), or this proves nothing`);
  assert.ok(existsSync(rollupPathOf(h.ledger)), "the trim wrote a rollup beside the ledger");
  const rows = perHour(kept, parseRollup(readFileSync(rollupPathOf(h.ledger), "utf8")), { account: WORKERS });
  const total = rows.reduce((sum, r) => sum + r.calls, 0);
  assert.equal(total, written, "every call is in exactly one of the two files");
  for (const hour of hours) {
    const row = rows.find((r) => r.hour === hour);
    assert.deepEqual(row && { calls: row.calls, read: row.read, floor: row.floor }, { calls: 12, read: 6 * COST, floor: 6 * COST + 6 }, `${hour}: the reading survived the trim`);
  }
  const lines = readFileSync(rollupPathOf(h.ledger), "utf8").split("\n").filter(Boolean);
  assert.equal(new Set(lines.map((l) => l.split("\t").slice(0, 3).join("\t"))).size, lines.length, "merged on every trim: one row per hour, account and resource, never one per trim");
});

test("#1482: the rollup a trim writes holds what `settle` makes of the dropped lines: counter-less lines are shared out, not left at the floor", () => {
  const h = host();
  const R1 = 1791925000;
  const R2 = 1791928600;
  const pool: Record<number, number> = { [R1]: 100, [R2]: 500 };
  // one account, two reset windows at once; every fourth graphql call is in window B, a `pr list` (no counter, a `graphql?` line) comes between them, and a
  // costed response shows its own cost now and then. The counter moves by 2 per graphql call in its window and by 1 for each `pr list` (unseen, so in window A).
  const counted = (time: string, used: number, reset: number, cost = "") =>
    [time, WORKERS, "graphql", cost, "0", "api graphql", "-", "/usr/bin/node /x/src/work-gate.ts", "-", "-", String(used), String(reset)].join("\t");
  const fixture: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const time = `2026-10-13T20:${String(i).padStart(2, "0")}:00Z`;
    if (i % 3 === 2) {
      pool[R1] += 1;
      fixture.push(line(time, { resource: "graphql?", command: "pr list" }));
      continue;
    }
    const reset = i % 4 === 0 ? R2 : R1;
    pool[reset] += 2;
    fixture.push(counted(time, pool[reset], reset, i % 7 === 0 ? String(COST) : ""));
  }
  const fixtureText = `${fixture.join("\n")}\n`;
  writeFileSync(h.ledger, fixtureText);
  // the fixture is past the bound, so this call's line is appended and the trim drops the older half of the file
  assert.equal(h.call("2026-10-13T21:00:00Z", "pr", "list").status, 0);
  const kept = readFileSync(h.ledger, "utf8");
  const appended = kept.slice(kept.lastIndexOf("\n", kept.length - 2) + 1);
  const keptFixture = kept.slice(0, kept.length - appended.length);
  assert.ok(fixtureText.endsWith(keptFixture), "POSITIVE CONTROL: what the trim kept is the newest lines of the fixture, whole");
  const dropped = fixtureText.slice(0, fixtureText.length - keptFixture.length);
  assert.ok(dropped.split("\n").filter(Boolean).length >= 20, "POSITIVE CONTROL: the trim dropped the older lines");
  const shared = settle(parseLedger(dropped)).filter((e) => e.settled === "shared").length;
  assert.ok(shared > 0, "POSITIVE CONTROL: some counter-less lines sit between two readings of one window in the dropped half");
  const actual = perHour([], parseRollup(readFileSync(rollupPathOf(h.ledger), "utf8")), { account: WORKERS, resource: "graphql" });
  const expected = perHour(parseLedger(dropped), [], { account: WORKERS, resource: "graphql" });
  assert.deepEqual(actual, expected, "the rollup is what `settle` makes of the same lines, hour by hour, read and floor alike");
});

test("#4148: the CLI prints the per-hour reading from a ledger and its rollup", () => {
  const dir = tmpDirForFile("gh-per-hour-cli-");
  const ledger = join(dir, "gh-calls.tsv");
  writeFileSync(ledger, `${line("2026-10-08T14:00:00Z")}\n`);
  writeFileSync(rollupPathOf(ledger), `2026-10-08T13\t${WORKERS}\tgraphql\t2026\t0\t2026\n`);
  const cli = fileURLToPath(new URL("../gh-ledger.ts", import.meta.url));
  const r = spawnSync(process.execPath, [cli, ledger, "--per-hour", "--account", WORKERS, "--resource", "graphql"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^2026-10-08T13Z +2026 calls +0 points read +2026 floor points$/m, "the 13:00Z baseline is reproduced from the rollup");
  assert.match(r.stdout, /^2026-10-08T14Z +1 calls/m);
});

const NOW = Date.parse("2026-10-08T15:30:00Z");

test("#4148: topSpender names the script with the most points in the last hour, and says nothing for an hour with none", () => {
  const entries = parseLedger([
    ...Array.from({ length: 5 }, (_, i) => line(`2026-10-08T15:0${i}:00Z`, { caller: "/usr/bin/node -e /* work-gate.ts runBatch */ const { execFile }" })),
    line("2026-10-08T15:10:00Z", { command: "issue list", caller: "/usr/bin/node /x/src/work-tick.ts" }),
    line("2026-10-08T13:00:00Z", { caller: "/usr/bin/node /x/src/old.mjs" }), // outside the hour
    line("2026-10-08T15:11:00Z", { resource: "core" }), // another pool
  ].join("\n"));
  const top = topSpender(entries, { account: WORKERS, now: NOW });
  assert.equal(top?.caller, "work-gate.ts", "a `node -e` batch worker is named for its script, not left as /usr/bin/node");
  assert.deepEqual([top?.points, top?.total], [5, 6]);
  assert.equal(topSpender(entries, { account: WORKERS, now: Date.parse("2026-10-09T15:30:00Z") }), null);
});

test("#4148: the gate's batch worker NAMES ITSELF to the ledger (the 852 calls that read /usr/bin/node)", () => {
  const gate = workGateSource();
  const worker = gate.match(/const BATCH_WORKER = `([\s\S]*?)`;/)?.[1];
  assert.ok(worker, "POSITIVE CONTROL: the worker text was found");
  const cmdline = `/usr/bin/node -e ${worker.replace(/\s+/g, " ")}`.slice(0, 160); // the ledger keeps 160 characters of the caller
  assert.equal(callerScript(cmdline), "work-gate.ts");
  assert.equal(callerScript("/usr/bin/node -e const { execFile } = require(\"node:child_process\"); const one"), "/usr/bin/node", "the control: without the name it IS the unnamed caller");
});

test("#4148: api-pool-low names its spender, and says UNREADABLE rather than nothing when the ledger cannot be read", () => {
  const pools = [{ account: WORKERS, resource: "graphql", remaining: 100, limit: 5000, resetAt: "2026-10-08T16:00:00Z" }];
  const named = poolLowReading({ pools, spenderOf: (account) => spenderPhrase("/ledger", account, NOW, () => [
    line("2026-10-08T15:01:00Z"), line("2026-10-08T15:02:00Z"), line("2026-10-08T15:03:00Z", { command: "issue list", caller: "/usr/bin/node /x/src/work-tick.ts" })].join("\n")) });
  assert.equal(named.status, "tripped");
  assert.match(named.detail, /Spender: a11ign-ai-workers's last hour \(3 floor points\): top caller work-gate\.ts \[pr list\], 2 points \(67%\)/);
  assert.match(named.detail, /20% of their limit/, "the 20%-per-account, real-header reading stays as built");
  const unread = poolLowReading({ pools, spenderOf: () => null });
  assert.match(unread.detail, /Spender: .*UNREADABLE/);
  const unchanged = poolLowReading({ pools: [{ ...pools[0], remaining: 1000 }], spenderOf: () => "x" });
  assert.equal(unchanged.status, "clear", "a pool at 20% is not raised, so no spender is looked up");
  const core = poolLowReading({ pools: [{ ...pools[0], resource: "core" }], spenderOf: () => "should not appear" });
  assert.doesNotMatch(core.detail, /Spender/, "the ledger's points are GraphQL's: a core pool is not blamed on them");
  assert.equal(named.discriminator, poolLowReading({ pools, spenderOf: () => null }).discriminator, "the spender is in the detail only: one spent window is still one signal");
});

// --- agent-org#1395: THE LEDGER ACCOUNTS FOR THE POOL, BY ITS OWN COUNTER ---------------------------------------------------------------------------------------------------
//
// MEASURED 2026-10-13 (`a11ign-scheduler[bot]`, window 19:08:25Z..20:08:25Z): the pool went from full to 5 of 5000, and the ledger held 1,557 graphql lines for it, NOT ONE
// with a `cost` (`awk -F'\t' '$4 != ""' gh-calls.tsv | wc -l` was 0 over the whole file), so every line read as the one-point floor: 1,557 of ~5,000, 30%. A response names its
// cost only when the query asked for `rateLimit { cost }`, and `gh pr list` and `gh issue view` build their own; the counter in the response head is the pool's own.

test("agent-org#1395: through the wrapper, an hour the responses never costed is accounted for by the pool's counter, within 10%", () => {
  const h = host();
  const bare = '{"data":{"viewer":{"login":"x"}}}'; // a query that did not ask for rateLimit { cost }: the case of every line in the measured hour
  h.extra.STUB_BODY = bare;
  // the counter after each call, as the pool reported it: [used after, the call]. The `pr list` is asked without `-i` and carries no counter; the 7 points the counter
  // moves over `pr list` + `api graphql` are the two of them together (an inference, said as one), and 15 -> 16 is a plain point.
  const script: [string | null, string[]][] = [
    ["1", ["api", "graphql"]],            // the window's first reading: a baseline, never a movement (the pool's first point is this call's own)
    ["8", ["api", "graphql"]],            // 7 read off the counter
    [null, ["pr", "list"]],
    ["15", ["api", "graphql"]],           // 7 more, between a `pr list` and this call: shared, 4 and 3
    ["16", ["api", "graphql"]],           // 1
  ];
  script.forEach(([used, args], i) => {
    if (used === null) delete h.extra.STUB_USED; else h.extra.STUB_USED = used;
    assert.equal(h.call(`2026-10-13T20:0${i}:00Z`, ...args).status, 0);
  });
  const text = readFileSync(h.ledger, "utf8");
  const entries = parseLedger(text);
  assert.equal(entries.length, 5, "POSITIVE CONTROL: every call wrote a line");
  assert.deepEqual(entries.map((e) => e.used), [1, 8, undefined, 15, 16], "the wrapper wrote the counter the head carried, and none where it asked for none");
  const POOL_USED = 16; // the last response's own X-Ratelimit-Used
  const now = Date.parse("2026-10-13T20:10:00Z");
  const settled = topSpender(entries, { account: WORKERS, now });
  assert.ok(settled !== null && Math.abs(settled.total - POOL_USED) <= POOL_USED * 0.1,
    `the ledger accounts for ${settled?.total} of the pool's ${POOL_USED}, within 10%`);
  assert.equal(settled?.total, POOL_USED, "and here, with every movement placed on a call, exactly");
  assert.deepEqual(settled?.counted, { read: 8, shared: 7, floor: 1, unplaced: 0 }, "7 + 1 read off the counter; 7 shared between the `pr list` and the call that closed the gap; the baseline stays a floor point");
  // THE CONTROL: the same five calls with the counter cut off the lines read as they did, one point each
  const floor = topSpender(parseLedger(text.split("\n").filter(Boolean).map((l) => l.split("\t").slice(0, 10).join("\t")).join("\n")), { account: WORKERS, now });
  assert.equal(floor?.total, 5, "CONTROL: without the counter the ledger says 5 of the pool's 16, which is the defect");
  const [hour] = perHour(entries, [], { account: WORKERS, resource: "graphql" });
  assert.deepEqual({ calls: hour.calls, read: hour.read, floor: hour.floor }, { calls: 5, read: 8, floor: 16 }, "--per-hour reads the same: 8 read, and 16 in all with the 7 shared and the baseline");
});

test("agent-org#1395: what the counter moved that no call in the ledger accounts for is `unplaced`, and a window the counter was never read in stays a floor", () => {
  const COUNTED = (time: string, used: number, cost = "") => [time, "app:scheduler", "graphql", cost, "0", "api graphql", "-", "/usr/bin/node /x/src/work-gate.ts", "-", "-", String(used), "1791925000"].join("\t");
  // the second call's response said its own cost (3), and the counter moved 10: 7 points were spent by someone whose call is not here
  const entries = parseLedger([COUNTED("2026-10-13T20:00:00Z", 100), COUNTED("2026-10-13T20:01:00Z", 110, "3")].join("\n"));
  const top = topSpender(entries, { account: "app:scheduler", now: Date.parse("2026-10-13T20:05:00Z") });
  assert.equal(top?.counted?.unplaced, 7, "a caller of the token that is not in the ledger shows as a movement with no call to go to");
  assert.equal(top?.total, 1 + 3, "and is NOT given to a call that did not spend it");
  // a ledger from before the counter
  const before = topSpender(parseLedger([line("2026-10-13T20:00:00Z", { account: "app:scheduler" })].join("\n")), { account: "app:scheduler", now: Date.parse("2026-10-13T20:05:00Z") });
  assert.equal(before?.counted, undefined, "no reading, no claim: the floor is called a floor");
  // a counter that went BACK inside one reset window is two calls answered out of order and moves nothing
  const reordered = parseLedger([COUNTED("2026-10-13T20:00:00Z", 100), COUNTED("2026-10-13T20:01:00Z", 105), COUNTED("2026-10-13T20:02:00Z", 103)].join("\n"));
  assert.equal(topSpender(reordered, { account: "app:scheduler", now: Date.parse("2026-10-13T20:05:00Z") })?.total, 1 + 5 + 0);
});

test("agent-org#1395: the scheduler App's token is handed out by `host/gh` alone, so every call that spends its pool is a ledger line", () => {
  // DONE-WHEN 2: "a test fails when a caller of the scheduler App's token is not ledgered". What can hand the token out is `app-token.ts` (the minter the wrapper runs) and the
  // wrapper; any other file that reads the cache file or mints one holds a token whose calls no ledger line is written for. The pool's counter (above) shows such spend as `unplaced`.
  const root = fileURLToPath(new URL("../..", import.meta.url));
  // a walk of the tree, not `git grep`: a file nobody has added yet is a holder too, and this file spawns nothing that would need GIT_* scrubbed
  const sources = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) return d.name === "node_modules" || d.name === "fixtures" ? [] : sources(rel);
    return /\.(ts|mjs|js|sh)$/.test(d.name) && !d.name.endsWith(".test.ts") ? [rel] : [];
  });
  const MINTS = /mintInstallationToken|tokenPath\(|parseTokenFile|appToken\(/;
  const files = [...sources("src"), ...sources("scripts"), "host/gh"];
  const holders = files.filter((f) => MINTS.test(readFileSync(join(root, f), "utf8")) && f !== "src/app-token.ts" && f !== "host/gh");
  assert.deepEqual(holders, [], "nothing but app-token.ts and host/gh reads or mints an installation token");
  assert.ok(MINTS.test(readFileSync(join(root, "src/app-token.ts"), "utf8")), "POSITIVE CONTROL: the pattern finds the minter, so an empty answer above is not a pattern that matches nothing");
});
