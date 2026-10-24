import { act, renderHook } from "@testing-library/react";
import type { Connection, Connections } from "../../../src/ticket-mode/connections.ts";
import { Unreachable } from "../../../src/ticket-mode/remote.ts";
import { proxy, type Forward } from "../../../src/ticket-mode/remote-proxy.ts";
import type { Answer } from "./answer.ts";
import { createClient } from "./client.ts";
import { usePoll } from "./use-poll.ts";
import type { ViewConnection } from "./types.ts";

const ok = <T,>(data: T): Answer<T> => ({ ok: true, data });
const fail = (refusal = "no", unreachable = false): Answer<never> => ({ ok: false, status: 500, refusal, unreachable });

/** A `read` that answers from `script` in turn, repeating the last, and records when each call was made. */
function scripted<T>(script: readonly Answer<T>[]) {
  const calls: number[] = [];
  const signals: AbortSignal[] = [];
  const read = async (signal: AbortSignal): Promise<Answer<T>> => {
    signals.push(signal);
    calls.push(Date.now());
    return script[Math.min(calls.length - 1, script.length - 1)];
  };
  return { read, calls, signals };
}

/** A `read` that stays in flight until `release` answers it, counting how many were started. */
function held() {
  const state = { started: 0, release: (_answer: Answer<number[]>) => undefined as void };
  const read = () => new Promise<Answer<number[]>>((resolve) => { state.started += 1; state.release = resolve; });
  return { read, state };
}

/** Render the hook on `read` and let its first read settle. */
async function polling<T>(read: (signal: AbortSignal) => Promise<Answer<T>>, options: Parameters<typeof usePoll<T>>[1] = { connection: LOCAL }) {
  const rendered = renderHook(() => usePoll(read, options));
  await advance(0);
  return rendered;
}

/** Let the timers run for `ms` of fake time, and the reads they start settle. */
const advance = (ms: number) => act(async () => { await rstest.advanceTimersByTimeAsync(ms); });

const seen = (calls: readonly number[], from: number): number[] => calls.map((at) => at - from);

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const LOCAL: ViewConnection = { name: "here", kind: "local" };

beforeEach(() => {
  rstest.useFakeTimers();
  setVisibility("visible");
});
afterEach(() => {
  rstest.useRealTimers();
});

describe("usePoll cadence", () => {
  it("reads at once and then every 5s after a success", async () => {
    const start = Date.now();
    const { read, calls } = scripted([ok([1])]);
    renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(0);
    await advance(5_000);
    await advance(5_000);
    expect(seen(calls, start)).toEqual([0, 5_000, 10_000]);
  });

  it("backs off 2s, 4s, 8s, 16s and 32s after five failures, then reads 5s after the success", async () => {
    const start = Date.now();
    const { read, calls } = scripted<number[]>([fail(), fail(), fail(), fail(), fail(), ok([1]), ok([1])]);
    renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(0);
    await advance(2_000 + 4_000 + 8_000 + 16_000 + 32_000 + 5_000);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000, 14_000, 30_000, 62_000, 67_000]);
  });

  it("does not read early: one millisecond short of the delay makes no read", async () => {
    const { read, calls } = scripted<number[]>([fail(), ok([1])]);
    renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(0);
    await advance(1_999);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);
  });

  it("stays at 60s after the backoff reaches it, however long the failures run", async () => {
    const start = Date.now();
    const { read, calls } = scripted<number[]>([fail()]);
    renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(0);
    await advance(2_000 + 4_000 + 8_000 + 16_000 + 32_000 + 60_000 * 4);
    const gaps = seen(calls, start).map((at, index, all) => at - (all[index - 1] ?? 0)).slice(1);
    expect(gaps).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
  });

  it("starts the backoff over at 2s after a success", async () => {
    const start = Date.now();
    const { read, calls } = scripted<number[]>([fail(), fail(), ok([1]), fail(), ok([1])]);
    renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(0);
    await advance(2_000 + 4_000 + 5_000 + 2_000);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000, 11_000, 13_000]);
  });

  it("keeps one read in flight: a slow answer does not start another", async () => {
    const { read, state } = held();
    renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(30_000);
    expect(state.started).toBe(1);
    await act(async () => { state.release(ok([1])); });
    await advance(4_999);
    expect(state.started).toBe(1);
    await advance(1);
    expect(state.started).toBe(2);
  });
});

describe("usePoll reads that land together", () => {
  it("starts one read when refresh and a return to the page land while a read is in flight", async () => {
    const { read, state } = held();
    const { result } = await polling(read);
    await act(async () => {
      result.current.refresh();
      result.current.refresh();
      setVisibility("hidden");
      setVisibility("visible");
    });
    expect(state.started).toBe(1);
  });
});

