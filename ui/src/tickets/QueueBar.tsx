import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { batchChoice, batchOverride, queueLabel } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import type { ConfigView } from "../api/types.ts";
import { settingsSectionHref } from "../shell/routes.ts";
import { OptionsIcon } from "./icons.tsx";
import type { QueueOptions } from "./tickets-model.ts";
import type { BatchState } from "./use-queue-state.ts";
import { useDismiss } from "./use-dismiss.ts";

type PopoverProps = Readonly<{ config: ConfigView; options: QueueOptions; batch: BatchState; close: () => void; anchor: RefObject<HTMLElement | null>; cog: RefObject<HTMLElement | null> }>;

/** A labelled select of the popover: the model or the effort, from the choices the config names. */
function ChoiceSelect({ label, value, choices, onChange }: Readonly<{ label: string; value: string; choices: readonly string[]; onChange: (value: string) => void }>) {
  return (
    <label className="popover-field">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    </label>
  );
}

/**
 * The Run options popover: the controls the Pick footer has, for this batch only. Plan first is offered while a selected ticket has no plan and the machine plans; Model and
 * Effort hold the batch's choice over the defaults; Change defaults goes to Settings; Reset puts the batch back on the defaults and ticks Plan first again.
 */
function RunOptions({ config, options, batch, close, anchor, cog }: PopoverProps) {
  useDismiss(close, anchor, cog);
  const { choice } = config;
  const change = (part: "model" | "effort", value: string) => batch.setOverride(batchOverride(choice, { ...batchChoice(choice, batch.override), [part]: value }));
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => dialog.current?.focus(), []);
  return (
    <div ref={dialog} tabIndex={-1} role="dialog" aria-label="Run options" className="popover run-options">
      <div className="popover-title">Run options <span className="popover-title-note">· this batch only</span></div>
      {options.planOffered ? (
        <label className="popover-check">
          <input type="checkbox" checked={batch.planFirst} onChange={(event) => batch.setPlanFirst(event.target.checked)} />
          Plan first <span className="popover-muted">({choice.planModel} · {choice.planEffort})</span>
        </label>
      ) : null}
      <ChoiceSelect label="Model" value={options.batch.model} choices={config.models} onChange={(value) => change("model", value)} />
      <ChoiceSelect label="Effort" value={options.batch.effort} choices={config.efforts} onChange={(value) => change("effort", value)} />
      <div className="popover-foot">
        <a className="popover-link" href={settingsSectionHref("models")}>Change defaults</a>
        <button type="button" className="ghost ghost-small" onClick={() => { batch.setOverride({}); batch.setPlanFirst(true); }}>Reset</button>
      </div>
    </div>
  );
}

type BarProps = Readonly<{
  config: ConfigView;
  count: number;
  options: QueueOptions;
  batch: BatchState;
  busy: boolean;
  onClear: () => void;
  onQueue: () => void;
}>;

/**
 * The bar that shows while tickets are selected: how many, Clear, the Custom pill while the batch differs from the default, the Options cog that opens the popover, and Queue. It sticks
 * to the bottom of the page.
 */
export function QueueBar({ config, count, options, batch, busy, onClear, onQueue }: BarProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const cog = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div role="region" aria-label="Queue selected tickets" className="queue-bar">
      <span className="queue-bar-count">{count} selected</span>
      <button type="button" className="ghost ghost-quiet" onClick={onClear}>Clear</button>
      <div className="queue-bar-spacer" />
      {options.custom ? <span className="pill-tag pill-tag-warn">Custom · {options.customLabel}</span> : null}
      <div className="run-options-anchor" ref={anchor}>
        <button ref={cog} type="button" className="ghost" aria-label="Run options" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
          <OptionsIcon />
          Options
        </button>
        {open ? <RunOptions config={config} options={options} batch={batch} close={close} anchor={anchor} cog={cog} /> : null}
      </div>
      <button type="button" className="primary" disabled={busy} onClick={onQueue}>{queueLabel(count)}</button>
    </div>
  );
}
