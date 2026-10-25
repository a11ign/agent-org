import { useState } from "react";
import { NewTicket } from "../new-ticket/NewTicket.tsx";
import { useShell, type ShellValue } from "../shell/ShellProvider.tsx";
import { HeldBanner, PausedBanner, StatusBanner } from "./Banners.tsx";
import { EmptyPanelView } from "./EmptyPanelView.tsx";
import { FailureBanner } from "./FailureBanner.tsx";
import { FilterRow } from "./FilterRow.tsx";
import { QueueBar } from "./QueueBar.tsx";
import { Sections } from "./Sections.tsx";
import { TicketsHeader } from "./TicketsHeader.tsx";
import { TicketsUnreachable } from "./TicketsUnreachable.tsx";
import { TicketsSkeleton } from "./TicketsSkeleton.tsx";
import { countText, planPatternOf, queueOptionsOf, type QueueOptions } from "./tickets-model.ts";
import { useFolding } from "./use-folding.ts";
import { useQueueNow } from "./use-queue-now.ts";
import { useBatch, useSelection } from "./use-queue-state.ts";
import { useTicketActions } from "./use-ticket-actions.ts";
import { useFilters, useList } from "./use-tickets-page.ts";

const NO_OPTIONS: QueueOptions = { planOffered: false, batch: { model: "", effort: "", plan: false }, custom: false, customLabel: "" };

/** Everything the page holds besides what the shell read: the filters, the folding, the selection, the batch's options and the actions. */
function usePage(shell: ShellValue) {
  const filters = useFilters(shell.goal);
  const list = useList(filters);
  const folding = useFolding(list);
  const selection = useSelection();
  const batch = useBatch();
  const selected = shell.allTickets.filter(({ key }) => selection.selected.has(key));
  const options = shell.config === null ? NO_OPTIONS : queueOptionsOf(shell.config, selected, batch);
  const { queue, learn } = useQueueNow();
  const actions = useTicketActions({ selection, batch, options, learn });
  return { filters, list, folding, selection, batch, options, actions, queue };
}

type Page = ReturnType<typeof usePage>;

/** Why Grill cannot start on this machine, in `ui.html`'s words, or null when it can. */
function grillReasonOf(shell: ShellValue): string | null {
  if (shell.config?.writer !== true) return "this machine names no tickets.writer, so it writes no tickets: name one in the host file";
  return shell.config.writerGrill ? null : "Grill needs a terminal: name tickets.terminal in the host file";
}

/** The sections, and the queue bar while tickets are selected. */
function Listing({ page, shell }: Readonly<{ page: Page; shell: ShellValue }>) {
  const { list, folding, selection, actions, batch, options } = page;
  const context = {
    open: folding.open, toggleSection: folding.toggleSection, queue: page.queue,
    row: {
      queue: page.queue, selected: selection.selected, openParents: folding.openParents, showsOwner: list.showsOwner, grillReason: grillReasonOf(shell),
      plan: planPatternOf(shell.config), planUniverse: [...shell.allTickets, ...shell.contextParents],
      pick: selection.pick, unpick: selection.unpick, toggleParent: folding.toggleParent, queueChildren: actions.queueChildren, grill: actions.grill, paused: shell.unreachable !== null,
    },
  };
  return (
    <>
      <Sections sections={list.sections} context={context} />
      {selection.selected.size > 0 && shell.config !== null ? (
        <QueueBar config={shell.config} count={selection.selected.size} options={options} batch={batch} busy={actions.busy} paused={shell.unreachable !== null} onClear={() => { selection.clear(); batch.reset(); }} onQueue={actions.queueSelected} />
      ) : null}
    </>
  );
}

/** The list by the tickets read's state: its skeleton, its empty panel, or its sections. */
function ListByState({ page, shell, onNewTicket }: Readonly<{ page: Page; shell: ShellValue; onNewTicket?: () => void }>) {
  const { state } = shell.tickets;
  // The queue says which tickets are already on it, so nothing is offered to be picked until it has been read.
  if (state === "loading" || (shell.queue.data === null && shell.queue.state === "loading")) return <TicketsSkeleton />;
  if (state === "empty") return <EmptyPanelView list={page.list} writer={shell.config?.writer !== false} {...(onNewTicket === undefined ? {} : { onNewTicket })} />;
  return shell.tickets.data === null ? null : <Listing page={page} shell={shell} />;
}

/** The page under its header: the filters, the paused banner, the notice of the last Queue its children, and the list. */
function Body({ page, shell, onNewTicket }: Readonly<{ page: Page; shell: ShellValue; onNewTicket?: () => void }>) {
  if (shell.tickets.data === null && shell.tickets.state !== "loading") return null;
  return (
    <>
      <FilterRow filters={page.filters} list={page.list} />
      <HeldBanner held={shell.queue.data?.held} />
      {shell.queue.data?.paused === true ? <PausedBanner /> : null}
      {page.actions.notice === null ? null : <StatusBanner>{page.actions.notice}</StatusBanner>}
      <ListByState page={page} shell={shell} {...(onNewTicket === undefined ? {} : { onNewTicket })} />
    </>
  );
}

/** The page once the connections are read: the header, the unreachable frame (or the failure banner), and the body. */
function TicketsContent() {
  const shell = useShell();
  const page = usePage(shell);
  const { tickets, connection, config, unreachable } = shell;
  const loaded = tickets.state !== "loading" && page.list.source !== null;
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  // New ticket needs an instance that writes tickets and answers: it opens nothing before the config is read, and nothing while the connection is paused.
  const writing = config?.writer === true;
  const openNewTicket = writing && unreachable === null ? () => setNewTicketOpen(true) : undefined;
  const header = (
    <TicketsHeader
      count={loaded && page.list.source !== null ? countText(shell.projectTickets.length, page.list.source) : null}
      allOpen={page.folding.allOpen} foldable={page.list.sections.length > 0} onFold={page.folding.foldAll} writer={config?.writer !== false}
      {...(openNewTicket === undefined ? {} : { onNewTicket: openNewTicket })}
      pausedFor={unreachable === null ? null : (connection?.name ?? "")} lastKnown={unreachable !== null && tickets.data !== null}
    />
  );
  const body = <Body page={page} shell={shell} {...(openNewTicket === undefined ? {} : { onNewTicket: openNewTicket })} />;
  return (
    <>
      {header}
      {/* Outside the unreachable frame, which swaps its element when the connection drops or returns: a request held in what it wraps would be lost with it. */}
      {writing && config !== null ? <NewTicket config={config} paused={unreachable === null ? null : (connection?.name ?? "")} open={newTicketOpen} onClose={() => setNewTicketOpen(false)} /> : null}
      <TicketsUnreachable>
        <FailureBanner refusal={page.actions.refusal} clearRefusal={page.actions.clearRefusal} />
        {body}
      </TicketsUnreachable>
    </>
  );
}

/** Until the connections are read the page is its header over the board's skeleton, which needs nothing the browser remembers. */
function Pending() {
  return (
    <>
      <TicketsHeader count={null} allOpen={false} foldable={false} onFold={() => undefined} writer />
      <TicketsSkeleton />
    </>
  );
}

/** The Tickets page: the list of what is open, its filters, and the queue bar. */
export function TicketsPage() {
  return useShell().connectionsReady ? <TicketsContent /> : <Pending />;
}
