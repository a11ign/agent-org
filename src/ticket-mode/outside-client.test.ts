// no-token: none -- every attempt is a function the test gives; nothing reaches a network
//
// A11-436 (R3): one client for outside calls, with one rule for what is transient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCallLedger, networkUpSince } from "./call-outcomes.ts";
import { BREAKER_FAILURES, BREAKER_OPEN_MS, OUTAGE_COUNTED_ONCE_MS, RETRY_WAITS_MS, ServiceUnavailable, countProgram, createOutsideClient, failureKindOf, isTransient, programKindOf } from "./outside-client.ts";
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

test("Given Linear answers a read with a 503 twice and then succeeds, the read succeeds and the failure figure counts it once, as a call that worked", async () => {
  const { client, ledger, waits } = world();
  const linear = answering(503, 503, 200);
  const answer = await client.call("linear", linear.attempt, byStatus);
  assert.equal(answer.status, 200, "the read succeeds");
  assert.equal(linear.made(), 3);
  assert.deepEqual(waits, RETRY_WAITS_MS.slice(0, 2), "after a wait that grows");
  assert.deepEqual(ledger.figures().linear, { calls: 1, failures: 0, failuresPer100: 0 }, "one call, not three, and it worked: its third attempt was answered");
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
  const client = createOutsideClient({ ledger: createCallLedger(), sleep: async () => undefined, attemptMs: { linear: 20, github: 20, herdr: 20 } });
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
  const { client, ledger } = world();
  const linear = answering(503);
  assert.equal((await client.call("linear", linear.attempt, byStatus)).status, 503);
  assert.equal(linear.made(), 1 + RETRY_WAITS_MS.length, "never a fifth");
  assert.deepEqual(ledger.figures().linear, { calls: 1, failures: 1, failuresPer100: 100 }, "a call that failed every attempt is one failed call");
});

test("A call the breaker refuses part-way, after its own attempts failed, is one failed call", async () => {
  const ledger = createCallLedger(() => 1_000);
  const client = createOutsideClient({ ledger, now: () => 1_000, sleep: async () => undefined, breakerFailures: 2 });
  await assert.rejects(client.call("linear", async () => { throw reset(); }), ServiceUnavailable);
  assert.deepEqual(ledger.figures().linear, { calls: 1, failures: 1, failuresPer100: 100 });
});

test("A11-399: a call the breaker refuses part-way moves no last-call time, so a good call made while it waited still shows the network up", async () => {
  let clock = 1_000;
  const ledger = createCallLedger(() => clock);
  // While the failing call waits to retry, another path counts a good call to Linear.
  const client = createOutsideClient({ ledger, now: () => clock, sleep: async () => { clock += 100; ledger.record("linear", false); clock += 100; }, breakerFailures: 2 });
  await assert.rejects(client.call("linear", async () => { clock += 10; throw reset(); }), ServiceUnavailable);
  assert.deepEqual(ledger.figures().linear, { calls: 3, failures: 1, failuresPer100: 33.3 }, "the refused call is counted once, as failed");
  assert.equal(networkUpSince(ledger, 500), true, "its last failed attempt came before the good call");
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
  assert.deepEqual(ledger.figures().linear, { calls: 1, failures: 0, failuresPer100: 0 }, "the call worked on its retry (A11-345)");
  assert.equal(networkUpSince(ledger, 500), true, "the answered retry is the ledger's latest call");
});

/** A connect timeout as Node's `fetch` throws it when the host has no route: what the board logged at 00:12Z on 2026-11-15. */
const noRoute = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) });
const unreachable = async (): Promise<string> => { throw noRoute(); };
const answered = async (): Promise<string> => "answered";

/** `count` answered calls to Linear. */
async function answer(client: ReturnType<typeof world>["client"], count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) await client.call("linear", answered);
}

