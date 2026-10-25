import { act, renderHook } from "@testing-library/react";
import type { Fetch } from "../api/request.ts";
import type { ViewConnection } from "../api/types.ts";
import { LOOP_POLL_MS, useLoopHealth } from "./use-loop-health.ts";

const HERE: ViewConnection = { name: "here", kind: "local" };
const BOARD = { p50Ms: 1, p99Ms: 18, maxMs: 41, windowMs: 60_000, sinceStartMaxMs: 41, at: 1 };
const PAGE = { ...BOARD, p99Ms: 1 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const advance = (ms: number) => act(async () => { await rstest.advanceTimersByTimeAsync(ms); });

/** A `fetch` that answers the instance's `/c/here/api/health` with `instance` and the root one with the page's loop, recording each path. */
function healthFetch(instance: () => Promise<Response>): Fetch & { paths: string[] } {
  const paths: string[] = [];
  const answer = async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    return path === "/api/health" ? json(200, { loop: { page: PAGE } }) : instance();
  };
  return Object.assign(answer as Fetch, { paths });
}

beforeEach(() => {
  rstest.useFakeTimers();
});
afterEach(() => {
  rstest.useRealTimers();
});

describe("useLoopHealth", () => {
  it("reads the instance's health and the page's own, and again every 10 s", async () => {
    const fetch = healthFetch(async () => json(200, { loop: { board: BOARD }, blocking: [] }));
    const { result } = renderHook(() => useLoopHealth(HERE, fetch));
    await advance(0);
    expect(result.current).toEqual({ board: BOARD, page: PAGE });
    await advance(LOOP_POLL_MS);
    expect(fetch.paths).toEqual(["/c/here/api/health", "/api/health", "/c/here/api/health", "/api/health"]);
  });

  it("gives no instance reading for an instance from before /api/health", async () => {
    const fetch = healthFetch(async () => json(404, { error: "no route GET /api/health" }));
    const { result } = renderHook(() => useLoopHealth(HERE, fetch));
    await advance(0);
    expect(result.current).toEqual({ page: PAGE });
  });

  it("leaves a read that waits on a slow instance to finish, so reads never pile up behind it", async () => {
    const fetch = healthFetch(() => new Promise<Response>(() => undefined));
    renderHook(() => useLoopHealth(HERE, fetch));
    await advance(3 * LOOP_POLL_MS);
    expect(fetch.paths.filter((path) => path === "/c/here/api/health")).toHaveLength(1);
  });
});
