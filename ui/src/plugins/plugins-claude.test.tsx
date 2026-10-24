import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { a11ign, answerOf, claudePlugin, pluginsSettings, PLUGIN_FILES, standOf as pluginsOf } from "../../test/plugins/plugins-stand.ts";
import { card, pageOn, posts } from "./plugins-harness.tsx";

const WRITER = "Run the a11ign:create-ticket skill for this request: {request}, in {dir}.";
const plugins = (...listed: ReturnType<typeof a11ign>[]) => pluginsOf({ answer: () => answerOf({ claude: { readable: true, plugins: listed } }) });
const claudeTab = async (stand = plugins(a11ign())) => {
  const page = await pageOn({ plugins: stand });
  fireEvent.click(screen.getByRole("tab", { name: /^Claude plugins/ }));
  return page;
};
/** The Claude plugins tab of the page over `options`, where the plugins and the settings are the stand-ins'. */
async function tabOver(options: Parameters<typeof pageOn>[0]) {
  const page = await pageOn(options);
  fireEvent.click(screen.getByRole("tab", { name: /^Claude plugins/ }));
  return page;
}
const removeIn = (name: string) => fireEvent.click(within(card(name)).getByRole("button", { name: "Remove from workers" }));
const skillSelect = (label: RegExp) => within(card("a11ign")).getByLabelText(label) as HTMLSelectElement;
const sent = (fetchWith: Parameters<typeof posts>[0], suffix: string) => posts(fetchWith).filter(({ path }) => path.endsWith(suffix)).map(({ body }) => body);