test("A11-345, fourth reopen: three Linear calls made one after another into one network drop count as one failed call", async () => {
  // The 2026-11-15 00:12Z reading: 140 answered calls in the hour, then the host lost its route and three calls failed in a row (the third refused part-way by the breaker). Counted one per call, that read
  // 3 of 143, 2.1%, and reopened the ticket.
  const { client, ledger, advance } = world();
  await answer(client, 140);
  for (let call = 0; call < 3; call += 1) {
    await assert.rejects(client.call("linear", unreachable));
    advance(5_000);
  }
  assert.deepEqual(ledger.figures().linear, { calls: 141, failures: 1, failuresPer100: 0.7 }, "the outage is one failed call; the calls made into it are only observed");
});

test("A11-345, fifth reopen: a call whose first attempt times out on a stale connection and is answered on a new one is no failed call", async () => {
  // The 2026-11-16 02:47Z reading, six minutes after the board restarted: 44 answered calls, then one whose first attempt failed with ETIMEDOUT and whose retry, on a new connection, was answered. Counted by its
  // first attempt, that read 1 of 45, 2.2%, and reopened the ticket, though no call to Linear failed.
  const { client, ledger } = world();
  await answer(client, 44);
  let made = 0;
  assert.equal(await client.call("linear", async () => { made += 1; if (made === 1) throw noRoute(); return "answered"; }), "answered");
  assert.deepEqual(ledger.figures().linear, { calls: 45, failures: 0, failuresPer100: 0 });
});

test("An outage ends at the service's next answer, and a failure after it is counted again", async () => {
  const { client, ledger } = world();
  await assert.rejects(client.call("linear", unreachable));
  await assert.rejects(client.call("linear", unreachable));
  assert.deepEqual(ledger.figures().linear, { calls: 1, failures: 1, failuresPer100: 100 });
  await answer(client, 1);
  await assert.rejects(client.call("linear", unreachable));
  assert.deepEqual(ledger.figures().linear, { calls: 3, failures: 2, failuresPer100: 66.7 }, "a new outage, counted");
});

test("An outage that outlasts OUTAGE_COUNTED_ONCE_MS has every failed call counted again, so a service that stays down reads as failing", async () => {
  const { client, ledger, advance } = world();
  await assert.rejects(client.call("linear", unreachable));
  advance(OUTAGE_COUNTED_ONCE_MS - 1);
  await assert.rejects(client.call("linear", unreachable));
  assert.deepEqual(ledger.figures().linear, { calls: 1, failures: 1, failuresPer100: 100 }, "still the one outage");
  advance(1);
  for (let call = 0; call < 3; call += 1) {
    await assert.rejects(client.call("linear", unreachable));
    advance(BREAKER_OPEN_MS);
  }
  assert.deepEqual(ledger.figures().linear, { calls: 4, failures: 4, failuresPer100: 100 }, "each call counted, as before");
});

test("A call only observed in one outage, that fails for good after an answer ended it, begins no outage: the next failure is counted", async () => {
  const { client, ledger } = world();
  await assert.rejects(client.call("linear", unreachable));
  let attempts = 0;
  const failsWhileAnotherIsAnswered = client.call("linear", async () => {
    attempts += 1;
    if (attempts === 2) await client.call("linear", answered); // another call is answered while this one retries
    throw noRoute();
  });
  await assert.rejects(failsWhileAnotherIsAnswered);
  assert.deepEqual(ledger.figures().linear, { calls: 2, failures: 1, failuresPer100: 50 }, "observed, as part of the first outage");
  await assert.rejects(client.call("linear", unreachable));
  assert.deepEqual(ledger.figures().linear, { calls: 3, failures: 2, failuresPer100: 66.7 }, "a new outage, counted");
});

test("A failure its retry covered begins no outage: the next failure is counted", async () => {
  const { client, ledger } = world();
  assert.equal((await client.call("linear", answering(503, 200).attempt, byStatus)).status, 200);
  await assert.rejects(client.call("linear", unreachable));
  assert.deepEqual(ledger.figures().linear, { calls: 2, failures: 1, failuresPer100: 50 }, "the covered call worked; the unreachable one is counted");
});

