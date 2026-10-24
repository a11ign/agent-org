import { config, queueOf, ticket, OTHER } from "../../test/fixtures.ts";
import type { PollView } from "../api/use-poll.ts";
import type { ConfigView, TicketView } from "../api/types.ts";
import { ALL_GOALS_ID, goalEntries, goalShown, NO_GOAL_ID, pillOf, runningCount, ticketsInScope, ticketsOfGoal, ticketsView } from "./shell-model.ts";

describe("pillOf", () => {
  it("is Unreachable · retrying only for an unreachable read", () => {
    expect(pillOf("unreachable")).toEqual({ tone: "unreachable", label: "Unreachable · retrying" });
  });

  it.each(["loading", "ready", "empty", "error"] as const)("is Connected while the read is %s", (state) => {
    expect(pillOf(state)).toEqual({ tone: "connected", label: "Connected" });
  });
});

describe("runningCount", () => {
  it("counts the runs whose phase is running", () => {
    expect(runningCount(queueOf("running", "queued", "running", "finished", "running"))).toBe(3);
  });

  it("is 0 for a queue with none running", () => {
    expect(runningCount(queueOf("queued", "finished"))).toBe(0);
  });
});

describe("ticketsInScope", () => {
  const mine = ticket({ key: "A11-1" });
  const theirs = ticket({ key: "A11-2", assignee: OTHER });
  const nobodys = ticket({ key: "A11-3", assignee: null });

  it("keeps the signed-in person's tickets when the list starts on you", () => {
    expect(ticketsInScope([mine, theirs, nobodys], config()).map((t) => t.key)).toEqual(["A11-1"]);
  });

  it("keeps every ticket when the list starts on Anyone", () => {
    expect(ticketsInScope([mine, theirs, nobodys], config({ pickDefault: "anyone" })).map((t) => t.key)).toEqual(["A11-1", "A11-2", "A11-3"]);
  });

  it("keeps every ticket when the config names no viewer, as an older instance lists", () => {
    const older = { pickDefault: "you" } as ConfigView;
    expect(ticketsInScope([mine, theirs], older)).toHaveLength(2);
  });

  it("keeps every ticket when the config could not be read", () => {
    expect(ticketsInScope([mine, theirs], null)).toHaveLength(2);
  });

  it("starts on Anyone when the tracker could not say who the viewer is", () => {
    expect(ticketsInScope([mine, theirs], config({ viewer: null }))).toHaveLength(2);
  });
});

describe("goalEntries", () => {
  it("lists All goals with the total, each Goal label by count then name, and (no Goal) last", () => {
    const tickets = [
      ticket({ key: "A11-1", goals: ["Fleet"] }), ticket({ key: "A11-2", goals: ["Fleet"] }), ticket({ key: "A11-3", goals: ["Clean boundaries"] }),
      ticket({ key: "A11-4", goals: ["Capture quality"] }), ticket({ key: "A11-5" }),
    ];
    expect(goalEntries(tickets).map(({ label, count }) => [label, count])).toEqual([["All goals", 5], ["Fleet", 2], ["Capture quality", 1], ["Clean boundaries", 1], ["(no Goal)", 1]]);
  });

  it("counts a ticket with two goals under each", () => {
    const entries = goalEntries([ticket({ key: "A11-1", goals: ["Fleet", "Capture quality"] })]);
    expect(entries.map(({ label, count }) => [label, count])).toEqual([["All goals", 1], ["Capture quality", 1], ["Fleet", 1]]);
  });

  it("ignores a label that is not in the Goal group", () => {
    const labelled = { ...ticket({ key: "A11-1" }), labels: [{ name: "bug", group: "Type" }] } as TicketView;
    expect(goalEntries([labelled]).map(({ label }) => label)).toEqual(["All goals", "(no Goal)"]);
  });

  it("is All goals at 0 with no tickets", () => {
    expect(goalEntries([])).toEqual([{ id: ALL_GOALS_ID, label: "All goals", count: 0 }]);
  });

  it("does not take a goal that is named (no Goal) for the ticket with none", () => {
    const entries = goalEntries([ticket({ key: "A11-1", goals: ["(no Goal)"] }), ticket({ key: "A11-2" })]);
    expect(new Set(entries.map(({ id }) => id)).size).toBe(3);
  });
});

describe("goalShown and ticketsOfGoal", () => {
  const tickets = [ticket({ key: "A11-1", goals: ["Fleet"] }), ticket({ key: "A11-2" })];
  const entries = goalEntries(tickets);
  const fleet = entries.find(({ label }) => label === "Fleet")?.id ?? "";

  it("shows the goal chosen while the entries hold it", () => {
    expect(goalShown(entries, fleet)).toBe(fleet);
  });

  it("falls back to All goals when the chosen project has no ticket with it", () => {
    expect(goalShown(goalEntries([ticket({ key: "A11-9" })]), fleet)).toBe(ALL_GOALS_ID);
  });

  it("filters the tickets by the goal an entry stands for", () => {
    expect(ticketsOfGoal(tickets, fleet).map((t) => t.key)).toEqual(["A11-1"]);
    expect(ticketsOfGoal(tickets, NO_GOAL_ID).map((t) => t.key)).toEqual(["A11-2"]);
    expect(ticketsOfGoal(tickets, ALL_GOALS_ID)).toHaveLength(2);
  });
});

describe("ticketsView", () => {
  const view = <T,>(state: PollView<T>["state"], data: T | null, refusal: string | null = null): PollView<T> => ({ state, data, refusal });
  const mine = ticket({ key: "A11-1" });
  const theirs = ticket({ key: "A11-2", assignee: OTHER });

  it("is loading until the tickets have been read", () => {
    expect(ticketsView(view("loading", null), view("ready", config()))).toEqual({ state: "loading", data: null, refusal: null });
  });

  it("is still loading when the tickets are in but the config, which says the scope, is not", () => {
    expect(ticketsView(view("ready", [mine]), view("loading", null)).state).toBe("loading");
  });

  it("is ready with the tickets in scope", () => {
    expect(ticketsView(view("ready", [mine, theirs]), view("ready", config())).data?.map((t) => t.key)).toEqual(["A11-1"]);
  });

  it("is empty when tickets exist and none is in scope", () => {
    expect(ticketsView(view("ready", [theirs]), view("ready", config())).state).toBe("empty");
  });

  it("is empty for a read that came back with no tickets", () => {
    expect(ticketsView(view("empty", []), view("ready", config())).state).toBe("empty");
  });

  it("keeps the failure and the last good tickets", () => {
    expect(ticketsView(view("unreachable", [mine], "cannot reach personal"), view("ready", config()))).toEqual({ state: "unreachable", data: [mine], refusal: "cannot reach personal" });
  });

  it("is the config's failure when the config cannot be read, with nothing shown", () => {
    expect(ticketsView(view("ready", [mine, theirs]), view("error", null, "no config"))).toEqual({ state: "error", data: null, refusal: "no config" });
    expect(ticketsView(view("loading", null), view("unreachable", null, "cannot reach personal")).state).toBe("unreachable");
  });

  it("keeps showing the tickets in scope when a later read of the config fails after it answered", () => {
    expect(ticketsView(view("ready", [mine, theirs]), view("error", config(), "late")).data?.map((t) => t.key)).toEqual(["A11-1"]);
  });
});
