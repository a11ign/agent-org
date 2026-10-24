import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HERE, standFetch, type Stand } from "../../test/fixtures.ts";
import type { Fetch } from "../api/request.ts";
import { ShellFrame } from "../shell/ShellFrame.tsx";
import { ShellProvider } from "../shell/ShellProvider.tsx";
import { TicketsPage } from "../tickets/TicketsPage.tsx";
import { TICKETS, writerBoard, type Run, type WriterBoard } from "./new-ticket-fixtures.ts";

// What the New ticket checks share: the Tickets page over a stand-in instance that writes tickets, and the ways to look at the dialog and the strip.
export const standOn = ({ instance }: WriterBoard): Stand => ({ connections: [HERE], instances: { here: instance } });

/** The Tickets page inside the shell, reading from `stand`; `wrap` stands between the page and its `fetch`, to hold or watch a call. Resolves once the tickets are drawn. */
export async function pageWith(stand: Stand, { wrap = (base) => base, writes = true }: Readonly<{ wrap?: (base: ReturnType<typeof standFetch>) => Fetch; writes?: boolean }> = {}) {
  const base = standFetch(stand);
  const fetchWith = wrap(base);
  const view = render(
    <ShellProvider fetchWith={fetchWith}>
      <ShellFrame page="tickets">
        <TicketsPage />
      </ShellFrame>
    </ShellProvider>,
  );
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading tickets" })).toBeNull());
  // An instance that writes tickets has its button enabled, and has read its requests, once the page has drawn.
  if (writes) await waitFor(() => expect(screen.getAllByRole("button", { name: "New ticket" }).every((button) => !(button as HTMLButtonElement).disabled)).toBe(true));
  if (writes) await waitFor(() => expect(base.paths.some((path) => path.endsWith("/api/writer"))).toBe(true));
  return { ...view, base };
}

/** The page over a board whose writer has `runs`. */
export const pageOver = (runs: readonly Run[] = [], more: Parameters<typeof writerBoard>[1] = {}, config?: Parameters<typeof writerBoard>[2]) => {
  const board = writerBoard(runs, more, config);
  return pageWith(standOn(board), { writes: config?.writer !== false }).then(async (page) => {
    if (runs.length > 0 && config?.writer !== false) await screen.findAllByRole("region", { name: "New ticket request" });
    return { ...page, board };
  });
};

export const dialog = () => screen.getByRole("dialog", { name: "New ticket" });
export const inDialog = () => within(dialog());
export const openDialog = () => fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
export const typeRequest = (text: string) => fireEvent.change(inDialog().getByLabelText("What is the ticket for?"), { target: { value: text } });
export const writeButton = () => inDialog().getByRole("button", { name: /^(Write ticket|Sending…)$/ }) as HTMLButtonElement;
export const strips = () => screen.queryAllByRole("region", { name: "New ticket request" });
export const textOf = (element: Element | null): string => element?.textContent ?? "";

/** The bodies posted to `/api/writer` itself, not to a run's Stop or Dismiss. */
export const sent = (base: ReturnType<typeof standFetch>) => base.requests.filter(({ method, path }) => method === "POST" && path === "/c/here/api/writer").map(({ body }) => body);

export { TICKETS };
