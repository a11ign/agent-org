import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { claudePlugin, failing, answerOf, pluginsFetch, standOf as pluginsOf, type PluginsStand } from "../../test/plugins/plugins-stand.ts";
import { HERE, PERSONAL, type Stand } from "../../test/fixtures.ts";
import { MIN_BACKOFF_MS } from "../api/poll-schedule.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import type { Page } from "../shell/routes.ts";
import { attentionWords } from "./AttentionBadge.tsx";
import { PluginsRead, useProvidedPluginsRead } from "./PluginsRead.tsx";

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/next/settings/models");
});

/** Just longer than the first backoff a failing poll waits before it reads again. */
const POLL_MS_OF_BACKOFF = MIN_BACKOFF_MS + 200;
const NOTHING_WRONG: Stand = { connections: [HERE] };

/** A Settings page's sub-nav over a stand-in instance, with the Plugins page's shared read around it when `shared`. */
async function subNav(page: Page, { stand = NOTHING_WRONG, plugins = pluginsOf(), shared = false }: Readonly<{ stand?: Stand; plugins?: PluginsStand; shared?: boolean }> = {}) {
  const fetchWith = pluginsFetch(stand, plugins);
  const frame = (
    <ShellFrame page={page}>
      <h1>The page</h1>
    </ShellFrame>
  );
  render(<ShellProvider fetchWith={fetchWith}>{shared ? <PluginsRead>{frame}</PluginsRead> : frame}</ShellProvider>);
  await waitFor(() => expect((screen.getByLabelText("Instance") as HTMLSelectElement).disabled).toBe(false));
  const link = () => within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("link", { name: /^Plugins/ });
  return { fetchWith, link };
}
const asked = (fetchWith: { paths: string[] }) => fetchWith.paths.filter((path) => path.endsWith("/api/plugins"));
const FAILING = { linear: [failing("token", "no token", "run agent-org doctor")] };

describe("the Plugins badge on the Settings sub-nav", () => {
  it("says the words of the boards for one plugin and for more", () => {
    expect(attentionWords(1)).toBe("1 needs attention");
    expect(attentionWords(2)).toBe("2 need attention");
  });

  it("is hidden when no plugin needs attention", async () => {
    const { fetchWith, link } = await subNav("models");
    await waitFor(() => expect(asked(fetchWith)).toHaveLength(1));
    await waitFor(() => expect(fetchWith.requests.length).toBeGreaterThan(3));
    expect(link().textContent).toBe("Plugins");
  });

  it("shows '1 needs attention' for one plugin whose doctor check fails", async () => {
    const { link } = await subNav("models", { plugins: pluginsOf({ answer: () => answerOf({ checks: FAILING }) }) });
    await waitFor(() => expect(link().textContent).toBe("Plugins 1 needs attention"));
  });

  it("counts a Claude plugin that is not installed and one whose health is unknown with the agent-org plugin, and says 'need' for more than one", async () => {
    const claude = { readable: true, plugins: [claudePlugin({ entry: "a@m", name: "a", loads: false, why: "a@m is not installed" }), claudePlugin({ entry: "b@m", name: "b", loads: null })] };
    const { link } = await subNav("workers", { plugins: pluginsOf({ answer: () => answerOf({ checks: FAILING, claude }) }) });
    await waitFor(() => expect(link().textContent).toBe("Plugins 3 need attention"));
  });

  it("is on the Plugins link only", async () => {
    const { link } = await subNav("machine", { plugins: pluginsOf({ answer: () => answerOf({ checks: FAILING }) }) });
    await waitFor(() => expect(link().textContent).toContain("needs attention"));
    const nav = within(screen.getByRole("navigation", { name: "Settings sections" }));
    expect(nav.getAllByText(/attention/)).toHaveLength(1);
  });

  it("is hidden after a failed read, and the read is not tried again on a backoff: the doctor checks it runs are not repeated by an open page", async () => {
    const { fetchWith, link } = await subNav("models", { plugins: pluginsOf({ fails: { status: 500, error: "the doctor checks fell over" } }) });
    await waitFor(() => expect(asked(fetchWith)).toHaveLength(1));
    await waitFor(() => expect(fetchWith.requests.length).toBeGreaterThan(3));
    expect(link().textContent).toBe("Plugins");
    await new Promise((later) => setTimeout(later, POLL_MS_OF_BACKOFF));
    expect(asked(fetchWith)).toHaveLength(1);
  });

  it("is hidden while an SSH instance cannot be reached, though the plugins were read and count one", async () => {
    const sshDown: Stand = { connections: [PERSONAL], instances: { personal: { queueFails: { status: 502, error: "cannot reach personal: ssh: Permission denied" } } } };
    const { fetchWith, link } = await subNav("models", { stand: sshDown, plugins: pluginsOf({ answer: () => answerOf({ checks: FAILING }) }) });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Unreachable"));
    await waitFor(() => expect(asked(fetchWith)).toHaveLength(1));
    await waitFor(() => expect(link().textContent).toBe("Plugins"));
  });

  it("is hidden while the plugins are still being read, and shows once they are", async () => {
    const inner = pluginsFetch(NOTHING_WRONG, pluginsOf({ answer: () => answerOf({ checks: FAILING }) }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => { release = done; });
    const requested: string[] = [];
    const held = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => { if (String(input).endsWith("/api/plugins")) { requested.push(String(input)); await gate; } return inner(input, init); }, { paths: inner.paths, requests: inner.requests });
    render(<ShellProvider fetchWith={held}><ShellFrame page="models"><h1>The page</h1></ShellFrame></ShellProvider>);
    await waitFor(() => expect(requested).toHaveLength(1));
    const plugins = () => screen.getByRole("link", { name: /^Plugins/ });
    expect(plugins().textContent).toBe("Plugins");
    release();
    await waitFor(() => expect(plugins().textContent).toBe("Plugins 1 needs attention"));
  });
});

