// @ts-check
// rstest setupFile, after `private-tmp-setup.ts`: keeps each test file, and each Node process it starts, off the network (`offline-fetch.ts` says why)
//
// A test that stubs `fetch` itself still wins: it replaces `globalThis.fetch` after this, and a stub it preloads through `NODE_OPTIONS` (agent-org#1178)
// comes after this preload, so it loads last.
import "./offline-fetch-preload.ts";

process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${new URL("./offline-fetch-preload.ts", import.meta.url).href}`].filter(Boolean).join(" ");
