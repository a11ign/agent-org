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

describe("usePoll's cap on the wait after failures (A11-217)", () => {
  it("keeps the failures' wait within maxWaitMs when it names less: 2s, 4s, then every 5s (A11-217)", async () => {
    const start = Date.now();
    const { read, calls } = scripted<number[]>([fail()]);
    renderHook(() => usePoll(read, { connection: LOCAL, maxWaitMs: () => 5_000 }));
    await advance(0);
    await advance(2_000 + 4_000 + 5_000 * 4);
    const gaps = seen(calls, start).map((at, index, all) => at - (all[index - 1] ?? 0)).slice(1);
    expect(gaps).toEqual([2_000, 4_000, 5_000, 5_000, 5_000, 5_000]);
  });

  it("asks maxWaitMs each time a read is scheduled, so the cap can come and go with the page's state (A11-217)", async () => {
    const start = Date.now();
    const { read, calls } = scripted<number[]>([fail()]);
    const cap = { ms: Infinity };
    renderHook(() => usePoll(read, { connection: LOCAL, maxWaitMs: () => cap.ms }));
    await advance(0);
    await advance(2_000 + 4_000 + 8_000);
    cap.ms = 5_000;
    await advance(16_000);
    await advance(5_000 + 5_000);
    const gaps = seen(calls, start).map((at, index, all) => at - (all[index - 1] ?? 0)).slice(1);
    // 2s, 4s and 8s uncapped; the 16s wait was scheduled before the cap came, then the cap holds each wait to 5s.
    expect(gaps.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(gaps.slice(4, 6)).toEqual([5_000, 5_000]);
  });
});

describe("usePoll with repeat: false, a read made once", () => {
  it("makes one read after a success and no more, however far the timers advance", async () => {
    const { read, calls } = scripted([ok([1])]);
    const { result } = renderHook(() => usePoll(read, { connection: LOCAL, repeat: false }));
    await advance(0);
    await advance(60_000);
    expect(calls).toHaveLength(1);
    expect(result.current.state).toBe("ready");
  });

  it("does not read again when the page is hidden and shown", async () => {
    const { read, calls } = scripted([ok([1])]);
    renderHook(() => usePoll(read, { connection: LOCAL, repeat: false }));
    await advance(0);
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    await advance(0);
    expect(calls).toHaveLength(1);
  });

  it("still backs off 2s, 4s, 8s after failures, and stops after the success", async () => {
    const start = Date.now();
    const { read, calls } = scripted<number[]>([fail(), fail(), fail(), ok([1])]);
    renderHook(() => usePoll(read, { connection: LOCAL, repeat: false }));
    await advance(0);
    await advance(2_000 + 4_000 + 8_000);
    await advance(60_000);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000, 14_000]);
  });

  it("reads again on refresh, and then waits again", async () => {
    const { read, calls } = scripted([ok([1]), ok([2])]);
    const { result } = renderHook(() => usePoll(read, { connection: LOCAL, repeat: false }));
    await advance(0);
    act(() => result.current.refresh());
    await advance(0);
    await advance(60_000);
    expect(calls).toHaveLength(2);
    expect(result.current.data).toEqual([2]);
  });

  it("is empty for an empty list, as any read is", async () => {
    const { read } = scripted<number[]>([ok([])]);
    const { result } = renderHook(() => usePoll(read, { connection: LOCAL, repeat: false }));
    await advance(0);
    expect(result.current.state).toBe("empty");
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

  it("refresh reads at once and starts the backoff over: a failure it meets waits 2s, not the 16s the failures in a row would", async () => {
    const { result, calls, start } = await scriptedPoll<number[]>([fail(), fail(), fail(), fail(), fail()]);
    for (const ms of [2_000, 4_000, 1_000]) await advance(ms);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000]);
    await act(async () => { result.current.refresh(); });
    await advance(0);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000, 7_000]);
    await advance(1_999);
    expect(calls).toHaveLength(4);
    await advance(1);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000, 7_000, 9_000]);
    await advance(4_000);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000, 7_000, 9_000, 13_000]);
  });

  it("refresh after a success leaves the 5s cadence as it was", async () => {
    const { result, calls, start } = await scriptedPoll<number[]>([ok([1])]);
    await advance(1_000);
    await act(async () => { result.current.refresh(); });
    await advance(0);
    await advance(5_000);
    expect(seen(calls, start)).toEqual([0, 1_000, 6_000]);
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

  it("does not poll on after an unmount whose read was still in flight", async () => {
    const { read, state } = held();
    const { unmount } = await polling(read);
    unmount();
    await act(async () => { state.release(ok([1])); });
    await advance(60_000);
    expect(state.started).toBe(1);
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
    restart: async () => TARGET,
    answered: () => undefined,
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

describe("usePoll unreachable versus reconnecting versus error, with the proxy's real answers", () => {
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
      it(`is reconnecting for a ${kind} connection that fails the same way (${broken}): its instance is restarting, not an error it answered with`, async () => {
        const connection: ViewConnection = { name: "personal", kind };
        const client = createClient(connection, { fetch: fetchThroughProxy(broken, kind) });
        const { result } = renderHook(() => usePoll(client.tickets, { connection }));
        await advance(0);
        expect(result.current.state).toBe("reconnecting");
        expect(result.current.refusal).toMatch(/^cannot reach /);
      });
    }
  }

  it("is reconnecting for an SSH connection whose instance was reached but answered something that is not JSON with a 502, which is not the proxy's 'cannot reach'", async () => {
    const connection: ViewConnection = { name: "personal", kind: "ssh" };
    const client = createClient(connection, { fetch: fetchThroughProxy("not-json", "ssh") });
    const { result } = await polling(client.tickets, { connection });
    expect(result.current.state).toBe("reconnecting");
    expect(result.current.refusal).toBe("personal's instance answered with something that is not JSON");
  });

  it("is reconnecting for an SSH connection when ticket:ui itself cannot be fetched", async () => {
    const connection: ViewConnection = { name: "personal", kind: "ssh" };
    const client = createClient(connection, { fetch: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof globalThis.fetch });
    const { result } = await polling(client.tickets, { connection });
    expect(result.current).toMatchObject({ state: "reconnecting", refusal: "Failed to fetch" });
  });

  it("is reconnecting for a null connection, which addresses the local instance", async () => {
    const client = createClient(null, { fetch: (async () => new Response(JSON.stringify({ error: "cannot reach the instance: down" }), { status: 502 })) as unknown as typeof globalThis.fetch });
    const { result } = await polling(client.tickets, { connection: null });
    expect(result.current.state).toBe("reconnecting");
  });
});

/** The hook on a scripted read, its first read settled; `start` is when it began, for `seen`. */
async function scriptedPoll<T>(script: readonly Answer<T>[]) {
  const start = Date.now();
  const { read, calls } = scripted(script);
  return { ...(await polling(read)), calls, start };
}

const answerWith = (status: number, refusal: string): Answer<never> => ({ ok: false, status, refusal, unreachable: false });
const restart = (): Answer<never> => answerWith(0, "Failed to fetch");

function focusWindow() {
  window.dispatchEvent(new Event("focus"));
}

describe("usePoll with the proxy's last known data (A11-195)", () => {
  it("shows the proxy's last known data at once when the first read already finds the connection unreachable, and the data it holds once it has some", async () => {
    const personal: ViewConnection = { name: "personal", kind: "ssh" };
    const gone = (kept: unknown) => (async () => new Response(JSON.stringify({ error: "cannot reach personal over SSH: timed out", ...(kept === undefined ? {} : { lastKnown: kept }) }), { status: 502 })) as unknown as typeof globalThis.fetch;
    const fresh = renderHook(() => usePoll(createClient(personal, { fetch: gone({ value: [{ key: "A11-1" }], readAt: "2026-10-24T10:00:00.000Z" }) }).tickets, { connection: personal }));
    await advance(0);
    expect(fresh.result.current).toMatchObject({ state: "unreachable", data: [{ key: "A11-1" }], refusal: "cannot reach personal over SSH: timed out" });
    const none = renderHook(() => usePoll(createClient(personal, { fetch: gone(undefined) }).tickets, { connection: personal }));
    await advance(0);
    expect(none.result.current).toMatchObject({ state: "unreachable", data: null });
    let good = true;
    const live = createClient(personal, { fetch: (async () => new Response(JSON.stringify([{ key: "A11-2" }]))) as unknown as typeof globalThis.fetch });
    const down = createClient(personal, { fetch: gone({ value: [{ key: "A11-1" }], readAt: "2026-10-24T10:00:00.000Z" }) });
    const holding = renderHook(() => usePoll((signal) => (good ? live.tickets(signal) : down.tickets(signal)), { connection: personal }));
    await advance(0);
    good = false;
    await advance(5_000);
    expect(holding.result.current).toMatchObject({ state: "unreachable", data: [{ key: "A11-2" }] });
  });

  it("ignores a last known on a failure that is not the proxy's 'cannot reach'", async () => {
    const personal: ViewConnection = { name: "personal", kind: "ssh" };
    const client = createClient(personal, { fetch: (async () => new Response(JSON.stringify({ error: "tracker refused", lastKnown: { value: [{ key: "A11-1" }], readAt: "2026-10-24T10:00:00.000Z" } }), { status: 500 })) as unknown as typeof globalThis.fetch });
    const { result } = renderHook(() => usePoll(client.tickets, { connection: personal }));
    await advance(0);
    expect(result.current).toMatchObject({ state: "error", data: null });
  });
});

describe("usePoll reads again on focus and when the page is shown (A11-211)", () => {
  it("reads at once when the window gains focus, without waiting for the 5s timer", async () => {
    const { calls, start } = await scriptedPoll([ok([1])]);
    await advance(1_000);
    await act(async () => { focusWindow(); });
    await advance(0);
    expect(seen(calls, start)).toEqual([0, 1_000]);
    await advance(5_000);
    expect(seen(calls, start)).toEqual([0, 1_000, 6_000]);
  });

  it("reads at once when the page is shown, and the failures in a row are forgotten so the next wait is 2s", async () => {
    const { calls, start } = await scriptedPoll<number[]>([restart(), restart(), restart(), restart(), restart(), restart(), ok([1])]);
    await advance(2_000 + 4_000 + 8_000);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000, 14_000]);
    await act(async () => { setVisibility("visible"); });
    await advance(0);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000, 14_000, 14_000]);
    await advance(1_999);
    expect(calls).toHaveLength(5);
    await advance(1);
    expect(seen(calls, start).slice(5)).toEqual([16_000]);
  });

  it("resets the backoff on focus", async () => {
    const { calls, start } = await scriptedPoll<number[]>([restart()]);
    await advance(2_000 + 4_000 + 8_000);
    await act(async () => { focusWindow(); });
    await advance(0);
    await advance(2_000);
    expect(seen(calls, start)).toEqual([0, 2_000, 6_000, 14_000, 14_000, 16_000]);
  });

  it("makes one read when a focus and a return to the page land together", async () => {
    const { read, state } = held();
    await polling(read);
    await act(async () => {
      focusWindow();
      setVisibility("hidden");
      setVisibility("visible");
      focusWindow();
    });
    expect(state.started).toBe(1);
  });

  it("makes no read on focus while the page is hidden, nor for a one-shot read that has succeeded", async () => {
    const { read, calls } = scripted([ok([1])]);
    await polling(read);
    setVisibility("hidden");
    await act(async () => { focusWindow(); });
    expect(calls).toHaveLength(1);
    const once = scripted([ok([1])]);
    setVisibility("visible");
    await polling(once.read, { connection: LOCAL, repeat: false });
    await act(async () => { focusWindow(); });
    await advance(0);
    expect(once.calls).toHaveLength(1);
  });

  it("stops listening for focus when the hook unmounts", async () => {
    const { read, calls } = scripted([ok([1])]);
    const { unmount } = await polling(read);
    unmount();
    await act(async () => { focusWindow(); });
    expect(calls).toHaveLength(1);
  });
});

