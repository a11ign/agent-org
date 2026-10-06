---
"agent-org": patch
---

The gh call ledger's caller test no longer fails under a long `TMPDIR` (a11ign/a11ign#3807). The ledger keeps the first 160 characters of the parent's command line, so a fake caller spawned by an absolute path under an agent session's scratchpad was cut before its script name. The test now spawns it as `fake-caller.sh` from inside its directory. Test only: `host/gh` is unchanged, because a caller line cut at 160 characters is its documented shape.
