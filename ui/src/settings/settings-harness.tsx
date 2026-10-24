import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { config, HERE, PERSONAL, queueOf, type InstanceAnswers, type Stand } from "../../test/fixtures.ts";
import { modelsConfig, settingsFetch, standOf as settingsOf, type SettingsStand } from "../../test/settings/settings-stand.ts";
import type { QueueView } from "../api/types.ts";
import { SettingsApp } from "./SettingsApp.tsx";
import type { SettingsPage } from "../../../src/ticket-mode/settings-view.ts";

// What the Settings page's component checks share: a stand-in instance with the Settings routes, the page drawn inside the shell over it, and the ways to look at what it draws.
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/next/settings/models");
});

/** The instance's reads: a config that offers models and a planner and a writer, and a queue of workers that are started. */
export const instanceOf = (more: InstanceAnswers = {}): InstanceAnswers => ({ config: modelsConfig(), queue: { ...queueOf(), max: 10, paused: false } as unknown as QueueView, ...more });

export const standOf = (instance: InstanceAnswers = instanceOf(), connection = HERE): Stand => ({ connections: [connection], instances: { [connection.name]: instance } });

/** The page of `section` inside the shell, reading from the stand-in; resolves once the settings have been drawn. */
export async function pageOn(section: SettingsPage, { stand = standOf(), state = settingsOf(), ready = true }: Readonly<{ stand?: Stand; state?: SettingsStand; ready?: boolean }> = {}) {
  const fetchWith = settingsFetch(stand, state);
  const view = render(<SettingsApp section={section} fetchWith={fetchWith} />);
  if (ready) {
    await screen.findByText(/^Host file/);
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading models" })).toBeNull());
  }
  return { ...view, fetchWith, state };
}

export const posts = (fetchWith: ReturnType<typeof settingsFetch>, path: string) => fetchWith.requests.filter((request) => request.method === "POST" && request.path.endsWith(path));
export const reads = (fetchWith: ReturnType<typeof settingsFetch>, path: string) => fetchWith.requests.filter((request) => request.method === "GET" && request.path.endsWith(path));
export const rowOf = (key: string): HTMLElement => {
  const row = document.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (row === null) throw new Error(`no row for ${key}`);
  return row;
};
export const keysShown = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-key]")].map((row) => row.dataset.key ?? "");
export const inputOf = (key: string): HTMLInputElement => screen.getByLabelText(key) as HTMLInputElement;
export const section = (name: string): HTMLElement => screen.getByRole("heading", { name }).closest("section") as HTMLElement;
export { config, fireEvent, PERSONAL, screen, waitFor, within };
