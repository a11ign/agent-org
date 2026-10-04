---
"agent-org": patch
---

`host:install` no longer starts a timer whose window ended on purpose: a timer systemd reports `disabled` whose window record holds a `stop` row (no newer arm marker) is written like every unit, gets no `enable --now`, and is reported `SKIPPED <unit> -- its window ended (<cause>, <ticks> ticks, <at>); arm it with shadow-window.mjs --arm`. It used to enable it, so the single remedy every message names undid what `host:check` calls `EXPECTED DISABLED -- ITS WINDOW ENDED`. A timer disabled with no stop row, one re-armed after its stop, and an enabled one are enabled as before, and the `host:check` note no longer says `host:install` would restart it (a11ign/a11ign#3484).
