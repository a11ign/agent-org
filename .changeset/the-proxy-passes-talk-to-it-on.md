---
"agent-org": patch
---

The page's proxy passes Talk to it on to an instance. Its allow-list of run actions (`remote-proxy.ts`) did not name `talk`, so the button answered "POST /api/queue/PA-492/talk is not passed on to an instance" through the page, while the board's own route worked. A new test reads every action the page labels and checks the proxy passes it on, so the next action cannot be left out.
