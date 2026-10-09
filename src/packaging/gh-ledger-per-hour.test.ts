// no-token: gh -- the wrapper is RUN here, against a stub `gh-real` the test writes (`A11Y_GH_REAL`); no real `gh` starts and
// nothing reaches the network or any account's config.
//
// #4148: THE INSTRUMENT THE GRAPHQL-HOUR READINGS USE. `gh-ledger.mjs --per-hour` buckets ONE account's ONE resource by UTC hour, keeps the points the responses
// REPORTED apart from the one-point FLOOR, and an hourly rollup that `host/gh` writes as the 2 MiB trim drops lines keeps a reading for an hour the ledger no longer
// holds. IT GUARDS THE INSTRUMENT, NOT THE SAVING: the saving is read off the live ledger, on the row.
//
// THE POSITIVE CONTROL for "the rollup survives the trim" is the ledger ALONE: after the trim it holds fewer lines than were written, so a rollup that counted nothing
// would show up as a total short of what the wrapper was called.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callerScript, parseLedger, parseRollup, perHour, renderPerHour, rollupPathOf, spenderPhrase, topSpender } from "../gh-ledger.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

// THE PROJECT THIS FILE RUNS AGAINST IS A RECORDED ONE (`org-health-auto-off-refusal.test.ts` says why): `org-health.mjs` resolves the checkout it serves when it is imported, and with no
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
const line = (time: string, { account = WORKERS, resource = "graphql", cost = "", command = "pr list", caller = "/usr/bin/node /x/src/work-gate.mjs" } = {}) =>
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
  writeFileSync(stub, ["#!/bin/sh", `[ "$1 $2" = "api graphql" ] && printf '%s' "$STUB_BODY"`, "exit 0", ""].join("\n"), { mode: 0o755 });
  const ledger = join(cfg, "gh-calls.tsv");
  const call = (now: string, ...args: string[]) => spawnSync("sh", [WRAPPER, ...args], { encoding: "utf8", input: "",
    env: { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, A11Y_GH_LEDGER_NOW: now, A11Y_GH_LEDGER_MAX_BYTES: "1500", A11Y_GH_READ_CACHE: "off", STUB_BODY: COSTED_BODY } });
  return { ledger, call };
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
    ...Array.from({ length: 5 }, (_, i) => line(`2026-10-08T15:0${i}:00Z`, { caller: "/usr/bin/node -e /* work-gate.mjs runBatch */ const { execFile }" })),
    line("2026-10-08T15:10:00Z", { command: "issue list", caller: "/usr/bin/node /x/src/work-tick.mjs" }),
    line("2026-10-08T13:00:00Z", { caller: "/usr/bin/node /x/src/old.mjs" }), // outside the hour
    line("2026-10-08T15:11:00Z", { resource: "core" }), // another pool
  ].join("\n"));
  const top = topSpender(entries, { account: WORKERS, now: NOW });
  assert.equal(top?.caller, "work-gate.mjs", "a `node -e` batch worker is named for its script, not left as /usr/bin/node");
  assert.deepEqual([top?.points, top?.total], [5, 6]);
  assert.equal(topSpender(entries, { account: WORKERS, now: Date.parse("2026-10-09T15:30:00Z") }), null);
});

test("#4148: the gate's batch worker NAMES ITSELF to the ledger (the 852 calls that read /usr/bin/node)", () => {
  const gate = readFileSync(fileURLToPath(new URL("../work-gate.ts", import.meta.url)), "utf8");
  const worker = gate.match(/const BATCH_WORKER = `([\s\S]*?)`;/)?.[1];
  assert.ok(worker, "POSITIVE CONTROL: the worker text was found");
  const cmdline = `/usr/bin/node -e ${worker.replace(/\s+/g, " ")}`.slice(0, 160); // the ledger keeps 160 characters of the caller
  assert.equal(callerScript(cmdline), "work-gate.mjs");
  assert.equal(callerScript("/usr/bin/node -e const { execFile } = require(\"node:child_process\"); const one"), "/usr/bin/node", "the control: without the name it IS the unnamed caller");
});

test("#4148: api-pool-low names its spender, and says UNREADABLE rather than nothing when the ledger cannot be read", () => {
  const pools = [{ account: WORKERS, resource: "graphql", remaining: 100, limit: 5000, resetAt: "2026-10-08T16:00:00Z" }];
  const named = poolLowReading({ pools, spenderOf: (account) => spenderPhrase("/ledger", account, NOW, () => [
    line("2026-10-08T15:01:00Z"), line("2026-10-08T15:02:00Z"), line("2026-10-08T15:03:00Z", { command: "issue list", caller: "/usr/bin/node /x/src/work-tick.mjs" })].join("\n")) });
  assert.equal(named.status, "tripped");
  assert.match(named.detail, /Spender: a11ign-ai-workers's last hour \(3 floor points\): top caller work-gate\.mjs \[pr list\], 2 points \(67%\)/);
  assert.match(named.detail, /20% of their limit/, "the 20%-per-account, real-header reading stays as built");
  const unread = poolLowReading({ pools, spenderOf: () => null });
  assert.match(unread.detail, /Spender: .*UNREADABLE/);
  const unchanged = poolLowReading({ pools: [{ ...pools[0], remaining: 1000 }], spenderOf: () => "x" });
  assert.equal(unchanged.status, "clear", "a pool at 20% is not raised, so no spender is looked up");
  const core = poolLowReading({ pools: [{ ...pools[0], resource: "core" }], spenderOf: () => "should not appear" });
  assert.doesNotMatch(core.detail, /Spender/, "the ledger's points are GraphQL's: a core pool is not blamed on them");
  assert.equal(named.discriminator, poolLowReading({ pools, spenderOf: () => null }).discriminator, "the spender is in the detail only: one spent window is still one signal");
});
