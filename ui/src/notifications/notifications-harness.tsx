import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { standFetch, type InstanceAnswers } from "../../test/fixtures.ts";
import type { Fetch } from "../api/request.ts";
import { FILED, REQUEST, writerBoard, writerRun, type Run, type WriterBoard } from "../new-ticket/new-ticket-fixtures.ts";
import { standOn } from "../new-ticket/new-ticket-harness.tsx";
import type { Page } from "../shell/routes.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";

// What the notification checks share: a page inside the shell over a stand-in instance that writes tickets, and the panel's parts.

export { REQUEST, FILED };

const MINUTE_MS = 60_000;

/** A request that finished `minutes` ago. */
export const finished = (fields: Partial<Run> & Readonly<{ minutes?: number }> = {}): Run => {
  const { minutes = 2, ...rest } = fields;
  return writerRun({ phase: "finished", status: "done", finishedAt: Date.now() - minutes * MINUTE_MS, tickets: [FILED], ...rest });
};

export const failedRun = (fields: Partial<Run> & Readonly<{ minutes?: number }> = {}): Run => finished({ status: "failed", failure: "The brief names no team", tickets: [], ...fields });

/** `post` for a board that keeps its runs: a dismiss removes that run, Clear all removes every finished one, and the answer is the runs left. */
export const keeping = (view: WriterBoard["view"]): InstanceAnswers["post"] => (path, body) => {
  const one = /\/api\/writer\/([^/]+)\/dismiss$/.exec(path);
  if (one !== null) view.runs = view.runs.filter((run) => run.id !== one[1]);
  if (path === "/api/writer/dismiss-finished") view.runs = view.runs.filter((run) => run.phase !== "finished" || !(body as { ids: string[] }).ids.includes(run.id));
  return { runs: view.runs };
};

/** Stands between the page and its `fetch`, to hold or watch a call. */
type Wrap = (base: ReturnType<typeof standFetch>) => Fetch;

/** A page of the shell, with a ticket search to hold the focus, over a board whose writer lists `runs`. `view` is what the board answers next. */
export async function pageIn(page: Page, runs: readonly Run[] = [], more: Parameters<typeof writerBoard>[1] = (view) => ({ post: keeping(view) }), wrap: Wrap = (fetchWith) => fetchWith) {
  const board = writerBoard(runs, more);
  const base = standFetch(standOn(board));
  const view = render(
    <ShellProvider fetchWith={wrap(base)}>
      <ShellFrame page={page}>
        <input aria-label="Search tickets" />
      </ShellFrame>
    </ShellProvider>,
  );
  await waitFor(() => expect(base.paths.some((path) => path.endsWith("/api/writer"))).toBe(true));
  await waitFor(() => expect(screen.getByRole("button", { name: /^Notifications, \d+$/ })).toBeTruthy());
  return { ...view, base, board };
}

/** The page with its panel open, once the bell counts the finished requests the board lists. */
export async function panelOver(runs: readonly Run[], more?: Parameters<typeof writerBoard>[1], page: Page = "tickets", wrap?: Wrap) {
  const opened = await pageIn(page, runs, more, wrap);
  const count = runs.filter((run) => run.phase === "finished").length;
  await waitFor(() => expect(screen.getByRole("button", { name: `Notifications, ${count}` })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: `Notifications, ${count}` }));
  return opened;
}

export const bell = () => screen.getByRole("button", { name: /^Notifications, \d+$/ });
export const panel = () => screen.getByRole("dialog", { name: "Notifications" });
export const inPanel = () => within(panel());
export const openPanel = () => fireEvent.click(bell());
export const items = () => within(panel()).queryAllByRole("listitem").filter((item) => item.classList.contains("notification"));
export const textOf = (element: Element | null | undefined): string => element?.textContent ?? "";

/** Reads the requests again, as the poll does every 5 s, once the board's runs have changed. */
export async function readAgain(until: () => void): Promise<void> {
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(until);
}
