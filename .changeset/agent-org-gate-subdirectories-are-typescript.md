---
"agent-org": patch
---

The slice of the gate's subdirectories that plain `node` never loads is TypeScript: the rstest config, `update-primary-argv` and two work-gate tests are `.ts`, converted by `js-to-ts` (a11ign/a11ign#4271). The 29 sources a plain-`node` entry imports stay `.mjs`, and so do the CI scripts that run before any install.
