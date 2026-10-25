import { render, screen } from "@testing-library/react";
import { HERE, standFetch, type Failure, type Stand } from "../../test/fixtures.ts";
import { pluginsFetch, pluginsSettings, standOf as pluginsOf } from "../../test/plugins/plugins-stand.ts";
import { detailStand } from "../../test/run-detail/run-detail-stand.ts";
import { runsStand } from "../../test/runs/runs-stand.ts";
import { modelsConfig, settingsFetch, standOf as settingsOf } from "../../test/settings/settings-stand.ts";
import { PluginsApp } from "../plugins/PluginsApp.tsx";
import { RunsApp } from "../runs/RunsApp.tsx";
import { SettingsApp } from "../settings/SettingsApp.tsx";
import { answers, renderOn, standOf as ticketsStand } from "../tickets/tickets-harness.tsx";

// THE LIFECYCLE OF EVERY PAGE (A11-202, PARITY.md "Every page"): the failure of a page's first read is the shared banner with the instance's own sentence and Retry, and an instance that is
// restarting is the quiet Reconnecting line with no red. Each page reads what it needs in its own way, so each is failed in the read it depends on.
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

const RESTART: Failure = { status: 502, error: "no answer within 30 seconds" };
const REFUSED: Failure = { status: 500, error: "the instance said boom" };

const here = (): Stand => ({ connections: [HERE], instances: { here: { config: modelsConfig() } } });

/** Each page, at its address, drawn over an instance whose read the page waits on fails as `fails`. */
const PAGES: Readonly<Record<string, Readonly<{ path: string; draw: (fails: Failure) => void }>>> = {
  Tickets: { path: "/tickets", draw: (fails) => { renderOn(ticketsStand(answers([], { ticketsFail: fails }))); } },
  Runs: { path: "/runs", draw: (fails) => { render(<RunsApp fetchWith={standFetch(runsStand({ queueFails: fails }))} />); } },
  "Run detail": { path: "/runs/A11-183", draw: (fails) => { render(<RunsApp fetchWith={standFetch(detailStand("running", { queueFails: fails }))} />); } },
  Models: { path: "/settings/models", draw: (fails) => { render(<SettingsApp section="models" fetchWith={settingsFetch(here(), settingsOf({ viewFails: fails }))} />); } },
  Workers: { path: "/settings/workers", draw: (fails) => { render(<SettingsApp section="workers" fetchWith={settingsFetch(here(), settingsOf({ viewFails: fails }))} />); } },
  Machine: { path: "/settings/machine", draw: (fails) => { render(<SettingsApp section="machine" fetchWith={settingsFetch(here(), settingsOf({ viewFails: fails }))} />); } },
  Plugins: { path: "/settings/plugins", draw: (fails) => { render(<PluginsApp fetchWith={pluginsFetch(here(), pluginsOf({ fails }), pluginsSettings())} />); } },
};

describe("every page's first read, when it fails", () => {
  it.each(Object.keys(PAGES))("%s shows the instance's sentence in the shared banner, with Retry", async (name) => {
    history.replaceState(null, "", PAGES[name].path);
    PAGES[name].draw(REFUSED);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("the instance said boom");
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });

  it.each(Object.keys(PAGES))("%s shows the quiet Reconnecting line, and no red, while the instance restarts", async (name) => {
    history.replaceState(null, "", PAGES[name].path);
    PAGES[name].draw(RESTART);
    await screen.findByText("Reconnecting…");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
