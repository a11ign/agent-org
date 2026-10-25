import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HERE, PERSONAL, queueingConfig, queueOf, standFetch, type InstanceAnswers, type Stand } from "../../test/fixtures.ts";
import { boardRuns, queueWith } from "../../test/runs/runs-stand.ts";
import type { QueueView } from "../api/types.ts";
import { RunsApp } from "../runs/RunsApp.tsx";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import type { UpdateInfo } from "./update-model.ts";

// The page left open across an update: the queue poll of a stand-in instance fails, and the shell shows the Updating card in place of the page, then Back. The clock is the test's, so the
// minute that makes it Slow and the five seconds before Back reloads pass at once.
const NOTE = { target: "v0.280.0", deadline: new Date(2026, 9, 24, 14, 30).getTime(), finishing: 3, forced: false, stopped: 0 };
const NORMAL: UpdateInfo = { version: "v0.273.0", note: null, next: "v0.280.0" };
const BREAKING: UpdateInfo = { version: "v0.273.0", note: NOTE, next: null };
const BACK: UpdateInfo = { version: "v0.280.0", note: null, next: null };

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/tickets");
  rstest.useFakeTimers();
});
afterEach(() => {
  rstest.useRealTimers();
});

const advance = (ms: number) => act(async () => { await rstest.advanceTimersByTimeAsync(ms); });

/** An instance whose queue says `update`, and which is down (answers 503, as the service in front of it does) while `down` is set. */
function instance(update: UpdateInfo | null) {
  const link = { down: false, update, failure: { status: 503, error: "service unavailable" } };
  const answers: InstanceAnswers = {
    get queue() { return { ...queueOf("running", "running"), update: link.update } as unknown as QueueView; },
    get queueFails() { return link.down ? link.failure : undefined; },
  };
  return { link, stand: { connections: [HERE], instances: { here: answers } } satisfies Stand };
}

/** The shell on Tickets over `stand`, a stand-in page in its main column, resolved once the first queue read is in. */
async function pageLeftOpen(stand: Stand) {
  const reload = rstest.fn();
  const fetchWith = standFetch(stand);
  render(
    <ShellProvider fetchWith={fetchWith} reload={reload}>
      <ShellFrame page="tickets">
        <p>The page</p>
        <input aria-label="A draft" />
      </ShellFrame>
    </ShellProvider>,
  );
  await advance(0);
  return { reload, fetchWith };
}

const sidebar = () => screen.getByRole("complementary", { name: "Atomaut" });
const pill = (): HTMLElement => {
  const found = within(sidebar()).getAllByRole("status").find((status) => /^(Connected|Updating|Unreachable)/.test(status.textContent ?? ""));
  if (found === undefined) throw new Error("no connection pill in the sidebar");
  return found;
};
/** Whether the page in the main column is hidden behind the card. */
const pageHidden = (): boolean => screen.getByText("The page").closest("[hidden]") !== null;
const titleOf = (): string | null => screen.getByRole("heading", { level: 1 }).textContent;
const cardText = (): string => document.querySelector(".updating-card")?.textContent ?? "";
/** The card says each of `lines`. */
const shows = (...lines: readonly string[]) => lines.forEach((line) => expect(cardText()).toContain(line));
const stepStates = (): string[] => [...document.querySelectorAll(".updating-step")].map((step) => `${step.className.replace("updating-step updating-step-", "")}: ${step.textContent}`);

/** The page's reads fail from now, and the next poll finds it. */
async function goDown(link: ReturnType<typeof instance>["link"]) {
  link.down = true;
  await advance(5_000);
}

/** The service answers again, on the version `update` says, and the next poll finds it. */
async function comeBackOn(link: ReturnType<typeof instance>["link"], update: UpdateInfo) {
  link.down = false;
  link.update = update;
  await advance(5_000);
}

/** The page left open on an instance that says `update`, and whose service goes down: the card shows. */
async function leftOpenAndDown(update: UpdateInfo | null) {
  const { link, stand } = instance(update);
  const opened = await pageLeftOpen(stand);
  await goDown(link);
  return { link, ...opened };
}

