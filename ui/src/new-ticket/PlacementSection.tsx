import type { Placement } from "../../../src/ticket-mode/writer-placement.ts";
import type { NewTicketForm, Option, ManualOptions } from "./new-ticket-model.ts";

const AUTO_TEXT = "The writer picks the project, repository, goal and priority from your request. You can change any of them on the ticket afterwards.";
const NOT_SET = "Not set";

/** The Auto and Manual toggle: one radio of two, Auto chosen when the dialog opens. */
function PlacementToggle({ placement, onChoose }: Readonly<{ placement: Placement; onChoose: (placement: Placement) => void }>) {
  return (
    <div role="radiogroup" aria-label="Placement" className="nt-toggle">
      <button type="button" role="radio" aria-checked={placement === "auto"} onClick={() => onChoose("auto")}>Auto</button>
      <button type="button" role="radio" aria-checked={placement === "manual"} onClick={() => onChoose("manual")}>Manual</button>
    </div>
  );
}

/** A select of the Manual grid: "Not set" first, which sends nothing so the writer chooses it, then the options. */
function ChoiceSelect({ label, value, options, onChange }: Readonly<{ label: string; value: string; options: readonly Option[]; onChange: (value: string) => void }>) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{NOT_SET}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

const plain = (values: readonly string[]): Option[] => values.map((value) => ({ value, label: value }));

/** The five choices Manual placement sets, which the writer then uses as given. */
function ManualFields({ form, options, onChange }: Readonly<{ form: NewTicketForm; options: ManualOptions; onChange: (fields: Partial<NewTicketForm>) => void }>) {
  return (
    <div className="nt-fields">
      <ChoiceSelect label="Project" value={form.project} options={plain(options.projects)} onChange={(project) => onChange({ project })} />
      <ChoiceSelect label="Repository" value={form.repo} options={plain(options.repos)} onChange={(repo) => onChange({ repo })} />
      <ChoiceSelect label="Goal" value={form.goal} options={plain(options.goals)} onChange={(goal) => onChange({ goal })} />
      <ChoiceSelect label="Priority" value={form.priority} options={options.priorities} onChange={(priority) => onChange({ priority })} />
      <label className="nt-parent">
        <span>Parent ticket <span className="nt-optional">(optional, makes this a sub-issue)</span></span>
        <input type="text" value={form.parent} placeholder="A11-24" onChange={(event) => onChange({ parent: event.target.value })} />
      </label>
    </div>
  );
}

/** Who places the ticket: the writer (Auto, with its sentence) or the person (Manual, with the five fields). */
export function PlacementSection({ form, options, onChange }: Readonly<{ form: NewTicketForm; options: ManualOptions; onChange: (fields: Partial<NewTicketForm>) => void }>) {
  return (
    <div className="nt-placement">
      <div className="nt-placement-head">
        <span className="nt-placement-title">Placement</span>
        <PlacementToggle placement={form.placement} onChoose={(placement) => onChange({ placement })} />
      </div>
      {form.placement === "auto" ? <p className="nt-auto-text">{AUTO_TEXT}</p> : <ManualFields form={form} options={options} onChange={onChange} />}
    </div>
  );
}
