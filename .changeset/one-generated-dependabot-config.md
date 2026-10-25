---
"agent-org": patch
---

The tool depends on `@a11ign/toolchain` `^0.11.0` (was `^0.7.0`), the release that carries `dependabot-config` (A11-253, under A11-251). `.github/dependabot.yml` of this repository is now that command's output, and `src/packaging/dependabot-config.test.ts` fails when it differs. The tool's own code is unchanged: the `lib/*` helpers it imports and the six copies `bootstrap-copies-match-toolchain.test.ts` compares behave the same at 0.11.0.
