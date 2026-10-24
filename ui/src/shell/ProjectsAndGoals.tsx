import { SidebarSkeleton } from "../lifecycle/Skeleton.tsx";
import { useShell } from "./ShellProvider.tsx";

/** One row of the Projects or the Goals list: a button pressed when it is the one shown, with its count. */
function FilterButton({ label, count, pressed, onPress }: Readonly<{ label: string; count: number; pressed: boolean; onPress: () => void }>) {
  return (
    <button type="button" className="filter-button" aria-pressed={pressed} onClick={onPress}>
      <span className="filter-label">{label}</span>
      <span className="filter-count">{count}</span>
    </button>
  );
}

/**
 * The Tickets page's middle section: the projects the tickets are in, then the goals of the chosen project, read from the tracker through the API. While the tickets load it is
 * the boards' skeleton; with no tickets both headings stay, Projects lists nothing and Goals lists "All goals" at 0.
 */
export function ProjectsAndGoals() {
  const { tickets, projects, project, chooseProject, goals, goal, chooseGoal } = useShell();
  if (tickets.state === "loading") return <SidebarSkeleton label="Loading projects and goals" />;
  return (
    <>
      <div className="sidebar-section filter-group filter-group-projects">
        <div className="section-label">Projects</div>
        {projects.map(([name, count]) => (
          <FilterButton key={name} label={name} count={count} pressed={name === project} onPress={() => chooseProject(name)} />
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
