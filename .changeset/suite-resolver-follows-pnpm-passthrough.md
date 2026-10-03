---
"agent-org": patch
---

The whole-suite resolver follows a script's delegation through the project's pnpm passthrough, `node scripts/pnpm.mjs run <script>`, as well as `pnpm run <script>` (a11ign/a11ign#3151). It matched only the second, so a project whose `test` script chains through the passthrough (to run on a box with `corepack pnpm` and no `pnpm` on PATH) resolved `test` to no `*.test.ts` glob and refused every whole-suite acceptance. The passthrough is recognised by its file name, `pnpm.mjs`; a runner of any other name is not followed.
