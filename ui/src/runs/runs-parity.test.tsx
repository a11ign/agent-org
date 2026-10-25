import { PERSONAL, queueingConfig, type Stand } from "../../test/fixtures.ts";
import { completed, queueWith, runsStand, working, type RunFields } from "../../test/runs/runs-stand.ts";
import { fireEvent, pageOn, rail, screen, textOf, within } from "./runs-harness.tsx";

// The features `ui.html` has on its Board tab that A11-197 left off the Runs page (A11-220): the held, reviewer-off and claim notices, and the Pull requests and After-merge checks lists.

const MINUTE = 60_000;
const HELD = { name: "tickets.preflight", reason: "the disk is 97% full", since: 0 };
const MINE = "https://github.com/a11ign/agent-org/pull/1900";
const MINE_REVIEW = "waiting on a reviewer";

/** Two merged runs, one After-merge line each (one names who runs it, one does not), which the board lists as open checks, and a run at work. */
const withAfterMerge = (): RunFields[] => [
  { ...completed({ key: "A11-70", title: "A merged run", startedAgo: 40 * MINUTE }), afterMerge: [{ line: "The chairman: check the release is out", owner: null }] },
  { ...completed({ key: "A11-71", title: "Another merged run", startedAgo: 50 * MINUTE }), afterMerge: [{ line: "Read the dashboard", owner: null }] },
  working({ key: "A11-72", title: "A run at work", startedAgo: 5 * MINUTE }),
];

type Extras = Readonly<{ held?: typeof HELD | null; claimWarning?: string | null; pulls?: Readonly<Record<string, string>>; reviewer?: string; runs?: RunFields[] }>;

/** A stand whose queue holds the given notices and pull requests. */
function standWith({ held = null, claimWarning = null, pulls = {}, reviewer = "on", runs = withAfterMerge() }: Extras = {}): Stand {
  const queue = { ...queueWith(runs), pulls, held, claimWarning };
  return { connections: [PERSONAL], instances: { personal: { config: queueingConfig({ reviewer } as never), queue } } };
}

