---
"agent-org": patch
---

Every routing record now carries its reason on the line a person reads (a11ign/a11ign#4736). The decision log's outcome line is `route <route> via <via> (<why>)`, and the work tick's `routed ...` journal line prints the same text: for a `fallback` the provider's own failure (the switch off, no provider declared, the state too large, the API's HTTP status, a timeout, an answer under the floor with its value and confidence, a malformed answer), for `refused` what refused the row, for `override` the label and, when Haiku was refused, the refusal, and for `jev` the answers that composed the route, an answer not given saying why. A `tier:haiku` refusal reads `tier:haiku was refused: <why>`. A test per `via` pins the line, and a named case pins that a fallback after the API's HTTP 422 carries the failure's text rather than `a small row`.