// A PAGE LOADED IN THE MIDDLE OF AN OUTAGE (A11-270): the queue the tab kept from an earlier page is not this page's read, so it starts no Updating card; that page shows the Reconnecting line, as it did before the tab kept anything.
describe("a page loaded while the instance is down, in a tab that kept its queue", () => {
  it("shows no Updating card from the kept queue's update", async () => {
    const { link, stand } = instance(NORMAL);
    await pageLeftOpen(stand);
    cleanup();
    link.down = true;
    await pageLeftOpen(stand);
    expect(cardText()).toBe("");
    expect(pageHidden()).toBe(false);
  });
});

describe("Updating: a normal update", () => {
  it("replaces the page with the card, from vX to vY, with the three steps and the board's sentence about runs", async () => {
    const { link, stand } = instance(NORMAL);
    await pageLeftOpen(stand);
    expect(pageHidden()).toBe(false);
    await goDown(link);
    expect(pageHidden()).toBe(true);
    expect(titleOf()).toBe("Updating Atomaut");
    expect(cardText()).toContain("Moving this instance from v0.273 to v0.280. This page reconnects by itself.");
    expect(stepStates()).toEqual(["done: New version v0.280 is ready", "now: Restarting the board", "next: Reconnecting this page"]);
    expect(cardText()).toContain("Runs already working keep going. Each stays on the version it started on, and new runs start on v0.280.");
    expect(document.querySelector(".updating-card .spin")).toBeTruthy();
    expect(cardText()).not.toContain("agent-org doctor");
    expect(screen.queryByRole("link", { name: "Back to Tickets" })).toBeNull();
  });

  it("keeps the sidebar as the last known state and turns the pill amber Updating", async () => {
    const { link, stand } = instance(NORMAL);
    await pageLeftOpen(stand);
    expect(pill().textContent).toBe("Connected");
    await goDown(link);
    expect(pill().textContent).toBe("Updating");
    expect(pill().className).toContain("pill-updating");
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: /Runs/ }).textContent).toContain("2");
    expect(screen.getByLabelText("Instance")).toBeTruthy();
  });

  it("is a status the screen reader announces politely", async () => {
    await leftOpenAndDown(NORMAL);
    expect(document.querySelector(".updating-card")?.getAttribute("role")).toBe("status");
    expect(document.querySelector(".updating-card")?.getAttribute("aria-live")).toBe("polite");
  });
});

describe("Updating: a breaking release", () => {
  it("says it waited for live runs and started none, with the versions of the drain note", async () => {
    await leftOpenAndDown(BREAKING);
    expect(cardText()).toContain("Moving this instance from v0.273 to v0.280.");
    expect(cardText()).toContain("This is a breaking release, so it waited for live runs to finish and started no new ones. Any run stopped at the deadline is queued again and resumes on v0.280.");
    expect(cardText()).not.toContain("Runs already working keep going");
  });
});

describe("the page behind the card", () => {
  it("stays mounted while the card shows, so a draft typed in it is still there when the board comes back on the version it had", async () => {
    const { link, stand } = instance(NORMAL);
    await pageLeftOpen(stand);
    fireEvent.change(screen.getByLabelText("A draft"), { target: { value: "half a sentence" } });
    await goDown(link);
    expect(pageHidden()).toBe(true);
    await comeBackOn(link, { version: "v0.273.0", note: null, next: null });
    expect(pageHidden()).toBe(false);
    expect((screen.getByLabelText("A draft") as HTMLInputElement).value).toBe("half a sentence");
  });

  it("is not in the accessibility tree while the card shows", async () => {
    await leftOpenAndDown(NORMAL);
    expect(screen.queryByRole("textbox", { name: "A draft" })).toBeNull();
  });
});