describe("the notices above the pool bar", () => {
  it("says which check holds every run, and what it printed", async () => {
    await pageOn(standWith({ held: HELD }));
    expect(screen.getByText("No run starts while tickets.preflight fails: the disk is 97% full")).toBeTruthy();
  });

  it("says reviews are required while the reviewer is off", async () => {
    await pageOn(standWith({ reviewer: "off-required" }));
    expect(screen.getByText("Reviews are required and the reviewer is off")).toBeTruthy();
  });

  it("says the review claims GitHub refuses, in the queue's own line", async () => {
    await pageOn(standWith({ claimWarning: "2 review claims were refused by GitHub: A11-70, A11-71" }));
    expect(screen.getByText("2 review claims were refused by GitHub: A11-70, A11-71")).toBeTruthy();
  });

  it("draws the three in the order held, reviewer, claims, above the pool bar", async () => {
    await pageOn(standWith({ held: HELD, reviewer: "off-required", claimWarning: "a claim was refused" }));
    const notices = [...document.querySelectorAll<HTMLElement>(".status-banner-text")].map(textOf);
    expect(notices).toEqual(["No run starts while tickets.preflight fails: the disk is 97% full", "Reviews are required and the reviewer is off", "a claim was refused"]);
    const banner = document.querySelector(".status-banner") as HTMLElement;
    const pool = document.querySelector(".pool-bar") as HTMLElement;
    expect(banner.compareDocumentPosition(pool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws none while the queue has nothing to say and the reviewer is on or absent", async () => {
    await pageOn(standWith({ reviewer: "none" }));
    expect(document.querySelector(".status-banner")).toBeNull();
  });

  it("is drawn under the empty panel too, since a check can hold a queue with no run", async () => {
    await pageOn(standWith({ held: HELD, runs: [] }));
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(screen.getByText("No run starts while tickets.preflight fails: the disk is 97% full")).toBeTruthy();
  });
});

describe("the Pull requests list", () => {
  it("lists a pull request no run has, linked to GitHub in a new tab, with the pool's review line", async () => {
    await pageOn(standWith({ pulls: { [MINE]: MINE_REVIEW } }));
    const list = within(screen.getByRole("region", { name: "Pull requests" }));
    const link = list.getByRole("link", { name: "a11ign/agent-org #1900" });
    expect(link.getAttribute("href")).toBe(MINE);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(list.getByText(MINE_REVIEW)).toBeTruthy();
    expect(textOf(document.querySelector(".runs-extra-head"))).toBe("Pull requests1");
  });

  it("leaves out a pull request a run lists", async () => {
    // The Ready to merge run of the boards lists a11ign/lab #150, which the stand's pool also read.
    await pageOn(runsStand());
    expect(screen.queryByRole("region", { name: "Pull requests" })).toBeNull();
  });

  it("draws an address that is not http or https as text, never as a link", async () => {
    await pageOn(standWith({ pulls: { "javascript:alert(1)": "x" } }));
    const list = within(screen.getByRole("region", { name: "Pull requests" }));
    expect(list.queryByRole("link")).toBeNull();
    expect(list.getByText("javascript:alert(1)")).toBeTruthy();
  });

  it("is not narrowed by the rail's status filter", async () => {
    await pageOn(standWith({ pulls: { [MINE]: MINE_REVIEW } }));
    fireEvent.click(rail().getByRole("button", { name: /^Failed/ }));
    expect(screen.getByText("No runs in this status right now.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Pull requests" })).toBeTruthy();
  });

  it("is drawn under the empty panel, since a person's pull request can exist while no run does", async () => {
    await pageOn(standWith({ pulls: { [MINE]: MINE_REVIEW }, runs: [] }));
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Pull requests" })).getByRole("link", { name: "a11ign/agent-org #1900" })).toBeTruthy();
  });
});

describe("the After-merge checks list", () => {
  it("lists each line with its ticket linked to the tracker and who runs it", async () => {
    await pageOn(standWith());
    const list = within(screen.getByRole("region", { name: "After-merge checks" }));
    expect(list.getByRole("link", { name: "A11-70" }).getAttribute("href")).toBe("https://linear.app/a11ign/issue/A11-70");
    expect(list.getByText("The chairman: check the release is out", { exact: false })).toBeTruthy();
    expect(list.getByText(/^Runs it: The chairman · you · /)).toBeTruthy();
    expect(textOf(document.querySelector(".runs-extra-head"))).toBe("After-merge checks2");
  });

  it("says when no one is named to run a line", async () => {
    await pageOn(standWith());
    expect(within(screen.getByRole("region", { name: "After-merge checks" })).getByText(/^Runs it: owner not named · the session · /)).toBeTruthy();
  });

  it("is not drawn while no check is open", async () => {
    await pageOn(standWith({ runs: [working({ key: "A11-72", title: "A run at work", startedAgo: 5 * MINUTE })] }));
    expect(screen.queryByRole("region", { name: "After-merge checks" })).toBeNull();
  });

  it("is not narrowed by the rail's status filter, and follows the checks rather than the rows drawn", async () => {
    await pageOn(standWith());
    fireEvent.click(rail().getByRole("button", { name: /^Failed/ }));
    expect(within(screen.getByRole("region", { name: "After-merge checks" })).getByText(/^Runs it: The chairman · /)).toBeTruthy();
  });

  it("is drawn after the Pull requests list, below the runs", async () => {
    await pageOn(standWith({ pulls: { [MINE]: MINE_REVIEW } }));
    const heads = [...document.querySelectorAll(".runs-extra-head")].map(textOf);
    expect(heads).toEqual(["Pull requests1", "After-merge checks2"]);
    const runs = document.querySelector(".runs-list") as HTMLElement;
    const pulls = screen.getByRole("region", { name: "Pull requests" });
    expect(runs.compareDocumentPosition(pulls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws the board's two After-merge lines under its 90 runs", async () => {
    await pageOn(runsStand());
    expect(within(screen.getByRole("region", { name: "After-merge checks" })).getAllByText(/^Runs it: /)).toHaveLength(2);
  });
});
