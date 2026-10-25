import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HERE, queueingConfig, queueOf, standFetch, ticket, type InstanceAnswers, type Stand } from "../../test/fixtures.ts";
import type { QueueView, TicketView } from "../api/types.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { TicketsPage } from "./TicketsPage.tsx";

// What the Tickets page's component checks share: a stand-in instance, the page drawn inside the shell over it, and the ways to look at the rows.
beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/tickets");
});

export const BACKLOG = [
  ticket({ key: "A11-1", title: "Fix the fleet", priority: 1, goals: ["Fleet"], url: "https://tracker.example/A11-1" }),
  ticket({ key: "A11-2", title: "Clean a boundary", priority: 3, goals: ["Clean boundaries"] }),
  ticket({ key: "A11-3", title: "Label the boxes", goals: ["Fleet"] }),
];

/** An instance's answers: the config of a machine that queues and plans, the tickets given, a queue with nothing on it that is not paused, and no new-ticket request (the page reads them beside the tickets). */
export const answers = (tickets: readonly TicketView[] = BACKLOG, more: InstanceAnswers = {}): InstanceAnswers => ({
  config: queueingConfig(), tickets, queue: { ...queueOf(), paused: false } as unknown as QueueView, writer: { runs: [] }, ...more,
});
export const standOf = (instance: InstanceAnswers = answers()): Stand => ({ connections: [HERE], instances: { here: instance } });

/** The Tickets page inside the shell, reading from a stand-in instance; resolves once the first list has been drawn. */
export async function pageOn(stand: Stand) {
  const fetchWith = standFetch(stand);
  const view = render(
    <ShellProvider fetchWith={fetchWith}>
      <ShellFrame page="tickets">
        <TicketsPage />
      </ShellFrame>
    </ShellProvider>,
  );
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading tickets" })).toBeNull());
  return { ...view, fetchWith };
}

/** The page with its Backlog section open, as the board draws it. */
export async function openPage(stand: Stand = standOf()) {
  const page = await pageOn(stand);
  const closed = screen.queryByRole("button", { name: "Expand Backlog" });
  if (closed !== null) fireEvent.click(closed);
  return page;
}

export const textOf = (element: Element | null): string => element?.textContent ?? "";
export const rowOf = (key: string): HTMLElement => {
  const row = document.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (row === null) throw new Error(`no row for ${key}`);
  return row;
};
export const keysShown = (): string[] => [...document.querySelectorAll<HTMLElement>("[data-key]")].map((row) => row.dataset.key ?? "");
export const tick = (key: string) => fireEvent.click(screen.getByLabelText(`Select ${key}`));
export const bar = () => screen.getByRole("region", { name: "Queue selected tickets" });
export const posts = (fetchWith: ReturnType<typeof standFetch>, path: string) => fetchWith.requests.filter((request) => request.method === "POST" && request.path.endsWith(path));
