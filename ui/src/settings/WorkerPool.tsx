import { useEffect, useRef, useState } from "react";
import { SaveStateText } from "./SaveStateText.tsx";
import type { Pool } from "./use-pool.ts";

/** The number of workers. It commits on the browser's own `change` (leaving the field, Enter, or a step of its spinner), not on every keystroke, as today's page does. */
function MaxInput({ pool }: Readonly<{ pool: Pool }>) {
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(pool.max === null ? "" : String(pool.max));
  // What the instance holds is what the field shows: after an answer, and after a refusal puts it back.
  useEffect(() => {
    if (pool.maxState.kind !== "saving") setText(pool.max === null ? "" : String(pool.max));
  }, [pool.max, pool.maxState]);
  const { setMax } = pool;
  useEffect(() => {
    const input = field.current;
    const commit = () => setMax(input?.value ?? "");
    input?.addEventListener("change", commit);
    return () => input?.removeEventListener("change", commit);
  }, [setMax]);
  return <input ref={field} id="workers-at-once" className="settings-input settings-input-number" type="number" min={1} step={1} value={text} disabled={pool.max === null || pool.waiting} onChange={(event) => setText(event.target.value)} />;
}

/** "Worker pool": how many runs work at once, and whether workers are started. Both save as they change. */
export function WorkerPool({ pool }: Readonly<{ pool: Pool }>) {
  const paused = pool.paused === true;
  return (
    <section aria-labelledby="h-workers" className="settings-section">
      <h3 id="h-workers" className="settings-section-title">Worker pool</h3>
      <div className="settings-card">
        <div className="settings-card-row">
          <div>
            <label htmlFor="workers-at-once" className="settings-label settings-label-block">Workers at once</label>
            <span className="settings-section-words">Up to this many runs work at the same time. The rest wait in the queue.</span>
          </div>
          <span className="settings-control">
            <SaveStateText state={pool.maxState} />
            <MaxInput pool={pool} />
          </span>
        </div>
        <div className="settings-card-row">
          <div>
            <span className="settings-label settings-label-block">{paused ? "Workers are paused" : "Workers are started"}</span>
            <span className="settings-section-words">While paused, tickets you queue wait until workers are started.</span>
          </div>
          <span className="settings-control">
            <SaveStateText state={pool.pauseState} />
            <button type="button" className="ghost" disabled={pool.paused === null || pool.waiting} onClick={pool.togglePause}>{paused ? "Start workers" : "Pause"}</button>
          </span>
        </div>
      </div>
    </section>
  );
}
