import { runsStand, working } from "../../test/runs/runs-stand.ts";
import { pageOn, rowOf, screen, textOf } from "./runs-harness.tsx";

const MINUTE = 60_000;

const figures = { pushes: 3, jobs: 48, weighted: 184 };
const ciOf = (state: "ok" | "over" | "held", ticket = figures) => ({ run: figures, ticket, budget: 300, state });

/** One live run per state, so each is a row of its own on one page. */
const runs = () => [
  working({ key: "A11-1", title: "under its budget", startedAgo: MINUTE, ci: ciOf("ok") }),
  working({ key: "A11-2", title: "over its budget", startedAgo: MINUTE, ci: ciOf("over", { pushes: 7, jobs: 90, weighted: 340 }) }),
  working({ key: "A11-3", title: "held for its budget", startedAgo: MINUTE, ci: ciOf("held", { pushes: 12, jobs: 150, weighted: 640 }) }),
  working({ key: "A11-4", title: "no CI read yet", startedAgo: MINUTE, sessionNote: "a session note" }),
];

const lineOf = (key: string): HTMLElement | null => rowOf(key).querySelector<HTMLElement>(".run-ci");

/** The page over the four runs, once the row titled `title` is drawn. */
async function pageShowing(title: string): Promise<void> {
  await pageOn(runsStand({ runs: runs() }));
  await screen.findByText(title);
}

/** What the card's CI line says of a run, and whether it is in the warn tone. */
const seen = (key: string): { text: string; warn: boolean } => ({ text: textOf(lineOf(key)), warn: lineOf(key)?.classList.contains("tone-warn") === true });

describe("the CI line of a run's card (A11-261)", () => {
  it("is plain under the budget, in an element of its own", async () => {
    await pageShowing("under its budget");
    expect(seen("A11-1")).toEqual({ text: "CI: 3 pushes, 48 jobs, ~184 min", warn: false });
  });

  it("takes the warn tone past the budget, with the ticket's total and the budget in its words", async () => {
    await pageShowing("over its budget");
    expect(seen("A11-2")).toEqual({ text: "CI: 3 pushes, 48 jobs, ~184 min (ticket ~340 min) · over budget (300)", warn: true });
  });

  it("takes the warn tone when the run is held at twice the budget", async () => {
    await pageShowing("held for its budget");
    expect(seen("A11-3")).toEqual({ text: "CI: 3 pushes, 48 jobs, ~184 min (ticket ~640 min) · over twice the budget (300)", warn: true });
  });

  it("is drawn only for a run the board has read CI of, and is not repeated in the note", async () => {
    await pageShowing("no CI read yet");
    expect(lineOf("A11-4")).toBeNull();
    for (const key of ["A11-1", "A11-2", "A11-3", "A11-4"]) expect(textOf(rowOf(key).querySelector(".run-note"))).not.toContain("CI:");
    expect(textOf(rowOf("A11-4").querySelector(".run-note"))).toBe("a session note");
  });
});
