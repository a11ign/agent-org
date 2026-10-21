---
"agent-org": patch
---

`agent-org ticket:capture <route> --size 1280x800` captures a page of the board as a PNG: it starts this checkout's instance and board on free ports from a throwaway host file, pairs a headless browser the way a browser pairs, opens the route at the size, and removes everything it started. `agent-org onboard` installs both Chromium builds, and the system libraries when it can, and `agent-org doctor` fails with the install command for whatever is missing. A worker whose change alters a page of the board captures it, and shows the image in its pull request, when `tickets.capture` is true.
