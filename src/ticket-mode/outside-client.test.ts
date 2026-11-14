// no-token: none -- every attempt is a function the test gives; nothing reaches a network
//
// A11-436 (R3): one client for outside calls, with one rule for what is transient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCallLedger, networkUpSince } from "./call-outcomes.ts";
import { BREAKER_FAILURES, BREAKER_OPEN_MS, RETRY_WAITS_MS, ServiceUnavailable, createOutsideClient, failureKindOf, isTransient } from "./outside-client.ts";
import { isTransient as attachIsTransient } from "./attach-retry.ts";
import { isRetryableWrite } from "./result-write-retry.ts";
import { crashRetryAfter } from "./crash-retry.ts";

/** Whether a run that crashed on `err` is started again by itself. */
const isCrashRetryable = (err: unknown): boolean => crashRetryAfter(err, undefined, 0)?.retryAt !== undefined;

/** A connection reset as Node's `fetch` throws it. */
const reset = () => new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });

/** A client over its own ledger and clock, whose waits are recorded and take no time. */
function world() {
  let clock = 1_000;
  const ledger = createCallLedger(() => clock);
  const waits: number[] = [];
  const client = createOutsideClient({ ledger, now: () => clock, sleep: async (ms) => { waits.push(ms); } });
  return { ledger, waits, client, advance: (ms: number) => { clock += ms; }, at: () => clock };
}

/** An attempt that answers each status of `statuses` in turn, as a `fetch` answer, and counts how often it was made. */
function answering(...statuses: number[]) {
  let made = 0;
  const attempt = async () => {
    made += 1;
    return new Response(`answer ${made}`, { status: statuses[Math.min(made, statuses.length) - 1] });
  };
  return { attempt, made: () => made };
}

const byStatus = { statusOf: (response: Response) => response.status } as const;

test("Given Linear answers a read with a 503 twice and then succeeds, the read succeeds and the failure figure counts it once", async () => {
  const { client, ledger, waits } = world();
  const linear = answering(503, 503, 200);
  const answer = await client.call("linear", linear.attempt, byStatus);
  assert.equal(answer.status, 200, "the read succeeds");
  assert.equal(linear.made(), 3);
  assert.deepEqual(waits, RETRY_WAITS_MS.slice(0, 2), "after a wait that grows");
  assert.deepEqual(ledger.figures().linear, { calls: 1, failures: 1, failuresPer100: 100 }, "one call, counted once as failed, not three");
});

test("Given a 401 from Linear, the call is not retried, because the one rule classes it as not transient", async () => {
  const { client, ledger, waits } = world();
  const linear = answering(401);
  assert.equal((await client.call("linear", linear.attempt, byStatus)).status, 401, "the refusal is the caller's to read");
  assert.deepEqual([linear.made(), waits], [1, []]);
  assert.equal(failureKindOf({ status: 401 }), "refused");
  assert.equal(isTransient(Object.assign(new Error("Linear answered 401"), { status: 401 })), false);
  assert.deepEqual(ledger.figures().linear, { calls: 1, failures: 0, failuresPer100: 0 }, "a refusal is the service answering, not failing");
  let thrown = 0;
  await assert.rejects(client.call("linear", async () => { thrown += 1; throw Object.assign(new Error("Linear answered 401"), { status: 401 }); }), /401/);
  assert.equal(thrown, 1, "thrown with its status, it is not retried either");
});

test("Given a service fails 10 times in a row on a connection reset, its breaker refuses the next call at once and says it is unavailable", async () => {
  const { client, advance, at } = world();
  let made = 0;
  const failing = async (): Promise<string> => { made += 1; throw reset(); };
  // Four attempts per call: three calls make twelve failed attempts in a row, past the ten that open the breaker, and the third is refused part-way.
  await assert.rejects(client.call("github", failing), /fetch failed/);
  await assert.rejects(client.call("github", failing), /fetch failed/);
  await assert.rejects(client.call("github", failing), ServiceUnavailable);
  assert.equal(made, BREAKER_FAILURES, "no attempt is made once ten in a row have failed");
  const refused = await client.call("github", failing).then(() => null, (err: unknown) => err);
  assert.ok(refused instanceof ServiceUnavailable);
  assert.match(refused.message, /^GitHub is unavailable: 10 calls in a row failed/);
  assert.equal(made, BREAKER_FAILURES, "refused at once: the service is not asked");
  assert.equal(isTransient(refused), true, "a refusal of the breaker is transient: a run that meets it is not a crash");
  assert.equal(await client.call("linear", async () => "answered"), "answered", "each service has its own breaker");
  advance(BREAKER_OPEN_MS);
  assert.equal(at() >= refused.until, true);
  assert.equal(await client.call("github", async () => "back"), "back", "once its time has passed a call goes through, and its answer closes the breaker");
  await assert.rejects(client.call("github", async () => { throw new RangeError("a refusal"); }), RangeError);
  assert.equal(await client.call("github", async () => "still up"), "still up", "a failure that is not transient does not trip the breaker");
});

