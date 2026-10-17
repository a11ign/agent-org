// no-token: gh -- the reviewer port and the head reader are injected; nothing starts and nothing reaches GitHub or herdr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewOnDemand } from "./review-command.ts";
import type { ReviewerPort } from "./reviewer-port.ts";

const URL = "https://github.com/a11ign/control/pull/119";
const HEAD = "3aeaba9bd".padEnd(40, "0");

/** A port that records what it was asked, and answers as told. */
const port = (answer: ReturnType<ReviewerPort["start"]>, live = false) => {
  const calls: string[] = [];
  const p: ReviewerPort = {
    live: ({ pr, head }) => { calls.push(`live ${pr}@${head}`); return live; },
    start: ({ pr, head }) => { calls.push(`start ${pr}@${head}`); return answer; },
  };
  return { p, calls };
};

test("starts the reviewer at the pull request's current head, and names the seat it started", () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  const r = reviewOnDemand({ url: URL, port: p, readHead: () => HEAD });
  assert.equal(r.code, 0);
  assert.match(r.out, /started reviewer-control-119 for .*pull\/119 at 3aeaba9b/);
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`, `start ${URL}@${HEAD}`]);
});

test("a --head given is the head reviewed, and the pull request is not read for one", () => {
  const { p, calls } = port({ label: "reviewer-control-119" });
  let read = false;
  reviewOnDemand({ url: URL, head: "abc1234", port: p, readHead: () => { read = true; return HEAD; } });
  assert.equal(read, false);
  assert.deepEqual(calls, [`live ${URL}@abc1234`, `start ${URL}@abc1234`]);
});

test("a reviewer already live for that head is not started twice", () => {
  const { p, calls } = port({ label: "never" }, true);
  const r = reviewOnDemand({ url: URL, port: p, readHead: () => HEAD });
  assert.equal(r.code, 0);
  assert.match(r.out, /already working/);
  assert.deepEqual(calls, [`live ${URL}@${HEAD}`]);
});

test("the port's refusal is passed on with a non-zero code: an outside author, checks not settled, a moved head", () => {
  const { p } = port({ refusal: "no reviewer for x: its checks at y have not settled green" });
  const r = reviewOnDemand({ url: URL, port: p, readHead: () => HEAD });
  assert.equal(r.code, 1);
  assert.match(r.out, /have not settled green/);
});

test("an address that is not a pull request is refused before anything is asked, and an unreadable one has no head", () => {
  const { p, calls } = port({ label: "never" });
  assert.equal(reviewOnDemand({ url: "a11ign/control#119", port: p, readHead: () => HEAD }).code, 2);
  assert.equal(reviewOnDemand({ url: URL, port: p, readHead: () => null }).code, 1);
  assert.deepEqual(calls, []);
});
