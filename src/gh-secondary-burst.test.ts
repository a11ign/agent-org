// no-token: gh -- the wrapper is RUN against a stub `gh-real` the test writes (`A11Y_GH_REAL`); no real `gh` starts and nothing reaches the network.
/**
 * (#1518) AN INSTALLATION REFUSED WHILE ITS HOURLY POOL HAS CALLS LEFT IS A SECONDARY (per-minute) LIMIT, and the installation's calls are PACED.
 *
 * The filer's reading: 26 refusals `API rate limit exceeded for installation ID 170075049` in 20:10Z to 20:19Z, while the pools read healthy, and
 * `plugins/github/wrapper/gh` and `gh-ledger.ts` both filed them as PRIMARY. Three claims, each with its positive control beside it:
 *   (a) the same refusal text is SECONDARY in the wrapper's queue and in `refusalKind` when the pool reads calls left, and PRIMARY when it reads zero;
 *   (b) 40 calls from three producers at once never have more than `A11Y_GH_PACE_INFLIGHT` (2) in flight, nor more than `A11Y_GH_PACE_PER_MINUTE`
 *       (4) starts in one window (1 s here, `A11Y_GH_PACE_WINDOW_MS`, 60 s by default). The control is the same calls with the bound lifted, and it overlaps.
 *       The starts are read from the wrapper's own record of its admissions, not from the stub's clock: a stub starts a little after its admission,
 *       by a lag that a loaded host makes longer than the window;
 *   (c) a read refused for a secondary limit is not asked again that tick, and the next tick asks (`readUnlessRefused`, as #1523 pinned it);
 *   (d) a queued call the gate RETRIES and sees refused again is filed as the refused pool reads now (`retryDue`, through `attemptCall`): secondary
 *       with calls left, primary at zero, and the pool is read once for an hourly phrase only;
 *   (e) the retry's reader (`poolLeftOfQueued`, run through `spawnQueued`) sends the wrapper's probe as the entry's own account, and reads the pool it answers, or nothing;
 *   (f) the gate's own tick (`ghQueueTick`) takes that reader by default: a queued call refused again on the tick is secondary with calls left, primary at zero.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDirForFile } from "./lib/tmp-fixture.ts";
import { ghQueueTick, poolLeftOfQueued, QUEUE_DIR, readQueue, refusalKind, retryDue, spawnQueued } from "./gh-ledger.ts";
import { GRAPHQL_POOL_PROBE } from "./api-pool.ts";
import { CORE_POOL_PROBE } from "./ticket-port/core-pool-probe.ts";
import { poolProbeAnswer as probeOf } from "./packaging/rows-by-label-fixtures.ts";
import { forgetRefusedReads, readUnlessRefused } from "./ticket-port/rows-by-label.ts";

const WRAPPER_TEXT = readFileSync(fileURLToPath(new URL("../plugins/github/wrapper/gh", import.meta.url)), "utf8");
const WRAPPER = (() => {
  const rendered = join(tmpDirForFile("gh-secondary-1518-"), "gh");
  writeFileSync(rendered, WRAPPER_TEXT.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();

const INSTALLATION_REFUSAL = "gh: API rate limit exceeded for installation ID 170075049";
const SECONDARY_REFUSAL = "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)";

/**
 * A response head that names the pool's own counter, as GitHub answers a call that is `-i`. The counter's line is the fixture's, not written here:
 * the #2003 rule in `packaging/work-gate.test.ts` keeps the header's name in one module, and this file is one of the files it scans.
 */
const head = (remaining: number) => probeOf(remaining)
  .replace("HTTP/2 200", "HTTP/2.0 403 Forbidden")
  .replace("\n\n", `\nX-Ratelimit-Reset: ${Math.floor(Date.now() / 1000) + 1800}\n\n`);

/** A scratch root holding a config directory whose hosts file names the account, as an account's own config does. */
function accountConfig(prefix: string) {
  const root = tmpDir(prefix);
  const cfg = join(root, "cfg");
  mkdirSync(cfg);
  writeFileSync(join(cfg, "hosts.yml"), "github.com:\n    user: a11ign-ai-workers\n    oauth_token: not-a-token\n");
  return { root, cfg };
}

/**
 * A host whose stub `gh-real` answers the wrapper's probe (`-i`) with `headers` and refuses every other call with `reply`. Its env is the
 * account's own: a config that names no role, so the pacing directory is `account`.
 */
