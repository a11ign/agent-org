import { useState } from "react";
import { useModalFocus } from "../lifecycle/use-modal-focus.ts";
import { MenuChevron } from "../tickets/icons.tsx";
import { useShell } from "./ShellProvider.tsx";
import { projectLabel } from "./shell-model.ts";

/** One choice of the sheet: a button pressed when it is the one shown, with its count, or none for a project not read yet. */
function Choice({ label, count, pressed, onPress }: Readonly<{ label: string; count: number | null; pressed: boolean; onPress: () => void }>) {
  return (
    <button type="button" className="scope-choice" aria-pressed={pressed} onClick={onPress}>
      <span className="scope-choice-label">{label}</span>
      {count === null ? null : <span className="scope-choice-count">{count}</span>}
    </button>
  );
}

/**
 * The Project and goal dialog (A11-427): the sidebar's Projects and Goals lists, with the same state and handlers (`ProjectsAndGoals`), and Done. A bottom sheet on a phone and a centred panel on a
 * tablet (`shell.css`). The focus is kept inside it, Escape closes it, and a press on the dimmed page beside it closes it too.
 */
function ScopeDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const { projects, project, chooseProject, goals, goal, chooseGoal } = useShell();
  const { dialog, onKeyDown } = useModalFocus(onClose);
  return (
    <div className="sheet-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="scope-title" className="sheet scope-sheet" onKeyDown={onKeyDown}>
        <div className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <strong id="scope-title">Project and goal</strong>
          <button type="button" className="primary" onClick={onClose}>Done</button>
        </div>
        <div className="sheet-body">
          <div className="section-label" id="scope-projects">Projects</div>
          <div role="group" aria-labelledby="scope-projects" className="scope-group">
            {projects.map(([name, count]) => <Choice key={name} label={projectLabel(name)} count={count} pressed={name === project} onPress={() => chooseProject(name)} />)}
          </div>
          <div className="section-label" id="scope-goals">Goals</div>
          <div role="group" aria-labelledby="scope-goals" className="scope-group">
            {goals.map((entry) => <Choice key={entry.id} label={entry.label} count={entry.count} pressed={entry.id === goal} onPress={() => chooseGoal(entry.id)} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A chip under the Tickets header: what it chooses, and what is chosen. */
function Chip({ kind, value, open, onOpen }: Readonly<{ kind: string; value: string; open: boolean; onOpen: () => void }>) {
  return (
    <button type="button" className="scope-chip" aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>
      <span className="scope-chip-kind">{kind}</span>{" "}
      <span className="scope-chip-value">{value}</span>
      <MenuChevron />
    </button>
  );
}

/**
 * The Project and Goal chips under the Tickets header at 1024px and below, where the sidebar's projects and goals are not drawn (A11-427). Both open one dialog. Above 1024px they are not drawn
 * (`shell.css`). Nothing is drawn before the tickets are read, as the sidebar draws its skeleton then.
 */
export function ScopeChips() {
  const { tickets, project, goals, goal } = useShell();
  const [open, setOpen] = useState(false);
  if (tickets.data === null) return null;
  const goalLabel = goals.find(({ id }) => id === goal)?.label ?? "";
  return (
    <>
      <div role="group" aria-label="Scope" className="scope-chips">
        <Chip kind="Project" value={project === null ? "" : projectLabel(project)} open={open} onOpen={() => setOpen(true)} />
        <Chip kind="Goal" value={goalLabel} open={open} onOpen={() => setOpen(true)} />
      </div>
      {open ? <ScopeDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
