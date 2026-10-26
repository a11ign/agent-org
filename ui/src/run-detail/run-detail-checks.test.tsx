import type { TicketCheck } from "../api/types.ts";
import { RUNS_OF } from "../../test/run-detail/run-detail-stand.ts";
import { detailStand } from "../../test/run-detail/run-detail-stand.ts";
import { pageFor, screen, textOf, waitFor, within } from "./run-detail-harness.tsx";
import { checkRowsOf } from "./run-detail-model.ts";

// A11-302: a ticket's Run detail lists its After-merge checks of every runner, since the org verifies its own work and the board's list shows a person only their own.

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

const check = (over: Partial<TicketCheck>): TicketCheck => ({ id: "A11-9#1", line: "For a week, no run is lost in a restart.", runner: "board", state: "open", listedAt: NOW - 2 * DAY, watching: null, windowEnds: null, ...over });

describe("a ticket's After-merge check rows", () => {
  it("say who runs each check and what the board watches until when, or why it was handed to an agent", () => {
    const rows = checkRowsOf([
      check({ watching: "no finished event in the run log naming \"lost in a restart\" within 7 d", windowEnds: Date.UTC(2026, 9, 31, 12, 0) }),
      check({ id: "A11-9#2", runner: "agent", handedOff: "the window of 7 d closed and the board did not see a needs-you event in the run log", watching: "a needs-you event in the run log within 7 d" }),
      check({ id: "A11-9#3", runner: "agent" }),
      check({ id: "A11-9#4", runner: "person", listedAt: NOW - 5 * HOUR }),
    ], NOW);
    expect(rows.map(({ id, runner, state, tone, detail }) => [id, runner, state, tone, detail])).toEqual([
      ["A11-9#1", "the board", "Open", "open", "Watching no finished event in the run log naming \"lost in a restart\" within 7 d until 2026-10-31 12:00 UTC · listed 2 d ago"],
      ["A11-9#2", "a verifier run", "Open", "open", "Watching a needs-you event in the run log within 7 d · handed to an agent: the window of 7 d closed and the board did not see a needs-you event in the run log · listed 2 d ago"],
      ["A11-9#3", "a verifier run", "Open", "open", "listed 2 d ago"],
      ["A11-9#4", "a person", "Open", "open", "listed 5 h ago"],
    ]);
  });

  it("say what a closed check was closed with and by whom, and what became of a failure", () => {
    const rows = checkRowsOf([
      check({ state: "passed", result: "no lost run from 2026-10-24 to 2026-10-31", closedBy: "board" }),
      check({ id: "A11-9#2", runner: "agent", state: "failed", result: "the doctor reports 0.4.1", closedBy: "agent", followUp: "f1" }),
      check({ id: "A11-9#3", runner: "agent", state: "failed", result: "x", closedBy: "agent", followUp: null }),
      check({ id: "A11-9#4", runner: "agent", state: "failed", result: "y", closedBy: "agent" }),
      check({ id: "A11-9#5", runner: "session", state: "superseded", result: "the laptop is not in use", closedBy: "session" }),
    ], NOW);
    expect(rows.map(({ runner, state, tone, detail }) => [runner, state, tone, detail])).toEqual([
      ["the board", "Passed", "passed", "no lost run from 2026-10-24 to 2026-10-31 · closed by the board"],
      ["a verifier run", "Failed", "failed", "the doctor reports 0.4.1 · closed by a verifier run · follow-up filed (f1)"],
      ["a verifier run", "Failed", "failed", "x · closed by a verifier run · no follow-up"],
      ["a verifier run", "Failed", "failed", "y · closed by a verifier run"],
      ["the person's session (retired)", "Superseded", "superseded", "the laptop is not in use · closed by the person's session"],
    ]);
  });

  it("are none for an instance that sends none", () => {
    expect(checkRowsOf(undefined, NOW)).toEqual([]);
  });
});

describe("the Run detail page", () => {
  const key = RUNS_OF.done.key;

  it("lists the ticket's After-merge checks of every runner, under the pull requests, with their runner and state", async () => {
    const stand = detailStand("done");
    await pageFor("done", { ...stand, instances: { personal: { ...stand.instances!.personal, ticketChecks: { [key]: [
      check({ id: `${key}#1`, watching: "no finished event in the run log within 7 d", windowEnds: Date.UTC(2026, 9, 31, 12, 0) }),
      check({ id: `${key}#2`, runner: "agent", state: "failed", result: "the doctor reports 0.4.1", closedBy: "agent", followUp: "f1" }),
    ] } } } });
    const section = within(await screen.findByRole("region", { name: /After-merge checks/ }));
    await waitFor(() => expect(section.getAllByText(/Runs it: /)).toHaveLength(2));
    expect(section.getByText(/^Runs it: the board · Watching no finished event in the run log within 7 d until 2026-10-31 12:00 UTC/)).toBeTruthy();
    expect(section.getByText("Runs it: a verifier run · the doctor reports 0.4.1 · closed by a verifier run · follow-up filed (f1)")).toBeTruthy();
    expect(section.getByText("Failed")).toBeTruthy();
    expect(textOf(document.querySelector("#h-checks"))).toBe("After-merge checks · the org verifies its own work");
  });

  it("draws no checks section for a ticket with none", async () => {
    await pageFor("done");
    expect(screen.queryByRole("region", { name: /After-merge checks/ })).toBeNull();
  });
});
