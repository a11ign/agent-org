import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HERE, OTHER, queueingConfig, standFetch, ticket, type Failure, type InstanceAnswers, type Stand } from "../../test/fixtures.ts";
import { ready, type RunFields } from "../../test/runs/runs-stand.ts";
import type { QueueView, TicketView } from "../api/types.ts";
import type { Page } from "../shell/routes.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";

// What the palette's component checks share (A11-387): a stand-in instance whose tracker searches, a page of the shell over it, and the ways to type into the palette and read its rows.
beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/runs");
});

/** A11-312 as the ticket's scenarios name it: open, unassigned, in agent-org, under the Fleet goal. */
export const A11_312 = ticket({ key: "A11-312", title: "Fleet status reads three worktree hashes", project: "agent-org", assignee: null, goals: ["Fleet"], statusType: "backlog" });
export const A11_298 = ticket({ key: "A11-298", title: "Follow-up to A11-31: label the boxes", project: "a11ign", assignee: OTHER });
export const A11_301 = ticket({ key: "A11-301", title: "Rotate the worktree keys", project: "control" });

/** A run in the queue, as the list sends it: its ticket's key, title and url, and what the board's status reads. */
export const running = (key: string, title: string): RunFields => ({ ticket: { key, title, url: "" }, phase: "running", queuedAt: Date.now(), startedAt: Date.now() });
export const readyRun = (key: string, title: string): RunFields => ready({ key, title, startedAgo: 60_000 });

/** An instance whose tracker searches: `search` answers the words asked, and the queue holds `runs`. Every word asked is kept in `asked`. */
export function searching(search: (text: string) => readonly TicketView[] | Failure, runs: readonly RunFields[] = [], more: InstanceAnswers = {}): Readonly<{ instance: InstanceAnswers; asked: string[] }> {
  const asked: string[] = [];
  const instance: InstanceAnswers = {
    config: queueingConfig({ search: true } as never), tickets: [], queue: { entries: runs, paused: false } as unknown as QueueView, writer: { runs: [] },
    search: (text) => { asked.push(text); return search(text); }, ...more,
  };
  return { instance, asked };
}

export const standOf = (instance: InstanceAnswers): Stand => ({ connections: [HERE], instances: { here: instance } });

/** The shell's frame on `page` over the instance, with an empty page inside it; resolves once the config is read, so the shortcut is live where the tracker searches. */
export async function shellOn(instance: InstanceAnswers, page: Page = "runs") {
  const fetchWith = standFetch(standOf(instance));
  const view = render(
    <ShellProvider fetchWith={fetchWith}>
      <ShellFrame page={page}><div /></ShellFrame>
    </ShellProvider>,
  );
  await waitFor(() => expect(fetchWith.paths.some((path) => path.endsWith("/api/config"))).toBe(true));
  await screen.findByText("Connected");
  return { ...view, fetchWith };
}

export const pressCtrlK = () => fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
export const pressCmdK = () => fireEvent.keyDown(document.body, { key: "k", metaKey: true });
export const palette = () => screen.getByRole("dialog", { name: "Search tickets" });
export const input = () => within(palette()).getByRole("combobox", { name: "Search tickets" });
export const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
export const press = (key: string) => fireEvent.keyDown(input(), { key });
export const pressShifted = (key: string) => fireEvent.keyDown(input(), { key, shiftKey: true });
export const options = () => within(palette()).queryAllByRole("option");
export const optionOf = (key: string): HTMLElement => {
  const found = options().find((option) => option.dataset.key === key);
  if (found === undefined) throw new Error(`no row for ${key}`);
  return found;
};
export const keysListed = () => options().map((option) => option.dataset.key);
export const actionsOf = (key: string): string[] => [...optionOf(key).querySelectorAll(".search-action")].map((action) => action.textContent ?? "");

/** Opens the palette with the sidebar's button, and types `text`; resolves once the tracker's answer is drawn. */
export async function searchFor(text: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Search tickets" }));
  type(text);
  await waitFor(() => expect(within(palette()).getByRole("listbox").getAttribute("aria-busy")).toBe("false"), { timeout: 2000 });
}
