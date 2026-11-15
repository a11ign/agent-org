// @ts-check
// module: a tracker that answers 5xx while a fault is on (A11-439) -- the tracker contract's in-memory fake, wrapped
//
// LINEAR'S 5xx, AS THE PLUGIN THROWS IT. While `fault.on`, every operation of the wrapped tracker rejects with the error `plugins/linear/linear.ts` throws for a 5xx once its own tries are used: `Linear answered 503`, with the
// status as data (tracker contract 1.7), and counts a failed call to Linear in the board's call ledger, as the plugin does. While it is off, every operation is the wrapped tracker's own, and a good call is counted. So with the
// fault off the wrapper is the fake it wraps, and it passes the tracker contract suite as that fake does (`fault-tracker.test.ts` runs the suite on it).
import type { TicketSource } from "../source.ts";
import type { CallLedger } from "../call-outcomes.ts";

/** The status a faulty tracker answers with: Linear's "service unavailable". */
export const FAULT_STATUS = 503;

/** A fault that a scenario turns on and off between the board's passes. */
export type FaultSwitch = { on: boolean };

/** The error a 5xx from Linear is thrown as, after the plugin's own retries: its message and its status as data. PURE. */
export const linearServerError = (status = FAULT_STATUS): Error => Object.assign(new Error(`Linear answered ${status}`), { status });

/**
 * `tracker`, with every operation refused as Linear refuses it while `fault.on` is set, and each call counted in `calls` as a call to Linear. Members that are not functions (`keywords`) are kept as they are. The wrapper
 * holds no state of its own: what the tracker holds is the wrapped one's.
 */
export function faultyTracker<T extends TicketSource>(tracker: T, fault: FaultSwitch, calls: CallLedger): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(tracker)) {
    if (typeof member !== "function") {
      wrapped[name] = member;
      continue;
    }
    wrapped[name] = async (...args: unknown[]): Promise<unknown> => {
      if (fault.on) {
        calls.record("linear", true);
        throw linearServerError();
      }
      calls.record("linear", false);
      return (member as (...given: unknown[]) => unknown).apply(tracker, args);
    };
  }
  return wrapped as T;
}
