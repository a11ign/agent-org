---
"@a11ign/agent-org": patch
---

`event-tunnel.ts up` and `down` read `tailscale serve status --json` first and change nothing when the receiver's Funnel path is already as asked, and read it again afterwards and fail when it is not (a11ign/a11ign#5197). tailscaled refuses a non-root change to the serve config whenever the config holds a file-path handler anywhere in it, so a path mounted once by root can now keep the tunnel unit active, and a refused `down` is no longer reported as done.
