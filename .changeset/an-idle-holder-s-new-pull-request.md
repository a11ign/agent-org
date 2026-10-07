---
"agent-org": patch
---

An idle holder whose own pull request is younger than `STALL_INTERVAL_MS` is no longer sent the idle nudge (a11ign/a11ign#4017). Five `claim-stalled` nudges in three days were typed while a pull request closing the row was open (#3560, #3591, #3719, #3787, #3993): the #2999 overlay's N of 45 minutes was derived from the gap between a claim and its first pull request, and fired 52 to 74 minutes after the pull request opened, before the gate had asked anybody to review it, while the review took 69 to 162 minutes. A pull request with no readable age, one past the interval, and a holder with no pull request are nudged as before.
