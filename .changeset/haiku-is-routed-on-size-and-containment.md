---
"agent-org": patch
---

Haiku/high is chosen on size and containment, not on `mechanical` (a11ign#4902). P(mechanical=yes) had a median of 0.10 on the decision log and never reached 0.65, so the router sent nothing to Haiku. `takesHaiku` now takes a row with P(score <= 2) >= 0.6, or P(score <= 3) >= 0.9 with P(subsystems=yes) <= 0.1 and P(debugging=yes) <= 0.25; a reading not given is not containment. `mechanical` is still logged and decides only an unscored row in a small Region. The Sonnet/medium rule, the debugging hold, the refusals and the no-provider fallback are unchanged.
