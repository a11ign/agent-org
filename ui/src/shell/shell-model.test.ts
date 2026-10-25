import { config, queueOf, ticket, OTHER } from "../../test/fixtures.ts";
import type { PollView } from "../api/use-poll.ts";
import type { ConfigView, TicketView } from "../api/types.ts";
import { ALL_GOALS_ID, contextParentsOf, goalEntries, goalShown, mergedTickets, NO_GOAL_ID, pillOf, runningCount, scopeOf, ticketsInScope, ticketsOfGoal, ticketsView, isLive, unreachableOf } from "./shell-model.ts";

describe("pillOf", () => {
  it("is Unreachable · retrying only for an unreachable read", () => {
    expect(pillOf("unreachable")).toEqual({ tone: "unreachable", label: "Unreachable · retrying" });
  });

  it.each(["loading", "ready", "empty", "error"] as const)("is Connected while the read is %s", (state) => {
    expect(pillOf(state)).toEqual({ tone: "connected", label: "Connected" });
  });

  const UPDATING = { kind: "updating", release: "normal", from: "v0.273.0", to: "v0.280.0", slow: false } as const;

  it("is amber Updating while the page shows the Updating screen, Slow included (A11-217)", () => {
    expect(pillOf("reconnecting", UPDATING)).toEqual({ tone: "updating", label: "Updating" });
    expect(pillOf("reconnecting", { ...UPDATING, slow: true })).toEqual({ tone: "updating", label: "Updating" });
  });

  it("is Connected on the Back screen and for a restart that is not an update", () => {
    expect(pillOf("ready", { kind: "back", to: "v0.280.0", release: "normal" })).toEqual({ tone: "connected", label: "Connected" });
    expect(pillOf("reconnecting")).toEqual({ tone: "connected", label: "Connected" });
    expect(pillOf("reconnecting", { kind: "none" })).toEqual({ tone: "connected", label: "Connected" });
  });

  it("is Unreachable for an SSH remote even if an update was under way: that state keeps priority", () => {
    expect(pillOf("unreachable", UPDATING)).toEqual({ tone: "unreachable", label: "Unreachable · retrying" });
  });
});

describe("isLive", () => {
  it("is true only for a read that answered, empty or not", () => {
    expect((["ready", "empty"] as const).map(isLive)).toEqual([true, true]);
    expect((["loading", "error", "unreachable", "reconnecting"] as const).map(isLive)).toEqual([false, false, false, false]);
  });
});

