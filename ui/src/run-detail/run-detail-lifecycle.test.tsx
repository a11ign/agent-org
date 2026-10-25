import { act, cleanup, render } from "@testing-library/react";
import { PERSONAL, queueingConfig, standFetch, type Failure, type InstanceAnswers } from "../../test/fixtures.ts";
import { addressOf, detailStand, queueOf, RUNS_OF, type RunFields } from "../../test/run-detail/run-detail-stand.ts";
import { RunsApp } from "../runs/RunsApp.tsx";
import { pageFor, screen, textOf } from "./run-detail-harness.tsx";

describe("a queue read that fails", () => {
  it("is the shared error banner with Retry, and no run, when the first read fails", async () => {
    history.replaceState(null, "", addressOf("running"));
    render(<RunsApp fetchWith={standFetch(detailStand("running", { queueFails: { status: 500, error: "the queue file cannot be read" } }))} />);
    expect(textOf(await screen.findByRole("alert"))).toContain("the queue file cannot be read");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("keeps the last run under the banner when a read fails over a run already drawn", async () => {
    rstest.useFakeTimers();
    try {
      const state: { fails: Failure | undefined; runs: readonly RunFields[] } = { fails: undefined, runs: RUNS_OF.running.runs };
      const instance: InstanceAnswers = { config: queueingConfig(), get queue() { return queueOf(state.runs); }, get queueFails() { return state.fails; } };
      history.replaceState(null, "", addressOf("running"));
      render(<RunsApp fetchWith={standFetch({ connections: [PERSONAL], instances: { personal: instance } })} />);
      const advance = (ms: number) => act(async () => { await rstest.advanceTimersByTimeAsync(ms); });
      for (let hop = 0; hop < 6; hop += 1) await advance(0);
      expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
      state.fails = { status: 500, error: "the queue file cannot be read" };
      await advance(5_000);
      expect(textOf(screen.getByRole("alert"))).toContain("the queue file cannot be read");
      expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    } finally {
      rstest.useRealTimers();
    }
  });
});

describe("the connection", () => {
  it("is read before the page draws anything but the board's skeleton", async () => {
    await pageFor("loading", { ...detailStand("loading"), holdInstance: true });
    expect(screen.getByRole("status", { name: "Loading run" })).toBeTruthy();
  });
});

// A RUN'S PAGE THE TAB HAS DRAWN, OPENED AGAIN WHILE ITS REMOTE CANNOT BE REACHED (A11-270): the run it last read is drawn under the frame, never the refusal in its place.
describe("a run's page whose SSH remote drops between two visits", () => {
  const HUNG_UP: Failure = { status: 502, error: "cannot reach personal over SSH: socket hung up" };
  const drawOn = (instance: InstanceAnswers) => render(<RunsApp fetchWith={standFetch({ connections: [PERSONAL], instances: { personal: instance } })} />);

  it("draws the run it last read under the unreachable frame, with its verbs held", async () => {
    history.replaceState(null, "", addressOf("running"));
    drawOn({ config: queueingConfig(), queue: queueOf(RUNS_OF.running.runs) });
    const heading = textOf(await screen.findByRole("heading", { level: 1 }));
    cleanup();
    drawOn({ configFail: HUNG_UP, queueFails: HUNG_UP });
    expect(textOf(await screen.findByRole("alert"))).toContain("Can't reach personal over SSH.");
    expect(textOf(screen.getByRole("heading", { level: 1 }))).toBe(heading);
    expect([...document.querySelectorAll<HTMLButtonElement>(".run-buttons button")].every((button) => button.disabled)).toBe(true);
  });
});

// A RUN'S OWN READ (A11-270): the queue the shell polls lists each run without its steps and its log, which the run's page reads from `GET /api/queue/<key>`, so the page draws from the list at once.
describe("a run's own read", () => {
  const STEPS_HEADING = /What it will do/;
  const wrapped = (answer: (path: string) => Promise<Response> | null) => {
    const base = standFetch(detailStand("running"));
    const asked: string[] = [];
    return Object.assign(((input: RequestInfo | URL, init?: RequestInit) => { asked.push(String(input)); return answer(String(input)) ?? base(input, init); }) as typeof fetch, { asked });
  };
  const isRun = (path: string) => /\/api\/queue\/A11-183$/.test(path);

  it("draws the run from the list before it answers, and its steps and timeline in place when it does", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    const base = standFetch(detailStand("running"));
    const fetchWith = wrapped((path) => (isRun(path) ? held.then(() => base(path)) : null));
    history.replaceState(null, "", addressOf("running"));
    render(<RunsApp fetchWith={fetchWith} />);
    expect(textOf(await screen.findByRole("heading", { level: 1 }))).toContain("The fleet is split on Edge again");
    expect(screen.queryByText(STEPS_HEADING)).toBeNull();
    expect(textOf(document.body)).toContain("from the run's times");
    expect(fetchWith.asked.some(isRun)).toBe(true);
    await act(async () => { release(); });
    expect(await screen.findByText(STEPS_HEADING)).toBeTruthy();
    expect(textOf(document.body)).not.toContain("from the run's times");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("is drawn from the list alone, with no banner, when the run's own read fails or answers that it is not on the queue", async () => {
    for (const answer of [{ status: 404, error: "no run A11-183 on the queue" }, { status: 500, error: "the log cannot be read" }]) {
      cleanup();
      history.replaceState(null, "", addressOf("running"));
      render(<RunsApp fetchWith={wrapped((path) => (isRun(path) ? Promise.resolve(new Response(JSON.stringify({ error: answer.error }), { status: answer.status })) : null))} />);
      expect(textOf(await screen.findByRole("heading", { level: 1 }))).toContain("The fleet is split on Edge again");
      await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
      expect(screen.queryByText(STEPS_HEADING)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    }
  });
  it("is read again each time the queue answers, so its log follows the status, and once for each answer", async () => {
    rstest.useFakeTimers();
    try {
      const stand = standFetch(detailStand("running"));
      history.replaceState(null, "", addressOf("running"));
      render(<RunsApp fetchWith={stand} />);
      const advance = (ms: number) => act(async () => { await rstest.advanceTimersByTimeAsync(ms); });
      for (let hop = 0; hop < 6; hop += 1) await advance(0);
      const reads = () => stand.paths.filter((path) => isRun(path)).length;
      const queues = () => stand.paths.filter((path) => path.endsWith("/api/queue")).length;
      const before = [reads(), queues()];
      await advance(5_000);
      expect([reads() - before[0], queues() - before[1]]).toEqual([1, 1]);
    } finally {
      rstest.useRealTimers();
    }
  });
});
