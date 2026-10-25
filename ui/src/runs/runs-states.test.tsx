import { render } from "@testing-library/react";
import { PERSONAL, queueingConfig, standFetch, type InstanceAnswers } from "../../test/fixtures.ts";
import { boardRuns, completed, queueWith, queuedRun, runsStand, working } from "../../test/runs/runs-stand.ts";
import { fireEvent, headings, keysShown, pageOn, posts, rail, rowOf, screen, textOf, waitFor, within } from "./runs-harness.tsx";
import { RunsApp } from "./RunsApp.tsx";

const MINUTE = 60_000;

describe("the loading state", () => {
  it("is the board's list skeleton and rail skeleton, with the h1 and the count's skeleton already drawn", async () => {
    await pageOn({ ...runsStand(), holdInstance: true }, { ready: false });
    const skeleton = await screen.findByRole("status", { name: "Loading runs" });
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.querySelectorAll(".skeleton-runs-row")).toHaveLength(6);
    expect(screen.getByRole("status", { name: "Loading run statuses" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Runs");
    expect(document.querySelector(".page-header .sk")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Run status" })).toBeNull();
    expect(screen.queryByText(/of \d+ busy/)).toBeNull();
  });
});

describe("wait cycles (A11-272)", () => {
  const FILES = ["lab:middleware/runtime/main.py"];
  const cycle = () => [
    working({ key: "A11-231", title: "parked", startedAgo: MINUTE, paths: FILES, working: { reason: "waits", at: Date.now(), waiting: true, waits: [{ kind: "ticket", key: "A11-229" }], waitText: "Waiting on ticket A11-229 (In Progress)" } }),
    queuedRun("A11-229", "held", MINUTE, { paths: FILES }),
  ];

  it("draws one banner for the cycle, naming it, and the cards say Waiting and name the cycle", async () => {
    await pageOn(runsStand({ runs: cycle() }));
    await screen.findByText("held");
    const banners = [...document.querySelectorAll(".status-banner")].map(textOf);
    expect(banners).toEqual(["Wait cycle A11-229 → A11-231 → A11-229: A11-229 is held behind A11-231's files; A11-231's worker waits on A11-229."]);
    expect(textOf(rowOf("A11-231"))).toMatch(/Waiting on ticket A11-229 \(In Progress\), until \d\d:\d\d/);
    expect(textOf(rowOf("A11-231"))).not.toMatch(/In progress/);
    expect(textOf(rowOf("A11-229"))).toContain("in a wait cycle: A11-229 → A11-231 → A11-229");
    expect(rail().getByRole("button", { name: /^Waiting/ }).textContent).toMatch(/1$/);
  });

  it("draws no banner when no ticket waits on another", async () => {
    await pageOn(runsStand({ runs: [working({ key: "A11-1", title: "at work", startedAgo: MINUTE }), queuedRun("A11-2", "q", MINUTE)] }));
    await screen.findByText("at work");
    expect(document.querySelector(".status-banner")).toBeNull();
  });
});

describe("the empty state", () => {
  it("is No runs yet with Go to Tickets, 0 total, 0 of N busy, and no rail", async () => {
    await pageOn(runsStand({ runs: [], max: 6 }));
    expect(await screen.findByText("No runs yet")).toBeTruthy();
    expect(screen.getByText("Queue tickets from the Tickets page and each one shows up here as it runs.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Tickets" }).getAttribute("href")).toBe("/tickets");
    expect(textOf(document.querySelector(".page-count"))).toBe("0 total");
    expect(screen.getByRole("img", { name: "0 of 6 busy" })).toBeTruthy();
    expect(document.querySelectorAll(".slot")).toHaveLength(6);
    expect(screen.queryByRole("navigation", { name: "Run status" })).toBeNull();
  });
});

describe("the paused state", () => {
  it("says Workers paused and Nothing queued will start, draws the list and the rail, and Start workers posts /api/paused", async () => {
    // The instance holds what it was last told, as the real one does: the queue read after the press says started.
    let paused = true;
    const instance: InstanceAnswers = { config: queueingConfig(), get queue() { return queueWith(boardRuns(), { paused }); }, post: () => { paused = false; return queueWith(boardRuns(), { paused }); } };
    const { fetchWith } = await pageOn({ connections: [PERSONAL], instances: { personal: instance } });
    expect(await screen.findByText("Workers paused")).toBeTruthy();
    expect(screen.getByText("Nothing queued will start.")).toBeTruthy();
    expect(rail().getByRole("button", { name: /^All runs/ })).toBeTruthy();
    expect(keysShown()).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Start workers" }));
    await waitFor(() => expect(screen.getByText("Workers started")).toBeTruthy());
    expect(posts(fetchWith, "/api/paused").map(({ body }) => body)).toEqual([{ paused: false }]);
    expect(screen.getByText("Queued tickets start as slots free up.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("links Change limit to Settings, Workers", async () => {
    await pageOn();
    expect(screen.getByRole("link", { name: "Change limit" }).getAttribute("href")).toBe("/settings/workers");
  });

  it("shows a refused pause in the failure banner", async () => {
    await pageOn(runsStand({ post: () => ({ status: 409, error: "the pool is busy right now" }) }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(textOf(await screen.findByRole("alert"))).toContain("the pool is busy right now");
  });
});

describe("the error state", () => {
  it("is the banner with the server's sentence, Retry reading the queue again, and Dismiss hiding it until the next failure", async () => {
    let failing = true;
    const instance: InstanceAnswers = { config: queueingConfig(), queue: queueWith(boardRuns()), get queueFails() { return failing ? { status: 500, error: "the queue file is unreadable" } : undefined; } };
    const fetchWith = standFetch({ connections: [PERSONAL], instances: { personal: instance } });
    render(<RunsApp fetchWith={fetchWith} />);
    const alert = await screen.findByRole("alert");
    expect(textOf(alert)).toContain("the queue file is unreadable");
    expect(keysShown()).toEqual([]);
    failing = false;
    const reads = fetchWith.paths.filter((path) => path === "/c/personal/api/queue").length;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchWith.paths.filter((path) => path === "/c/personal/api/queue").length).toBe(reads + 1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(keysShown()).toContain("A11-179"));
    expect(keysShown()).toHaveLength(50);
  });

  it("hides the banner with Dismiss", async () => {
    render(<RunsApp fetchWith={standFetch(runsStand({ queueFails: { status: 500, error: "the queue file is unreadable" } }))} />);
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the last good list beneath a refused action's banner", async () => {
    await pageOn(runsStand({ post: () => ({ status: 409, error: "A11-179 cannot be dismissed" }) }));
    fireEvent.click(within(document.getElementById("run-A11-179") as HTMLElement).getByRole("button", { name: "Dismiss from list" }));
    expect(textOf(await screen.findByRole("alert"))).toContain("A11-179 cannot be dismissed");
    expect(keysShown()).toHaveLength(50);
  });

  it("says an SSH instance cannot be reached in the shared frame, with the last list beneath it", async () => {
    let down = false;
    const instance: InstanceAnswers = { config: queueingConfig(), queue: queueWith(boardRuns()), get queueFails() { return down ? { status: 502, error: "cannot reach personal: ssh: timed out" } : undefined; }, post: () => queueWith(boardRuns()) };
    render(<RunsApp fetchWith={standFetch({ connections: [PERSONAL], instances: { personal: instance } })} />);
    await waitFor(() => expect(keysShown()).toHaveLength(50));
    down = true;
    const first = document.getElementById("run-A11-179") as HTMLElement;
    fireEvent.click(within(first).getByRole("button", { name: "Dismiss from list" }));
    expect(await screen.findByText("Can't reach personal over SSH.", {}, { timeout: 10_000 })).toBeTruthy();
    expect(keysShown()).toHaveLength(50);
  }, 30_000);
});

describe("the page while an SSH instance cannot be reached or an answer fails", () => {
  const DOWN = { status: 502, error: "cannot reach personal: ssh: timed out" };

  /** The page over an SSH instance whose queue read fails once `link.down` is set; a press on a row is answered, and the read after it is what finds the instance down. */
  function sshPage(): { down: boolean } {
    const link = { down: false };
    const instance: InstanceAnswers = { config: queueingConfig(), queue: queueWith(boardRuns()), get queueFails() { return link.down ? DOWN : undefined; }, post: () => queueWith(boardRuns()) };
    render(<RunsApp fetchWith={standFetch({ connections: [PERSONAL], instances: { personal: instance } })} />);
    return link;
  }

  it("keeps the rows Load more drew, in the frame and after it", async () => {
    const link = sshPage();
    await waitFor(() => expect(keysShown()).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(keysShown()).toHaveLength(90);
    link.down = true;
    fireEvent.click(within(rowOf("A11-179")).getByRole("button", { name: "Dismiss from list" }));
    expect(await screen.findByText("Can't reach personal over SSH.", {}, { timeout: 10_000 })).toBeTruthy();
    expect(keysShown()).toHaveLength(90);
    link.down = false;
    fireEvent.click(within(rowOf("A11-179")).getByRole("button", { name: "Dismiss from list" }));
    await waitFor(() => expect(screen.queryByText("Can't reach personal over SSH.")).toBeNull(), { timeout: 15_000 });
    expect(keysShown()).toHaveLength(90);
  }, 40_000);

  it("presses nothing on the last known rows, and Pause waits too", async () => {
    const link = sshPage();
    await waitFor(() => expect(keysShown()).toHaveLength(50));
    link.down = true;
    fireEvent.click(within(rowOf("A11-179")).getByRole("button", { name: "Dismiss from list" }));
    await screen.findByText("Can't reach personal over SSH.", {}, { timeout: 10_000 });
    expect((within(rowOf("A11-181")).getByRole("button", { name: "Stop run" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(true);
  }, 30_000);

  it("is No runs yet, not the filter's line, when the last known queue holds no run", async () => {
    let down = false;
    const instance: InstanceAnswers = { config: queueingConfig(), queue: queueWith([]), get queueFails() { return down ? { status: 500, error: "the queue file is unreadable" } : undefined; }, post: () => { down = true; return queueWith([]); } };
    render(<RunsApp fetchWith={standFetch({ connections: [PERSONAL], instances: { personal: instance } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(textOf(await screen.findByRole("alert"))).toContain("the queue file is unreadable");
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(screen.queryByText("No runs in this status right now.")).toBeNull();
  });

  it("draws no count skeleton when the first read fails", async () => {
    render(<RunsApp fetchWith={standFetch(runsStand({ queueFails: { status: 500, error: "the queue file is unreadable" } }))} />);
    await screen.findByRole("alert");
    expect(document.querySelector(".page-header .sk")).toBeNull();
  });
});

describe("a filter", () => {
  it("shows No runs in this status right now for a status no run has, with no footer", async () => {
    await pageOn();
    fireEvent.click(rail().getByRole("button", { name: /^Failed/ }));
    expect(screen.getByText("No runs in this status right now.")).toBeTruthy();
    expect(document.querySelector(".runs-footer")).toBeNull();
    expect(rail().getByRole("button", { name: /^Failed/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows only the runs of the status chosen, and the groups it holds", async () => {
    await pageOn();
    fireEvent.click(rail().getByRole("button", { name: /^In progress/ }));
    expect(keysShown()).toEqual(["A11-181", "A11-183"]);
    expect(headings()).toEqual(["Running now 2"]);
  });

  it("remembers the choice under the key ui.html uses, and applies it on the next visit", async () => {
    await pageOn();
    fireEvent.click(rail().getByRole("button", { name: /^Completed/ }));
    expect(localStorage.getItem("ticket-mode.run-filter")).toBe('["completed"]');
    fireEvent.click(rail().getByRole("button", { name: /^All runs/ }));
    expect(localStorage.getItem("ticket-mode.run-filter")).toBe("[]");
    fireEvent.click(rail().getByRole("button", { name: /^Checked/ }));
    document.body.innerHTML = "";
    await pageOn();
    expect(rail().getByRole("button", { name: /^Checked/ }).getAttribute("aria-pressed")).toBe("true");
    expect(keysShown()).toEqual(["A11-100"]);
  });

  it("puts the rail in the sidebar, between Runs and Settings, whether workers are paused or not", async () => {
    for (const paused of [false, true]) {
      document.body.innerHTML = "";
      await pageOn(runsStand({ paused }));
      const nav = screen.getByRole("navigation", { name: "Run status" });
      const sidebar = screen.getByRole("complementary", { name: "Atomaut" });
      expect(sidebar.contains(nav)).toBe(true);
      const order = [...sidebar.querySelectorAll("nav, a")].map((element) => element.getAttribute("aria-label") ?? element.textContent);
      expect(order.indexOf("Run status")).toBeGreaterThan(order.indexOf("Main"));
      expect(order.indexOf("Run status")).toBeLessThan(order.indexOf("Settings"));
    }
  });

  it("draws every status in the rail, a status with no runs dimmed", async () => {
    await pageOn();
    expect(rail().getAllByRole("button")).toHaveLength(17);
    expect(rail().getByRole("button", { name: /^Needs you/ }).className).toContain("rail-button-empty");
    expect(rail().getByRole("button", { name: /^Completed/ }).className).not.toContain("rail-button-empty");
    expect(textOf(rail().getByRole("button", { name: /^All runs/ }))).toBe("All runs90");
  });

  it("starts again at 50 rows when a new status is chosen", async () => {
    await pageOn();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(keysShown()).toHaveLength(90);
    fireEvent.click(rail().getByRole("button", { name: /^Completed/ }));
    expect(keysShown()).toHaveLength(50);
    expect(textOf(document.querySelector(".runs-footer span"))).toBe("Showing the latest 50 of 85 runs");
  });
});

describe("the list", () => {
  it("is the first 50 runs under their headings, with the footer's real counts, and Load more draws the rest", async () => {
    await pageOn();
    expect(keysShown()).toHaveLength(50);
    expect(headings()).toEqual(["Running now 3", "Ready to merge 1", "Checked 1", "Completed 85"]);
    expect(textOf(document.querySelector(".page-count"))).toBe("90 total · 3 running");
    expect(textOf(document.querySelector(".runs-footer span"))).toBe("Showing the latest 50 of 90 runs");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(keysShown()).toHaveLength(90);
    expect(document.querySelector(".runs-footer")).toBeNull();
  });

  it("has no footer when every run is shown at once", async () => {
    await pageOn(runsStand({ runs: boardRuns().slice(0, 9) }));
    expect(keysShown()).toHaveLength(9);
    expect(document.querySelector(".runs-footer")).toBeNull();
  });

  it("draws the status icon, the meta line, the pull request pills and the timing of a row from the queue", async () => {
    await pageOn();
    const ready = document.getElementById("run-A11-180") as HTMLElement;
    expect(within(ready).getByRole("img", { name: "Ready to merge" })).toBeTruthy();
    expect(textOf(ready.querySelector(".run-meta"))).toBe("Ready to merge·lab·sonnet/high on an unattended plan·74.2M in · 189k out");
    expect(within(ready).getByRole("link", { name: "#150 a11ign/lab" }).getAttribute("href")).toBe("https://github.com/a11ign/lab/pull/150");
    expect(textOf(ready.querySelector(".run-timing"))).toBe("Ran 14m");
    expect(textOf(ready.querySelector(".run-started"))).toBe("Started 20 min ago");
    expect(ready.querySelector(".run-note")?.getAttribute("title")).toBe("a11ign/lab #150: approved at 1f6009d");
    const planningRow = document.getElementById("run-A11-184") as HTMLElement;
    expect(within(planningRow).getByRole("img", { name: "Planning" })).toBeTruthy();
    expect(textOf(planningRow.querySelector(".run-meta"))).toContain("plan on opus/high, then sonnet/high");
    expect(within(document.getElementById("run-A11-127") as HTMLElement).getAllByRole("link", { name: /^#\d+/ }).map((link) => link.textContent?.split(" ")[0])).toEqual(["#149", "#5718"]);
  });

  it("links a row's key and title to Run detail, encoded", async () => {
    await pageOn(runsStand({ runs: [working({ key: "A11-1", title: "One", startedAgo: MINUTE }), completed({ key: "A11 2", title: "Two", startedAgo: 3 * MINUTE })] }));
    expect(document.querySelector("#run-A11-1 .run-title")?.getAttribute("href")).toBe("/runs/A11-1");
    expect(document.querySelector("[id='run-A11 2'] .run-title")?.getAttribute("href")).toBe("/runs/A11%202");
  });

  it("fills the pool bar's squares from the queue", async () => {
    await pageOn();
    expect(screen.getByRole("img", { name: "3 of 10 busy" })).toBeTruthy();
    expect(textOf(document.querySelector(".pool-busy"))).toBe("3 of 10 busy");
    expect(textOf(document.querySelector(".page-count"))).toBe("90 total · 3 running");
  });

  it("serves a run's own address with Run detail, not the list", async () => {
    history.replaceState(null, "", "/runs/A11-184");
    await pageOn(runsStand(), { ready: false });
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("herdr's claude and codex integrations are installed by onboard and kept current, and herdr's plugins are auto-updated");
    expect(textOf(screen.getByRole("navigation", { name: "Breadcrumb" }))).toBe("Runs/A11-184");
    expect(screen.queryByRole("navigation", { name: "Run status" })).toBeNull();
    expect(document.title).toBe("Atomaut: Run detail");
  });
});
