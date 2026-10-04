---
"agent-org": patch
---

The "Do it for me" press writes the line `chairman:queue add` accepts as his OK (a11ign/a11ign#3581, D1b of #3409). `answers.mjs` used to answer a `forme` press "not available yet" and write nothing; it now writes ONE ledger line, `{direction: "answer", step: "forme", via: "button", messageRef}` (`FORME_STEP`, the constant `session-queue.mjs` verifies), once per message: a second press on the same message writes nothing and says so. The press is not an answer: the request's label is untouched and nobody is woken, and he is told in plain words that his session was asked and nothing happens until it reads the queue, never what the queue holds. The ask itself is still the liaison's `chairman:queue add`.
