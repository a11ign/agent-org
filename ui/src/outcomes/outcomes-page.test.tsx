import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DAY, NOW, outcomesFetch, outcomesFiles, type OutcomesFiles } from "../../test/outcomes/outcomes-stand.ts";
import { OutcomesApp } from "./OutcomesApp.tsx";

// THE OUTCOMES PAGE (A11-430, step 3 of 3) over the instance's own route: the stand answers `/api/outcomes` with `outcomesAnswer` over a scratch outcome log and host file (`outcomes-stand.ts`).
// The week: A11-1 and A11-2 on opus/high, A11-3 on sonnet/medium, all in agent-org; at the published prices (Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10 a million) opus/high cost $24 + $4 and
// sonnet/medium $2. A11-9 ended three weeks before and is outside the window.

const WEEK_QUERY = `?from=${NOW - 7 * DAY}&to=${NOW}`;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", `/outcomes${WEEK_QUERY}`);
});

/** The Outcomes page over `files`; resolves once the tables are drawn. */
async function pageOn(files: OutcomesFiles = outcomesFiles()) {
  const fetchWith = outcomesFetch(files);
  render(<OutcomesApp fetchWith={fetchWith} />);
  await screen.findByRole("heading", { name: "By model and effort" });
  return { fetchWith, files };
}

const table = (heading: string): HTMLElement => {
  const found = screen.getByRole("heading", { name: heading }).closest("section");
  if (found === null) throw new Error(`no section headed ${heading}`);
  return within(found).getByRole("table");
};

/** The text of each cell of the row headed `key` in the table under `heading`. */
const rowOf = (heading: string, key: string): string[] => {
  const row = within(table(heading)).getByRole("rowheader", { name: key }).closest("tr");
  if (row === null) throw new Error(`no row ${key}`);
  return [...row.querySelectorAll("th, td")].map((cell) => cell.textContent ?? "");
};

/** The runs the list under the tables shows, by ticket. */
const listedRuns = (): string[] => [...document.querySelectorAll(".outcomes-runs .outcomes-run")].map((link) => link.textContent ?? "");

