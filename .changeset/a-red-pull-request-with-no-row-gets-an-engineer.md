---
"agent-org": patch
---

A red pull request that has no ready row now gets an engineer. Its `pr-checks-failing` order was addressed to the engineer pool and refused whenever every engineer had held a row, and nothing started a process for it, so it could stay red and undelivered for hours (a11ign/agent-org#1520, a11ign/a11ign#5528). The pilot now starts one engineer for that pull request, named for the pull request, and starts no second one while it runs. It takes no row, so no claim is made, and the same host load, pace and memory limits apply as to any other start.
