// no-token: gh -- the instance is this checkout's own `ticket:serve` on a throwaway host (`scripts/loop-load.ts`), with stand-ins first on PATH: a `herdr` whose `agent list` is held until the test opens its gate, a `gh` and a `tailscale` that log their arguments and exit 0; its tracker's `fetch` is offline
//
// PROVED UNDER LOAD (A11-282), BY ORDER AND NOT BY A CLOCK (A11-297). The instance's sweeps run every second, and each one's synchronous `herdr agent list` holds the board thread (the GitHub plugin's `gh` is asynchronous since A11-356 and holds nothing). Here that call returns only
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
import { BOARD_THREAD_ROUTES, type Health, ROUTES, startThrowawayInstance, timedRead, waitFor } from "../../scripts/loop-load.ts";
import type { RequestHealthView } from "./health-route.ts";

const ROUNDS = 3;
/** The routes the request thread answers itself: every GET route but the ones the board thread answers. */
const LOCAL_ROUTES = ROUTES.filter((route) => !BOARD_THREAD_ROUTES.includes(route));
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin.ts");
/** The `gh` calls the log at `log` holds, one line of arguments each: none before its file is written. */
const callsIn = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
/** The sweep's synchronous `herdr agent list`, which the stand-in holds until the gate opens: since A11-356 the GitHub plugin's `gh` is asynchronous and holds no thread, so this is what holds the board thread. */
const SWEEP_CALL = "agent list";

test("while a synchronous call holds the board thread, every read the request thread answers is answered before that call returns, a write lands once it does, and the request thread spawns nothing synchronously", { timeout: 240_000 }, async () => {
  const instance = await startThrowawayInstance(tmpDir("request-thread-load-"), { gated: true });
  try {
    await waitFor("a sweep's herdr call on the board thread", () => callsIn(instance.herdrLog).some((call) => call.includes(SWEEP_CALL)));
    const healths: Health[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const route of LOCAL_ROUTES) {
        const read = await timedRead(instance.port, route);
        assert.notEqual(read.status, 0, `${route} was answered while the board thread was held`);
        assert.deepEqual(callsIn(instance.ghDoneLog), [], `${route} was answered before any held call returned`);
        if (route === "/api/health") healths.push(JSON.parse(read.body) as Health);
      }
    }
    const split = healths as RequestHealthView[];
    assert.ok(split.every((health) => health.loop.requests !== undefined && health.loop.board !== undefined), "the health names both threads' loops");
    assert.equal(new Set(split.map((health) => health.loop.board.at)).size, 1, "the board thread posted no snapshot while the reads were answered: every health carries the one snapshot's reading");
    assert.deepEqual(split.map((health) => health.requestThreadSyncCalls).filter((calls) => calls !== 0), [], "no synchronous spawn on the request thread");

    // A write is the board thread's: it waits behind the held call, and lands once the gate opens.
    const paused = fetch(`http://127.0.0.1:${instance.port}/api/paused`, { method: "POST", headers: { "x-ticket-token": instance.key }, body: JSON.stringify({ paused: true }) });
    instance.releaseGh();
    assert.equal((await paused).status, 200, "a write is forwarded to the board thread, and answered when it is free");
    assert.notDeepEqual(callsIn(instance.ghDoneLog), [], "the write was answered only after the held call returned");
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
