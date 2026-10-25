---
"agent-org": patch
---

A test can no longer take a host's tailnet serves off. On 2026-10-25 a test that switched a plugin off reached the real Tailscale plugin and removed the agents host's live board (:9443) and terminal (:9444) serves, twice. Under the test runner the real `exec` now refuses `tailscale` before anything is spawned, unless a test sets `A11Y_TESTS_MAY_RUN_TAILSCALE=1` on purpose. The exposure contract goes to 1.2: `unserve` names the caller's loopback port, and the Tailscale exposure removes an entry only when it proxies there, so a second instance on another port leaves this one's serves alone. A11-279.