function refusingHost({ reply, headers }: { reply: string; headers: string; }) {
  const { root, cfg } = accountConfig("gh-secondary-1518-");
  writeFileSync(join(root, "headers"), headers);
  const stub = join(root, "gh-real");
  writeFileSync(stub, ["#!/bin/sh", `if [ "$2" = -i ]; then cat "${root}/headers"; exit 0; fi`, `printf '%s\\n' '${reply}' >&2`, "exit 1", ""].join("\n"), { mode: 0o755 });
  const env = { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, HERDR_WORKSPACE_ID: "w9", A11Y_GH_READ_CACHE: "off", A11Y_GH_LEDGER: join(cfg, "gh-calls.tsv"), A11Y_GH_PACE_DIR: join(root, "pace") };
  const run = () => spawnSync("sh", [WRAPPER, "issue", "comment", "1", "--body", "x"], { encoding: "utf8", env, input: "", cwd: root });
  return { run, queue: join(cfg, QUEUE_DIR) };
}

// ---- (a) the refusal's kind is read off the pool that refused ---------------------------------------------------------

test("(a) an installation refused while its pool has calls left is SECONDARY, in the wrapper's queue and in refusalKind", () => {
  const host = refusingHost({ reply: INSTALLATION_REFUSAL, headers: head(4560) });
  const r = host.run();
  assert.equal(r.status, 75, `a refused write is queued (exit 75), read ${r.status}: ${r.stderr}`);
  const [call] = readQueue(host.queue);
  assert.equal(call.kind, "secondary", "the wrapper's queue files it as secondary");
  assert.equal(refusalKind(INSTALLATION_REFUSAL, 4560), "secondary", "refusalKind reads the same reading as secondary");
  // a secondary limit waits the two minutes, not the hour a primary one waits when its head has no reset
  const wait = call.resetAtS - Math.floor(Date.now() / 1000);
  assert.ok(wait >= 115 && wait <= 125, `a secondary limit waits two minutes, read ${wait} s`);
});

test("(a) POSITIVE CONTROL: the same text with the pool at zero stays PRIMARY, in both places", () => {
  const host = refusingHost({ reply: INSTALLATION_REFUSAL, headers: head(0) });
  assert.equal(host.run().status, 75);
  const [call] = readQueue(host.queue);
  assert.equal(call.kind, "primary", "a pool at zero is the hourly limit: primary");
  assert.equal(refusalKind(INSTALLATION_REFUSAL, 0), "primary");
  assert.equal(refusalKind(INSTALLATION_REFUSAL), "primary", "with no reading the phrase is still primary, as before");
});

// ---- (b) the installation's calls are paced across processes ----------------------------------------------------------

const CALLS = 40;
const WINDOW_MS = 1000;
const PER_WINDOW = 4;
const IN_FLIGHT = 2;

/**
 * One pacing run: three chains of calls, each chain one producer's calls in turn, all started at once. Returns the stub's log in order (S when a
 * call starts, E when it ends) and the admissions the wrapper recorded, in its own clock.
 */