test("A 4xx is the service answering: it begins no outage, and it ends one that is going on", async () => {
  const refusing = world();
  const unauthorised = async () => (await refusing.client.call("linear", answering(401).attempt, byStatus)).status;
  assert.equal(await unauthorised(), 401);
  await assert.rejects(refusing.client.call("linear", unreachable));
  assert.equal(refusing.ledger.figures().linear.failures, 1, "a 401 is the service answering: no outage, so the network failure is counted");
  assert.equal(await unauthorised(), 401);
  await assert.rejects(refusing.client.call("linear", unreachable));
  assert.equal(refusing.ledger.figures().linear.failures, 2, "and a 401 inside an outage ends it, since the service answered");
});

test("A thrown 4xx inside an outage is counted as the base counts it, and ends the outage", async () => {
  const { client, ledger } = world();
  await assert.rejects(client.call("linear", unreachable));
  await assert.rejects(client.call("linear", async () => { throw Object.assign(new Error("Linear answered 401"), { status: 401 }); }), /401/);
  assert.deepEqual(ledger.figures().linear, { calls: 2, failures: 2, failuresPer100: 100 }, "the 401 is not the outage: it is counted");
  await assert.rejects(client.call("linear", unreachable));
  assert.equal(ledger.figures().linear.failures, 3, "the service answered, so the next network failure is a new outage");
});

test("An outage is one service's: GitHub failing begins no outage of Linear", async () => {
  const { client, ledger } = world();
  await assert.rejects(client.call("github", unreachable));
  await assert.rejects(client.call("linear", unreachable));
  assert.deepEqual([ledger.figures().github.failures, ledger.figures().linear.failures], [1, 1]);
});

/** A `gh` answer as `exec` gives it. */
const ghExit = (status: number | null, stderr = "") => ({ status, stdout: "", stderr });

test("The one rule reads a program's exit: a gh that could not start or was cut, or printed that the network or GitHub failed, is transient; one that exited non-zero for an answer is refused", () => {
  const kinds = [ghExit(0), ghExit(null, "spawn gh ETIMEDOUT"), ghExit(1, "read tcp 192.0.2.10:443: connection reset by peer"), ghExit(1, "Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host"),
    ghExit(1, "HTTP 502: Bad Gateway"), ghExit(1, "HTTP 429: API rate limit exceeded"), ghExit(1, "gh: Not Found (HTTP 404)"), ghExit(8, ""), ghExit(1, "no pull requests found for branch"),
    ghExit(null, "spawn gh ENOENT"), ghExit(null, "spawn gh ENOBUFS")].map(programKindOf);
  assert.deepEqual(kinds, [null, "network", "network", "network", "server", "rate-limit", "refused", "refused", "refused", "refused", "refused"],
    "a gh that is not installed or printed past its buffer fails the same way on every try, so it is not tried again and does not open the breaker");
  const failure = (stderr: string) => Object.assign(new Error(`Command failed: gh api x\n${stderr}`), { status: 1, stderr, exit: { status: 1, stderr } });
  assert.deepEqual([isTransient(failure("connection reset by peer")), isTransient(failure("HTTP 503")), isTransient(failure("HTTP 401: Bad credentials")), isTransient(failure("HTTP 404"))], [true, true, false, false],
    "a thrown gh failure is classed by its exit, so a run that crashed on a reset is retried and one that met a 401 is not");
});

test("A gh call is counted by the one rule: a failure another try could get past is a failed call, and an answer GitHub gave is not; any other program is not a call to GitHub", () => {
  const ledger = createCallLedger(() => 1_000);
  for (const answer of [ghExit(1, "HTTP 500"), ghExit(null, "spawn gh ETIMEDOUT"), ghExit(1, "HTTP 429: API rate limit exceeded"), ghExit(1, "HTTP 404"), ghExit(8), ghExit(0)]) countProgram("/home/agent/.local/bin/gh", answer, ledger);
  countProgram("ssh", ghExit(1, "HTTP 500"), ledger);
  countProgram("claude", ghExit(null, "timeout"), ledger);
  assert.deepEqual(ledger.figures().github, { calls: 6, failures: 3, failuresPer100: 50 });
});

