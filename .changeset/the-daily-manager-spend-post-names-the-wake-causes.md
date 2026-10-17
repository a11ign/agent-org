---
"agent-org": patch
---

`trace manager-spend` names the day's wakes by cause (a11ign/agent-org#1699). Under the first table it prints a second one, `Wakes by cause, largest first`: each cause's wakes, the wakes a run served, and its share of the day's wakes, with a wake that carries no cause shown as `(no cause)`. The rows add up to the day's wake total. The first table is unchanged, byte for byte, and `managerSpendReading` returns the same rows under a new `causes` field.
