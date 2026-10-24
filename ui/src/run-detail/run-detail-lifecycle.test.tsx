import { act, render } from "@testing-library/react";
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
