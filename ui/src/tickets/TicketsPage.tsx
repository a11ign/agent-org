import { UnreachableFrame } from "../lifecycle/UnreachableFrame.tsx";
import { useShell, type ShellValue } from "../shell/ShellProvider.tsx";
import { PausedBanner, StatusBanner } from "./Banners.tsx";
import { EmptyPanelView } from "./EmptyPanelView.tsx";
import { FailureBanner } from "./FailureBanner.tsx";
import { FilterRow } from "./FilterRow.tsx";
import { QueueBar } from "./QueueBar.tsx";
import { Sections } from "./Sections.tsx";
import { TicketsHeader } from "./TicketsHeader.tsx";
import { TicketsSkeleton } from "./TicketsSkeleton.tsx";
import { countText, queueOptionsOf, type QueueOptions } from "./tickets-model.ts";
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
      pick: selection.pick, unpick: selection.unpick, toggleParent: folding.toggleParent, queueChildren: actions.queueChildren, grill: actions.grill,
    },
  };
  return (
    <>
      <Sections sections={list.sections} context={context} />
      {selection.selected.size > 0 && shell.config !== null ? (
        <QueueBar config={shell.config} count={selection.selected.size} options={options} batch={batch} busy={actions.busy} onClear={() => { selection.clear(); batch.reset(); }} onQueue={actions.queueSelected} />
      ) : null}
    </>
  );
}

/** The list by the tickets read's state: its skeleton, its empty panel, or its sections. */
function ListByState({ page, shell }: Readonly<{ page: Page; shell: ShellValue }>) {
  const { state } = shell.tickets;
  // The queue says which tickets are already on it, so nothing is offered to be picked until it has been read.
  if (state === "loading" || (shell.queue.data === null && shell.queue.state === "loading")) return <TicketsSkeleton />;
  if (state === "empty") return <EmptyPanelView list={page.list} writer={shell.config?.writer !== false} />;
  return shell.tickets.data === null ? null : <Listing page={page} shell={shell} />;
}

/** The page under its header: the filters, the paused banner, the notice of the last Queue its children, and the list. */
function Body({ page, shell }: Readonly<{ page: Page; shell: ShellValue }>) {
  if (shell.tickets.data === null && shell.tickets.state !== "loading") return null;
  return (
    <>
      <FilterRow filters={page.filters} list={page.list} />
      {shell.queue.data?.paused === true ? <PausedBanner /> : null}
      {page.actions.notice === null ? null : <StatusBanner>{page.actions.notice}</StatusBanner>}
      <ListByState page={page} shell={shell} />
    </>
  );
}

/** The page once the connections are read: the header, the failure or unreachable frame, and the body. */
function TicketsContent() {
  const shell = useShell();
  const page = usePage(shell);
  const { tickets, connection, config } = shell;
  const loaded = tickets.state !== "loading" && page.list.source !== null;
  const header = (
    <TicketsHeader
      count={loaded && page.list.source !== null ? countText(shell.projectTickets.length, page.list.source) : null}
      allOpen={page.folding.allOpen} foldable={page.list.sections.length > 0} onFold={page.folding.foldAll} writer={config?.writer !== false}
    />
  );
  const body = <Body page={page} shell={shell} />;
  if (tickets.state === "unreachable") {
    return <>{header}<UnreachableFrame name={connection?.name ?? ""} refusal={tickets.refusal ?? ""}>{body}</UnreachableFrame></>;
  }
  return <>{header}<FailureBanner refusal={page.actions.refusal} clearRefusal={page.actions.clearRefusal} />{body}</>;
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
