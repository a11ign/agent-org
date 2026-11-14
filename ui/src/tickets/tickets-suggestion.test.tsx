import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Suggestion } from "../api/types.ts";
import { answers, BACKLOG, bar, openPage, posts, standOf, textOf, tick } from "./tickets-harness.tsx";

// The queue footer's suggested model and effort (A11-435): shown with its reason and sample size when past runs give one, and never chosen for the person.

const SONNET: Suggestion = { model: "sonnet", effort: "medium", firstPass: 94, n: 31, label: "dependency-update", repo: "agent-org", reason: "94% first-pass, n=31, on dependency-update tickets in agent-org" };

const asked: string[][] = [];
const suggesting = (suggestion: Suggestion | null) => standOf(answers(BACKLOG, {
  suggestion: (keys) => { asked.push([...keys]); return { suggestion }; },
  post: () => ({ entries: [], paused: false }),
}));

beforeEach(() => { asked.length = 0; });

describe("the suggested model and effort", () => {
  it("shows the suggestion for the selected tickets with its first-pass rate and sample size, asked again as the selection changes", async () => {
    await openPage(suggesting(SONNET));
    tick("A11-1");
    await waitFor(() => expect(textOf(bar())).toContain("Suggested: sonnet/medium · 94% first-pass, n=31, on dependency-update tickets in agent-org"));
    tick("A11-2");
    await waitFor(() => expect(asked).toContainEqual(["A11-1", "A11-2"]));
    expect(asked[0]).toEqual(["A11-1"]);
  });

  it("shows nothing when there is no suggestion: fewer past runs of the kind than the minimum", async () => {
    await openPage(suggesting(null));
    tick("A11-1");
    await waitFor(() => expect(asked).toEqual([["A11-1"]]));
    expect(textOf(bar())).not.toContain("Suggested");
    expect(textOf(bar())).not.toContain("No suggestion");
  });

  it("does not choose for the person: Queue sends the default, and a model the person picked is the one the run starts on", async () => {
    const { fetchWith } = await openPage(suggesting(SONNET));
    tick("A11-1");
    await waitFor(() => expect(textOf(bar())).toContain("Suggested: sonnet/medium"));
    fireEvent.click(screen.getByRole("button", { name: "Run options" }));
    const dialog = screen.getByRole("dialog", { name: "Run options" });
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "opus" } });
    fireEvent.click(within(bar()).getByRole("button", { name: "Queue 1 ticket" }));
    await waitFor(() => expect(posts(fetchWith, "/api/queue")).toHaveLength(1));
    expect(posts(fetchWith, "/api/queue")[0].body).toEqual({ keys: ["A11-1"], model: "opus", effort: "high", plan: true });
  });

  it("says why there is none when the outcome log cannot be read", async () => {
    const unreadable = standOf(answers(BACKLOG, { suggestion: () => ({ status: 400, error: "line 3 of the outcome log /state/tickets/outcomes.jsonl is not JSON" }) }));
    await openPage(unreadable);
    tick("A11-1");
    await waitFor(() => expect(textOf(bar())).toContain("No suggestion: line 3 of the outcome log /state/tickets/outcomes.jsonl is not JSON"));
  });

  it("shows nothing from an instance from before the route", async () => {
    const { fetchWith } = await openPage(standOf(answers(BACKLOG)));
    tick("A11-1");
    await waitFor(() => expect(fetchWith.paths.some((path) => path.includes("/api/suggestion"))).toBe(true));
    expect(textOf(bar())).not.toContain("uggestion");
  });
});