describe("the week's figures by model and effort", () => {
  it("shows the cost, rounds per pull request, first-pass approval rate and Needs-you rate of opus/high and sonnet/medium", async () => {
    await pageOn();
    expect(within(table("By model and effort")).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Model / effort", "Runs", "Cost", "Reviewer", "Rounds per PR", "First-pass approval", "Needs you"]);
    expect(rowOf("By model and effort", "opus/high")).toEqual(["opus/high", "2", "$28.00", "$0.00", "1.5", "50%", "50%"]);
    expect(rowOf("By model and effort", "sonnet/medium")).toEqual(["sonnet/medium", "1", "$2.00", "$0.00", "1.0", "100%", "0%"]);
  });

  it("asks the instance for the window the page's address names, and leaves out a run that ended before it", async () => {
    const { fetchWith } = await pageOn();
    expect(fetchWith.paths).toContain(`/c/here/api/outcomes${WEEK_QUERY}`);
    expect(screen.getByText("3 runs")).toBeTruthy();
    expect(listedRuns()).toEqual(["A11-1", "A11-2", "A11-3"]);
  });

  it("rolls the same runs up by repository and by label, a run in each of its labels", async () => {
    await pageOn();
    expect(rowOf("By repository", "agent-org").slice(0, 3)).toEqual(["agent-org", "3", "$30.00"]);
    expect(rowOf("By label", "Bug").slice(0, 3)).toEqual(["Bug", "2", "$6.00"]);
    expect(rowOf("By label", "Feature").slice(0, 3)).toEqual(["Feature", "1", "$24.00"]);
  });
});

describe("each figure links to the runs behind it", () => {
  it("lists a figure's runs under the tables, each a link to its run's page, and Show every run goes back", async () => {
    await pageOn();
    fireEvent.click(within(table("By model and effort")).getByRole("button", { name: /^opus\/high, Cost:/ }));
    expect(screen.getByRole("heading", { name: "Cost, opus/high" })).toBeTruthy();
    expect(listedRuns()).toEqual(["A11-1", "A11-2"]);
    expect(screen.getByRole("link", { name: "A11-2" }).getAttribute("href")).toBe("/runs/A11-2");
    fireEvent.click(screen.getByRole("button", { name: "Show every run" }));
    expect(listedRuns()).toEqual(["A11-1", "A11-2", "A11-3"]);
  });

  it("lists the runs a rate is out of, and marks the figure chosen", async () => {
    await pageOn();
    const needsYou = within(table("By model and effort")).getByRole("button", { name: "opus/high, Needs you: 1 of 2 runs handed to a person" });
    fireEvent.click(needsYou);
    expect(needsYou.getAttribute("aria-pressed")).toBe("true");
    expect(listedRuns()).toEqual(["A11-1", "A11-2"]);
    fireEvent.click(within(table("By model and effort")).getByRole("button", { name: /^sonnet\/medium, First-pass approval:/ }));
    expect(needsYou.getAttribute("aria-pressed")).toBe("false");
    expect(listedRuns()).toEqual(["A11-3"]);
  });

  it("lists the runs that opened a pull request behind rounds per pull request", async () => {
    await pageOn();
    fireEvent.click(within(table("By label")).getByRole("button", { name: "Bug, Rounds per PR: 3 rounds over 2 pull requests" }));
    expect(listedRuns()).toEqual(["A11-2", "A11-3"]);
  });
});

describe("the prices", () => {
  it("says every dollar figure is at configured prices", async () => {
    await pageOn();
    expect(screen.getByText(/^Dollar figures are at configured prices/)).toBeTruthy();
    const costs = within(table("By model and effort")).getAllByRole("button", { name: /, (Cost|Reviewer):/ });
    expect(costs).toHaveLength(4);
    for (const cost of costs) expect(cost.getAttribute("title")).toMatch(/ at configured prices$/);
  });

  it("uses a price changed in the host file when the page is read again", async () => {
    const { files } = await pageOn();
    files.setPrices([{ prefix: "claude-opus-5-5", input: 8, output: 40, cacheRead: 0.4 }, { prefix: "claude-sonnet-5-5", input: 3, output: 15, cacheRead: 0.3 }]);
    cleanup();
    await pageOn(files);
    expect(rowOf("By model and effort", "opus/high").slice(0, 3)).toEqual(["opus/high", "2", "$56.00"]);
    expect(rowOf("By model and effort", "sonnet/medium").slice(0, 3)).toEqual(["sonnet/medium", "1", "$3.00"]);
    expect(within(table("By model and effort")).getByRole("button", { name: /^opus\/high, Cost:/ }).getAttribute("title")).toBe("$56.00 at configured prices");
  });

  it("shows a figure with an unpriced model as at least that much, never as a whole figure", async () => {
    const { files } = await pageOn();
    files.setPrices([{ prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2 }]);
    cleanup();
    await pageOn(files);
    expect(rowOf("By model and effort", "sonnet/medium")[2]).toBe("≥ $0.00");
    expect(rowOf("By model and effort", "opus/high")[2]).toBe("$28.00");
  });
});

describe("the window", () => {
  it("names its days and links the weeks either side of a week in the past", async () => {
    await pageOn();
    const nav = within(screen.getByRole("navigation", { name: "Window" }));
    expect(nav.getByText("7 Nov 2026 – 14 Nov 2026")).toBeTruthy();
    expect(nav.getByRole("link", { name: "Previous week" }).getAttribute("href")).toBe(`/outcomes?from=${NOW - 14 * DAY}&to=${NOW - 7 * DAY}`);
    expect(nav.getByRole("link", { name: "Next week" }).getAttribute("href")).toBe(`/outcomes?from=${NOW}&to=${NOW + 7 * DAY}`);
  });

  it("links no week after a window that reaches the browser's now, since no run has ended after it", async () => {
    const to = Date.now() + DAY;
    history.replaceState(null, "", `/outcomes?from=${to - 7 * DAY}&to=${to}`);
    render(<OutcomesApp fetchWith={outcomesFetch(outcomesFiles())} />);
    await screen.findByRole("link", { name: "Previous week" });
    expect(screen.queryByRole("link", { name: "Next week" })).toBeNull();
  });

  it("draws the empty panel for a week with no finished run, and still offers the week before", async () => {
    history.replaceState(null, "", `/outcomes?from=${NOW - 70 * DAY}&to=${NOW - 63 * DAY}`);
    render(<OutcomesApp fetchWith={outcomesFetch(outcomesFiles())} />);
    expect(await screen.findByText("No finished runs in this window")).toBeTruthy();
    expect(screen.getByText("0 runs")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Previous week" })).toBeTruthy();
  });
});

describe("the tab's storage", () => {
  it("keeps no week's answer, so stepping through weeks never fills it", async () => {
    await pageOn();
    expect(Object.keys(sessionStorage).filter((key) => key.includes("/api/outcomes"))).toEqual([]);
  });
});

describe("an outcome log the instance cannot read", () => {
  it("is the instance's sentence in the banner, never an empty week", async () => {
    const files = outcomesFiles();
    files.setLog("not a record\n");
    render(<OutcomesApp fetchWith={outcomesFetch(files)} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("line 1 of the outcome log");
    expect(screen.queryByText("No finished runs in this window")).toBeNull();
  });
});

describe("the sidebar", () => {
  it("marks Outcomes as the page shown, and links it", async () => {
    await pageOn();
    const outcomes = within(screen.getByRole("complementary", { name: "Atomaut" })).getAllByRole("link", { name: "Outcomes" });
    expect(outcomes.map((link) => [link.getAttribute("href"), link.getAttribute("aria-current")])).toEqual([["/outcomes", "page"]]);
  });
});
