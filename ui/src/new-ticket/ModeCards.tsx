import { GRILL_NEEDS_TERMINAL, GRILL_TEXT, type NewTicketForm } from "./new-ticket-model.ts";

type Mode = NewTicketForm["mode"];

/** One card of "How to write it": a radio with its name and what it does, the chosen one in the accent. */
function ModeCard({ mode, chosen, name, text, disabled = false, onChoose }: Readonly<{ mode: Mode; chosen: boolean; name: string; text: string; disabled?: boolean; onChoose: (mode: Mode) => void }>) {
  return (
    <label className={chosen ? "nt-mode nt-mode-chosen" : "nt-mode"}>
      <input type="radio" name="mode" value={mode} checked={chosen} disabled={disabled} onChange={() => onChoose(mode)} />
      <span>
        <span className="nt-mode-name">{name}</span>
        <span className="nt-mode-text">{text}</span>
      </span>
    </label>
  );
}

/** Quick or Grill. Grill is disabled, with the reason in place of its words, on a machine that names no terminal for it. */
export function ModeCards({ mode, grill, onChoose }: Readonly<{ mode: Mode; grill: boolean; onChoose: (mode: Mode) => void }>) {
  return (
    <div role="radiogroup" aria-label="How to write it" className="nt-modes">
      <ModeCard mode="quick" chosen={mode === "quick"} name="Quick" text="The writer files it straight away. No questions." onChoose={onChoose} />
      <ModeCard mode="grill" chosen={mode === "grill"} name="Grill" text={grill ? GRILL_TEXT : GRILL_NEEDS_TERMINAL} disabled={!grill} onChoose={onChoose} />
    </div>
  );
}
