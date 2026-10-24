import { StepMarkIcon } from "./icons.tsx";
import type { StepRow } from "./run-detail-model.ts";

/** "What it will do": the worker's own steps, the one it is on highlighted. Drawn only while the run has steps. */
export function Steps({ steps }: Readonly<{ steps: readonly StepRow[] }>) {
  if (steps.length === 0) return null;
  return (
    <section aria-labelledby="h-steps" className="detail-section">
      <h2 id="h-steps" className="detail-heading">What it will do <span className="detail-heading-note">· from the worker's own note</span></h2>
      <ol className="steps">
        {steps.map(({ n, text, mark }) => (
          <li key={n} className={`step step-${mark}`}>
            <span className="step-mark"><StepMarkIcon mark={mark} /></span>
            <div className="step-text">{text}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}
