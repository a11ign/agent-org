import { render, screen, waitFor } from "@testing-library/react";
import type { Fetch } from "../api/request.ts";
import { standFetch } from "../../test/fixtures.ts";
import { runsStand } from "../../test/runs/runs-stand.ts";
import { RunsApp } from "./RunsApp.tsx";

// A11-257: the health number, the person-interventions of today, on the pool bar.
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/runs");
});

const WEEK = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"];
const viewOf = (totals: readonly number[]) => ({ today: totals.at(-1), days: WEEK.map((date, index) => ({ date, needsYou: totals[index], fixes: 0, total: totals[index], standoffs: 0 })) });

/** The Runs page over the stand-in instance, with the read at `route` answered by `answer`: a view, a status to fail with, or "held" for a read that never answers. */
function pageAnswering(route: string, answer: object | number | "held") {
  const stand = standFetch(runsStand());
  const fetchWith = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith(route)) return stand(input, init);
    if (answer === "held") return new Promise<Response>(() => undefined);
    if (typeof answer === "number") return Promise.resolve(new Response(JSON.stringify({ error: "no" }), { status: answer }));
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as Fetch;
  return render(<RunsApp fetchWith={fetchWith} />);
}

/** The Runs page with `/api/interventions` answered by `answer`. */
const pageWith = (answer: ReturnType<typeof viewOf> | number | "held") => pageAnswering("/api/interventions", answer);

const poolBar = async (): Promise<HTMLElement> => {
  await waitFor(() => expect(document.querySelector(".pool-bar")).not.toBeNull());
  return document.querySelector<HTMLElement>(".pool-bar")!;
};

describe("the health number", () => {
  it("reads 'Person interventions today: N' on the pool bar, and its title lists the last 7 days oldest first, each as a date and its count", async () => {
    pageWith(viewOf([2, 0, 0, 1, 0, 3, 4]));
    const bar = await poolBar();
    const number = await waitFor(() => {
      const found = [...bar.querySelectorAll<HTMLElement>(".pool-note")].find((note) => /Person interventions/.test(note.textContent ?? ""));
      expect(found).toBeDefined();
      return found!;
    });
    expect(number.textContent).toBe("Person interventions today: 4");
    expect(number.getAttribute("title")).toBe(WEEK.map((date, index) => `${date}: ${[2, 0, 0, 1, 0, 3, 4][index]}`).join("\n"));
    expect(bar.querySelector(".pool-busy")?.nextElementSibling).toBe(number);
  });

  it("says after the number how many stand-offs the board settled with no person today, and names the days in the title (A11-290)", async () => {
    const view = viewOf([0, 0, 0, 0, 0, 0, 0]);
    pageWith({ ...view, days: view.days.map((day, index) => ({ ...day, standoffs: index === 5 ? 1 : index === 6 ? 2 : 0 })) });
    const number = await screen.findByText("Person interventions today: 0, stand-offs settled with no person: 2");
    expect(number.getAttribute("title")).toContain("2026-10-25: 0 (1 stand-offs settled with no person)");
    expect(number.getAttribute("title")).toContain("2026-10-24: 0\n");
  });

  it("shows 0 as 0: zero is the target and is seen", async () => {
    pageWith(viewOf([0, 0, 0, 0, 0, 0, 0]));
    const number = await screen.findByText("Person interventions today: 0");
    expect(number.getAttribute("title")).toBe(WEEK.map((date) => `${date}: 0`).join("\n"));
  });

  it("draws nothing while the number is loading", async () => {
    pageWith("held");
    const bar = await poolBar();
    expect(bar.textContent).not.toMatch(/Person interventions/);
  });

  it("draws nothing from the tab's kept copy of an earlier visit while this visit's read has not answered", async () => {
    const first = pageWith(viewOf([0, 0, 0, 0, 0, 0, 9]));
    await screen.findByText("Person interventions today: 9");
    first.unmount();
    pageWith("held");
    const bar = await poolBar();
    expect(bar.textContent).not.toMatch(/Person interventions/);
  });

  it("draws nothing when the read failed, and not a zero", async () => {
    pageWith(500);
    const bar = await poolBar();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bar.textContent).not.toMatch(/Person interventions/);
    expect(bar.textContent).not.toMatch(/today: 0/);
  });
});

// A11-300: the tests that flaked three times in seven days, listed on the pool bar as needing a fix.
const flakyView = (counts: readonly number[]) => ({ limit: 3, days: 7, tests: counts.map((count, index) => ({ test: `src/a${index}.test.ts > flakes`, check: "suite (2)", count, last: 0, runs: [] })) });

/** The Runs page with `/api/flakes` answered by `answer`. */
const pageWithFlakes = (answer: ReturnType<typeof flakyView> | number | "held") => pageAnswering("/api/flakes", answer);

describe("the flaky tests", () => {
  it("reads 'Flaky tests needing a fix: N' on the pool bar, and its title names each test with how often it flaked", async () => {
    pageWithFlakes(flakyView([4, 3]));
    const bar = await poolBar();
    const note = await waitFor(() => {
      const found = bar.querySelector<HTMLElement>(".pool-flakes");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(note.textContent).toBe("Flaky tests needing a fix: 2 (flaked 3+ times in 7 days)");
    expect(note.getAttribute("title")).toBe("src/a0.test.ts > flakes (suite (2)): flaked 4 times in 7 days\nsrc/a1.test.ts > flakes (suite (2)): flaked 3 times in 7 days");
  });

  it("draws nothing when no test needs a fix, while the list is loading, and when the read failed", async () => {
    for (const answer of [flakyView([]), "held", 500] as const) {
      const page = pageWithFlakes(answer);
      const bar = await poolBar();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bar.querySelector(".pool-flakes")).toBeNull();
      page.unmount();
    }
  });
});
