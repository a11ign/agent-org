import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { a11ign, answerOf, standOf as pluginsOf, type PluginsStand } from "../../test/plugins/plugins-stand.ts";
import { card, head, pageOn, posts } from "./plugins-harness.tsx";

const WITH_SLACK = { tickets: { providers: { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", enabled: true }, publish: { provider: "slack", enabled: true } } } };
const SLACK_OFF = { tickets: { providers: { ...WITH_SLACK.tickets.providers, publish: { provider: "slack", enabled: false } } } };
const IN_FORCE = "in force after the board restarts: ticket:serve and ticket:ui.";

const standWith = (host: unknown, fields: Partial<PluginsStand> = {}): PluginsStand => pluginsOf({ answer: () => answerOf({ host }), ...fields });
const opened = (name: string) => fireEvent.click(head(name));
const actions = (fetchWith: Parameters<typeof posts>[0]) => posts(fetchWith).filter(({ path }) => path.endsWith("/api/plugins/action")).map(({ body }) => body);
const reads = (fetchWith: { paths: string[] }) => fetchWith.paths.filter((path) => path.endsWith("/api/plugins")).length;

describe("disable and enable", () => {
  it("disables a plugin with one request that carries the file's base, and says what the backend said, when it is in force and the file it kept", async () => {
    const plugins = standWith(WITH_SLACK, { action: () => ({ said: "disabled slack: nothing is published, and its settings are kept for `enable`", changed: true, inForce: [IN_FORCE], backup: "/home/agents/.agent-org/host.json.bak" }) });
    const { fetchWith } = await pageOn({ plugins });
    opened("Publisher");
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Disable slack" }));
    await screen.findByText(/Disabled slack: nothing is published/);
    expect(actions(fetchWith)).toEqual([{ action: "disable", name: "slack", base: "base-1" }]);
    const text = screen.getByText(/Disabled slack/).parentElement!.textContent!;
    expect(text).toContain("In force after the board restarts: ticket:serve and ticket:ui.");
    expect(text).toContain("The previous host file is kept as host.json.bak.");
  });

  it("reads the plugins again after an action, which is also what updates the badge", async () => {
    const plugins = standWith(WITH_SLACK);
    const { fetchWith } = await pageOn({ plugins });
    expect(reads(fetchWith)).toBe(1);
    opened("Publisher");
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Disable slack" }));
    await waitFor(() => expect(reads(fetchWith)).toBe(2));
  });

  it("offers Enable in Disable's place for a plugin that is switched off, and posts enable", async () => {
    const { fetchWith } = await pageOn({ plugins: standWith(SLACK_OFF) });
    opened("Publisher");
    expect(within(card("Publisher")).queryByRole("button", { name: "Disable slack" })).toBeNull();
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Enable slack" }));
    await waitFor(() => expect(actions(fetchWith)).toEqual([{ action: "enable", name: "slack", base: "base-1" }]));
  });

  it("draws a control the plan refuses off, with the plan's sentence beside it, and posts nothing when it is pressed", async () => {
    const { fetchWith } = await pageOn({ plugins: standWith(WITH_SLACK) });
    const tracker = card("Tracker");
    const disable = within(tracker).getByRole("button", { name: "Disable linear" }) as HTMLButtonElement;
    expect(disable.disabled).toBe(true);
    expect(within(tracker).getByText("linear is the only tracker, and exactly one tracker must be enabled: it cannot be disabled")).toBeTruthy();
    fireEvent.click(disable);
    expect(actions(fetchWith)).toEqual([]);
  });

  it("says that a disabled plugin keeps its settings, with the command that enables it", async () => {
    await pageOn({ plugins: standWith(WITH_SLACK) });
    opened("Publisher");
    expect(within(card("Publisher")).getByText(/Disabled plugins keep their settings, for/).textContent).toContain("agent-org plugin enable slack");
  });
});

describe("install", () => {
  it("installs a plugin that replaces nothing at once, with no confirmation", async () => {
    const { fetchWith } = await pageOn({ plugins: standWith(WITH_SLACK) });
    opened("Reviewer");
    fireEvent.click(within(card("Reviewer")).getByRole("button", { name: "Install atomic" }));
    await waitFor(() => expect(actions(fetchWith)).toEqual([{ action: "install", name: "atomic", base: "base-1" }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/** The page with a control pressed that asks first: the dialog it opens, over the page. */
async function asked(concern: string, control: () => HTMLElement, heading: string) {
  const page = await pageOn({ plugins: standWith(WITH_SLACK) });
  opened(concern);
  fireEvent.click(control());
  return { ...page, dialog: await screen.findByRole("dialog", { name: heading }) };
}

describe("uninstall", () => {
  const asking = () => asked("Publisher", () => within(card("Publisher")).getByRole("button", { name: "Uninstall slack" }), "Uninstall slack?");

  it("asks first, in the backend's sentence, with the restart note and where the previous file is kept, and sends nothing yet", async () => {
    const { dialog, fetchWith } = await asking();
    expect(dialog.textContent).toContain("Uninstall slack? Its block is removed, with its settings, so the publisher takes its default.");
    expect(dialog.textContent).toContain("Takes effect after the board restarts.");
    expect(dialog.textContent).toContain("The previous host file is kept as host.json.bak.");
    expect(actions(fetchWith)).toEqual([]);
  });

  it("Cancel closes it and posts nothing, as Escape does", async () => {
    const { dialog, fetchWith } = await asking();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    opened("Publisher");
    opened("Publisher");
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Uninstall slack" }));
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions(fetchWith)).toEqual([]);
  });

  it("Uninstall posts the action confirmed", async () => {
    const { dialog, fetchWith } = await asking();
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(actions(fetchWith)).toEqual([{ action: "uninstall", name: "slack", base: "base-1", confirmed: true }]));
    await screen.findByText(/Uninstalled slack/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("switching a concern's plugin", () => {
  const switching = () => asked("Exposure", () => within(card("Exposure")).getByRole("radio", { name: /^local/ }), "Switch the exposure to another plugin?");

  it("lists the plugins of a concern with more than one, the active one chosen", async () => {
    await pageOn({ plugins: standWith(WITH_SLACK) });
    opened("Exposure");
    const radios = within(card("Exposure")).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => [radio.checked])).toEqual([[false], [true]]);
    expect(within(card("Exposure")).getByText("Active plugin")).toBeTruthy();
  });

  it("asks first in the backend's sentence, and Cancel posts nothing", async () => {
    const { dialog, fetchWith } = await switching();
    expect(dialog.textContent).toContain("Install local? It replaces tailscale as the exposure: no setting is lost.");
    expect(dialog.textContent).toContain("Takes effect after the board restarts.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(actions(fetchWith)).toEqual([]);
  });

  it("Switch posts the install confirmed, and the card says the switch needs a restart", async () => {
    const { dialog, fetchWith } = await switching();
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(actions(fetchWith)).toEqual([{ action: "install", name: "local", base: "base-1", confirmed: true }]));
    await waitFor(() => expect(within(card("Exposure")).getByText(/Switching runs/).textContent).toBe("Switching runs agent-org plugin enable local and needs a restart."));
  });
});

describe("a change that does not go through", () => {
  it("says Nothing was changed, with the server's sentence, for a refusal", async () => {
    const sentence = "the host file is refused, so no plugin can be changed: ticket mode: `tickets.workers` in the host file must be a whole number of 1 or more, not 0.";
    await pageOn({ plugins: standWith(WITH_SLACK, { action: () => ({ status: 400, error: sentence }) }) });
    opened("Publisher");
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Disable slack" }));
    const banner = await screen.findByText("Nothing was changed.");
    expect(banner.parentElement!.textContent).toBe(`Nothing was changed. ${sentence.replaceAll("`", "")}`);
    expect([...banner.parentElement!.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["tickets.workers"]);
    expect(banner.closest("[role=alert]")).not.toBeNull();
  });

  it("says the file changed, and Read the plugins again reads them again", async () => {
    const plugins = standWith(WITH_SLACK);
    const { fetchWith } = await pageOn({ plugins });
    plugins.base = "base-2";
    opened("Publisher");
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Disable slack" }));
    const banner = await screen.findByText("Nothing was changed.");
    expect(banner.parentElement!.textContent).toBe("Nothing was changed. The file changed since you looked: read it again.");
    await waitFor(() => expect(reads(fetchWith)).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Read the plugins again" }));
    await waitFor(() => expect(reads(fetchWith)).toBe(3));
    expect(screen.queryByRole("button", { name: "Read the plugins again" })).toBeNull();
    // The page now holds the file as it is, so the same action goes through.
    opened("Publisher");
    opened("Publisher");
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Disable slack" }));
    await screen.findByText(/Disabled slack/);
  });


  it("is the banner of the last change only: the next change clears it", async () => {
    const plugins = standWith(WITH_SLACK, { action: (body) => (body.name === "slack" ? { status: 400, error: "refused" } : { said: "installed atomic", changed: true, inForce: [IN_FORCE], backup: null }) });
    await pageOn({ plugins });
    opened("Publisher");
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Disable slack" }));
    await screen.findByText("Nothing was changed.");
    opened("Reviewer");
    fireEvent.click(within(card("Reviewer")).getByRole("button", { name: "Install atomic" }));
    await screen.findByText(/Installed atomic/);
    expect(screen.queryByText("Nothing was changed.")).toBeNull();
  });
});

describe("a change that follows another", () => {
  it("waits for the plugins read after the first, so the next action is not sent with the base the first one replaced", async () => {
    const plugins = standWith(WITH_SLACK);
    let release: () => void = () => undefined;
    await pageOn({ plugins });
    plugins.hold = new Promise<void>((done) => { release = done; });
    opened("Publisher");
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Disable slack" }));
    await screen.findByText(/Disabled slack/);
    const uninstall = within(card("Publisher")).getByRole("button", { name: "Uninstall slack" }) as HTMLButtonElement;
    expect(uninstall.disabled).toBe(true);
    release();
    await waitFor(() => expect(uninstall.disabled).toBe(false));
  });

  it("is not left beside the banner of an earlier save of a concern's setting", async () => {
    const plugins = standWith(WITH_SLACK);
    await pageOn({ plugins });
    opened("Publisher");
    fireEvent.change(within(card("Publisher")).getByLabelText("tickets.providers.publish.model"), { target: { value: "sonnet" } });
    fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Review changes" })).getByRole("button", { name: "Save to host.json" }));
    await screen.findByText("Saved to host.json.");
    fireEvent.click(within(card("Publisher")).getByRole("button", { name: "Disable slack" }));
    await screen.findByText(/Disabled slack/);
    expect(screen.queryByText("Saved to host.json.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore previous" })).toBeNull();
  });

  it("says no switch for an enable of the plugin the block names", async () => {
    await pageOn({ plugins: standWith({ tickets: { providers: { ...WITH_SLACK.tickets.providers, exposure: { provider: "tailscale", enabled: false } } } }) });
    opened("Exposure");
    fireEvent.click(within(card("Exposure")).getByRole("radio", { name: /^tailscale/ }));
    await screen.findByText(/Enabled tailscale/);
    expect(within(card("Exposure")).queryByText(/Switching runs/)).toBeNull();
  });
});

describe("the page with a Claude plugin around it", () => {
  it("keeps its own Claude plugin out of the agent-org actions", async () => {
    const { fetchWith } = await pageOn({ plugins: pluginsOf({ answer: () => answerOf({ host: WITH_SLACK, claude: { readable: true, plugins: [a11ign()] } }) }) });
    expect(actions(fetchWith)).toEqual([]);
  });
});
