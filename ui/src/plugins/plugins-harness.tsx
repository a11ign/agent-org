import { render, screen, waitFor, within } from "@testing-library/react";
import { HERE, type Stand } from "../../test/fixtures.ts";
import { modelsConfig } from "../../test/settings/settings-stand.ts";
import { pluginsFetch, pluginsSettings, standOf as pluginsOf, type PluginsStand } from "../../test/plugins/plugins-stand.ts";
import type { SettingsStand } from "../../test/settings/settings-stand.ts";
import { PluginsApp } from "./PluginsApp.tsx";

// What the Plugins page's component checks share: a stand-in instance with the plugins and Settings routes, the page drawn inside the shell over it, and the ways to look at what it draws.
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/settings/plugins");
});

export const standOf = (connection = HERE): Stand => ({ connections: [connection], instances: { [connection.name]: { config: modelsConfig() } } });

type Options = Readonly<{ stand?: Stand; plugins?: PluginsStand; settings?: SettingsStand; ready?: boolean }>;

/** The Plugins page inside the shell over the stand-ins; resolves once the plugins have been drawn. */
export async function pageOn({ stand = standOf(), plugins = pluginsOf(), settings = pluginsSettings(), ready = true }: Options = {}) {
  const fetchWith = pluginsFetch(stand, plugins, settings);
  const view = render(<PluginsApp fetchWith={fetchWith} />);
  if (ready) await screen.findByRole("tablist", { name: "Plugin kind" });
  if (ready) await waitFor(() => expect(screen.queryByRole("status", { name: "Loading plugins" })).toBeNull());
  return { ...view, fetchWith, plugins, settings };
}

/** The card of a concern or a Claude plugin, by its name. */
export const card = (name: string): HTMLElement => screen.getByRole("region", { name });

/** The card's header button, which opens it. */
export const head = (name: string): HTMLElement => within(card(name)).getAllByRole("button")[0];

/** The requests the page made that changed something, with their methods and bodies. */
export const posts = (fetchWith: { requests: readonly { method: string; path: string; body?: unknown }[] }) => fetchWith.requests.filter(({ method }) => method === "POST");
