A `release:*` announcement quotes a change log, so none of its words is read as asking the chairman: a line ending in `?`, a `needs:chairman` / `answer:` marker and the word "reply" are not asks for that key. `announcementAsks(key, text)` in `src/messaging/audit.ts` is the one predicate; the delivery guard in `core.ts` and the detector `misuseOf` both read it. Every other announcement kind is still read for all three checks, and a non-release "reply here" or a non-release line ending in "?" is still refused.

Acceptance: `node --test src/messaging/audit.test.ts src/messaging/core.test.ts`

Mutation: the release exemption removed from `announcementAsks` (the predicate reads `asksSomething(text)` for every key) failed 4 of 76 tests; `audit.ts` restored from a copy and byte-identical on `diff`.

Measured: `ℹ tests 76`, `ℹ pass 76`, `ℹ fail 0` for the acceptance command.
