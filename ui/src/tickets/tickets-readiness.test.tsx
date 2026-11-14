import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { queueingConfig, ticket } from "../../test/fixtures.ts";
import type { ReadinessAnswer, ReadinessView } from "../api/types.ts";
import { answers, BACKLOG, openPage, posts, rowOf, standOf, textOf } from "./tickets-harness.tsx";

// Each ticket's readiness score (A11-443): a low one shows its score, its reasons and "Improve with the writer", which opens the New ticket dialog filled in with the ticket and its reasons.

const LOW: ReadinessView = { state: "scored", score: 20, reasons: ["No acceptance criteria.", "No repository is named."], low: true };
const READY: ReadinessView = { state: "scored", score: 90, reasons: [], low: false };

/** An instance with tickets.readiness `on` (and a writer unless `writer` is false), whose readiness route answers `scores` for the keys asked. */
function scoring(scores: Record<string, ReadinessView>, { on = true, writer = true } = {}) {
  const asked: string[][] = [];
  const stand = standOf(answers(BACKLOG, {
    config: queueingConfig({ readiness: on, writer }),
    post: (path, body) => {
      if (!path.endsWith("/api/readiness")) return { entries: [], paused: false };
      const keys = (body as { keys: string[] }).keys;
      asked.push(keys);
      const answer: ReadinessAnswer = { on: true, scores: Object.fromEntries(keys.flatMap((key) => (scores[key] === undefined ? [] : [[key, scores[key]]]))) };
      return answer;
    },
  }));
  return { stand, asked };
}

describe("a ticket's readiness score", () => {
  it("shows a low score with its reasons and an Improve with the writer button, and a ready one as its score alone", async () => {
    const { stand, asked } = scoring({ "A11-1": LOW, "A11-2": READY });
    await openPage(stand);
    await waitFor(() => expect(textOf(rowOf("A11-1"))).toContain("Readiness 20"));
    expect(asked[0]).toEqual(["A11-1", "A11-2", "A11-3"]);
    expect(textOf(rowOf("A11-1"))).toContain("No acceptance criteria. No repository is named.");
    expect(within(rowOf("A11-1")).getByRole("button", { name: "Improve with the writer" })).toBeTruthy();
    expect(textOf(rowOf("A11-2"))).toContain("Readiness 90");
    expect(within(rowOf("A11-2")).queryByRole("button", { name: "Improve with the writer" })).toBeNull();
    expect(textOf(rowOf("A11-3"))).not.toContain("Readiness");
  });

  it("opens the New ticket dialog filled in with the ticket, its score and its reasons, and sends nothing until the person does", async () => {
    const { stand } = scoring({ "A11-1": LOW });
    const { fetchWith } = await openPage(stand);
    await waitFor(() => expect(within(rowOf("A11-1")).getByRole("button", { name: "Improve with the writer" })).toBeTruthy());
    fireEvent.click(within(rowOf("A11-1")).getByRole("button", { name: "Improve with the writer" }));
    const request = screen.getByLabelText<HTMLTextAreaElement>("What is the ticket for?");
    expect(request.value).toBe("Improve A11-1 (Fix the fleet) in place: edit its description, and file no new ticket. Its readiness score is 20 of 100. What it is missing: No acceptance criteria. No repository is named.");
    expect(posts(fetchWith, "/api/writer")).toHaveLength(0);
  });

  it("disables Improve with the writer on a machine with no ticket writer", async () => {
    const { stand } = scoring({ "A11-1": LOW }, { writer: false });
    await openPage(stand);
    await waitFor(() => expect(textOf(rowOf("A11-1"))).toContain("Readiness 20"));
    expect(within(rowOf("A11-1")).getByRole<HTMLButtonElement>("button", { name: "Improve with the writer" }).disabled).toBe(true);
  });

  it("asks for nothing and shows nothing while tickets.readiness is off", async () => {
    const { stand, asked } = scoring({ "A11-1": LOW }, { on: false });
    const { fetchWith } = await openPage(stand);
    expect(textOf(rowOf("A11-1"))).not.toContain("Readiness");
    expect(asked).toEqual([]);
    expect(posts(fetchWith, "/api/readiness")).toHaveLength(0);
  });

  it("does not score a parent, which is never queued itself", async () => {
    const parent = ticket({ key: "A11-9", title: "An epic", children: ["A11-1"] });
    const { stand, asked } = scoring({ "A11-1": LOW });
    const withParent = { ...stand, instances: { here: { ...stand.instances!.here!, tickets: [...BACKLOG, parent] } } };
    await openPage(withParent);
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked[0]).not.toContain("A11-9");
  });
});
