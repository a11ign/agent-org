Every test worker, and every Node process a test starts, runs with an offline `fetch` (`src/offline-fetch.ts`, preloaded by `src/offline-setup.ts`, the second rstest setup file): loopback and `data:` go through, GitHub's status page answers calm, and anything else is refused. `src/offline-fetch.test.ts` reads the library with a fake real `fetch`, and a LIVE case reads this worker's own `fetch` and a child Node process's. The review-depth "ask nobody" cases assert nobody was asked.

Acceptance:
```bash
npx rstest run --config scripts/rstest/rstest.config.ts src/offline-fetch.test.ts src/review-depth.test.ts src/private-tmp.test.ts
```

Consumer-declaration: none -- test infrastructure: a setup file, a preload and their library; no module the tool runs imports them.
