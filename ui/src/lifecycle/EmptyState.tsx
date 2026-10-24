import type { ReactNode } from "react";

/**
 * The boards' empty panel: a dashed frame with a title, a sentence, and room for the page's actions ("New ticket", "Go to Tickets"). The words are the page's;
 * this is only the pattern. It is a plain region, not a status: nothing about it changes while it is shown.
 */
export function EmptyState({ title, text, actions }: Readonly<{ title: string; text: string; actions?: ReactNode }>) {
  return (
    <section className="empty-state">
      <div className="empty-state-title">{title}</div>
      <div className="empty-state-text">{text}</div>
      {actions === undefined ? null : <div className="empty-state-actions">{actions}</div>}
    </section>
  );
}
