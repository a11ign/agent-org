---
"agent-org": patch
---

`ticket:ui` serves the built board UI at `/next/` (A11-190), beside the board at `/`, behind the same browser pairing and the same `/api/connections` and `/c/<connection>/api/...` routes to each instance, so a page built there shows this machine's instance or a remote one as today's board does. It looks for the build in `ui-build/` beside the running version, then in the checkout's `ui/dist/`. A client-side route falls back to the nearest page above it, files under `_astro/` are cached for a year, pages and other files are `no-cache`, and a path out of the build is a 404. With no build, `/next` answers a plain 503 page saying the build is missing and how to get it, never a stack trace. `/` and `/api/*` are unchanged.
