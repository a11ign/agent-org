import { SidebarSkeleton } from "../lifecycle/Skeleton.tsx";
import { useShell } from "./ShellProvider.tsx";
import { projectLabel } from "./shell-model.ts";

/** One row of the Projects or the Goals list: a button pressed when it is the one shown, with its count, or none for a project not read yet. */
function FilterButton({ label, count, pressed, onPress }: Readonly<{ label: string; count: number | null; pressed: boolean; onPress: () => void }>) {
  return (
    <button type="button" className="filter-button" aria-pressed={pressed} onClick={onPress}>
      <span className="filter-label">{label}</span>
      {count === null ? null : <span className="filter-count">{count}</span>}
    </button>
  );
}

/**
 * The Tickets page's middle section: the projects the tickets are in, then the goals of the chosen project, read from the tracker through the API. While the tickets load it is
 * the boards' skeleton, and after a failure with nothing read it is nothing; with no tickets both headings stay, Projects lists nothing and Goals lists "All goals" at 0.
 */
export function ProjectsAndGoals() {
  const { tickets, projects, project, chooseProject, goals, goal, chooseGoal } = useShell();
  if (tickets.state === "loading") return <SidebarSkeleton label="Loading projects and goals" />;
  // A read that failed before it ever succeeded has no tickets to count: the page says why, and the sidebar does not claim there are none.
  if (tickets.data === null) return null;
  return (
    <>
      <div className="sidebar-section filter-group filter-group-projects">
        <div className="section-label">Projects</div>
        {projects.map(([name, count]) => (
          <FilterButton key={name} label={projectLabel(name)} count={count} pressed={name === project} onPress={() => chooseProject(name)} />
        ))}
      </div>
      <div className="sidebar-section filter-group">
        <div className="section-label">Goals</div>
        {goals.map((entry) => (
          <FilterButton key={entry.id} label={entry.label} count={entry.count} pressed={entry.id === goal} onPress={() => chooseGoal(entry.id)} />
        ))}
      </div>
    </>
  );
}
