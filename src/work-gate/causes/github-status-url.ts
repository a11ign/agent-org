// @ts-check
// module: where the gate reads GitHub's own status. A leaf that imports nothing: the gate's incident cause reads it, and so does the test suite's offline
// `fetch` (`src/offline-fetch.ts`), which is preloaded into every Node process a test starts and must load nothing more.

/** GitHub's status page summary, which the gate asks once a tick (#3723). */
export const GITHUB_STATUS_URL = "https://www.githubstatus.com/api/v2/summary.json";
