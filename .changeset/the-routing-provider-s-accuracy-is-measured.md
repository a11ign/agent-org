---
"agent-org": patch
---

`node src/route-accuracy.ts --repos=<checkout>,<checkout> [--log=<decisions>] [--ref=origin/main]` measures the routing provider's accuracy: each row's latest `model-routing` decision joined to the row's merged diff (`git diff --numstat <merge>^1 <merge>` less `.acceptance/` and `.changeset/`), and for `score` and `mechanical` the share of answers that matched the diff, by confidence bucket (under 0.4, 0.4 to 0.55, 0.55 to 0.7, 0.7 and over) and under 0.7 against 0.7 and over. The answer scored is the one the provider gave, not the fallback that replaced it; a row named as an example in the criteria is held out and counted; a bucket under 10 decisions prints `n=<k>, not a rate`; a decision with no merged pull request is named; `subsystems` and `debugging` print `NOT MEASURED`. The reading is `routeAccuracy` in `src/route-accuracy.ts` and is pure. a11ign/agent-org#688, use 4 of a11ign/a11ign#4627.
