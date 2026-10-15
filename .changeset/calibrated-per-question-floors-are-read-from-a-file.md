---
"agent-org": minor
---

The decision provider reads calibrated per-question confidence floors from `.agent-org/confidence-floors.json` (`{ "<use>.<question>": 0..1 }`), beside `decisions.json` and not in it, so the switches file still holds booleans only. A question's floor is its own `minConfidence` when it has one, then its calibrated floor, then the host's floor. An absent file means no calibrated floors, quietly; one that cannot be used says so once and every question takes the host's floor (agent-org#1445, #1205 Change 3).
