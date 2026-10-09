---
"agent-org": minor
---

Every source file is `.ts`, run by `node file.ts` with no loader. The 110 held-back `.mjs` under `src/` were renamed (history kept), `tsx` left `dependencies`, and `engines.node` is `>=24`, so Node strips the types itself (`process.features.typescript` prints `strip`). The six units (kernel-reboot, otel-receiver, shadow-window, tmp-prune, trace-publish, work-tick) name `%h/.local/bin/node` and a `.ts`, and the work-tick `--import=` preload is `src/lib/crash-exit.ts`. The `bin` and every `exports` entry name a `.ts`, and `@a11ign/toolchain` stays a dev dependency. Node refuses to strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, measured on 24.21.0), so the tool runs from a checkout outside it, through `host/agent-org`; a copy installed under `node_modules` can be read but not run. a11ign/a11ign#4389.
