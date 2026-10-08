---
"agent-org": minor
---

Something now runs `host-kernel.mjs --reboot` (a11ign/a11ign#4053, follow-up to #4046): the shipped `kernel-reboot.service` (a oneshot whose `ExecStart` is exactly `--reboot`, with a 45-minute start bound for the 30-minute drain) and `kernel-reboot.timer` (`OnCalendar=*-*-* 05:30:00 Europe/London`, `ceo`'s hour, daily). The timer has NO `Requires=` on the service, so `host:install`'s `enable --now` cannot reboot the host, and no `Persistent=`, so a host that was down at 05:30 does not reboot at boot. On a day with no newer kernel installed the run is a no-op. The drain now excuses the reboot service's own `activating` state, which it counted as a host job and would have held every scheduled run for the whole drain bound.
