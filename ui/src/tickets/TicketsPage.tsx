import { useEffect, useState } from "react";
import { ANYONE } from "../../../src/ticket-mode/assignee-filter.ts";
import { EmptyState } from "../lifecycle/EmptyState.tsx";
import { ErrorState } from "../lifecycle/ErrorState.tsx";
import { UnreachableFrame } from "../lifecycle/UnreachableFrame.tsx";
import { useShell, type ShellValue } from "../shell/ShellProvider.tsx";
import { PausedBanner, StatusBanner } from "./Banners.tsx";
import { AssigneeGroup, FilterMenu, SearchBox } from "./FilterBar.tsx";
import { QueueBar } from "./QueueBar.tsx";
import { Sections } from "./Sections.tsx";
import { TicketsHeader } from "./TicketsHeader.tsx";
import { TicketsSkeleton } from "./TicketsSkeleton.tsx";
import { countText, emptyPanelOf, everythingOpen, parentsOf, queueOptionsOf, segmentsOf, type QueueOptions } from "./tickets-model.ts";
import { OPEN_MEMORY, OPEN_PARENTS_MEMORY, useRemembered } from "./use-remembered.ts";
import { useBatch, useSelection } from "./use-queue-state.ts";
import { useTicketActions } from "./use-ticket-actions.ts";
import { useFilters, useList, type FilterState, type ListView } from "./use-tickets-page.ts";

const NO_OPTIONS: QueueOptions = { planOffered: false, batch: { model: "", effort: "", plan: false }, custom: false, customLabel: "" };

/** What the instance says when it lists no ticket at all, read once when that is the case; null until it has answered. */
function useInstanceEmptyText(listed: readonly unknown[]): string | null {
  const { client } = useShell();
  const [text, setText] = useState<string | null>(null);
  const needed = listed.length === 0;
  useEffect(() => {
    if (!needed) return;
    let live = true;
    void client.pick().then((answer) => {
      if (live) setText(answer.ok ? answer.data.empty : "No open tickets to list.");
    });
    return () => {
      live = false;
    };
  }, [client, needed]);
  return text;
}

/** The empty panel of the chosen scope, with the board's buttons where the board draws them. */
function EmptyPanelView({ list, writer }: Readonly<{ list: ListView; writer: boolean }>) {
  const { chooseScope, allTickets } = useShell();
  const instanceText = useInstanceEmptyText(allTickets);
  if (list.source === null) return null;
  const panel = emptyPanelOf(list.source, instanceText);
  const actions = panel.offersActions ? (
    <>
      {writer ? <button type="button" className="primary primary-small" disabled>New ticket</button> : null}
      <button type="button" className="ghost" onClick={() => chooseScope(ANYONE)}>Show anyone's tickets</button>
    </>
  ) : undefined;
  return <EmptyState title={panel.title} text={panel.text ?? ""} {...(actions === undefined ? {} : { actions })} />;
}

type RowProps = Readonly<{ filters: FilterState; list: ListView }>;

/** The filter row: the search box, the Assignee group where the instance names assignees, and the dashed Priority, Plan and label buttons. */
function FilterRow({ filters, list }: RowProps) {
  const { config, chooseScope } = useShell();
  const segments = list.source === null ? [] : segmentsOf(list.source);
  return (
    <div className="filter-row">
      <SearchBox value={filters.filters.search} onChange={filters.setSearch} />
      {config?.viewer === undefined ? null : <AssigneeGroup segments={segments} signedIn={config.viewer !== null} onChoose={chooseScope} />}
      {list.menus.map((menu) => <FilterMenu key={menu.id} menu={menu} onChoose={(itemId) => filters.choose(menu, itemId)} />)}
    </div>
  );
}

