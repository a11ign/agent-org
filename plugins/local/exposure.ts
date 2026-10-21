// @ts-check
// module: the local exposure -- the exposure contract (1.1) for a board served on this machine's loopback only (A11-162)
//
// IT SERVES NOTHING AND ASKS NOTHING OF THE MACHINE. The board's page and the instance listen on 127.0.0.1 themselves, and the terminal service on its own port; there is no name for
// the board to answer to, no extra host or origin, and no address for a terminal other than the one the host file stores (`terminal`, which the board hands the page as it stands).
// A caller that asks it to serve is refused by name, which is how the events tunnel learns it needs an exposure that reaches the internet.
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001).
import type { Exposure, PortState, ServeResult } from "../../src/plugins/contracts/exposure.ts";

/** Why this exposure serves nothing: said by each caller that asks it to. */
export const LOOPBACK_ONLY = "local serves on loopback only";

const REFUSED: ServeResult = { status: 1, stdout: "", stderr: LOOPBACK_ONLY, refusal: LOOPBACK_ONLY };
const FREE: PortState = Object.freeze({ kind: "free", proxy: null, funnel: false });

/** The local exposure. */
export function createExposure(): Exposure {
  return {
    machineName: () => Promise.resolve(null),
    hosts: () => [],
    origins: () => [],
    terminal: () => null,
    serve: () => REFUSED,
    unserve: () => REFUSED,
    portState: () => FREE,
    ports: () => null,
    readiness: () => null,
    claim: () => null,
    served: () => [],
  };
}
