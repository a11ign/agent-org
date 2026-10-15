// @ts-check
// preload: this process's `fetch` becomes `offlineFetch` (`offline-fetch.ts` says why). `offline-setup.ts` imports it into each test worker, and adds it
// to `NODE_OPTIONS` so every Node process a test starts loads it too, the gate's status worker among them.
//
// A SEPARATE FILE FROM `offline-fetch.ts` BECAUSE ITS WORK HAPPENS ON IMPORT, and `offline-fetch.test.ts` imports the library.
import { offlineFetch } from "./offline-fetch.ts";

globalThis.fetch = offlineFetch(globalThis.fetch);