describe("usePoll visibility", () => {
  it("makes no read while the page is hidden however far the timers advance, and reads at once when it is shown", async () => {
    const start = Date.now();
    const { read, calls } = scripted([ok([1])]);
    await polling(read);
    expect(calls).toHaveLength(1);
    setVisibility("hidden");
    await advance(10 * 60_000);
    expect(calls).toHaveLength(1);
    await act(async () => { setVisibility("visible"); });
    await advance(0);
    expect(seen(calls, start)).toEqual([0, 10 * 60_000]);
    await advance(5_000);
    expect(seen(calls, start)).toEqual([0, 10 * 60_000, 10 * 60_000 + 5_000]);
  });

  it("makes no read at all when it starts hidden, until it is shown", async () => {
    setVisibility("hidden");
    const { read, calls } = scripted([ok([1])]);
    const { result } = renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(60_000);
    expect(calls).toHaveLength(0);
    expect(result.current.state).toBe("loading");
    await act(async () => { setVisibility("visible"); });
    await advance(0);
    expect(calls).toHaveLength(1);
    expect(result.current.state).toBe("ready");
  });

  it("schedules no read for an answer that arrives while hidden, and no backoff read either", async () => {
    const { read, state } = held();
    await polling(read);
    setVisibility("hidden");
    await act(async () => { state.release(fail()); });
    await advance(5 * 60_000);
    expect(state.started).toBe(1);
  });
});

describe("usePoll states", () => {
  it("is loading before the first answer, empty for an empty list and ready otherwise", async () => {
    const { read } = scripted([ok<number[]>([]), ok([1])]);
    const { result } = renderHook(() => usePoll(read, { connection: LOCAL }));
    expect(result.current).toMatchObject({ state: "loading", data: null, refusal: null });
    await advance(0);
    expect(result.current).toMatchObject({ state: "empty", data: [], refusal: null });
    await advance(5_000);
    expect(result.current).toMatchObject({ state: "ready", data: [1] });
  });

  it("decides empty with the page's own isEmpty for an object answer", async () => {
    const { read } = scripted([ok({ entries: [] as number[] })]);
    const { result } = renderHook(() => usePoll(read, { connection: LOCAL, isEmpty: (queue) => queue.entries.length === 0 }));
    await advance(0);
    expect(result.current.state).toBe("empty");
  });

  it("keeps the last good data through an error and says why, and clears the reason on the next success", async () => {
    const { read } = scripted<number[]>([ok([1]), fail("the tracker is down"), ok([2])]);
    const { result } = renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(0);
    await advance(5_000);
    expect(result.current).toMatchObject({ state: "error", data: [1], refusal: "the tracker is down" });
    await advance(2_000);
    expect(result.current).toMatchObject({ state: "ready", data: [2], refusal: null });
  });

  it("refresh reads at once, and a failure it meets does not reset the backoff", async () => {
    const start = Date.now();
    const { read, calls } = scripted<number[]>([fail(), fail(), fail(), ok([1])]);
    const { result } = renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(0);
    await advance(1_000);
    await act(async () => { result.current.refresh(); });
    await advance(0);
    expect(seen(calls, start)).toEqual([0, 1_000]);
    await advance(3_999);
    expect(calls).toHaveLength(2);
    await advance(1);
    expect(seen(calls, start)).toEqual([0, 1_000, 5_000]);
  });
});

