import { writerRun } from "../new-ticket/new-ticket-fixtures.ts";
import { agoOf, arrivedOf, bellLabelOf, clearLabelOf, countsOf, emptyOf, filtered, notificationsOf, underWayOf, writerNotificationOf } from "./notifications-model.ts";

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const done = (id: string, minutesAgo: number | null, fields = {}) => writerRun({ id, phase: "finished", status: "done", ...(minutesAgo === null ? {} : { finishedAt: NOW - minutesAgo * MIN }), ...fields });

describe("agoOf", () => {
  it.each([
    [0, "just now"], [30_000, "just now"], [MIN, "1 min ago"], [14 * MIN, "14 min ago"], [59 * MIN, "59 min ago"], [60 * MIN, "1 h ago"], [5 * 60 * MIN, "5 h ago"],
    [24 * 60 * MIN, "yesterday"], [47 * 60 * MIN, "yesterday"], [48 * 60 * MIN, "2 d ago"],
  ])("reads %i ms as %s", (elapsed, words) => expect(agoOf(NOW - elapsed, NOW)).toBe(words));

  it("reads a time in the future (clocks differ) as just now, and no time as earlier", () => {
    expect(agoOf(NOW + 5 * MIN, NOW)).toBe("just now");
    expect(agoOf(null, NOW)).toBe("earlier");
  });
});

describe("notificationsOf", () => {
  it("lists only finished requests, newest first, a new arrival before the rest, and one with no time last", () => {
    const runs = [done("old", 90), writerRun({ id: "going" }), done("none", null), done("new", 1), done("arrived", 600)];
    expect(notificationsOf(runs, new Set(["arrived"])).map((item) => item.id)).toEqual(["arrived", "new", "old", "none"]);
  });

  it("maps a request to an item of a kind, with its outcome, head line, text, reason and tickets", () => {
    const item = { ...writerNotificationOf(done("w1", 2, { status: "failed", failure: "The brief names no team", mode: "grill" })), fresh: true };
    expect(item).toMatchObject({ id: "w1", kind: "writer", outcome: "failed", at: NOW - 2 * MIN, headline: "Ticket writer · sonnet/high · Grill", failure: "The brief names no team", tickets: [], fresh: true });
  });

  it("gives a Done request no reason, even if one is stored", () => {
    expect(writerNotificationOf(done("w1", 2, { failure: "stale" }))).toMatchObject({ outcome: "succeeded", failure: null });
  });
});

describe("the filters", () => {
  const items = notificationsOf([done("a", 1), done("b", 2), done("c", 3, { status: "failed" })], new Set());
  it("count each outcome and filter by it", () => {
    expect(countsOf(items)).toEqual({ all: 3, succeeded: 2, failed: 1 });
    expect(filtered(items, "succeeded").map((item) => item.id)).toEqual(["a", "b"]);
    expect(filtered(items, "failed").map((item) => item.id)).toEqual(["c"]);
    expect(filtered(items, "all")).toBe(items);
  });
});

describe("the words", () => {
  it("name the bell by the count, and a clear button by outcome and age", () => {
    expect(bellLabelOf(3)).toBe("Notifications, 3");
    const [item] = notificationsOf([done("a", 2)], new Set());
    expect(clearLabelOf(item as NonNullable<typeof item>, NOW)).toBe("Clear notification: done, 2 min ago");
    const [failed] = notificationsOf([done("a", null, { status: "failed" })], new Set());
    expect(clearLabelOf(failed as NonNullable<typeof failed>, NOW)).toBe("Clear notification: failed, earlier");
  });

  it("say all caught up when nothing is held, and which filter is empty otherwise", () => {
    expect(emptyOf("failed", 0).title).toBe("You are all caught up");
    expect(emptyOf("all", 0).title).toBe("You are all caught up");
    expect(emptyOf("failed", 2)).toEqual({ title: "No failed notifications", note: "Nothing has failed since these were last cleared." });
    expect(emptyOf("succeeded", 2)).toEqual({ title: "No succeeded notifications", note: "Nothing has finished successfully since these were last cleared." });
  });
});

describe("arrivals", () => {
  it("are the requests seen under way and now finished, and not one first seen finished", () => {
    const before = underWayOf([writerRun({ id: "a" }), writerRun({ id: "b", phase: "queued", status: "queued" }), done("c", 1)]);
    expect([...before]).toEqual(["a", "b"]);
    expect(arrivedOf(before, [done("a", 0), writerRun({ id: "b" }), done("c", 1), done("d", 0)])).toEqual(["a"]);
  });
});