describe("Slow", () => {
  it("adds the note that points at agent-org doctor once the polls have failed for 60 s, and not before", async () => {
    const { link, stand } = instance(NORMAL);
    await pageLeftOpen(stand);
    link.down = true;
    await advance(5_000);
    await advance(59_000);
    expect(titleOf()).toBe("Updating Atomaut");
    expect(cardText()).not.toContain("Taking longer than usual.");
    await advance(1_000);
    expect(titleOf()).toBe("Still updating");
    expect(cardText()).toContain("Taking longer than usual. This page keeps trying every few seconds. If it does not come back, run agent-org doctor on the host.");
    expect(document.querySelector(".updating-code")?.textContent).toBe("agent-org doctor");
    expect(cardText()).toContain("Moving this instance from v0.273 to v0.280.");
    expect(stepStates()[1]).toBe("now: Restarting the board");
    expect(pill().textContent).toBe("Updating");
  });

  it("keeps the breaking wording when a breaking release is slow", async () => {
    await leftOpenAndDown(BREAKING);
    await advance(60_000);
    expect(cardText()).toContain("This is a breaking release, so it waited");
    expect(cardText()).toContain("Taking longer than usual.");
  });
});

describe("Back", () => {
  async function cameBack(update: UpdateInfo) {
    const { link, ...opened } = await leftOpenAndDown(update);
    await comeBackOn(link, BACK);
    return { ...opened, link };
  }

  it("shows Updated to vY, the board is back, all three steps done, and a Back to Tickets link", async () => {
    await cameBack(NORMAL);
    expect(titleOf()).toBe("Updated to v0.280");
    shows("The board is back on the new version.", "Runs already working keep going. Each stays on the version it started on, and new runs start on v0.280.");
    expect(stepStates()).toEqual(["done: New version v0.280 is ready", "done: Restarting the board", "done: Reconnecting this page"]);
    expect(screen.getByRole("link", { name: "Back to Tickets" }).getAttribute("href")).toBe("/tickets");
    expect(document.querySelector(".updating-card .spin")).toBeNull();
    expect(pill().textContent).toBe("Connected");
  });

  it("says, for a breaking release, that no new runs started while it waited and what became of the stopped ones", async () => {
    await cameBack(BREAKING);
    expect(cardText()).toContain("This was a breaking release, so no new runs started while it waited. Runs that were stopped at the deadline are queued again and resume on v0.280.");
  });

  it("reloads the page 5 s later onto the new version's code, and not before", async () => {
    const { reload } = await cameBack(NORMAL);
    await advance(4_999);
    expect(reload).not.toHaveBeenCalled();
    await advance(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("is Slow's end too: a board that comes back after the slow note is Back", async () => {
    const { link } = await leftOpenAndDown(NORMAL);
    await advance(60_000);
    expect(titleOf()).toBe("Still updating");
    await comeBackOn(link, BACK);
    expect(titleOf()).toBe("Updated to v0.280");
    expect(cardText()).not.toContain("Taking longer than usual.");
  });

  it("names the version the instance reports, which is not always the one that was expected", async () => {
    const { link } = await leftOpenAndDown(NORMAL);
    await comeBackOn(link, { version: "v0.281.0", note: null, next: null });
    expect(titleOf()).toBe("Updated to v0.281");
  });
});

describe("what is not an update", () => {
  it("leaves the screen, with no Back, when the board comes back on the version it had: a restart that was not an update", async () => {
    const { link, reload } = await leftOpenAndDown(NORMAL);
    expect(pageHidden()).toBe(true);
    await comeBackOn(link, { version: "v0.273.0", note: null, next: null });
    expect(pageHidden()).toBe(false);
    expect(document.querySelector(".updating-card")).toBeNull();
    expect(pill().textContent).toBe("Connected");
    await advance(10_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows no card for a restart the page has no reason to think is an update: the page keeps its own Reconnecting line", async () => {
    await leftOpenAndDown({ version: "v0.273.0", note: null, next: null });
    expect(document.querySelector(".updating-card")).toBeNull();
    expect(pageHidden()).toBe(false);
    expect(pill().textContent).toBe("Connected");
  });

  it("shows no card for an instance that says nothing of updates, as an older one does", async () => {
    await leftOpenAndDown(null);
    expect(document.querySelector(".updating-card")).toBeNull();
    expect(pageHidden()).toBe(false);
  });

  it("shows no card for an error the server answered with, even in the middle of an update, and leaves the card that was there", async () => {
    const { link } = await leftOpenAndDown(NORMAL);
    expect(document.querySelector(".updating-card")).toBeTruthy();
    link.failure = { status: 500, error: "boom" };
    await advance(5_000);
    expect(document.querySelector(".updating-card")).toBeNull();
    expect(pageHidden()).toBe(false);
  });

  it("is never the screen of an SSH remote its proxy cannot reach: that is the unreachable state, with its own pill", async () => {
    history.replaceState(null, "", "/tickets?connection=personal");
    const link = { down: false };
    const answers: InstanceAnswers = {
      get queue() { return { ...queueOf("running"), update: NORMAL } as unknown as QueueView; },
      get queueFails() { return link.down ? { status: 502, error: "cannot reach personal over SSH: Permission denied" } : undefined; },
    };
    await pageLeftOpen({ connections: [PERSONAL], instances: { personal: answers } });
    link.down = true;
    await advance(5_000);
    expect(document.querySelector(".updating-card")).toBeNull();
    expect(pill().textContent).toBe("Unreachable · retrying");
  });

  it("shows no card for a connection that never answered: a page opened during the restart has no version to name", async () => {
    const { link, stand } = instance(NORMAL);
    link.down = true;
    await pageLeftOpen(stand);
    await advance(10_000);
    expect(document.querySelector(".updating-card")).toBeNull();
  });
});

describe("the page keeps trying by itself", () => {
  it("reads the queue every 5 s while the card shows, not on the backoff up to 60 s", async () => {
    const { link, stand } = instance(NORMAL);
    const { fetchWith } = await pageLeftOpen(stand);
    link.down = true;
    await advance(5_000);
    const reads = () => fetchWith.paths.filter((path) => path.endsWith("/api/queue")).length;
    const before = reads();
    await advance(60_000);
    // 2 s and 4 s after the first failure, then every 5 s: not the 8 s, 16 s, 32 s and 60 s of the backoff.
    expect(reads() - before).toBeGreaterThanOrEqual(11);
    const afterBack = reads();
    await comeBackOn(link, BACK);
    expect(reads()).toBeGreaterThan(afterBack);
    expect(titleOf()).toBe("Updated to v0.280");
  });
});

describe("on the Runs page, which has its own Reconnecting line (A11-211)", () => {
  /** The Runs page over the board's runs, whose queue says `update` and fails while the link is down. */
  async function runsLeftOpen(update: UpdateInfo) {
    history.replaceState(null, "", "/runs");
    const link = { down: false };
    const answers: InstanceAnswers = {
      config: queueingConfig(),
      get queue() { return { ...queueWith(boardRuns()), update } as unknown as QueueView; },
      get queueFails() { return link.down ? { status: 503, error: "service unavailable" } : undefined; },
    };
    render(<RunsApp fetchWith={standFetch({ connections: [HERE], instances: { here: answers } })} />);
    await advance(0);
    await advance(0);
    link.down = true;
    await advance(5_000);
  }

  it("replaces the plain Reconnecting line with the card when the page has reason to think an update is in progress, and keeps the rail in the sidebar", async () => {
    await runsLeftOpen(NORMAL);
    expect(screen.queryByText("Reconnecting…")?.closest("[hidden]")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "Runs" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Updating Atomaut" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Run status" })).toBeTruthy();
    expect(pill().textContent).toBe("Updating");
  });

  it("keeps the plain Reconnecting line, and the list as last known, for a restart with no such reason", async () => {
    await runsLeftOpen({ version: "v0.273.0", note: null, next: null });
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Runs" })).toBeTruthy();
    expect(document.querySelector(".updating-card")).toBeNull();
    expect(pill().textContent).toBe("Connected");
  });
});
