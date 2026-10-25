# A11-202: the canvas walk's images (never merged)

Canvas version `1792919148-89e5` (60 boards), read on 2026-10-25.

- `boards/<Board>-<width>.png`: each board rendered locally in Chromium from its own markup and `renderVals` (a stand-in for the canvas runtime), with the same bundled Inter and JetBrains Mono as the build.
- `pairs/<Board>-<width>.png`: the board on the left and the built page's capture (a stand-in instance, `ui/captures/`) on the right, at 1440 and 390 wide.
The pass over the agents host's live data is recorded in the pull request (its images hold the host's real ticket and request text, so they are not published).