test("A breaker that lets a call through after its time opens again at once when that call fails too", async () => {
  const { client, advance } = world();
  const failing = async (): Promise<string> => { throw reset(); };
  for (let call = 0; call < 3; call += 1) await client.call("github", failing).catch(() => undefined);
  advance(BREAKER_OPEN_MS);
  let made = 0;
  await assert.rejects(client.call("github", async () => { made += 1; throw reset(); }), ServiceUnavailable, "the trial fails, and its retry is refused");
  assert.equal(made, 1);
});

test("Given an attempt that never answers, it fails as transient when its time passes, and is tried again", async () => {
  const client = createOutsideClient({ ledger: createCallLedger(), sleep: async () => undefined, attemptMs: { linear: 20, github: 20 } });
  let made = 0;
  let aborted = false;
  const silent = (signal: AbortSignal) => {
    made += 1;
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise<string>(() => undefined);
  };
  const failure = await client.call("linear", silent).then(() => null, (err: unknown) => err);
  assert.equal((failure as Error).name, "TimeoutError");
  assert.match((failure as Error).message, /^Linear did not answer within 0\.02 s$/);
  assert.equal(isTransient(failure), true);
  assert.equal(made, 1 + RETRY_WAITS_MS.length, "each attempt is cut and tried again");
  assert.equal(aborted, true, "the attempt is told to stop");
});

test("The one rule: the network, a 5xx and an open breaker are transient; a 429 is retried within the call but is not a crash; a 4xx and any other error are refused", () => {
  const cases: readonly [unknown, string, boolean][] = [
    [reset(), "network", true],
    [new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }), "network", true],
    [Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }), "network", true],
    [Object.assign(new Error("late"), { name: "TimeoutError" }), "network", true],
    [Object.assign(new Error("Linear answered 503"), { status: 503 }), "server", true],
    [new Error("wrapped", { cause: Object.assign(new Error("Linear answered 502"), { status: 502 }) }), "server", true],
    [new ServiceUnavailable("linear", 10, 0), "unavailable", true],
    [Object.assign(new Error("Linear answered 429"), { status: 429 }), "rate-limit", false],
    [Object.assign(new Error("Linear answered 404"), { status: 404 }), "refused", false],
    [new Error("Linear answered 200: Entity not found"), "refused", false],
    [new RangeError("bad"), "refused", false],
    [Object.assign(new Error("busy", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }), { status: 429 }), "network", true],
    [Object.assign(new Error("busy", { cause: { status: 503 } }), { status: 429 }), "server", true],
  ];
  for (const [err, kind, transient] of cases) {
    assert.equal(failureKindOf(err), kind, String((err as Error).message));
    assert.equal(isTransient(err), transient, String((err as Error).message));
    assert.equal(attachIsTransient(err), transient, "the plan attach reads the same rule");
    assert.equal(isCrashRetryable(err), transient, "and so does a crashed run");
  }
  assert.equal(isRetryableWrite(Object.assign(new Error("Linear answered 429"), { status: 429 })), true, "a result write waits out a 429 itself");
});

test("A 429 is tried again within the call, and an answer let go for a retry is released", async () => {
  const { client } = world();
  const released: string[] = [];
  const linear = answering(429, 200);
  const answer = await client.call("linear", linear.attempt, { ...byStatus, release: async (response) => released.push(await response.text()) });
  assert.equal(answer.status, 200);
  assert.deepEqual(released, ["answer 1"], "the 429's body was read so its connection closes");
});

test("A 5xx that goes on is returned after the fourth attempt, for the caller to read as any answer", async () => {
  const { client } = world();
  const linear = answering(503);
  assert.equal((await client.call("linear", linear.attempt, byStatus)).status, 503);
  assert.equal(linear.made(), 1 + RETRY_WAITS_MS.length, "never a fifth");
});

test("Every attempt is told to the caller: whether it failed, why, and the wait before the next", async () => {
  const { client } = world();
  const told: unknown[] = [];
  const linear = answering(502, 200);
  await client.call("linear", linear.attempt, { ...byStatus, onAttempt: ({ failed, failure, retryInMs }) => told.push([failed, (failure as Error | null)?.message ?? null, retryInMs]) });
  assert.deepEqual(told, [[true, "Linear answered 502", RETRY_WAITS_MS[0]], [false, null, null]]);
  const thrown: unknown[] = [];
  await assert.rejects(client.call("linear", async () => { throw new RangeError("bad"); }, { onAttempt: ({ kind, threw }) => thrown.push([kind, threw]) }), RangeError);
  assert.deepEqual(thrown, [["refused", true]], "a thrown refusal is told with its kind, so a caller can leave it out of its own count");
});

test("A11-399: a retry that got through is not a call of its own, but it shows the network is up again", async () => {
  const { client, ledger, advance } = world();
  let up = false;
  let made = 0;
  const call = client.call("linear", async () => {
    made += 1;
    advance(10);
    if (!up) { up = made >= 2; throw reset(); }
    return "answered";
  });
  assert.equal(await call, "answered");
  assert.deepEqual(ledger.figures().linear, { calls: 1, failures: 1, failuresPer100: 100 });
  assert.equal(networkUpSince(ledger, 500), true, "the answered retry is the ledger's latest call");
});
