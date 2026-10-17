---
"agent-org": minor
---

The board can be served on your tailnet. `tickets.serve: "tailscale"` serves the page and the worker terminal with `tailscale serve`, on `tickets.servePorts` (`9443` and `9444` by default), and never with Funnel. `start` and `onboard` set the entries up after their checks pass, `doctor` checks them, and `stop` removes only the two entries this feature made, leaving every other serve and Funnel entry on the host alone. The page accepts this machine's MagicDNS name as its `Host` as well as `127.0.0.1`, and the board hands the page the tailnet address of the terminal. Browser pairing is unchanged. Without `tickets.serve`, nothing changes. A11-87.
