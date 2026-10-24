import type { KeyboardEvent } from "react";

export type Tab = "integrations" | "claude";

const TABS: readonly Readonly<{ id: Tab; label: string }>[] = [
  { id: "integrations", label: "Integrations" },
  { id: "claude", label: "Claude plugins" },
];

export const tabId = (tab: Tab): string => `plugins-tab-${tab}`;
export const panelId = (tab: Tab): string => `plugins-panel-${tab}`;

/**
 * The two kinds of plugin, as tabs: the integrations agent-org runs and the Claude plugins its workers load. A count is blank while the plugins are being read. The arrow keys move between the
 * tabs, as a tablist does.
 */
export function PluginTabs({ tab, counts, onChoose }: Readonly<{ tab: Tab; counts: Readonly<Record<Tab, number | null>>; onChoose: (tab: Tab) => void }>) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = TABS[(TABS.findIndex(({ id }) => id === tab) + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].id;
    onChoose(next);
    document.getElementById(tabId(next))?.focus();
  };
  return (
    <div role="tablist" aria-label="Plugin kind" className="plugin-tabs" onKeyDown={onKeyDown}>
      {TABS.map(({ id, label }) => (
        <button key={id} id={tabId(id)} type="button" role="tab" aria-selected={tab === id} aria-controls={panelId(id)} tabIndex={tab === id ? 0 : -1}
          className={`plugin-tab-button${tab === id ? " plugin-tab-button-on" : ""}`} onClick={() => onChoose(id)}>
          {label}
          {counts[id] === null ? null : <span className="plugin-tab-count">{counts[id]}</span>}
        </button>
      ))}
    </div>
  );
}