test("A herdr program is counted by the same rule as the herdr figure (A11-436 step 3): herdr cut at its bound or its server unreachable is a failed call, and a refusal herdr gave is not", () => {
  const ledger = createCallLedger(() => 1_000);
  for (const answer of [ghExit(null, "spawn herdr ETIMEDOUT"), ghExit(1, "Connection refused (os error 111)"), ghExit(1, "{\"error\":{\"code\":\"agent_not_found\"}}"), ghExit(0)]) countProgram("herdr", answer, ledger);
  assert.deepEqual(ledger.figures().herdr, { calls: 4, failures: 2, failuresPer100: 50 });
  assert.deepEqual(ledger.figures().github, { calls: 0, failures: 0, failuresPer100: 0 }, "a herdr call is not a call to GitHub");
});

test("Given gh fails 10 times in a row on a connection reset, the board's next gh call is refused at once by the breaker, which says GitHub is unavailable", async () => {
  const { client, ledger } = world();
  let made = 0;
  const reset = async () => { made += 1; return ghExit(1, "read tcp: connection reset by peer"); };
  const byExit = { exitOf: (answer: ReturnType<typeof ghExit>) => answer } as const;
  const answers = [await client.call("github", reset, byExit), await client.call("github", reset, byExit)];
  assert.deepEqual(answers.map(({ status }) => status), [1, 1], "a gh that failed every try answers its last exit, for the runner to read as it always did");
  await assert.rejects(client.call("github", reset, byExit), ServiceUnavailable, "the tenth failed attempt in a row opens the breaker part-way through the third call");
  assert.equal(made, BREAKER_FAILURES);
  await assert.rejects(client.call("github", reset, byExit), /GitHub is unavailable: 10 calls in a row failed/);
  assert.equal(made, BREAKER_FAILURES, "refused at once: gh is not run");
  assert.deepEqual(ledger.figures().github, { calls: 1, failures: 1, failuresPer100: 100 }, "the reset is one brief outage of GitHub, counted once (A11-345), however many calls failed in it, and a call the breaker refused is not counted");
});

test("A gh answer GitHub gave (a 404) is not tried again, does not trip the breaker and is not a failed call; one that failed on GitHub is tried again with the call's own time", async () => {
  const { client, ledger, waits } = world();
  let made = 0;
  const notFound = await client.call("github", async () => { made += 1; return ghExit(1, "gh: Not Found (HTTP 404)"); }, { exitOf: (answer) => answer });
  assert.deepEqual([notFound.status, made, waits], [1, 1, []]);
  const answered = await client.call("github", async () => { made += 1; return made === 2 ? ghExit(1, "HTTP 502: Bad Gateway") : ghExit(0); }, { exitOf: (answer) => answer, attemptMs: 120_000 });
  assert.deepEqual([answered.status, made, waits], [0, 3, [RETRY_WAITS_MS[0]]]);
  assert.deepEqual(ledger.figures().github, { calls: 2, failures: 0, failuresPer100: 0 }, "the 502 was covered by its retry, so neither call failed (A11-345)");
});

test("A call made once (a write) is not tried again after a failure another try could get past, and is still counted and seen by the breaker", async () => {
  const { client, ledger, waits } = world();
  let made = 0;
  await assert.rejects(client.call("github", async () => { made += 1; throw reset(); }, { once: true }), /fetch failed/);
  assert.deepEqual([made, waits], [1, []]);
  assert.deepEqual(ledger.figures().github, { calls: 1, failures: 1, failuresPer100: 100 });
});

test("A call that names its own time is cut at it, not at its service's", async () => {
  const client = createOutsideClient({ ledger: createCallLedger(() => 0), sleep: async () => undefined, retryWaitsMs: [], attemptMs: { linear: 1, github: 1, herdr: 1 } });
  assert.equal(await client.call("github", () => new Promise((done) => { setTimeout(() => done("late but within its own time"), 20); }), { attemptMs: 1_000 }), "late but within its own time");
  await assert.rejects(client.call("github", () => new Promise(() => undefined)), { name: "TimeoutError" });
});