describe("unreachableOf", () => {
  const view = (state: PollView<unknown>["state"], refusal: string | null = null) => ({ state, refusal });
  const ssh = { kind: "ssh" } as const;

  it("is the sentence of the first read that is unreachable, the queue's before the tickets'", () => {
    expect(unreachableOf(ssh, [view("unreachable", "cannot reach personal: queue"), view("unreachable", "cannot reach personal: tickets")])).toBe("cannot reach personal: queue");
    expect(unreachableOf(ssh, [view("ready"), view("unreachable", "cannot reach personal: tickets")])).toBe("cannot reach personal: tickets");
  });

  it("is null while every read answers, or fails some other way", () => {
    expect(unreachableOf(ssh, [view("ready"), view("loading")])).toBeNull();
    expect(unreachableOf(ssh, [view("error", "boom"), view("reconnecting", "Failed to fetch")])).toBeNull();
  });

  it("is null for a local or https connection, and before a connection is chosen, whatever the reads say", () => {
    for (const connection of [{ kind: "local" }, { kind: "https" }, null] as const) expect(unreachableOf(connection, [view("unreachable", "cannot reach x")])).toBeNull();
  });

  it("is an empty sentence for an unreachable read that names none", () => {
    expect(unreachableOf(ssh, [view("unreachable")])).toBe("");
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

describe("scopeOf", () => {
  it("is the one chosen, else the setting's default", () => {
    expect(scopeOf(config(), "anyone")).toBe("anyone");
    expect(scopeOf(config(), null)).toBe("you");
    expect(scopeOf(config({ pickDefault: "anyone" }), null)).toBe("anyone");
  });

  it("starts on Anyone when the tracker could not say who the viewer is or the config could not be read", () => {
    expect(scopeOf(config({ viewer: null }), null)).toBe("anyone");
    expect(scopeOf(null, null)).toBe("anyone");
  });
});

describe("ticketsInScope for a scope chosen", () => {
  const mine = ticket({ key: "A11-1" });
  const theirs = ticket({ key: "A11-2", assignee: OTHER });
  const nobodys = ticket({ key: "A11-3", assignee: null });

  it("keeps the tickets of the scope: a person, the unassigned, or everyone", () => {
    expect(ticketsInScope([mine, theirs, nobodys], config(), OTHER.id).map((t) => t.key)).toEqual(["A11-2"]);
    expect(ticketsInScope([mine, theirs, nobodys], config(), "unassigned").map((t) => t.key)).toEqual(["A11-3"]);
    expect(ticketsInScope([mine, theirs, nobodys], config(), "anyone")).toHaveLength(3);
  });

  it("lists every ticket whatever the scope on an instance that names no viewer", () => {
    expect(ticketsInScope([mine, theirs], { pickDefault: "you" } as ConfigView, OTHER.id)).toHaveLength(2);
  });
});

describe("mergedTickets", () => {
  it("adds the tickets of the scopes read since, once each by key", () => {
    const first = [ticket({ key: "A11-1" }), ticket({ key: "A11-2" })];
    const merged = mergedTickets(first, [ticket({ key: "A11-2" }), ticket({ key: "A11-3" }), ticket({ key: "A11-3" })]);
    expect(merged.map((t) => t.key)).toEqual(["A11-1", "A11-2", "A11-3"]);
  });
});

describe("contextParentsOf", () => {
  const mine = ticket({ key: "A11-1" });
  const theirs = ticket({ key: "A11-2", assignee: OTHER });
  const epic = ticket({ key: "A11-9" });

  it("is every ticket outside the scope, then the parents the instance names", () => {
    expect(contextParentsOf([mine, theirs], [epic], config(), "you").map((t) => t.key)).toEqual(["A11-2", "A11-9"]);
  });

  it("is the named parents only on an instance with no scope to be outside of", () => {
    expect(contextParentsOf([mine, theirs], [epic], { pickDefault: "you" } as ConfigView, "you").map((t) => t.key)).toEqual(["A11-9"]);
    expect(contextParentsOf([mine, theirs], [], null, "you")).toEqual([]);
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
  const view = <T,>(state: PollView<T>["state"], data: T | null, refusal: string | null = null): PollView<T> => ({ state, data, refusal, cached: false });
  const mine = ticket({ key: "A11-1" });
  const theirs = ticket({ key: "A11-2", assignee: OTHER });

  it("is loading until the tickets have been read", () => {
    expect(ticketsView(view("loading", null), view("ready", config()))).toEqual({ state: "loading", data: null, refusal: null, cached: false });
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
    expect(ticketsView(view("unreachable", [mine], "cannot reach personal"), view("ready", config()))).toEqual({ state: "unreachable", data: [mine], refusal: "cannot reach personal", cached: false });
  });

  it("is the config's failure when the config cannot be read, with nothing shown", () => {
    expect(ticketsView(view("ready", [mine, theirs]), view("error", null, "no config"))).toEqual({ state: "error", data: null, refusal: "no config", cached: false });
    expect(ticketsView(view("loading", null), view("unreachable", null, "cannot reach personal")).state).toBe("unreachable");
  });

  it("is reconnecting when the config cannot be read because the instance is restarting, and keeps the last good tickets when the tickets read does", () => {
    expect(ticketsView(view("loading", null), view("reconnecting", null, "Failed to fetch"))).toEqual({ state: "reconnecting", data: null, refusal: "Failed to fetch", cached: false });
    expect(ticketsView(view("reconnecting", [mine], "Failed to fetch"), view("ready", config()))).toEqual({ state: "reconnecting", data: [mine], refusal: "Failed to fetch", cached: false });
  });

  it("shows the scope chosen, from the first list and the pages read since", () => {
    const shown = ticketsView(view("ready", [mine]), view("ready", config()), { scope: "anyone", extra: [theirs] });
    expect(shown.data?.map((t) => t.key)).toEqual(["A11-1", "A11-2"]);
  });

  it("is loading, not empty, while the scope chosen is still being read", () => {
    expect(ticketsView(view("ready", [mine]), view("ready", config()), { scope: OTHER.id, reading: OTHER.id }).state).toBe("loading");
    expect(ticketsView(view("ready", [mine]), view("ready", config()), { scope: OTHER.id }).state).toBe("empty");
  });

  it("is an error, in the server's words, with the tickets it has, when a scope could not be read", () => {
    expect(ticketsView(view("ready", [mine]), view("ready", config()), { scope: "anyone", refusal: "tracker refused" })).toEqual({ state: "error", data: [mine], refusal: "tracker refused", cached: false });
  });

  it("keeps showing the tickets in scope when a later read of the config fails after it answered", () => {
    expect(ticketsView(view("ready", [mine, theirs]), view("error", config(), "late")).data?.map((t) => t.key)).toEqual(["A11-1"]);
  });
});
