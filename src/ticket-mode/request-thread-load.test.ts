// no-token: gh -- the instance is this checkout's own `ticket:serve` on a throwaway host (`scripts/loop-load.ts`), with stand-ins first on PATH: a `gh` and a `herdr` held until the test opens its gate, a `systemctl` and a `tailscale` that log their arguments and exit 0; its tracker's `fetch` is offline
//
// PROVED UNDER LOAD (A11-282), BY ORDER AND NOT BY A CLOCK (A11-297). The instance's tick runs every second, and its synchronous read of herdr's start from the service manager (`systemctl --user show`, `pool-resume.ts`) holds the board thread (the GitHub plugin's `gh` is asynchronous since A11-356, and the tick's herdr listings since A11-282, and they hold nothing). Here that call returns only
// when the test says so: the test waits for a sweep's call to start, reads every route the request thread answers while it has not returned, and only then opens the gate. A read that
// came back is therefore a read answered while the board thread was held, whatever the runner's speed; a request thread that waited on the board thread would never answer (the read
// gives up after READ_TIMEOUT_MS and the test fails on it). Every `/api/health` read carrying the one board snapshot's reading shows the board thread posted nothing meanwhile.
// `node scripts/loop-load.ts` still prints the p50, p99 and max of the same reads against a `gh` that sleeps 2 s, for a person to read; no test asserts on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { BOARD_THREAD_ROUTES, type Health, HOLD_LOG, ROUTES, startThrowawayInstance, timedRead, waitFor } from "../../scripts/loop-load.ts";
import type { RequestHealthView } from "./health-route.ts";

const ROUNDS = 3;
/** The routes the request thread answers itself: every GET route but the ones the board thread answers. */
const LOCAL_ROUTES = ROUTES.filter((route) => !BOARD_THREAD_ROUTES.includes(route));
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin.ts");
/** The `gh` calls the log at `log` holds, one line of arguments each: none before its file is written. */
const callsIn = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
/** What the held call of the board thread logs when it begins and when it ends (`scripts/loop-load-hold.ts`): the GitHub plugin's `gh`, the tick's herdr listings and its read of herdr's start are asynchronous and hold no thread, so this stand-in synchronous spawn is what holds it. If the tick stops making it, nothing holds the board thread and the snapshot assertion below fails, saying so. */
/** How long the stand-in's held call lasts before it cuts itself, in ms (`HOLD_LIMIT_S` in `scripts/loop-load-hold.ts`): the test's reads are made inside it. */
const HELD_CALL_LIMIT_MS = 5_000;

test("while a synchronous call holds the board thread, every read the request thread answers is answered before that call returns, a write lands once it does, and the request thread spawns nothing synchronously", { timeout: 240_000 }, async () => {
  const instance = await startThrowawayInstance(tmpDir("request-thread-load-"), { gated: true, holdsBoardThread: true });
  const holdLog = join(instance.dir, HOLD_LOG);
  try {
    instance.holdBoardThread();
    await waitFor("a synchronous call holding the board thread", () => callsIn(holdLog).includes("held"));
    const healths: Health[] = [];
    const heldAt = Date.now();
    // Each round reads every route at once: the held call cuts itself after HELD_CALL_LIMIT_MS, so the reads must fit well inside it.
    for (let round = 0; round < ROUNDS; round += 1) {
      const reads = await Promise.all(LOCAL_ROUTES.map(async (route) => [route, await timedRead(instance.port, route)] as const));
      for (const [route, read] of reads) {
        assert.notEqual(read.status, 0, `${route} was answered while the board thread was held`);
        if (route === "/api/health") healths.push(JSON.parse(read.body) as Health);
      }
      assert.deepEqual(callsIn(holdLog), ["held"], `round ${round + 1} was answered before the held call returned`);
    }
    assert.ok(Date.now() - heldAt < HELD_CALL_LIMIT_MS, `the reads took ${Date.now() - heldAt} ms, longer than the tick lets the held call run`);
    const split = healths as RequestHealthView[];
    assert.ok(split.every((health) => health.loop.requests !== undefined && health.loop.board !== undefined), "the health names both threads' loops");
    assert.equal(new Set(split.map((health) => health.loop.board.at)).size, 1, "the board thread posted no snapshot while the reads were answered (it was held by the stand-in's synchronous call: if that call did not hold it, this is where that shows): every health carries the one snapshot's reading");
    assert.deepEqual(split.map((health) => health.requestThreadSyncCalls).filter((calls) => calls !== 0), [], "no synchronous spawn on the request thread");

    // A write is the board thread's: it waits behind the held call, and lands once the gate opens.
    const paused = fetch(`http://127.0.0.1:${instance.port}/api/paused`, { method: "POST", headers: { "x-ticket-token": instance.key }, body: JSON.stringify({ paused: true }) });
    instance.releaseGh();
    assert.equal((await paused).status, 200, "a write is forwarded to the board thread, and answered when it is free");
    assert.deepEqual(callsIn(holdLog), ["held", "released"], "the write was answered only after the held call returned");
    const queue = JSON.parse((await timedRead(instance.port, "/api/queue")).body) as { paused?: boolean };
    assert.equal(queue.paused, true, "the next read shows the write: the board thread posts its snapshot before it answers");

    // A second instance on the same host file finds the port taken: it stops with 1 and says why, as an instance that listened itself did, and runs no second pool.
    const second = spawn(process.execPath, [BIN, "ticket:serve"], { env: instance.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    second.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((done) => { second.on("exit", done); });
    assert.equal(code, 1, stderr);
    assert.match(stderr, /the request thread cannot listen on 127\.0\.0\.1:\d+: listen EADDRINUSE/);
    assert.doesNotMatch(stderr, /started again/, "it is not started again");
  } finally {
    instance.stop();
  }
});

test("A11-282: while the tick's herdr listing is held, the board thread goes on: a synchronous listing would have held it, and its snapshot would not move", { timeout: 240_000 }, async () => {
  const instance = await startThrowawayInstance(tmpDir("request-thread-listing-"), { gated: true });
  try {
    await waitFor("the tick's herdr agent list", () => callsIn(instance.herdrLog).some((call) => call.includes("agent list")));
    const snapshots = new Set<number>();
    await waitFor("the board thread posting its snapshot again while the listing is held", async () => {
      const health = JSON.parse((await timedRead(instance.port, "/api/health")).body) as RequestHealthView;
      snapshots.add(health.loop.board.at);
      return snapshots.size >= 3;
    });
    assert.deepEqual(callsIn(instance.ghDoneLog), [], "and the listing is still held: the board thread was free, not the listing done");
  } finally {
    instance.stop();
  }
});
