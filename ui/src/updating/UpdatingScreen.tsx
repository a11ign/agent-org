import { ticketsHref } from "../shell/routes.ts";
import { screenOf, type Step } from "./update-copy.ts";
import type { UpdateView } from "./update-model.ts";

/** The board's spinner: a track ring and a quarter arc in the accent, turning (`.spin` stops for reduced motion). */
function Spinner() {
  return (
    <svg className="spin updating-icon" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle className="updating-spinner-track" cx="14" cy="14" r="11" strokeWidth="3" />
      <path className="updating-spinner-arc" d="M14 3a11 11 0 0 1 11 11" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** The board's tick, drawn when the board is back. */
function Tick() {
  return (
    <svg className="updating-icon" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle className="updating-tick-ring" cx="14" cy="14" r="12" strokeWidth="2" />
      <path className="updating-tick-mark" d="M8.5 14.5l3.8 3.8 7.2-7.6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StepRow({ step }: Readonly<{ step: Step }>) {
  return (
    <li className={`updating-step updating-step-${step.state}`}>
      <span className="updating-step-ring" />
      <span>{step.text}</span>
    </li>
  );
}

/**
 * The page while the board restarts for an update, on the page that was open (A11-217): the card of `AtomautUpdating`, `AtomautUpdatingBreaking`, `AtomautUpdatingSlow` and `AtomautUpdatingBack`, which the
 * frame draws in the main column in place of the page. The sidebar beside it stays as the last known state. The steps are a story, not progress from the updater.
 */
export function UpdatingScreen({ view }: Readonly<{ view: Exclude<UpdateView, Readonly<{ kind: "none" }>> }>) {
  const screen = screenOf(view);
  return (
    <div role="status" aria-live="polite" className="updating-card">
      <div className="updating-head">
        {screen.working ? <Spinner /> : <Tick />}
        <div className="updating-titles">
          <h1 className="updating-title">{screen.title}</h1>
          <span className="updating-sub">{screen.sub}</span>
        </div>
      </div>
      <ol className="updating-steps">
        {screen.steps.map((step) => (
          <StepRow key={step.text} step={step} />
        ))}
      </ol>
      <div className="updating-runs">{screen.runsNote}</div>
      {screen.slowNote ? (
        <div className="updating-slow">
          <strong className="updating-slow-heading">Taking longer than usual.</strong> This page keeps trying every few seconds. If it does not come back, run <code className="updating-code">agent-org doctor</code> on the host.
        </div>
      ) : null}
      {screen.backLink ? (
        <a className="updating-back-link" href={ticketsHref}>
          Back to Tickets
        </a>
      ) : null}
    </div>
  );
}
