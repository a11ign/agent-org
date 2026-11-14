---
"agent-org": patch
---

The README is a short front page (under 150 lines) with a table linking a page for each task under `docs/guide/`: install, onboard, services, ticket mode, configuration, plugins, other machines' instances, troubleshooting, and working on agent-org. The text moved as it was, with headings one level up and relative links written from the page's folder; the Releases section stays in the README. The host-file key table is now in `docs/guide/configuration.md`, and `readme-keys.test.ts` reads it there. A new test keeps the README under 150 lines, linking to the six task pages, and checks that every relative link in the README and the guide pages names a file that exists. The package now ships `docs/guide/`, so the README's links resolve in an installed copy.