async function pacedRun(env: Record<string, string>) {
  const { root, cfg } = accountConfig("gh-pace-1518-");
  const log = join(root, "log");
  const stub = join(root, "gh-real");
  // S when a call starts, E when it ends: the file's order is the order the calls ran in
  writeFileSync(stub, ["#!/bin/sh", `printf 'S\\n' >> "${log}"`, "sleep 0.2", `printf 'E\\n' >> "${log}"`, ""].join("\n"), { mode: 0o755 });
  const base = { PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, GH_CONFIG_DIR: cfg, HERDR_WORKSPACE_ID: "w9", A11Y_GH_READ_CACHE: "off", A11Y_GH_LEDGER: join(cfg, "gh-calls.tsv"), A11Y_GH_PACE_DIR: join(root, "pace"), ...env };
  const one = () => new Promise<number | null>((resolve) => {
    const child = spawn("sh", [WRAPPER, "issue", "view", "1"], { env: base, cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    child.on("close", (code) => resolve(code));
  });
  // The wrapper rewrites its `starts` file at every admission, pruned to the window it bounds, so it is read every 5 ms. An admission
  // stays in the file until the window passes it, so every admission shows in some snapshot, and the most copies of one millisecond
  // that a snapshot held is how many were admitted at that millisecond.
  const starts = join(root, "pace", "account", "starts");
  const admitted = new Map<number, number>();
  const poll = setInterval(() => {
    let lines: string[];
    try {
      lines = readFileSync(starts, "utf8").split("\n").filter((line) => line !== "");
    } catch {
      return; // nothing admitted yet
    }
    const here = new Map<number, number>();
    for (const line of lines) here.set(Number(line), (here.get(Number(line)) ?? 0) + 1);
    for (const [ms, copies] of here) admitted.set(ms, Math.max(admitted.get(ms) ?? 0, copies));
  }, 5);
  // 40 calls as 14 + 13 + 13, so the three chains together make exactly CALLS
  const shares = [14, 13, 13];
  const chains = shares.map(async (share) => {
    const codes: (number | null)[] = [];
    for (let i = 0; i < share; i++) codes.push(await one());
    return codes;
  });
  const codes = (await Promise.all(chains).finally(() => clearInterval(poll))).flat();
  const events = readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
  const times = [...admitted].flatMap(([ms, copies]) => Array<number>(copies).fill(ms)).sort((a, b) => a - b);
  return { codes, events, admitted: times };
}

/** The most calls in flight at once, read off the stub's log in the order it was written. */
function peakInFlight(events: string[]): number {
  let running = 0;
  let peak = 0;
  for (const event of events) {
    running += event.startsWith("S") ? 1 : -1;
    peak = Math.max(peak, running);
  }
  return peak;
}

/** The most admissions in any one window, read off the wrapper's own record (sorted): a window opens at each admission and lasts `WINDOW_MS`. */
function mostStartsInWindow(starts: number[]): number {
  let most = 0;
  for (let i = 0; i < starts.length; i++) {
    let inWindow = 0;
    for (let j = i; j < starts.length && starts[j] - starts[i] < WINDOW_MS; j++) inWindow++;
    most = Math.max(most, inWindow);
  }
  return most;
}

test("(b) 40 calls from three producers at once never exceed the in-flight bound nor the per-window bound", async () => {
  const { codes, events, admitted } = await pacedRun({ A11Y_GH_PACE_INFLIGHT: String(IN_FLIGHT), A11Y_GH_PACE_PER_MINUTE: String(PER_WINDOW), A11Y_GH_PACE_WINDOW_MS: String(WINDOW_MS) });
  assert.equal(codes.filter((code) => code === 0).length, CALLS, `all ${CALLS} calls ran, read ${JSON.stringify(codes)}`);
  assert.equal(events.filter((event) => event.startsWith("S")).length, CALLS);
  const peak = peakInFlight(events);
  assert.ok(peak <= IN_FLIGHT, `in flight never exceeded ${IN_FLIGHT}, read a peak of ${peak}`);
  assert.equal(peak, IN_FLIGHT, "the bound is reached, so the calls were paced and not merely sequential");
  assert.equal(admitted.length, CALLS, `the wrapper recorded every admission, read ${admitted.length}`);
  const most = mostStartsInWindow(admitted);
  assert.ok(most <= PER_WINDOW, `admissions in one ${WINDOW_MS} ms window never exceeded ${PER_WINDOW}, read ${most}`);
});

test("(b) POSITIVE CONTROL: the same calls with the bound lifted overlap beyond the in-flight bound", async () => {
  const { events } = await pacedRun({ A11Y_GH_PACE_INFLIGHT: "20", A11Y_GH_PACE_PER_MINUTE: "1000", A11Y_GH_PACE_WINDOW_MS: String(WINDOW_MS) });
  assert.ok(peakInFlight(events) > IN_FLIGHT, `unpaced, the producers overlap beyond ${IN_FLIGHT}, read a peak of ${peakInFlight(events)}`);
});

// ---- (c) a read refused for a secondary limit is not asked again that tick ---------------------------------------------

beforeEach(() => forgetRefusedReads());

test("(c) a read refused for a secondary limit is not asked again that tick, and the next tick asks", () => {
  let reads = 0;
  const run = (args: string[]): string => {
    if (args.join(" ") === GRAPHQL_POOL_PROBE.join(" ")) return probeOf(4560);
    throw new Error(SECONDARY_REFUSAL);
  };
  const read = () => {
    reads++;
    return run(["api", "graphql", "-f", "query=query { repository { issues { totalCount } } }"]);
  };
  const attempt = () => {
    try {
      readUnlessRefused({ what: "OPEN rows labelled ready", run, log: () => undefined, read });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };
  assert.match(attempt() ?? "", /secondary rate limit/);
  const afterFirst = reads;
  assert.match(attempt() ?? "", /not asked again this tick/);
  assert.equal(reads, afterFirst, "the refused read is not sent a second time in the same tick");
  forgetRefusedReads();
  assert.match(attempt() ?? "", /secondary rate limit/);
  assert.equal(reads, afterFirst + 1, "the next tick sends the read again");
});

// ---- (d) the gate's RETRY files a refusal as the pool reads NOW --------------------------------------------------------

/** A queued call as `plugins/github/wrapper/gh` writes it, filed `primary`: the kind its first refusal had when the pool was at zero. */
function queuedCall(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1000000-1.argv"), ["issue", "comment", "7", "--body", "x"].map((a) => `${a}\0`).join(""));
  writeFileSync(join(dir, "1000000-1.meta"), "queuedAt\t1000000\nresetAt\t1000600\nattempts\t0\nkind\tprimary\nresource\tgraphql\ncwd\t\nworkspace\t-\nsession\t-\n");
  return readQueue(dir)[0];
}

for (const [name, stderr, left, kind, reads] of [
  ["(d) a queued call refused AGAIN by an hourly limit with calls left is SECONDARY when the gate retries it", INSTALLATION_REFUSAL, 4560, "secondary", 1],
  ["(d) POSITIVE CONTROL: the same retry with the pool at zero stays PRIMARY", INSTALLATION_REFUSAL, 0, "primary", 1],
  ["(d) a secondary phrase on a retry is SECONDARY, and the pool is not read for it", SECONDARY_REFUSAL, 4560, "secondary", 0],
] as const) {
  test(name, () => {
    const dir = join(tmpDirForFile("gh-secondary-retry-"), QUEUE_DIR);
    queuedCall(dir);
    const asked: string[] = [];
    const outcomes = retryDue(dir, {
      nowMs: 1_000_600_000,
      run: () => ({ status: 1, stderr }),
      poolLeftOf: (_call, text) => { asked.push(text); return left; },
    });
    assert.equal(outcomes[0].event, "requeued", outcomes[0].detail);
    assert.equal(readQueue(dir)[0].kind, kind, "the requeued entry carries the kind the refusal has now");
    assert.equal(asked.length, reads, "the pool is read once for an hourly phrase, never for a secondary one");
  });
}

// ---- (f) the gate's own tick reads the pool for its retries, through the same runner ------------------------------------

for (const [name, left, kind] of [
  ["(f) ghQueueTick's default reader: a queued call refused again on the tick is SECONDARY when the pool has calls left", 4560, "secondary"],
  ["(f) POSITIVE CONTROL: the same tick with the pool at zero stays PRIMARY", 0, "primary"],
] as const) {
  test(name, () => {
    const home = tmpDir("gh-secondary-tick-");
    const dir = join(home, "workers", "gh", QUEUE_DIR);
    queuedCall(dir);
    const probes: string[] = [];
    const run = (_call: unknown, argv: string[]) => {
      if (argv.join(" ") !== CORE_POOL_PROBE.join(" ")) return { status: 1, stderr: INSTALLATION_REFUSAL };
      probes.push(argv.join(" "));
      return { status: 0, stderr: "", stdout: probeOf(left) };
    };
    ghQueueTick({ home, nowMs: 1_000_600_000, run });
    assert.equal(readQueue(dir)[0].kind, kind, "the requeued entry carries the kind the tick's reading gives");
    assert.equal(probes.length, 1, "the pool is read once, as the account whose queue it is");
  });
}

// ---- (e) the gate's reader asks the refused pool AS the entry's account --------------------------------------------------

test("(e) the gate's pool reader sends the wrapper's probe as the entry's account, and reads the pool it answers, or nothing", () => {
  const root = tmpDir("gh-secondary-reader-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "calls.log");
  const answer = join(root, "answer");
  writeFileSync(answer, probeOf(4560));
  writeFileSync(join(bin, "gh"), ["#!/bin/sh", `echo "$GH_CONFIG_DIR $*" >> "${log}"`, `cat "${answer}"`, ""].join("\n"), { mode: 0o755 });
  const cfg = join(root, "cfg");
  const call = queuedCall(join(cfg, QUEUE_DIR));
  const reading = poolLeftOfQueued(spawnQueued);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    assert.equal(reading(call, INSTALLATION_REFUSAL), 4560, "the core pool's reading");
    assert.equal(readFileSync(log, "utf8").split("\n")[0], `${cfg} api user -i`, "the core probe, as the account whose queue this is");
    assert.equal(reading(call, "GraphQL: API rate limit exceeded for user ID 1"), 4560, "a GraphQL refusal reads the GraphQL pool");
    assert.match(readFileSync(log, "utf8"), /api graphql/, "and sends the GraphQL probe");
    writeFileSync(answer, "");
    assert.equal(reading(call, INSTALLATION_REFUSAL), null, "no answer is no reading, never a zero");
  } finally {
    process.env.PATH = savedPath;
  }
});
