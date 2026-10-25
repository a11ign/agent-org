// no-token: gh -- the instance is this checkout's own `ticket:serve` on a throwaway host (`scripts/loop-load.ts`), with stand-ins first on PATH: a `gh` that sleeps 2 s per call, and a `herdr` and a `tailscale` that log their arguments and exit 0; its tracker's `fetch` is offline
//
// PROVED UNDER LOAD (A11-282). The instance's sweeps run every second, and each one's `gh` holds the board thread 2 s. While they do, every read the request thread answers is
// timed 20 times, one at a time, and its p99 must be under 200 ms, with no synchronous spawn on the request thread. `/api/health`'s `boardSnapshotAgeMs` shows the board
// thread was held while the reads were answered: before the split, every read waited the 2 s with it (`node scripts/loop-load.ts` on the base prints that "before").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { BOARD_THREAD_ROUTES, type Health, percentile, READ_LIMIT_MS, ROUTES, startThrowawayInstance, timedRead, waitFor } from "../../scripts/loop-load.ts";
import type { RequestHealthView } from "./health-route.ts";

const ROUNDS = 20;
/** The gap between rounds, so the reads span several of the sweeps' 2 s calls. */
const ROUND_GAP_MS = 250;
/** The routes the request thread answers itself: every GET route but the ones the board thread answers. */
const LOCAL_ROUTES = ROUTES.filter((route) => !BOARD_THREAD_ROUTES.includes(route));
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin.ts");
const ghCallsIn = (log: string): number => readFileSync(log, "utf8").split("\n").filter(Boolean).length;

test("while a 2 s gh holds the board thread, every read the request thread answers has a p99 under 200 ms, a write still lands, and the request thread spawns nothing synchronously", { timeout: 240_000 }, async () => {
  const instance = await startThrowawayInstance(tmpDir("request-thread-load-"));
  try {
    await waitFor("a sweep's first gh call", () => { try { return ghCallsIn(instance.ghLog) > 0; } catch { return false; } });
    const ghBefore = ghCallsIn(instance.ghLog);
    const times = new Map<string, number[]>(LOCAL_ROUTES.map((route) => [route, []]));
    const healths: Health[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const route of LOCAL_ROUTES) {
        const read = await timedRead(instance.port, route);
        assert.notEqual(read.status, 0, `${route} answered`);
        times.get(route)?.push(read.ms);
        if (route === "/api/health") healths.push(JSON.parse(read.body) as Health);
      }
      await new Promise((done) => { setTimeout(done, ROUND_GAP_MS); });
    }
    assert.ok(ghCallsIn(instance.ghLog) > ghBefore, "a sweep's gh ran while the reads were made");
    const over = LOCAL_ROUTES.map((route) => [route, Math.round(percentile(times.get(route) ?? [], 99))] as const).filter(([, p99]) => p99 >= READ_LIMIT_MS);
    assert.deepEqual(over, [], `every read's p99 is under ${READ_LIMIT_MS} ms`);
    const split = healths as RequestHealthView[];
    assert.ok(split.every((health) => health.loop.requests !== undefined && health.loop.board !== undefined), "the health names both threads' loops");
    assert.ok(Math.max(...split.map((health) => health.boardSnapshotAgeMs)) >= 1_000, "the board thread was held while the reads were answered");
    assert.deepEqual(split.map((health) => health.requestThreadSyncCalls).filter((calls) => calls !== 0), [], "no synchronous spawn on the request thread");

    const paused = await fetch(`http://127.0.0.1:${instance.port}/api/paused`, { method: "POST", headers: { "x-ticket-token": instance.key }, body: JSON.stringify({ paused: true }) });
    assert.equal(paused.status, 200, "a write is forwarded to the board thread, and answered when it is free");
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
