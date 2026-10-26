import { PERSONAL, queueingConfig, type Stand } from "../../test/fixtures.ts";
import { queueWith, working, type RunFields } from "../../test/runs/runs-stand.ts";
import type { QueueView } from "../api/types.ts";
import { pageOn, screen, textOf } from "./runs-harness.tsx";

// A11-279: the Runs page names what is wrong with the host itself in a banner above the runs, with when it began, and draws nothing while the host has no alert.

const MINUTE = 60_000;
const RUNS: RunFields[] = [working({ key: "A11-72", title: "A run at work", startedAgo: 5 * MINUTE })];

const TMP = { id: "tmp-entries", sentence: "/tmp holds 19,960 entries, over the 1,000 it should stay under.", since: Date.UTC(2026, 9, 25, 15, 20, 0) };
const LOCKUP = { id: "soft-lockup", sentence: "The kernel logged a soft lockup this boot.", since: Date.UTC(2026, 9, 25, 15, 22, 5) };

/** A stand whose queue lists `hostAlerts` (none at all for an instance older than the alerts) over `runs`. */
function standWith(hostAlerts: QueueView["hostAlerts"] | undefined, runs: RunFields[] = RUNS): Stand {
  const queue = { ...queueWith(runs), ...(hostAlerts === undefined ? {} : { hostAlerts }) } as QueueView;
  return { connections: [PERSONAL], instances: { personal: { config: queueingConfig(), queue } } };
}

const banners = (): string[] => [...document.querySelectorAll<HTMLElement>(".status-banner-text")].map(textOf);

describe("the host's alerts on the Runs page", () => {
  it("draws one banner for each alert, with its sentence and when it began in UTC, above the pool bar", async () => {
    await pageOn(standWith([TMP, LOCKUP]));
    expect(banners()).toEqual([
      "/tmp holds 19,960 entries, over the 1,000 it should stay under. Since 15:20Z.",
      "The kernel logged a soft lockup this boot. Since 15:22Z.",
    ]);
    const banner = document.querySelector(".status-banner") as HTMLElement;
    expect(banner.compareDocumentPosition(document.querySelector(".pool-bar") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws them above the empty panel too, since the host is wrong whether or not a run exists", async () => {
    await pageOn(standWith([TMP], []));
    expect(await screen.findByText("No runs yet")).toBeTruthy();
    expect(banners()).toEqual(["/tmp holds 19,960 entries, over the 1,000 it should stay under. Since 15:20Z."]);
  });

  it("draws nothing while the host has no alert, and for an instance that sends none", async () => {
    await pageOn(standWith([]));
    expect(document.querySelector(".status-banner")).toBeNull();
    document.body.innerHTML = "";
    await pageOn(standWith(undefined));
    expect(document.querySelector(".status-banner")).toBeNull();
  });

  it("offers no Dismiss: the board clears an alert when its condition clears", async () => {
    await pageOn(standWith([TMP]));
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });
});
