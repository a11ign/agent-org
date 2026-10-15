---
"@a11ign/agent-org": minor
---

A host can expose the event receiver to GitHub: `events.tunnel: "tailscale-funnel"` ships the `event-tunnel` unit, which serves the receiver's loopback port at `events.publicUrl` over Tailscale Funnel (`none`, the default, ships nothing; the revert is that one word and `host:install`). A `poll` host that opens the funnel also runs the receiver, so the feed is proven before the gate reads it; `source` is not changed by it. `node src/event-tunnel.ts register` creates the webhook secret file (mode 600, never replaced, never printed) and sets the scheduler App's webhook URL and secret by the App's own JWT; `deliveries` lists the App's recent deliveries. a11ign/a11ign#5197, the last mile of #5043.
