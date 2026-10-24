import { act } from "@testing-library/react";
import type { QueueView } from "../api/types.ts";
import { queueWith, queuedRun, runsStand, working, type RunFields } from "../../test/runs/runs-stand.ts";
import { HERE, queueingConfig, type Stand } from "../../test/fixtures.ts";
import { pageOn, rowOf, screen, textOf, waitFor } from "./runs-harness.tsx";

// The Runs page while a breaking update drains (A11-217): the banner `AtomautRunsDraining` draws above the header, and `updateLines()`'s words on each run's note.
const MINUTE = 60_000;
const NOTE = { target: "v0.280.0", deadline: new Date(2026, 9, 24, 14, 30).getTime(), finishing: 1, forced: false, stopped: 0 };
const BANNER = "Updating to v0.280 (breaking): no new runs start; 1 run finishing; forced at 14:30";

const runs = (): RunFields[] => [
  working({ key: "A11-1", title: "A run at work", startedAgo: 5 * MINUTE }),
  queuedRun("A11-2", "A run that waits"),
  working({ key: "A11-3", title: "A run on an older version", startedAgo: 9 * MINUTE, toolVersion: "v0.272.0" }),
];

/** An instance whose queue says `update`, which a check changes through `link`. */
function instance() {
  const link: { update: unknown } = { update: { version: "v0.273.0", note: NOTE, next: null } };
  const stand: Stand = {
    connections: [HERE],
    instances: { here: { config: queueingConfig(), get queue() { return { ...queueWith(runs()), update: link.update } as unknown as QueueView; } } },
  };
  return { link, stand };
}

const noteOf = (key: string): string => textOf(rowOf(key).querySelector(".run-note"));

describe("the Runs page while an update drains", () => {
  it("shows the banner above the header, from the backend's words", async () => {
    await pageOn(instance().stand);
    const banner = screen.getByText(BANNER).closest(".drain-banner") as HTMLElement;
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.compareDocumentPosition(screen.getByRole("heading", { level: 1, name: "Runs" }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("says finishing before the update on a live run, and waits for the update on a queued one", async () => {
    await pageOn(instance().stand);
    expect(noteOf("A11-1")).toContain("finishing before the update");
    expect(noteOf("A11-2")).toContain("waits for the update");
    expect(noteOf("A11-2")).not.toContain("finishing before the update");
    expect(noteOf("A11-1")).not.toContain("waits for the update");
  });

  it("names a run's own version beside the instance's when it is on another", async () => {
    await pageOn(instance().stand);
    expect(noteOf("A11-3")).toContain("finishing before the update");
    expect(noteOf("A11-3")).toContain("on v0.272 (instance v0.273)");
  });

  it("drops the banner and both lines when the drain record goes", async () => {
    const { link, stand } = instance();
    await pageOn(stand);
    link.update = { version: "v0.273.0", note: null, next: null };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.queryByText(BANNER)).toBeNull());
    expect(noteOf("A11-1")).not.toContain("before the update");
    expect(noteOf("A11-2")).not.toContain("the update");
  });

  it("shows neither the banner nor the lines on an instance that sends no update, as an older one", async () => {
    await pageOn(runsStand({ runs: runs() }));
    expect(document.querySelector(".drain-banner")).toBeNull();
    expect(noteOf("A11-1")).not.toContain("the update");
  });
});
