---
"agent-org": minor
---

Engineer routing (`model-routing`) decides on the provider's probabilities with thresholds scaled to what a wrong route costs, not on a confidence floor that demanded p >= 0.85 of a yes/no: Haiku/high needs P(mechanical = yes) >= 0.65 and P(score <= 2) >= 0.6, Sonnet/medium needs P(score <= 3) >= 0.6 and P(subsystems = yes) < 0.5, and anything else is Sonnet/high. Every answer in the decision log now carries the provider's whole `probabilities`, a score's keyed by the 1..5 level. The refusals (`.github/workflows/`, no Acceptance command, `lane:ceo`, `needs:chairman`) and the no-provider fallback are unchanged. a11ign/a11ign#4875.
