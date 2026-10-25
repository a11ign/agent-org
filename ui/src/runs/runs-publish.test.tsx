import { act } from "@testing-library/react";
import { selectOf, selectRuns, PUBLISHER_REASON, REFUSAL, TICKABLE, MESSAGE } from "../../test/publish/publish-stand.ts";
import { fireEvent, keysShown, pageOn, posts, rowOf, screen, textOf, waitFor, within } from "./runs-harness.tsx";

const tickOf = (key: string): HTMLInputElement | null => within(rowOf(key)).queryByRole("checkbox", { name: `Select ${key} to publish` });
const tick = (key: string) => fireEvent.click(within(rowOf(key)).getByRole("checkbox", { name: `Select ${key} to publish` }));
const bar = () => screen.queryByRole("region", { name: "Selected runs" });
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
/** The Runs page on a machine whose publisher takes every post. */
const acceptingPage = () => pageOn(selectOf({ post: () => ({ entries: [] }) }));
/** The body of the one post to /api/publish, once it has been made. */
const publishedBody = async (fetchWith: Parameters<typeof posts>[0]) => {
  await waitFor(() => expect(posts(fetchWith, "/api/publish")).toHaveLength(1));
  return posts(fetchWith, "/api/publish")[0].body;
};

describe("Publish on a machine with no publisher", () => {
  it("draws no tick box, no tick column and no selection bar", async () => {
    await pageOn(selectOf({ publisher: false }));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(document.querySelector(".run-tick")).toBeNull();
    expect(bar()).toBeNull();
  });

  it("shows no publish run's failure, since this machine has none", async () => {
    await pageOn(selectOf({ publisher: false }, selectRuns(), { keys: ["A11-30"], phase: "finished", failure: PUBLISHER_REASON }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Publish on a machine with a publisher", () => {
  it("draws a tick box on each publishable Ready to merge run and on no other, but reserves the column on every row", async () => {
    await pageOn(selectOf());
    const withBox = keysShown().filter((key) => tickOf(key) !== null);
    expect(withBox.sort()).toEqual([...TICKABLE].sort());
    expect(document.querySelectorAll(".run-row")).toHaveLength(document.querySelectorAll(".run-tick").length);
    // Publishing (A11-32) and Published (A11-27) rows have a status of their own and no tick.
    expect(tickOf("A11-32")).toBeNull();
    expect(tickOf("A11-27")).toBeNull();
  });

  it("draws the bar only while a run is ticked", async () => {
    await pageOn(selectOf());
    expect(bar()).toBeNull();
    tick("A11-180");
    expect(within(bar() as HTMLElement).getByText("1 selected")).toBeTruthy();
  });

  it("counts the ticks, tints the ticked rows, and says what Publish does", async () => {
    await pageOn(selectOf());
    tick("A11-180");
    tick("A11-29");
    const region = within(bar() as HTMLElement);
    expect(region.getByText("2 selected")).toBeTruthy();
    expect(region.getByText("Posts their pull requests. Nothing is merged.")).toBeTruthy();
    expect(region.getByRole("button", { name: "Publish selected (2)" })).toBeTruthy();
    expect(rowOf("A11-180").classList.contains("run-row-picked")).toBe(true);
    expect(rowOf("A11-30").classList.contains("run-row-picked")).toBe(false);
  });

  it("posts the ticked keys, in the order they were ticked, to /api/publish, and empties the selection", async () => {
    const { fetchWith } = await acceptingPage();
    tick("A11-29");
    tick("A11-180");
    press("Publish selected (2)");
    expect(await publishedBody(fetchWith)).toEqual({ keys: ["A11-29", "A11-180"] });
    await waitFor(() => expect(bar()).toBeNull());
    expect(tickOf("A11-29")?.checked).toBe(false);
  });

  it("posts a single ticked run alone, and drops only the runs it posted: one ticked while the post is out stays ticked", async () => {
    const { fetchWith } = await acceptingPage();
    tick("A11-180");
    press("Publish selected (1)");
    tick("A11-30");
    expect(await publishedBody(fetchWith)).toEqual({ keys: ["A11-180"] });
    await waitFor(() => expect(tickOf("A11-180")?.checked).toBe(false));
    expect(tickOf("A11-30")?.checked).toBe(true);
    expect(within(bar() as HTMLElement).getByText("1 selected")).toBeTruthy();
  });

  it("empties the selection and hides the bar on Clear, posting nothing", async () => {
    const { fetchWith } = await pageOn(selectOf());
    tick("A11-180");
    tick("A11-30");
    press("Clear");
    expect(bar()).toBeNull();
    expect(tickOf("A11-180")?.checked).toBe(false);
    expect(posts(fetchWith, "/api/publish")).toHaveLength(0);
  });

  it("keeps the ticks when the filter changes", async () => {
    await pageOn(selectOf());
    tick("A11-180");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Run status" })).getByRole("button", { name: /^Completed/ }));
    await waitFor(() => expect(keysShown()).toEqual(["A11-179"]));
    expect(within(bar() as HTMLElement).getByText("1 selected")).toBeTruthy();
  });
});

describe("a publish that did not happen", () => {
  it("does not let a dismissed publish failure hide the next refusal: a refused Pause is shown", async () => {
    const failed = { keys: ["A11-30"], phase: "finished", failure: PUBLISHER_REASON };
    await pageOn(selectOf({ post: () => ({ status: 409, error: "the workers are already paused" }) }, selectRuns(), failed));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    press("Pause");
    const alert = await screen.findByRole("alert");
    expect(textOf(alert)).toContain("the workers are already paused");
    expect(within(alert).queryByText("Not published.")).toBeNull();
  });

  it("shows the server's sentence under Not published. when it refuses, and keeps the selection to try again", async () => {
    await pageOn(selectOf({ post: () => ({ status: 409, error: REFUSAL }) }));
    tick("A11-180");
    tick("A11-30");
    press("Publish selected (2)");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Not published.")).toBeTruthy();
    expect(within(alert).getByText(REFUSAL)).toBeTruthy();
    expect(within(bar() as HTMLElement).getByText("2 selected")).toBeTruthy();
    expect(tickOf("A11-180")?.checked).toBe(true);
  });

  it("shows the publisher's reason for a publish run that failed, under Not published.", async () => {
    await pageOn(selectOf({}, selectRuns(), { keys: ["A11-30"], phase: "finished", failure: PUBLISHER_REASON }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Not published.")).toBeTruthy();
    expect(within(alert).getByText(`Publishing 1 run failed: ${PUBLISHER_REASON}`)).toBeTruthy();
    expect(tickOf("A11-30")).not.toBeNull();
  });
});

describe("the ticks when the next read changes the queue", () => {
  /** A stand whose queue is read afresh each time, from `now`, which a check changes between reads. */
  function changing(now: { runs: ReturnType<typeof selectRuns>; publish: { keys: readonly string[]; phase: string } | undefined }) {
    const stand = selectOf();
    const instance = stand.instances?.personal;
    if (instance === undefined) throw new Error("the stand holds no instance");
    const live = { ...instance, get queue() { return { ...instance.queue, entries: now.runs, publish: now.publish }; } };
    return { ...stand, instances: { personal: live as never } };
  }
  /** Has the shell read the queue again, as it does when the page is focused. */
  const readAgain = () => act(async () => { fireEvent.focus(window); document.dispatchEvent(new Event("visibilitychange")); });

  it("drops a ticked run that was dismissed from the selection, and keeps the other", async () => {
    const now = { runs: selectRuns(), publish: undefined };
    await pageOn(changing(now));
    tick("A11-30");
    tick("A11-29");
    now.runs = now.runs.filter((run) => (run.ticket as { key: string }).key !== "A11-30");
    await readAgain();
    await waitFor(() => expect(keysShown()).not.toContain("A11-30"), { timeout: 8000 });
    expect(within(bar() as HTMLElement).getByText("1 selected")).toBeTruthy();
    expect(tickOf("A11-29")?.checked).toBe(true);
  });

  it("drops a ticked run that a publish run now holds, and hides the bar when none is left", async () => {
    const now: { runs: ReturnType<typeof selectRuns>; publish: { keys: readonly string[]; phase: string } | undefined } = { runs: selectRuns(), publish: undefined };
    await pageOn(changing(now));
    tick("A11-29");
    now.publish = { keys: ["A11-29"], phase: "running" };
    await readAgain();
    await waitFor(() => expect(bar()).toBeNull(), { timeout: 8000 });
    expect(textOf(rowOf("A11-29").querySelector(".run-state"))).toBe("Publishing");
  });
});

describe("the Publishing and Published rows", () => {
  it("name their status, and the Published row links the posted message beside its pull request", async () => {
    await pageOn(selectOf());
    expect(textOf(rowOf("A11-32").querySelector(".run-state"))).toBe("Publishing");
    expect(textOf(rowOf("A11-27").querySelector(".run-state"))).toBe("Published");
    expect(within(rowOf("A11-27")).getByRole("img", { name: "Published" })).toBeTruthy();
    const message = within(rowOf("A11-27")).getByRole("link", { name: "Slack message" });
    expect(message.getAttribute("href")).toBe(MESSAGE);
    expect(message.getAttribute("title")).toBe("Open the Slack message");
    expect(within(rowOf("A11-32")).queryByRole("link", { name: "Slack message" })).toBeNull();
  });

  it("are grouped under their own status, as A11-197 grouped them, and not under a Delivery heading", async () => {
    await pageOn(selectOf());
    const heads = [...document.querySelectorAll(".runs-head-label")].map(textOf);
    expect(heads).toEqual(expect.arrayContaining(["Ready to merge", "Publishing", "Published"]));
    expect(heads).not.toContain("Delivery");
  });
});
