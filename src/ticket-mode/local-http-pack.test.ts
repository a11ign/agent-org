// no-token: none -- no socket is opened; the response is a stand-in that records what it is given
// A11-270: an answer of 4 KB or more is gzipped for a client that takes gzip, and every other answer is sent as it always was
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { sendJsonFor, takesGzip } from "./local-http.ts";

/** A response that keeps its head and the bytes it was ended with. */
function recorder() {
  const sent: { status?: number; headers?: Record<string, string>; body?: Buffer | string } = {};
  const response = { writeHead: (status: number, headers: Record<string, string>) => { sent.status = status; sent.headers = headers; }, end: (body: Buffer | string) => { sent.body = body; } } as unknown as ServerResponse;
  return { response, sent };
}

const asking = (encoding?: string) => ({ headers: encoding === undefined ? {} : { "accept-encoding": encoding } });

test("A11-270: a request takes gzip when it names it among its encodings and does not refuse it", () => {
  for (const offered of ["gzip", "gzip, deflate, br", "deflate, GZIP;q=0.8", "br;q=1.0, gzip;q=0.5"]) assert.equal(takesGzip(asking(offered)), true, offered);
  for (const offered of [undefined, "", "identity", "deflate, br", "gzip;q=0", "gzip; q=0.0", "xgzip"]) assert.equal(takesGzip(asking(offered)), false, String(offered));
});

test("A11-270: a long answer is gzipped for a client that takes gzip and is the same text when unpacked, and a short one, or one for a client that does not, is plain", () => {
  const long = { rows: Array.from({ length: 400 }, (_, n) => ({ n, text: "a row of the list that repeats itself" })) };
  const packed = recorder();
  sendJsonFor(asking("gzip"), packed.response, { status: 201, value: long });
  assert.deepEqual([packed.sent.status, packed.sent.headers?.["Content-Encoding"], packed.sent.headers?.Vary, packed.sent.headers?.["Cache-Control"], packed.sent.headers?.["Content-Type"]], [201, "gzip", "Accept-Encoding", "no-store", "application/json"]);
  assert.deepEqual(JSON.parse(gunzipSync(packed.sent.body as Buffer).toString("utf8")), long);
  assert.ok((packed.sent.body as Buffer).length < JSON.stringify(long).length / 10);
  for (const [value, request] of [[long, asking()], [{ short: true }, asking("gzip")]] as const) {
    const plain = recorder();
    sendJsonFor(request, plain.response, { status: 200, value });
    assert.equal(plain.sent.headers?.["Content-Encoding"], undefined);
    assert.equal(plain.sent.body, JSON.stringify(value));
  }
});
