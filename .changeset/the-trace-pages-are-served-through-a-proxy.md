---
"@a11ign/agent-org": patch
---

The trace pages are no longer the node's one file-path Tailscale handler: `host:install` ships `trace-publish-serve.service`, a loopback-only server (`127.0.0.1:8788`, read-only, GET and HEAD, no listing) on the publication directory, and the `8443` tailnet mount is `tailscale serve --bg --https=8443 http://127.0.0.1:8788`, a proxy handler, so an operator can change Funnel mounts without root. The unit restarts on failure and `host:check` asks of it what it asks of the other long-running services (agent-org#1159).
