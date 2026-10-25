import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Fetch } from "../api/request.ts";
import { HERE, standFetch, ticket, type Stand } from "../../test/fixtures.ts";
import { answerOf, pluginsFetch, pluginsSettings, PLUGIN_FILES, standOf as pluginsOf } from "../../test/plugins/plugins-stand.ts";
import { detailStand } from "../../test/run-detail/run-detail-stand.ts";
import { boardRuns, runsStand, working } from "../../test/runs/runs-stand.ts";
import { GRILL } from "../../../src/ticket-mode/board-view.ts";
import { modelsConfig, settingsFetch, standOf as settingsOf } from "../../test/settings/settings-stand.ts";
import { writerRun } from "../new-ticket/new-ticket-fixtures.ts";
import { ShellFrame } from "./ShellFrame.tsx";
import { ShellProvider } from "./ShellProvider.tsx";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { TicketsPage } from "../tickets/TicketsPage.tsx";
import { answers, BACKLOG, standOf as ticketsStand } from "../tickets/tickets-harness.tsx";
import { RunsApp } from "../runs/RunsApp.tsx";
import { SettingsApp } from "../settings/SettingsApp.tsx";
import { PluginsApp } from "../plugins/PluginsApp.tsx";

// THE RETURN VISIT (A11-270): every route is a page load of its own. A page the tab has drawn before draws its last data at once, with no skeleton, while every read it makes (the
// connections too) is still in flight, and refreshes in place when they answer. Until they do, the controls that write wait.
beforeEach(() => {
  localStorage.clear();
});

const here = (): Stand => ({ connections: [HERE], instances: { here: { config: modelsConfig() } } });