describe("the read behind the badge", () => {
  it("waits for the connections: before they are known it asks nobody, since the instance it is for is not chosen yet", async () => {
    const stand = pluginsFetch(NOTHING_WRONG, pluginsOf({ answer: () => answerOf({ checks: FAILING }) }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => { release = done; });
    const held = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => { if (String(input) === "/api/connections") await gate; return stand(input, init); }, { paths: stand.paths, requests: stand.requests });
    const root = rstest.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("the page's own fetch is not the stand-in"));
    render(<ShellProvider fetchWith={held}><ShellFrame page="models"><h1>The page</h1></ShellFrame></ShellProvider>);
    await screen.findByRole("link", { name: /^Plugins/ });
    expect([root.mock.calls.length, asked(held)]).toEqual([0, []]);
    release();
    await waitFor(() => expect(screen.getByRole("link", { name: /^Plugins/ }).textContent).toBe("Plugins 1 needs attention"));
    expect([root.mock.calls.length, asked(held)]).toEqual([0, ["/c/here/api/plugins"]]);
    root.mockRestore();
  });

  it("is made by the Settings page itself, once, of the instance shown and not before the connections are known", async () => {
    const { fetchWith, link } = await subNav("models", { plugins: pluginsOf({ answer: () => answerOf({ checks: FAILING }) }) });
    await waitFor(() => expect(link().textContent).toContain("needs attention"));
    expect(asked(fetchWith)).toEqual(["/c/here/api/plugins"]);
  });

  it("is the Plugins page's own when it provides one: the page and the badge share a single request", async () => {
    const { fetchWith, link } = await subNav("plugins", { shared: true, plugins: pluginsOf({ answer: () => answerOf({ checks: FAILING }) }) });
    await waitFor(() => expect(link().textContent).toContain("needs attention"));
    expect(asked(fetchWith)).toEqual(["/c/here/api/plugins"]);
  });

  it("is not tried again on a backoff when the Plugins page's shared read fails either, and is read again only when asked", async () => {
    let fails = true;
    const plugins = pluginsOf({ answer: () => answerOf({ checks: FAILING }) });
    const flaky = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (fails && String(input).endsWith("/api/plugins")) {
        flaky.paths.push(String(input));
        return new Response(JSON.stringify({ error: "the doctor checks fell over" }), { status: 500 });
      }
      return inner(input, init);
    }, { paths: [] as string[], requests: [] as unknown[] });
    const inner = pluginsFetch(NOTHING_WRONG, plugins);
    function AskAgain() {
      const read = useProvidedPluginsRead();
      return <button onClick={() => read?.refresh()}>Read the plugins again</button>;
    }
    render(<ShellProvider fetchWith={flaky as never}><PluginsRead><ShellFrame page="plugins"><AskAgain /></ShellFrame></PluginsRead></ShellProvider>);
    await waitFor(() => expect(flaky.paths).toEqual(["/c/here/api/plugins"]));
    await new Promise((later) => setTimeout(later, POLL_MS_OF_BACKOFF));
    expect(flaky.paths).toEqual(["/c/here/api/plugins"]);
    expect(screen.getByRole("link", { name: /^Plugins/ }).textContent).toBe("Plugins");
    fails = false;
    fireEvent.click(screen.getByRole("button", { name: "Read the plugins again" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /^Plugins/ }).textContent).toBe("Plugins 1 needs attention"));
  });
});
