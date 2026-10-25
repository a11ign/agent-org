import type { ConfigView } from "../api/types.ts";
import { SaveStateText } from "./SaveStateText.tsx";
import type { ChoicePart, Choices } from "./use-choices.ts";

type Kind = "model" | "effort";

type Group = Readonly<{ id: string; title: string; words: string; model: ChoicePart; effort: ChoicePart }>;

const NEW_RUNS: Group = {
  id: "new-runs", title: "New runs", model: "model", effort: "effort",
  words: "The default for tickets you queue. The Tickets queue bar can choose otherwise for one batch.",
};
const PLANNING: Group = {
  id: "planning", title: "Planning", model: "planModel", effort: "planEffort",
  words: "A ticket queued with Plan first is planned on these before it runs. Planning decides for you, so it usually wants the most capable model.",
};
const WRITER: Group = {
  id: "writer", title: "Ticket writer", model: "writerModel", effort: "writerEffort",
  words: "A new-ticket request is written on these. Until one is chosen here, the host file's is used, and a choice here wins until it is set back to the host default.",
};

/** One select that saves as it changes, with its quiet state beside it. The writer's first option clears the choice, so it names the host file's value that then applies. */
function ChoiceSelect({ id, kind, part, options, hostDefault, choices, disabled }: Readonly<{ id: string; kind: Kind; part: ChoicePart; options: readonly string[]; hostDefault: string | null; choices: Choices; disabled: boolean }>) {
  return (
    <div className="settings-card-row">
      <label htmlFor={id} className="settings-label">{kind === "model" ? "Model" : "Effort"}</label>
      <span className="settings-control">
        <SaveStateText state={choices.state(part)} />
        <select id={id} className="settings-select" value={choices.value(part)} disabled={disabled} onChange={(event) => choices.change(part, event.target.value)}>
          {hostDefault === null ? null : <option value="">Host default: {hostDefault}</option>}
          {options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </span>
    </div>
  );
}

function ChoiceGroup({ group, config, choices, writer, disabled }: Readonly<{ group: Group; config: ConfigView; choices: Choices; writer: boolean; disabled: boolean }>) {
  const hostDefault = (kind: Kind): string | null => (writer ? (config.writerDefault?.[kind] ?? "") : null);
  return (
    <section aria-labelledby={`h-${group.id}`} className="settings-section">
      <div>
        <h3 id={`h-${group.id}`} className="settings-section-title">{group.title}</h3>
        <p className="settings-section-words">{group.words}</p>
      </div>
      <div className="settings-card">
        <ChoiceSelect id={`${group.id}-model`} kind="model" part={group.model} options={config.models} hostDefault={hostDefault("model")} choices={choices} disabled={disabled} />
        <ChoiceSelect id={`${group.id}-effort`} kind="effort" part={group.effort} options={config.efforts} hostDefault={hostDefault("effort")} choices={choices} disabled={disabled} />
      </div>
    </section>
  );
}

/**
 * "Defaults for new work": the model and effort of new runs, of planning (where a planner is configured) and of the ticket writer (where a writer is). They save as they change, through
 * `/api/choice`, and never go through the review of the host file. `disabled` holds them while the config is not the instance's own answer yet.
 */
export function ChoiceSection({ config, choices, disabled = false }: Readonly<{ config: ConfigView; choices: Choices; disabled?: boolean }>) {
  return (
    <>
      <div className="settings-divider">
        <h2 className="settings-heading">Defaults for new work</h2>
        <p className="settings-section-words">These save as you change them. A run already on the queue keeps its own.</p>
      </div>
      <ChoiceGroup group={NEW_RUNS} config={config} choices={choices} writer={false} disabled={disabled} />
      {config.planner ? <ChoiceGroup group={PLANNING} config={config} choices={choices} writer={false} disabled={disabled} /> : null}
      {config.writer ? <ChoiceGroup group={WRITER} config={config} choices={choices} writer disabled={disabled} /> : null}
    </>
  );
}
