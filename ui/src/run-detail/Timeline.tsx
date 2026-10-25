import type { TimelineRow } from "./run-timeline-model.ts";

/** "Timeline": what happened to the run, newest first, each with a coloured dot, its words and when. Not drawn for a run with no event. */
export function Timeline({ rows }: Readonly<{ rows: readonly TimelineRow[] }>) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="h-time" className="detail-section">
      <h2 id="h-time" className="detail-heading">Timeline</h2>
      <ol className="timeline">
        {rows.map(({ text, when, tone }, index) => (
          <li key={`${index}-${text}`} className="timeline-row">
            <span className={`timeline-dot timeline-dot-${tone}`} />
            <div className="timeline-text">
              <div>{text}</div>
              <div className="timeline-when">{when}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
