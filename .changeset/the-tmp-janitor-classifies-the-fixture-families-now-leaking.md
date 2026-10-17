---
"agent-org": patch
---

The tmp janitor classifies the fixture families that now fill `/tmp`. The timer's run found nothing to remove on 2026-10-17 (`0 classified path(s)`) while `/tmp` held 6,939 entries, because the test suites of this host's other repositories write their fixtures there and `FIXTURE_PREFIXES` named only agent-org's own. The list now carries those prefixes, grouped by the repository that makes them. The removal budget, the pause, the niced unit and the one-hour window are unchanged.