describe("the Claude plugins tab", () => {
  it("says what the tab is, apart from the agent-org plugins: its own intro and cards, with no concern's words or controls", async () => {
    await claudeTab();
    expect(screen.getByText(/loaded into every worker's session/).textContent).toContain("claude plugin install <plugin> --scope user");
    expect(screen.queryByText("Active plugin")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Disable|^Uninstall|^Install/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /^Claude plugins/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("draws a plugin's contract, its health, the skill of each job, the plan file, and what it needs from the machine", async () => {
    await claudeTab();
    const plugin = card("a11ign");
    expect(within(plugin).getByText("contract 1.0")).toBeTruthy();
    expect(within(plugin).getByText("agent-org >=0.258.0 <1.0.0")).toBeTruthy();
    expect(within(plugin).getByText("Loads")).toBeTruthy();
    expect(within(plugin).getByText("Installed for workers (user scope).")).toBeTruthy();
    expect((within(plugin).getByLabelText(/Writing a new ticket/) as HTMLSelectElement).value).toBe("a11ign:create-ticket");
    expect((within(plugin).getByLabelText(/Review before a pull request/) as HTMLSelectElement).value).toBe("a11ign:clean-code-review");
    expect(within(plugin).getByText("<issue-id>-0001-plan-<slug>.md")).toBeTruthy();
    expect(within(plugin).getByText("Allowed in tickets.connectors")).toBeTruthy();
    expect(within(plugin).getByText("Found")).toBeTruthy();
  });

  it("says a plugin that does not load, with the backend's fix sentence and a Copy button", async () => {
    await claudeTab(plugins(claudePlugin({ loads: false, why: "a11ign@applied-ai is not installed for the worker's folder: run claude plugin install a11ign@applied-ai --scope user" })));
    const plugin = card("a11ign");
    expect(within(plugin).getByText("Does not load")).toBeTruthy();
    expect(within(plugin).getByText(/is not installed for the worker's folder/)).toBeTruthy();
    expect(within(plugin).getByRole("button", { name: /^Copy the fix:/ })).toBeTruthy();
  });

  it("shows only the intro and the form when the list is empty", async () => {
    await claudeTab(plugins());
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("button", { name: "Add Claude plugin" })).toBeTruthy();
  });
});

describe("adding a Claude plugin", () => {
  it("previews the list with the plugin added, asks in the schema's sentence because tickets.plugins is dangerous, and saves it confirmed by name", async () => {
    const { fetchWith } = await claudeTab();
    const input = screen.getByLabelText("Plugin to add, as name@marketplace");
    const add = screen.getByRole("button", { name: "Add Claude plugin" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "other@market" } });
    fireEvent.click(add);
    const dialog = await screen.findByRole("dialog", { name: "Change tickets.plugins?" });
    expect(dialog.textContent).toContain("Each plugin is loaded into every worker's session, so a wrong one changes what every worker can do.");
    expect(dialog.textContent).toContain("Takes effect after the board restarts.");
    expect(sent(fetchWith, "/api/settings/save")).toEqual([]);
    expect(sent(fetchWith, "/api/settings/preview")).toEqual([{ file: "host.json", changes: [{ key: "tickets.plugins", value: ["a11ign@applied-ai", "other@market"] }] }]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Change" }));
    await screen.findByText(/Added other@market to tickets\.plugins\./);
    expect(sent(fetchWith, "/api/settings/save")).toEqual([{ file: "host.json", changes: [{ key: "tickets.plugins", value: ["a11ign@applied-ai", "other@market"] }], base: "base-1", confirmed: ["tickets.plugins"] }]);
  });

  it("Cancel saves nothing, and what was typed stays to be tried again", async () => {
    const { fetchWith } = await claudeTab();
    fireEvent.change(screen.getByLabelText("Plugin to add, as name@marketplace"), { target: { value: "other@market" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Claude plugin" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent(fetchWith, "/api/settings/save")).toEqual([]);
    expect((screen.getByLabelText("Plugin to add, as name@marketplace") as HTMLInputElement).value).toBe("other@market");
  });

  it("clears what was typed once the plugin is added", async () => {
    await claudeTab();
    fireEvent.change(screen.getByLabelText("Plugin to add, as name@marketplace"), { target: { value: "other@market" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Claude plugin" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Change" }));
    await screen.findByText(/Added other@market/);
    await waitFor(() => expect((screen.getByLabelText("Plugin to add, as name@marketplace") as HTMLInputElement).value).toBe(""));
  });

  it("is a conflict, and saves nothing, when the host file changed since the page read the list it adds to", async () => {
    const settings = pluginsSettings();
    const stand = plugins(a11ign());
    const { fetchWith } = await tabOver({ plugins: stand, settings });
    // The file changes after the page read it: the preview is made of the file as it is now.
    settings.base = "base-2";
    fireEvent.change(screen.getByLabelText("Plugin to add, as name@marketplace"), { target: { value: "other@market" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Claude plugin" }));
    await screen.findByRole("button", { name: "Read the plugins again" });
    expect(sent(fetchWith, "/api/settings/save")).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not offer to add what is not a name@marketplace, or what is listed already", async () => {
    await claudeTab();
    const add = screen.getByRole("button", { name: "Add Claude plugin" }) as HTMLButtonElement;
    for (const text of ["other", "a b@c", "a11ign@applied-ai"]) {
      fireEvent.change(screen.getByLabelText("Plugin to add, as name@marketplace"), { target: { value: text } });
      expect(add.disabled).toBe(true);
    }
  });

});

describe("removing a Claude plugin, and a change that does not go through", () => {
  it("removes a plugin from workers by saving the list without it, confirmed by name", async () => {
    const { fetchWith } = await claudeTab();
    removeIn("a11ign");
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Change tickets.plugins?" })).getByRole("button", { name: "Change" }));
    await screen.findByText(/Removed a11ign@applied-ai from tickets\.plugins\./);
    expect(sent(fetchWith, "/api/settings/save")).toEqual([{ file: "host.json", changes: [{ key: "tickets.plugins", value: [] }], base: "base-1", confirmed: ["tickets.plugins"] }]);
  });

  it("says what the readers refused, with the server's sentence, and the file changed", async () => {
    const settings = pluginsSettings(PLUGIN_FILES, { answers: { preview: () => ({ status: 400, error: "ticket mode: tickets.plugins must be a list" }) } });
    await tabOver({ plugins: plugins(a11ign()), settings });
    removeIn("a11ign");
    const banner = await screen.findByText("Nothing was changed.");
    expect(banner.parentElement!.textContent).toBe("Nothing was changed. ticket mode: tickets.plugins must be a list");
  });

  it("is a conflict when the host file changed since the preview", async () => {
    const settings = pluginsSettings();
    await tabOver({ plugins: plugins(a11ign()), settings });
    removeIn("a11ign");
    const dialog = await screen.findByRole("dialog");
    settings.base = "base-2";
    fireEvent.click(within(dialog).getByRole("button", { name: "Change" }));
    await screen.findByRole("button", { name: "Read the plugins again" });
  });
});

describe("which skill does each job", () => {
  it("changes the review skill by saving tickets.prReview, at once because it is not a dangerous key", async () => {
    const files = { ...PLUGIN_FILES, host: { tickets: { ...(PLUGIN_FILES.host.tickets as object), prReview: "other:review" } } };
    const { fetchWith } = await tabOver({ plugins: plugins(a11ign()), settings: pluginsSettings(files) });
    const select = skillSelect(/Review before a pull request/);
    expect([...select.options].map((option) => option.value)).toEqual(["other:review", "a11ign:clean-code-review"]);
    fireEvent.change(select, { target: { value: "a11ign:clean-code-review" } });
    await screen.findByText(/Review before a pull request now uses a11ign:clean-code-review\./);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent(fetchWith, "/api/settings/save")).toEqual([{ file: "host.json", changes: [{ key: "tickets.prReview", value: "a11ign:clean-code-review" }], base: "base-1", confirmed: [] }]);
  });

  it("changes only the skill the writer's instruction names, so its {request} and {dir} stay", async () => {
    const stand = pluginsOf({ answer: () => answerOf({ claude: { readable: true, plugins: [a11ign({ contract: { ...a11ign().contract!, provides: { writer: { skill: "a11ign:other-writer" } } } })] } }) });
    const { fetchWith } = await tabOver({ plugins: stand });
    const select = skillSelect(/Writing a new ticket/);
    expect([...select.options].map((option) => option.value)).toEqual(["a11ign:create-ticket", "a11ign:other-writer"]);
    fireEvent.change(select, { target: { value: "a11ign:other-writer" } });
    await waitFor(() => expect(sent(fetchWith, "/api/settings/save")).toHaveLength(1));
    expect(sent(fetchWith, "/api/settings/save")[0]).toMatchObject({ changes: [{ key: "tickets.writer.run", value: WRITER.replace("a11ign:create-ticket", "a11ign:other-writer") }] });
  });

  it("shows the key's text, not a select, when the writer's instruction names no single skill of the plugin", async () => {
    const files = { ...PLUGIN_FILES, host: { tickets: { ...(PLUGIN_FILES.host.tickets as object), writer: { run: "Write the ticket for {request} in {dir}." } } } };
    await tabOver({ plugins: plugins(a11ign()), settings: pluginsSettings(files) });
    expect(within(card("a11ign")).queryByLabelText(/Writing a new ticket/)).toBeNull();
    expect(within(card("a11ign")).getByText("Write the ticket for {request} in {dir}.")).toBeTruthy();
  });

  it("draws no job for a plugin that declares no contract", async () => {
    await claudeTab(plugins(claudePlugin()));
    expect(within(card("a11ign")).queryByText("Which skill does each job")).toBeNull();
    expect(within(card("a11ign")).queryByText("Needs from this machine")).toBeNull();
    expect(within(card("a11ign")).getByText("Loads")).toBeTruthy();
  });
});
