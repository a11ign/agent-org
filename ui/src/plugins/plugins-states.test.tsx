import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HERE, PERSONAL, type Stand } from "../../test/fixtures.ts";
import { a11ign, answerOf, failing, pluginsSettings, standOf as pluginsOf } from "../../test/plugins/plugins-stand.ts";
import { modelsConfig } from "../../test/settings/settings-stand.ts";
import { card, head, pageOn, standOf } from "./plugins-harness.tsx";

const TELEGRAM = { provider: "telegram", enabled: true, settings: {} } as const;
const UNPAIRED = { telegram: [failing("messaging (telegram)", "The chairman has not paired, so nothing can be sent or asked.", "agent-org messaging:pair")] };
const UNCONNECTED = { rows: [{ plugin: "a11ign@applied-ai", kind: "connector-need", why: "a11ign@applied-ai needs the connector tools matched by ^mcp__linear__, which tickets.connectors does not allow: add the pattern to tickets.connectors." }] } as const;

const sshDown = (): Stand => ({ connections: [PERSONAL], instances: { personal: { config: modelsConfig(), queueFails: { status: 502, error: "cannot reach personal: ssh: Permission denied" } } } });

describe("the page while the plugins are read", () => {
  it("draws the title, the sentence under it, the tabs with no counts, and the board's six cards as one status", async () => {
    await pageOn({ plugins: pluginsOf({ hold: true }), ready: false });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Plugins");
    expect(screen.getByText(/Two kinds\./)).toBeTruthy();
    const tabs = within(screen.getByRole("tablist", { name: "Plugin kind" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Integrations", "Claude plugins"]);
    const skeleton = screen.getByRole("status", { name: "Loading plugins" });
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.querySelectorAll(".skeleton-plugin-card")).toHaveLength(6);
  });

  it("says the error with Retry when the first read fails, and reads again on Retry", async () => {
    const plugins = pluginsOf({ fails: { status: 500, error: "the doctor checks fell over" } });
    const { fetchWith } = await pageOn({ plugins, ready: false });
    await screen.findByText("the doctor checks fell over");
    plugins.fails = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("tablist", { name: "Plugin kind" });
    expect(fetchWith.paths.filter((path) => path.endsWith("/api/plugins"))).toHaveLength(2);
  });
});

describe("the plugins read while the instance restarts (A11-211)", () => {
  it("says Reconnecting…, reads again by itself after 2 seconds, and draws the cards once the instance answers", async () => {
    const plugins = pluginsOf({ fails: { status: 502, error: "no answer within 30 seconds" } });
    const { fetchWith } = await pageOn({ plugins, ready: false });
    await screen.findByText("Reconnecting…");
    expect(fetchWith.paths.filter((path) => path.endsWith("/api/plugins"))).toHaveLength(1);
    plugins.fails = undefined;
    await screen.findByRole("region", { name: "Tracker" }, { timeout: 4_000 });
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(fetchWith.paths.filter((path) => path.endsWith("/api/plugins"))).toHaveLength(2);
  });

  it("does not read again by itself after a refusal, which the page's Retry asks for", async () => {
    const plugins = pluginsOf({ fails: { status: 500, error: "the doctor checks fell over" } });
    const { fetchWith } = await pageOn({ plugins, ready: false });
    await screen.findByText("the doctor checks fell over");
    await new Promise((done) => setTimeout(done, 2_600));
    expect(fetchWith.paths.filter((path) => path.endsWith("/api/plugins"))).toHaveLength(1);
  });
});

describe("where a plugin is", () => {
  it("is said with what the plugin is, as today's board said it, on a concern of one plugin and on each plugin a concern chooses between", async () => {
    const answer = answerOf();
    await pageOn({ plugins: pluginsOf({ answer: () => answer }) });
    const placeOf = ({ description, where }: { description: string; where: string }) => `${description} ${where}.`;
    const concerns = answer.concerns.filter(({ plugins }) => plugins.length > 0);
    const single = concerns.find(({ plugins }) => plugins.length === 1);
    const choice = concerns.find(({ plugins }) => plugins.length > 1);
    if (single === undefined || choice === undefined) throw new Error("the stand has no concern of one plugin and one with a choice");
    const titled = (label: string): string => `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
    const opened = (label: string): void => { if (head(label).getAttribute("aria-expanded") !== "true") fireEvent.click(head(label)); };
    opened(titled(single.label));
    expect(within(card(titled(single.label))).getByText(placeOf(single.plugins[0])).className).toContain("plugin-note");
    opened(titled(choice.label));
    for (const plugin of choice.plugins) expect(within(card(titled(choice.label))).getByText(placeOf(plugin))).toBeTruthy();
  });
});

describe("the page when the plugins are read", () => {
  it("counts the concerns on Integrations and the Claude plugins on the other tab", async () => {
    await pageOn({ plugins: pluginsOf({ answer: () => answerOf({ claude: { readable: true, plugins: [a11ign()] } }) }) });
    expect(screen.getByRole("tab", { name: /^Integrations/ }).textContent).toBe("Integrations6");
    expect(screen.getByRole("tab", { name: /^Claude plugins/ }).textContent).toBe("Claude plugins1");
  });

  it("opens a card to its checks, and shows the failing one with its fix and a Copy button", async () => {
    const writeText = rstest.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
    await pageOn({ plugins: pluginsOf({ answer: () => answerOf({ messaging: TELEGRAM, checks: UNPAIRED }) }) });
    fireEvent.click(head("Messaging"));
    const messaging = card("Messaging");
    expect(within(messaging).getByText("1 check failing")).toBeTruthy();
    expect(within(messaging).getByText("The chairman has not paired, so nothing can be sent or asked.")).toBeTruthy();
    fireEvent.click(within(messaging).getByRole("button", { name: "Copy the fix: agent-org messaging:pair" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("agent-org messaging:pair"));
    await within(messaging).findByRole("button", { name: "Copy the fix: agent-org messaging:pair" }).then((button) => expect(button.textContent).toBe("Copied"));
  });

  it("shows a secret as the command that sets it, never as a field", async () => {
    await pageOn();
    const tracker = card("Tracker");
    expect(within(tracker).getByText(/A secret is never typed in this page/)).toBeTruthy();
    expect(within(tracker).getByText(/security add-generic-password/)).toBeTruthy();
    expect(within(tracker).queryByLabelText(/keychain/i)).toBeNull();
  });

  it("draws a package the registry refused as a failed card with doctor's reason and fix", async () => {
    const why = "plugins/broken/package.json has no agentOrg block";
    await pageOn({ plugins: pluginsOf({ answer: () => answerOf({ refused: [{ plugin: "broken", why }] }) }) });
    expect(["Failed", why, "fix the plugin's package.json, or remove the plugin"].map((words) => within(card("broken")).queryByText(words) !== null)).toEqual([true, true, true]);
  });

  it("is the card of one concern open at a time, as the board has it", async () => {
    await pageOn();
    expect(head("Tracker").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head("Code host"));
    expect(head("Tracker").getAttribute("aria-expanded")).toBe("false");
    expect(head("Code host").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("health unknown", () => {
  it("shows the Unknown board's banner over the last answer, every status Unknown, every check not checked, and no badge", async () => {
    const plugins = pluginsOf({ answer: () => answerOf({ messaging: TELEGRAM, checks: UNPAIRED }) });
    await pageOn({ stand: sshDown(), plugins });
    const banner = await screen.findByText("Plugin health is unknown.");
    expect(banner.parentElement!.textContent).toBe("Plugin health is unknown. Can't reach personal, so no check has run. Settings shown are the last the instance sent.");
    expect(within(card("Tracker")).getByText("Unknown")).toBeTruthy();
    expect(within(card("Messaging")).getByText("Unknown")).toBeTruthy();
    expect(within(card("Tracker")).getByText("Not checked: personal can't be reached.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Plugins/ }).textContent).toBe("Plugins");
  });

  it("Retry reads the plugins again", async () => {
    const { fetchWith } = await pageOn({ stand: sshDown(), plugins: pluginsOf() });
    await screen.findByText("Plugin health is unknown.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchWith.paths.filter((path) => path.endsWith("/api/plugins"))).toHaveLength(2));
  });

  it("says a Claude plugin's health is unknown too", async () => {
    await pageOn({ stand: sshDown(), plugins: pluginsOf({ answer: () => answerOf({ claude: { readable: true, plugins: [a11ign()] } }) }) });
    await screen.findByText("Plugin health is unknown.");
    fireEvent.click(screen.getByRole("tab", { name: /^Claude plugins/ }));
    const plugin = card("a11ign");
    expect(within(plugin).getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(within(plugin).getAllByText("Not checked")).toHaveLength(2);
  });
});

describe("the badge", () => {
  it("counts a failing check and a Claude plugin's unmet need, from the one read the page makes", async () => {
    const plugins = pluginsOf({ answer: () => answerOf({ messaging: TELEGRAM, checks: UNPAIRED, claude: { readable: true, plugins: [a11ign(UNCONNECTED)] } }) });
    const { fetchWith } = await pageOn({ plugins });
    expect(screen.getByRole("link", { name: /^Plugins/ }).textContent).toBe("Plugins 2 need attention");
    expect(fetchWith.paths.filter((path) => path.endsWith("/api/plugins"))).toHaveLength(1);
  });

  it("is not on the link when nothing needs attention", async () => {
    await pageOn();
    expect(screen.getByRole("link", { name: /^Plugins/ }).textContent).toBe("Plugins");
  });
});

describe("a page that offers no control", () => {
  it("draws none for a remote instance, and says its files are changed on that machine", async () => {
    await pageOn({ stand: { connections: [PERSONAL], instances: { personal: { config: modelsConfig() } } } });
    expect(screen.getByText("This instance is personal. Its files are changed on that machine, so this page offers no edit here.")).toBeTruthy();
    fireEvent.click(head("Publisher"));
    expect(within(card("Tracker")).queryByRole("button", { name: /^Disable|^Uninstall/ })).toBeNull();
    for (const input of within(card("Tracker")).queryAllByRole("textbox")) expect((input as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: /^Claude plugins/ }));
    expect(screen.queryByRole("button", { name: "Add Claude plugin" })).toBeNull();
  });

  it("draws the note and no control when the reader refuses the host file", async () => {
    const note = "the host file is refused, so the plugins are shown as their defaults: tickets.workers must be a whole number";
    await pageOn({ plugins: pluginsOf({ answer: () => answerOf({ note, claude: { readable: true, plugins: [a11ign()] } }) }) });
    expect(screen.getByText(note)).toBeTruthy();
    fireEvent.click(head("Exposure"));
    expect(within(card("Exposure")).queryByRole("button", { name: /^Disable|^Uninstall/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^Claude plugins/ }));
    expect(screen.queryByRole("button", { name: /Remove from workers/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Claude plugin" })).toBeNull();
  });
});

describe("a concern's own settings", () => {
  it("draws the editable settings of the concern, stages one typed into, and reviews it through the Settings flow", async () => {
    const { fetchWith } = await pageOn({ settings: pluginsSettings(), plugins: pluginsOf({ answer: () => answerOf({ host: { tickets: { providers: { publish: { provider: "slack", enabled: true } } } } }) }) });
    fireEvent.click(head("Publisher"));
    const model = within(card("Publisher")).getByLabelText("tickets.providers.publish.model") as HTMLInputElement;
    fireEvent.change(model, { target: { value: "sonnet" } });
    await screen.findByText("1 unsaved change");
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Review changes" });
    expect(dialog.textContent).toContain("tickets.providers.publish.model");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save to host.json" }));
    await screen.findByText("Saved to host.json.");
    expect(fetchWith.requests.filter(({ path }) => path.endsWith("/api/settings/save")).map(({ body }) => body)).toEqual([
      { file: "host.json", changes: [{ key: "tickets.providers.publish.model", value: "sonnet" }], base: "base-1", confirmed: [] },
    ]);
  });
});
