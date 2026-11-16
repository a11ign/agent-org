import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { answerOf, standOf as pluginsOf } from "../../test/plugins/plugins-stand.ts";
import { card, head, pageOn, posts } from "./plugins-harness.tsx";

// A11-445: a plugin's secret is typed in a write-only field, sent once, and never drawn again.
const TOKEN = "lin_api_typedonceSECRET";
const field = () => within(card("Tracker")).getByLabelText("Set key.path:") as HTMLInputElement;
const secrets = (fetchWith: Parameters<typeof posts>[0]) => posts(fetchWith).filter(({ path }) => path.endsWith("/api/plugins/secret")).map(({ body }) => body);

describe("a secret typed on the page", () => {
  it("is a password field that says where the secret is stored and which key a save sets, beside the command that sets it on the host", async () => {
    await pageOn();
    const tracker = card("Tracker");
    expect(field().type).toBe("password");
    expect(field().autocomplete).toBe("off");
    expect(field().value).toBe("");
    expect(within(tracker).getByText(/Stored in the file ~\/\.config\/agent-org\/linear\.key, and tickets\.providers\.tracker\.key is set to point at it, then linear's check runs\./)).toBeTruthy();
    expect(within(tracker).getByText("Or on the host:")).toBeTruthy();
    expect((within(tracker).getByRole("button", { name: "Save key.path" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is sent once with the file's base, cleared as it is sent, and the banner says where it went and what the plugin's check found, never the secret", async () => {
    const plugins = pluginsOf({ secret: () => ({ said: "stored key.path of linear in the file /home/me/.config/agent-org/linear.key", inForce: [], backup: null, checkedAt: null,
      checks: [{ name: "tracker key", ok: true, detail: "Linear accepted the key: it is Ada's", fix: null }] }) });
    const { fetchWith } = await pageOn({ plugins });
    fireEvent.change(field(), { target: { value: TOKEN } });
    fireEvent.click(within(card("Tracker")).getByRole("button", { name: "Save key.path" }));
    expect(field().value).toBe("");
    await screen.findByText(/Stored key\.path of linear in the file/);
    expect(screen.getByText(/linear's check tracker key passes:/).textContent).toContain("Linear accepted the key: it is Ada's");
    expect(secrets(fetchWith)).toEqual([{ name: "linear", setting: "key.path", value: TOKEN, base: "base-1" }]);
    await waitFor(() => expect(document.body.textContent).not.toContain(TOKEN));
    expect([...document.querySelectorAll("input")].some((input) => input.value.includes(TOKEN))).toBe(false);
  });

  it("says a refusal as nothing changed, in the instance's words", async () => {
    const plugins = pluginsOf({ secret: () => ({ status: 400, error: "the secret must be one line with no space, quote or backslash in it, as an API token is" }) });
    await pageOn({ plugins });
    fireEvent.change(field(), { target: { value: "two words" } });
    fireEvent.click(within(card("Tracker")).getByRole("button", { name: "Save key.path" }));
    const alert = await screen.findByText(/Nothing was changed\./);
    expect(alert.parentElement!.textContent).toContain("the secret must be one line with no space");
  });

  it("says when no check ran because the plugin is not enabled", async () => {
    await pageOn({ plugins: pluginsOf({ secret: () => ({ said: "stored key.path of linear in the file /x/linear.key", inForce: [], backup: null, checks: null, checkedAt: null }) }) });
    fireEvent.change(field(), { target: { value: TOKEN } });
    fireEvent.click(within(card("Tracker")).getByRole("button", { name: "Save key.path" }));
    expect((await screen.findByText(/Stored key\.path of linear/)).parentElement!.textContent).toContain("No check of linear ran: it runs once linear is enabled.");
  });

  it("offers Install for a plugin whose secrets the page takes, and draws its field only once it is installed, with the command alone before", async () => {
    await pageOn({ plugins: pluginsOf({ answer: () => answerOf({ host: { tickets: { providers: { codeHost: { provider: "github", enabled: true } } } } }) }) });
    const tracker = card("Tracker");
    expect(within(tracker).getByRole("button", { name: "Install linear" })).toBeTruthy();
    expect(within(tracker).queryByLabelText("Set key.path:")).toBeNull();
    expect(within(tracker).queryByText("Or on the host:")).toBeNull();
    expect(within(tracker).getAllByText("Set key.path:").length).toBe(1);
  });

  it("offers no Install for a plugin with a secret set only on the host", async () => {
    await pageOn();
    fireEvent.click(head("Messaging"));
    expect(within(card("Messaging")).queryByRole("button", { name: "Install telegram" })).toBeNull();
  });
});