describe("usePoll connections", () => {
  it("starts again from loading with none of the old data on a change of connection", async () => {
    const { read, calls } = scripted([ok(["data of here"])]);
    const { result, rerender } = renderHook(({ connection }) => usePoll(read, { connection }), { initialProps: { connection: LOCAL as ViewConnection } });
    await advance(0);
    expect(result.current.data).toEqual(["data of here"]);
    rerender({ connection: { name: "there", kind: "ssh" } });
    expect(result.current).toMatchObject({ state: "loading", data: null });
    await advance(0);
    expect(calls).toHaveLength(2);
  });

  it("aborts the read in flight on a change of connection", async () => {
    const signals: AbortSignal[] = [];
    const read = (signal: AbortSignal) => new Promise<Answer<string[]>>(() => { signals.push(signal); });
    const { rerender } = renderHook(({ connection }) => usePoll(read, { connection }), { initialProps: { connection: LOCAL as ViewConnection } });
    await advance(0);
    expect(signals[0].aborted).toBe(false);
    rerender({ connection: { name: "there", kind: "ssh" } });
    expect(signals[0].aborted).toBe(true);
  });

  it("drops an answer read for the connection it left", async () => {
    const answers: ((answer: Answer<string[]>) => void)[] = [];
    const read = () => new Promise<Answer<string[]>>((resolve) => { answers.push(resolve); });
    const { result, rerender } = renderHook(({ connection }) => usePoll(read, { connection }), { initialProps: { connection: LOCAL as ViewConnection } });
    await advance(0);
    rerender({ connection: { name: "there", kind: "ssh" } });
    await advance(0);
    await act(async () => { answers[0](ok(["of here"])); });
    expect(result.current).toMatchObject({ state: "loading", data: null });
    await act(async () => { answers[1](ok(["of there"])); });
    expect(result.current).toMatchObject({ state: "ready", data: ["of there"] });
  });

  it("aborts its read in flight when it unmounts", async () => {
    const signals: AbortSignal[] = [];
    const read = (signal: AbortSignal) => new Promise<Answer<string[]>>(() => { signals.push(signal); });
    const { unmount } = renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(0);
    unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it("stops polling when it unmounts", async () => {
    const { read, calls } = scripted([ok([1])]);
    const { unmount } = renderHook(() => usePoll(read, { connection: LOCAL }));
    await advance(0);
    unmount();
    await advance(60_000);
    expect(calls).toHaveLength(1);
  });
});

/** The proxy's own answers, served through a `fetch`: what `ticket:ui` sends a page for a call to connection `name`. */
const PERSONAL: Connection = { name: "personal", kind: "ssh", ssh: "agents", agentOrg: "agent-org" };
const TARGET = { key: "k".repeat(48), host: "127.0.0.1:4747", address: { socket: "/tmp/none.sock" }, terminal: () => null };

type Break = "reach" | "forward" | "key" | "not-json";

function fetchThroughProxy(broken: Break, kind: Connection["kind"]) {
  const connection = { ...PERSONAL, kind } as Connection;
  const connections = {
    get: (name: string) => (name === connection.name ? connection : undefined),
    reach: async () => { if (broken === "reach") throw new Unreachable("ssh: connection timed out"); return TARGET; },
    forget: () => undefined,
    close: () => undefined,
  } as unknown as Connections;
  const forward: Forward = async () => {
    if (broken === "forward") throw new Error("connect ECONNREFUSED");
    if (broken === "key") return { status: 401, body: "{}" };
    return { status: 200, body: "<html>not json</html>" };
  };
  return (async (url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url, "http://page");
    const [, , name, ...rest] = pathname.split("/");
    const [status, value] = await proxy(connections, name, { method: init.method ?? "GET", path: `/${rest.join("/")}${search}`, body: null }, forward);
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
}

describe("usePoll unreachable versus error, with the proxy's real answers", () => {
  const CANNOT_REACH: readonly Break[] = ["reach", "forward", "key"];

  for (const broken of CANNOT_REACH) {
    it(`is unreachable for an SSH connection when the proxy cannot reach it (${broken}), and keeps the data it last had`, async () => {
      const personal: ViewConnection = { name: "personal", kind: "ssh" };
      let good = true;
      const working = createClient(personal, { fetch: (async () => new Response(JSON.stringify([{ key: "A11-1" }]))) as unknown as typeof globalThis.fetch });
      const broke = createClient(personal, { fetch: fetchThroughProxy(broken, "ssh") });
      const { result } = renderHook(() => usePoll((signal) => (good ? working.tickets(signal) : broke.tickets(signal)), { connection: personal }));
      await advance(0);
      expect(result.current.state).toBe("ready");
      good = false;
      await advance(5_000);
      expect(result.current.state).toBe("unreachable");
      expect(result.current.data).toEqual([{ key: "A11-1" }]);
      expect(result.current.refusal).toMatch(/^cannot reach /);
    });

    for (const kind of ["local", "https"] as const) {
      it(`is an error for a ${kind} connection that fails the same way (${broken})`, async () => {
        const connection: ViewConnection = { name: "personal", kind };
        const client = createClient(connection, { fetch: fetchThroughProxy(broken, kind) });
        const { result } = renderHook(() => usePoll(client.tickets, { connection }));
        await advance(0);
        expect(result.current.state).toBe("error");
        expect(result.current.refusal).toMatch(/^cannot reach /);
      });
    }
  }

  it("is an error for an SSH connection whose instance was reached but answered something that is not JSON", async () => {
    const connection: ViewConnection = { name: "personal", kind: "ssh" };
    const client = createClient(connection, { fetch: fetchThroughProxy("not-json", "ssh") });
    const { result } = await polling(client.tickets, { connection });
    expect(result.current.state).toBe("error");
    expect(result.current.refusal).toBe("personal's instance answered with something that is not JSON");
  });

  it("is an error for an SSH connection when ticket:ui itself cannot be fetched", async () => {
    const connection: ViewConnection = { name: "personal", kind: "ssh" };
    const client = createClient(connection, { fetch: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof globalThis.fetch });
    const { result } = await polling(client.tickets, { connection });
    expect(result.current).toMatchObject({ state: "error", refusal: "Failed to fetch" });
  });

  it("is an error for a null connection, which addresses the local instance", async () => {
    const client = createClient(null, { fetch: (async () => new Response(JSON.stringify({ error: "cannot reach the instance: down" }), { status: 502 })) as unknown as typeof globalThis.fetch });
    const { result } = await polling(client.tickets, { connection: null });
    expect(result.current.state).toBe("error");
  });
});