describe("usePoll reconnecting (A11-211)", () => {
  it("is reconnecting for no answer, a proxy's 502 and a 503, keeps the last data, and backs off 2s then 4s", async () => {
    const { result, calls, start } = await scriptedPoll<number[]>([ok([1]), restart(), answerWith(502, "<html>Bad Gateway</html>"), answerWith(503, "starting"), ok([2])]);
    expect(result.current.state).toBe("ready");
    for (const [wait, refusal] of [[5_000, "Failed to fetch"], [2_000, "<html>Bad Gateway</html>"], [4_000, "starting"]] as const) {
      await advance(wait);
      expect(result.current).toMatchObject({ state: "reconnecting", data: [1], refusal });
    }
    expect(seen(calls, start)).toEqual([0, 5_000, 7_000, 11_000]);
    await advance(8_000);
    expect(result.current).toMatchObject({ state: "ready", data: [2], refusal: null });
  });

  it("is an error, with the server's sentence, for an answer that is not a restart", async () => {
    const { read } = scripted<number[]>([ok([1]), answerWith(500, "Linear refused the key")]);
    const { result } = await polling(read);
    await advance(5_000);
    expect(result.current).toMatchObject({ state: "error", data: [1], refusal: "Linear refused the key" });
    for (const status of [400, 403, 404, 504]) {
      const { read: again } = scripted<number[]>([answerWith(status, "no")]);
      const { result: seenStatus } = await polling(again);
      expect(seenStatus.current.state, String(status)).toBe("error");
    }
  });

  it("is still unreachable for an SSH 502 'cannot reach', which is its own state", async () => {
    const { read } = scripted<number[]>([{ ok: false, status: 502, refusal: "cannot reach personal over SSH: down", unreachable: true }]);
    const { result } = await polling(read, { connection: { name: "personal", kind: "ssh" } });
    expect(result.current.state).toBe("unreachable");
  });
});

