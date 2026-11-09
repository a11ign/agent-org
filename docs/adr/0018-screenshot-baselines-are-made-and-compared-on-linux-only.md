# Screenshot baselines are made and compared on Linux Chromium only

The UI's page checks capture each responsive screen and compare it, pixel by pixel within a named threshold, with a baseline PNG committed under `ui/captures/responsive/`. Baselines are written only on Linux, in the Chromium build `playwright-core` pins, with `UPDATE_CAPTURES=1`. On any other OS the comparison is skipped with a printed note, while the overflow and hit-area checks still run. CI's `ui` job runs on Ubuntu and enforces it.

We chose this because font anti-aliasing differs between Linux and macOS even with the bundled fonts. A baseline made on one OS would fail on the other, and baselines kept for each OS would go stale because CI checks only the Linux ones.

## Considered options

- One baseline per OS (`-linux.png`, `-darwin.png`): twice the PNGs, and the macOS set is never checked.
- Comparing in CI only, with baselines downloaded from a CI artifact: it can't be refreshed locally.
- No comparison, only committed captures, as the repo did before: it records the pages but catches no regression.
