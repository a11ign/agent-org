// no-token: gh -- the clock and the fetch are injected; nothing is spawned or sent
import { test } from "node:test";
import assert from "node:assert/strict";
import { addCallFigures, CALL_WINDOW_MS, countedFetch, countProgram, createCallLedger, ghFailed, networkUpSince, per100, serviceOfUrl, statusFailed } from "./call-outcomes.ts";

test("failures per 100 calls is rounded to one decimal place, and 0 when there were no calls", () => {
  assert.deepEqual([per100(0, 0), per100(1, 3), per100(3, 200), per100(5, 5)], [0, 33.3, 1.5, 100]);
});

test("a ledger counts each service's calls and failures over the last hour only", () => {
  let clock = 5 * CALL_WINDOW_MS;
  const ledger = createCallLedger(() => clock);
  for (let call = 0; call < 199; call++) ledger.record("linear", false);
  ledger.record("linear", true);
  ledger.record("github", true);
  assert.deepEqual(ledger.figures(), { linear: { calls: 200, failures: 1, failuresPer100: 0.5 }, github: { calls: 1, failures: 1, failuresPer100: 100 } });
  clock += CALL_WINDOW_MS + 120_000;
  assert.deepEqual(ledger.figures().linear, { calls: 0, failures: 0, failuresPer100: 0 }, "past the hour, they are out");
});

test("a request to api.github.com is GitHub's, and any other address is neither: the tracker's calls are counted by its own fetch", () => {
  assert.deepEqual([serviceOfUrl("https://api.linear.app/graphql"), serviceOfUrl(new URL("https://api.github.com/repos")), serviceOfUrl(new Request("https://api.github.com/graphql")), serviceOfUrl("https://hooks.slack.com/x"), serviceOfUrl("not a url")],
    [null, "github", "github", null, null]);
});

test("a 429 and a 5xx are the service failing the call, and a 404 or a 401 is it answering", () => {
  assert.deepEqual([200, 404, 401, 429, 500, 502].map(statusFailed), [false, false, false, true, true, true]);
});

test("a fetch counted as the tracker counts every request, as failed when it throws or answers 5xx, passes the answer or the throw on unchanged, and counts no other address", async () => {
  const ledger = createCallLedger(() => 1_000);
  const answers = [new Response("ok", { status: 200 }), new Response("busy", { status: 503 }), "reset"] as const;
  let made = 0;
  const counted = countedFetch((async () => {
    const answer = answers[made++]!;
    if (answer === "reset") throw new TypeError("fetch failed");
    return answer;
  }) as typeof fetch, ledger, "linear");
  assert.equal((await counted("https://api.linear.app/graphql")).status, 200);
  assert.equal((await counted("https://api.linear.app/graphql")).status, 503);
  await assert.rejects(counted("https://api.linear.app/graphql"), /fetch failed/);
  assert.deepEqual(ledger.figures().linear, { calls: 3, failures: 2, failuresPer100: 66.7 });
  const elsewhere = countedFetch((async () => new Response("", { status: 500 })) as typeof fetch, ledger);
  await elsewhere("https://example.org/x");
  assert.equal(ledger.figures().linear.calls, 3, "a fetch not counted as the tracker counts no address but GitHub's API");
  const byAddress = countedFetch((async () => new Response("", { status: 200 })) as typeof fetch, ledger);
  await byAddress("https://api.linear.app/graphql");
  assert.equal(ledger.figures().linear.calls, 3, "core reads no tracker's address: only the tracker's own fetch counts its calls");
});

test("a gh that could not start, was cut, or printed that the network or GitHub failed is a failed call, and one that exited non-zero for an answer is not", () => {
  const failed = [{ status: null, stderr: "spawnSync gh ETIMEDOUT" }, { status: 1, stderr: "HTTP 502: Bad Gateway" }, { status: 1, stderr: "Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host" },
    { status: 1, stderr: "HTTP 429: API rate limit exceeded" }];
  const answered = [{ status: 0, stderr: "" }, { status: 1, stderr: "HTTP 404: Not Found" }, { status: 8, stderr: "" }, { status: 1, stderr: "no pull requests found for branch" }];
  assert.deepEqual([failed.map(ghFailed), answered.map(ghFailed)], [[true, true, true, true], [false, false, false, false]]);
});

test("a program is counted only when it is gh", () => {
  const ledger = createCallLedger(() => 1_000);
  countProgram("/home/agent/.local/bin/gh", { status: 1, stderr: "HTTP 500" }, ledger);
  countProgram("ssh", { status: 1, stderr: "HTTP 500" }, ledger);
  countProgram("claude", { status: null, stderr: "timeout" }, ledger);
  assert.deepEqual(ledger.figures().github, { calls: 1, failures: 1, failuresPer100: 100 });
});

test("two threads' figures are added and the failures per 100 are worked out from the sums, not averaged", () => {
  const board = { linear: { calls: 100, failures: 0, failuresPer100: 0 }, github: { calls: 0, failures: 0, failuresPer100: 0 } };
  const page = { linear: { calls: 100, failures: 4, failuresPer100: 4 }, github: { calls: 50, failures: 5, failuresPer100: 10 } };
  assert.deepEqual(addCallFigures(board, page), { linear: { calls: 200, failures: 4, failuresPer100: 2 }, github: { calls: 50, failures: 5, failuresPer100: 10 } });
});

test("A11-399: the ledger says when each service's last good and last failed call were, within the hour", () => {
  let clock = 5 * CALL_WINDOW_MS;
  const ledger = createCallLedger(() => clock);
  assert.deepEqual(ledger.lastCalls("linear"), { ok: undefined, failed: undefined });
  const start = clock;
  ledger.record("linear", true);
  clock += 1_000;
  ledger.record("linear", false);
  clock += 1_000;
  ledger.record("github", true);
  assert.deepEqual(ledger.lastCalls("linear"), { ok: start + 1_000, failed: start });
  assert.deepEqual(ledger.lastCalls("github"), { ok: undefined, failed: start + 2_000 });
  clock += CALL_WINDOW_MS;
  assert.deepEqual(ledger.lastCalls("linear"), { ok: undefined, failed: undefined }, "past the hour they are out");
});

test("A11-399: the network is up since a crash only when a call succeeded after it and neither service's latest call failed", () => {
  let clock = 10 * CALL_WINDOW_MS;
  const ledger = createCallLedger(() => clock);
  const crashedAt = clock;
  /** One millisecond on, `service` is called and fails or not; whether the network is up since the crash then. */
  const upAfter = (service: "linear" | "github", failed: boolean): boolean => {
    clock += 1;
    ledger.record(service, failed);
    return networkUpSince(ledger, crashedAt);
  };
  assert.equal(networkUpSince(ledger, crashedAt), false, "no call at all");
  ledger.record("linear", false);
  assert.equal(networkUpSince(ledger, crashedAt), false, "a good call at the moment of the crash is not after it");
  assert.equal(upAfter("linear", false), true, "a good Linear call, and GitHub not called");
  assert.equal(upAfter("github", true), false, "GitHub's latest call failed");
  assert.equal(upAfter("github", false), true, "and answers again");
  assert.equal(upAfter("linear", true), false, "Linear's latest call failed");
  clock += CALL_WINDOW_MS;
  assert.equal(networkUpSince(ledger, crashedAt), false, "calls of an hour ago are no evidence");
});