describe("usePoll.current, the data fresh enough to build a link from (A11-211)", () => {
  it("resolves to the held data while it was read no more than 5s ago, and reads nothing", async () => {
    const { read, calls } = scripted([ok([1]), ok([2])]);
    const { result } = await polling(read);
    await advance(4_999);
    expect(await result.current.current()).toEqual([1]);
    expect(calls).toHaveLength(1);
  });

  it("reads now when the data is older than 5s, and resolves to that read's data", async () => {
    rstest.setSystemTime(Date.now());
    const { read, calls } = scripted([ok([1]), ok([2]), ok([3])]);
    const { result } = await polling(read);
    setVisibility("hidden");
    await advance(5_001);
    expect(calls).toHaveLength(1);
    let found: number[] | null = null;
    await act(async () => { found = await result.current.current(); });
    expect(found).toEqual([2]);
    expect(calls).toHaveLength(2);
    expect(result.current.data).toEqual([2]);
  });

  it("resolves to null when the read it makes fails, and to null before any data", async () => {
    const { read } = scripted<number[]>([ok([1]), restart()]);
    const { result } = await polling(read);
    setVisibility("hidden");
    await advance(5_001);
    let found: number[] | null = [0];
    await act(async () => { found = await result.current.current(); });
    expect(found).toBeNull();
    expect(result.current.data).toEqual([1]);
  });

  it("joins the read already in flight instead of starting another", async () => {
    const { read, state } = held();
    const { result } = await polling(read);
    let found: number[] | null = null;
    await act(async () => {
      const pending = result.current.current();
      state.release(ok([7]));
      found = await pending;
    });
    expect(state.started).toBe(1);
    expect(found).toEqual([7]);
  });

  it("says when the last good data was read, and keeps that time through a failure", async () => {
    const { read } = scripted<number[]>([ok([1]), restart()]);
    const { result } = renderHook(() => usePoll(read, { connection: LOCAL }));
    expect(result.current.readAt).toBeNull();
    await advance(0);
    const first = result.current.readAt;
    expect(first).toBe(Date.now());
    await advance(5_000);
    expect(result.current.state).toBe("reconnecting");
    expect(result.current.readAt).toBe(first);
  });
});
