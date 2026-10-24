import { useCallback, useRef, useState, type RefObject } from "react";
import { NO_VIEWER } from "../../../src/ticket-mode/assignee-filter.ts";
import { MenuChevron, SearchIcon } from "./icons.tsx";
import type { Menu, Segment } from "./tickets-model.ts";
import { useDismiss } from "./use-dismiss.ts";

/** The search box: "Filter by key, title or project". */
export function SearchBox({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  return (
    <label className="search">
      <span className="visually-hidden">Filter by key, title or project</span>
      <SearchIcon />
      <input type="text" value={value} placeholder="Filter by key, title or project" onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/** The Assignee group: Mine, Anyone, Unassigned and each other person, with the count on the pressed one. It wraps at narrow widths. */
export function AssigneeGroup({ segments, signedIn, onChoose }: Readonly<{ segments: readonly Segment[]; signedIn: boolean; onChoose: (scope: string) => void }>) {
  return (
    <div role="group" aria-label="Assignee" className="segments" {...(signedIn ? {} : { title: NO_VIEWER })}>
      {segments.map(({ scope, text, pressed, count }) => (
        <button key={scope} type="button" className="segment" aria-pressed={pressed} onClick={() => onChoose(scope)}>
          {text}
          {count === undefined ? null : <span className="segment-count">{count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * One filter: a dashed button that opens a menu in the Run options popover's surface, with the filter's choices as checkable items and how many tickets each holds. A menu
 * that chooses several has checkboxes; the Plan menu chooses one, with radios. Escape and a click outside close it.
 */
export function FilterMenu({ menu, onChoose }: Readonly<{ menu: Menu; onChoose: (itemId: string) => void }>) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="menu-anchor" ref={anchor}>
      <button ref={trigger} type="button" className="ghost ghost-dashed" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        {menu.name}
        <MenuChevron />
      </button>
      {open ? <MenuPanel menu={menu} onChoose={onChoose} close={close} anchor={anchor} trigger={trigger} /> : null}
    </div>
  );
}

type PanelProps = Readonly<{ menu: Menu; onChoose: (itemId: string) => void; close: () => void; anchor: RefObject<HTMLElement | null>; trigger: RefObject<HTMLElement | null> }>;

/** The open menu: its items as native checkboxes or radios, closed by Escape or a click outside. */
function MenuPanel({ menu, onChoose, close, anchor, trigger }: PanelProps) {
  useDismiss(close, anchor, trigger);
  return (
    <div role="group" aria-label={menu.label} className="popover menu-panel">
      {menu.items.map((item) => (
        <label key={item.id} className="menu-item">
          <input type={menu.multiple ? "checkbox" : "radio"} name={menu.id} checked={item.chosen} onChange={() => onChoose(item.id)} />
          <span className="menu-item-text">{item.text}</span>
          {item.count === undefined ? null : <span className="menu-item-count">{item.count}</span>}
        </label>
      ))}
    </div>
  );
}
