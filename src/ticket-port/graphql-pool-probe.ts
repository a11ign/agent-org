// THE GRAPHQL POOL'S PROBE, the call that names the pool, its budget and its reset in the headers of its answer (`api-pool.ts` reads them). The command is the GitHub plugin's (A11-160, step 9), behind the code host's `rows`;
// this is core's delegate, asked when a pool is read and not when the module loads, since the code host is reached by `rows()`. `api-pool.ts` stays a leaf and sends no probe of its own: its caller hands it this one.
import { rows } from "../plugins/rows.ts";

/** The probe as arguments, for a caller that sends it through a runner of its own (the ledger's retry sends it as the queue's account). */
export const graphqlPoolProbe = (): readonly string[] => rows().graphqlPoolProbeArgs();
