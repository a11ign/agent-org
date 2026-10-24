// no-token: gh -- pure: errors are built in the test and nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTACH_TRIES, ATTACH_WAITS_MS, isTransient } from "./attach-retry.ts";

const named = (name: string, message = "the operation failed") => Object.assign(new Error(message), { name });
const coded = (code: string) => Object.assign(new Error("socket error"), { code });
const answered = (status: number) => Object.assign(new Error(`Linear answered ${status}: x`), { status });
const fetchFailed = (cause?: unknown) => new TypeError("fetch failed", cause === undefined ? undefined : { cause });

test("a failure of the network is transient: fetch failed with or without its cause, a timeout, a reset, an undici socket error", () => {
  const network = [
    ["fetch failed", fetchFailed()],
    ["fetch failed, caused by a reset", fetchFailed(coded("ECONNRESET"))],
    ["an AbortError", named("AbortError", "This operation was aborted")],
    ["a TimeoutError", named("TimeoutError", "The operation was aborted due to timeout")],
    ["undici's headers timeout in the cause", new Error("request failed", { cause: coded("UND_ERR_HEADERS_TIMEOUT") })],
    ["undici's socket error", coded("UND_ERR_SOCKET")],
    ["a refused connection", coded("ECONNREFUSED")],
    ["a connection timed out", coded("ETIMEDOUT")],
    ["a DNS lookup that did not answer", coded("EAI_AGAIN")],
    ["a name that did not resolve", coded("ENOTFOUND")],
    ["a broken pipe", coded("EPIPE")],
  ] as const;
  for (const [what, err] of network) assert.equal(isTransient(err), true, what);
});

test("a 5xx the tracker answered with is transient, on the error or on its cause", () => {
  for (const status of [500, 502, 503, 599]) assert.equal(isTransient(answered(status)), true, String(status));
  assert.equal(isTransient(new Error("the upload failed", { cause: answered(503) })), true, "the cause carries it");
});

test("a refusal is not transient: a 4xx, a GraphQL error on a 200, an error with no status, and a message that only says a number", () => {
  for (const status of [400, 401, 403, 404, 422, 429]) assert.equal(isTransient(answered(status)), false, String(status));
  assert.equal(isTransient(answered(200)), false, "Linear's GraphQL errors arrive on a 200");
  assert.equal(isTransient(answered(600)), false, "outside the 5xx range");
  assert.equal(isTransient(new Error("Linear did not attach NBF-1-0001-plan-fit.md")), false);
  assert.equal(isTransient(new Error("Linear answered 503: upstream")), false, "the status is data on the error, never read from the message");
  assert.equal(isTransient(new TypeError("Failed to parse URL")), false, "a TypeError that is not fetch failed");
  assert.equal(isTransient(coded("ENOENT")), false, "a file the board cannot read");
  assert.equal(isTransient(Object.assign(new Error("x"), { status: "503" })), false, "a status that is not a number");
  for (const odd of [undefined, null, "fetch failed", 503]) assert.equal(isTransient(odd), false, String(odd));
});

test("four tries in all, waiting 5 seconds, 30 seconds and 2 minutes between them", () => {
  assert.equal(ATTACH_TRIES, 4);
  assert.deepEqual(ATTACH_WAITS_MS, [5_000, 30_000, 120_000]);
  assert.equal(ATTACH_WAITS_MS.length, ATTACH_TRIES - 1, "a wait after every try but the last");
});
