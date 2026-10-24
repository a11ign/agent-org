import { useEffect, useState } from "react";
import { ANYONE } from "../../../src/ticket-mode/assignee-filter.ts";
import { EmptyState } from "../lifecycle/EmptyState.tsx";
import { useShell } from "../shell/ShellProvider.tsx";
import { emptyPanelOf, NO_TICKETS_TEXT } from "./tickets-model.ts";
import type { ListView } from "./use-tickets-page.ts";

/** What the instance says when it lists no ticket at all, read once when that is the case; null until it has answered. */
function useInstanceEmptyText(listed: readonly unknown[]): string | null {
  const { client } = useShell();
  const [text, setText] = useState<string | null>(null);
  const needed = listed.length === 0;
  useEffect(() => {
    if (!needed) return;
    let live = true;
    void client.pick().then((answer) => {
      if (live) setText(answer.ok ? answer.data.empty : NO_TICKETS_TEXT);
    });
    return () => {
      live = false;
    };
  }, [client, needed]);
  return text;
}

/** The empty panel of the chosen scope, with the board's buttons where the board draws them. */
export function EmptyPanelView({ list, writer }: Readonly<{ list: ListView; writer: boolean }>) {
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