/** Opens or closes every section and parent, and remembers them as `ui.html`'s Expand all does. */
function useFolding(list: ListView) {
  const open = useRemembered(OPEN_MEMORY);
  const openParents = useRemembered(OPEN_PARENTS_MEMORY);
  const allOpen = everythingOpen(list.sections, open.values, openParents.values);
  const foldAll = () => {
    openParents.replace(allOpen ? new Set() : new Set([...openParents.values, ...parentsOf(list.sections)]));
    open.replace(allOpen ? new Set() : new Set([...open.values, ...list.sections.map(({ status }) => status)]));
  };
  return { open: open.values, openParents: openParents.values, toggleSection: open.toggle, toggleParent: openParents.toggle, allOpen, foldAll };
}

/** Everything the page holds besides what the shell read: the filters, the folding, the selection, the batch's options and the actions. */
function usePage(shell: ShellValue) {
  const filters = useFilters(shell.goal);
  const list = useList(filters);
  const folding = useFolding(list);
  const selection = useSelection();
  const batch = useBatch();
  const selected = shell.allTickets.filter(({ key }) => selection.selected.has(key));
  const options = shell.config === null ? NO_OPTIONS : queueOptionsOf(shell.config, selected, batch);
  const actions = useTicketActions(selection, batch, options);
  return { filters, list, folding, selection, batch, options, actions };
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
    open: folding.open, toggleSection: folding.toggleSection, queue: shell.queue.data,
    row: {
      queue: shell.queue.data, selected: selection.selected, openParents: folding.openParents, showsOwner: list.showsOwner, grillReason: grillReasonOf(shell),
      pick: selection.pick, unpick: selection.unpick, toggleParent: folding.toggleParent, queueChildren: actions.queueChildren, grill: actions.grill,
    },
  };
  return (
    <>
      <Sections sections={list.sections} context={context} />
      {selection.selected.size > 0 && shell.config !== null ? (
        <QueueBar config={shell.config} count={selection.selected.size} options={options} batch={batch} busy={actions.busy} onClear={selection.clear} onQueue={actions.queueSelected} />
      ) : null}
    </>
  );
}

/** The list by the tickets read's state: its skeleton, its empty panel, or its sections. */
function ListByState({ page, shell }: Readonly<{ page: Page; shell: ShellValue }>) {
  const { state } = shell.tickets;
  if (state === "loading") return <TicketsSkeleton />;
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

/**
 * The banner of a failure: the server's sentence for an action it refused, else for a read that failed, with Retry reading again and Dismiss hiding it until the next failure.
 * An instance that cannot be reached is the shell's frame instead, above the last good list.
 */
function useFailure(shell: ShellValue, refusal: string | null, clearRefusal: () => void) {
  const { tickets } = shell;
  const sentence = refusal ?? (tickets.state === "error" ? tickets.refusal : null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (sentence === null) setDismissed(null);
  }, [sentence]);
  if (sentence === null || sentence === dismissed) return null;
  return <ErrorState refusal={sentence} onRetry={() => { clearRefusal(); tickets.refresh(); }} onDismiss={() => { clearRefusal(); setDismissed(sentence); }} />;
}

function TicketsContent() {
  const shell = useShell();
  const page = usePage(shell);
  const failure = useFailure(shell, page.actions.refusal, page.actions.clearRefusal);
  const { tickets, connection, config } = shell;
  const loaded = tickets.state !== "loading" && page.list.source !== null;
  const header = (
    <TicketsHeader
      count={loaded && page.list.source !== null ? countText(page.list.projectTickets.length, page.list.source) : null}
      allOpen={page.folding.allOpen} foldable={tickets.state === "ready"} onFold={page.folding.foldAll} writer={config?.writer !== false}
    />
  );
  const body = <Body page={page} shell={shell} />;
  if (tickets.state === "unreachable") {
    return <>{header}<UnreachableFrame name={connection?.name ?? ""} refusal={tickets.refusal ?? ""}>{body}</UnreachableFrame></>;
  }
  return <>{header}{failure}{body}</>;
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