/** A host whose publisher, slack, can be disabled from the page. */
const WITH_SLACK = { tickets: { providers: { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", enabled: true }, publish: { provider: "slack", enabled: true } } } };

type Page = Readonly<{ path: string; serve: () => Fetch; draw: (fetchWith: Fetch) => void; drawn: () => Promise<unknown> }>;

const settingsPage = (section: "machine" | "models" | "workers"): Page => ({
  path: `/settings/${section}`, serve: () => settingsFetch(here(), settingsOf()), draw: (fetchWith) => render(<SettingsApp section={section} fetchWith={fetchWith} />),
  drawn: () => screen.findByText(/^Host file/),
});

/** Each page at its address: the stand-in it reads, how it is drawn, and what it draws once its data is in. */
const PAGES: Readonly<Record<string, Page>> = {
  Tickets: {
    path: "/tickets", serve: () => standFetch(ticketsStand(answers())),
    draw: (fetchWith) => render(<ShellProvider fetchWith={fetchWith}><ShellFrame page="tickets"><TicketsPage /></ShellFrame></ShellProvider>),
    drawn: () => screen.findByRole("region", { name: "Backlog" }),
  },
  Runs: { path: "/runs", serve: () => standFetch(runsStand()), draw: (fetchWith) => render(<RunsApp fetchWith={fetchWith} />), drawn: () => waitFor(() => expect(document.getElementById("run-A11-184")).not.toBeNull()) },
  "Run detail": { path: "/runs/A11-183", serve: () => standFetch(detailStand("running")), draw: (fetchWith) => render(<RunsApp fetchWith={fetchWith} />), drawn: () => screen.findByRole("heading", { level: 1 }) },
  Machine: settingsPage("machine"),
  Models: settingsPage("models"),
  Workers: settingsPage("workers"),
  Plugins: { path: "/settings/plugins", serve: () => pluginsFetch(here(), pluginsOf({ answer: () => answerOf({ host: WITH_SLACK }) }), pluginsSettings()), draw: (fetchWith) => render(<PluginsApp fetchWith={fetchWith} />), drawn: () => screen.findByRole("tabpanel") },
};

/** A `fetch` that holds every call, `/api/connections` too, until `release`, then answers it from `inner`: a page whose reads are all still in flight. `paths` are the calls made, as they are made. */
function held(inner: Fetch) {
  const paths: string[] = [];
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const fetchWith: Fetch = async (input, init) => {
    paths.push(String(input));
    await gate;
    return inner(input, init);
  };
  return { fetchWith, paths, release: () => act(async () => { open(); await gate; await new Promise((done) => setTimeout(done, 50)); }) };
}

/**
 * Draw `page` once with its reads answered, leave it, and draw it again at `path` (its own by default) with every read held, answered from `again` (the page's stand-in by default), as a
 * click back to it does: resolves to the held reads.
 */
async function heldReturnTo(page: Page, { path = page.path, again = page.serve }: Readonly<{ path?: string; again?: () => Fetch }> = {}) {
  history.replaceState(null, "", page.path);
  page.draw(page.serve());
  await page.drawn();
  cleanup();
  history.replaceState(null, "", path);
  const reads = held(again());
  page.draw(reads.fetchWith);
  await act(async () => undefined);
  return reads;
}

/** `heldReturnTo`, resolving to the release of the held reads. */
const returnTo = async (page: Page) => (await heldReturnTo(page)).release;

const asked = (paths: readonly string[], path: string): number => paths.filter((called) => called.endsWith(path)).length;

const skeleton = (): Element | null => document.querySelector('[aria-busy="true"]');
const enabled = (element: Element | null): boolean => element instanceof HTMLElement && !(element as HTMLButtonElement).disabled;

describe("a page the tab has drawn before", () => {
  it.each(Object.keys(PAGES))("%s draws its last data at once, with no skeleton, while its reads are in flight", async (name) => {
    await returnTo(PAGES[name]);
    expect(skeleton()).toBeNull();
    await PAGES[name].drawn();
  });

  it.each(Object.keys(PAGES))("%s draws nothing kept on the first visit of a tab: the skeleton while it reads", async (name) => {
    history.replaceState(null, "", PAGES[name].path);
    PAGES[name].draw(held(PAGES[name].serve()).fetchWith);
    await act(async () => undefined);
    expect(skeleton()).not.toBeNull();
  });

  it("refreshes in place: the instance's answer replaces the kept one without a skeleton between", async () => {
    history.replaceState(null, "", "/runs");
    const first = runsStand();
    render(<RunsApp fetchWith={standFetch(first)} />);
    await PAGES.Runs.drawn();
    cleanup();
    const later = held(standFetch({ ...first, instances: { here: { ...first.instances?.here, queue: { ...first.instances?.here?.queue, entries: [] } as never } } }));
    render(<RunsApp fetchWith={later.fetchWith} />);
    await act(async () => undefined);
    expect(document.getElementById("run-A11-184")).not.toBeNull();
    await later.release();
    expect(document.getElementById("run-A11-184")).toBeNull();
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(skeleton()).toBeNull();
  });
});

/** The controls that write on each page, found once `open` has opened what the page draws closed. */
const WRITERS: Readonly<Record<string, Readonly<{ page: Page; controls: () => readonly (Element | null)[]; open?: () => void }>>> = {
  "Runs: the pool's Pause": { page: PAGES.Runs, controls: () => [...document.querySelectorAll(".pool-bar button")] },
  "Run detail: the run's verbs": { page: PAGES["Run detail"], controls: () => [...document.querySelectorAll(".run-buttons button")] },
  "Machine: Restore": { page: PAGES.Machine, controls: () => [screen.getByRole("button", { name: "Restore the backup of host.json" })] },
  "Models: the selects": { page: PAGES.Models, controls: () => [document.getElementById("new-runs-model"), document.getElementById("new-runs-effort")] },
  "Workers: Pause and the number of workers": { page: PAGES.Workers, controls: () => [document.getElementById("workers-at-once"), screen.getByRole("button", { name: "Pause" })] },
  "Tickets: Grill": {
    page: { ...PAGES.Tickets, serve: () => standFetch(ticketsStand(answers([...BACKLOG, ticket({ key: "A11-6", title: "Needs a decision", needsDecision: { kind: "open", reason: "Two readings" } } as never)]))) },
    open: () => fireEvent.click(screen.getByRole("button", { name: "Expand Backlog" })), controls: () => screen.getAllByRole("button", { name: GRILL }) },
  "Tickets: a ticket request's Stop": {
    page: { ...PAGES.Tickets, serve: () => standFetch(ticketsStand(answers(undefined, { writer: { runs: [writerRun()] } }))) },
    controls: () => [...document.querySelectorAll(".run-stop")],
  },
  "Plugins: a plugin's action": {
    page: PAGES.Plugins, open: () => fireEvent.click(within(screen.getByRole("region", { name: "Publisher" })).getAllByRole("button")[0]),
    controls: () => [screen.getByRole("button", { name: "Disable slack" })],
  },
};

describe("the controls that write, on a page drawn from what the tab kept", () => {
  it.each(Object.keys(WRITERS))("%s waits for the instance's own answer", async (name) => {
    const { page, controls, open } = WRITERS[name];
    const release = await returnTo(page);
    open?.();
    expect(controls().length).toBeGreaterThan(0);
    expect(controls()).not.toContain(null);
    expect(controls().some(enabled)).toBe(false);
    await release();
    expect(controls().every(enabled)).toBe(true);
  });
});

// WHAT THE KEPT DATA MUST NOT DO (A11-270): stand in for the instance's own answer where that answer is the proof.
describe("a page drawn from what the tab kept, where only the instance's answer will do", () => {
  it("Tickets asks for the parents only once the instance has listed the tickets again, since it works them out from that list", async () => {
    const reads = await heldReturnTo(PAGES.Tickets);
    expect(asked(reads.paths, "/api/parents")).toBe(0);
    await reads.release();
    await waitFor(() => expect(asked(reads.paths, "/api/parents")).toBe(1));
  });

  it("Plugins reads the plugins once, though the fresh connections list follows the kept one", async () => {
    const reads = await heldReturnTo(PAGES.Plugins);
    await reads.release();
    expect(asked(reads.paths, "/api/plugins")).toBe(1);
  });

  it("a run's page is its skeleton, not \"no longer on the board\", when the kept queue does not hold a run that has started since", async () => {
    const started = () => standFetch(runsStand({ runs: [...boardRuns(), working({ key: "A11-999", title: "Started since", startedAgo: 1_000 })] }));
    const reads = await heldReturnTo(PAGES.Runs, { path: "/runs/A11-999", again: started });
    expect(screen.queryByText("This run is no longer on the board")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading run" })).toBeTruthy();
    await reads.release();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Started since");
  });

  it("Plugins: a plugin's action does not wait on a settings read that keeps failing", async () => {
    const failing = () => pluginsFetch(here(), pluginsOf({ answer: () => answerOf({ host: WITH_SLACK }) }), pluginsSettings(PLUGIN_FILES, { viewFails: { status: 500, error: "the settings cannot be read" } }));
    const reads = await heldReturnTo(PAGES.Plugins, { again: failing });
    await reads.release();
    fireEvent.click(within(screen.getByRole("region", { name: "Publisher" })).getAllByRole("button")[0]);
    expect(enabled(screen.getByRole("button", { name: "Disable slack" }))).toBe(true);
  });
});
