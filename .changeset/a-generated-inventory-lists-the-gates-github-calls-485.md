---
"agent-org": minor
---

`docs/gh-call-inventory.json` lists every GitHub call site the tool's non-test `.ts` and `.mjs` make, per file: the `gh` spawn sites, the shapes (`issue list`, `api graphql`, ...) counted as array literals, the label constants and label-flag arguments it names, and whether it parses a `Closes` line; and per declared cause, the inventory files that name it. `node --import tsx src/packaging/gh-call-inventory.ts` rewrites it. `src/packaging/gh-call-inventory.test.ts` fails when the committed file differs from a fresh scan, and when a file with a call whose first argument is the quoted command is not in it. Phase 0 of a11ign/a11ign#4505 (the ticket port, D1b, is cut against this list). a11ign/agent-org#485.
