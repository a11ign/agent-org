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
const viewOf = (totals: readonly number[]) => ({ today: totals.at(-1), days: WEEK.map((date, index) => ({ date, needsYou: totals[index], fixes: 0, total: totals[index] })) });

/** The Runs page over the stand-in instance, with `/api/interventions` answered by `answer`: a view, a status to fail with, or "held" for a read that never answers. */
function pageWith(answer: ReturnType<typeof viewOf> | number | "held") {
  const stand = standFetch(runsStand());
  const fetchWith = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/api/interventions")) return stand(input, init);
    if (answer === "held") return new Promise<Response>(() => undefined);
    if (typeof answer === "number") return Promise.resolve(new Response(JSON.stringify({ error: "no" }), { status: answer }));
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } }));
  }) as Fetch;
  return render(<RunsApp fetchWith={fetchWith} />);
}

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
