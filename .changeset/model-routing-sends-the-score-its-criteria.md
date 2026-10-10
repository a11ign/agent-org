---
"agent-org": patch
---

Model routing's provider call is no longer rejected with HTTP 422. `wire()` (`src/decision-provider.ts`) sent the `score` question as `{type, instructions}`; the API requires `criteria`, an ordered array of level descriptions, and one invalid question rejects the whole request, so all 15 routed starts on a11ign fell back (`"via":"none"`, reason `the API answered HTTP 422`) while the journal read the same as before the switch. A `score` question now carries its five `levels` and sends them as `criteria`. The API scores a level by its position from zero and answers fractionally (`0.04` for the first level), so `readAnswer` rounds to the nearest level and moves it onto the 1..5 scale the callers use; a position that rounds outside the five levels is still malformed.

A fallback now says why where the log can be read: the `route … via fallback` outcome line (and the journal's `why`) carries the reason (switch off, no provider, HTTP error, timeout, state too large, malformed answer), a `jev` route held to Sonnet/high lists the answers not given and why, a refused row says what refused it, and a switches file that exists and cannot be used says so instead of reading as a use that is simply off. A test pins the wire: the posted body is validated against the API's schema with the recorded 200 as the fake's answer.
