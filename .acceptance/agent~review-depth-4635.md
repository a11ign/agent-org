`src/review-depth.ts` adds the review-depth seam (#4635): `reviewDepth(state, deps)` returns `light`, `normal` or `full` as data. Code decides first: a workflow, an auth or token path, `SECURITY.md`, `.claude/rules/` or a closed row's gate-bearing path is `full` and nobody is asked. Otherwise three atomic questions (docs or tests only; changes observable behaviour; mainly deletes) over a trimmed state (paths, counts, title), composed in code. No provider, no key, switched off, refusal, timeout or low confidence is `normal`, today's order. `raiseDepth` lets a reviewer raise and never lower. The call site, `src/wake.ts`, is not in this row's Region and is not touched.

Acceptance:

```bash
cd /home/agent/repos/agent-org-wt-4635 && AGENT_ORG_HOST=/home/agent/repos/wt-4635/.agent-org/host.json npx rstest run --config scripts/rstest/rstest.config.ts src/review-depth.test.ts
```

Closes a11ign/a11ign#4635

Measured: the command printed `VERDICT pass: 8 tests in 1 file`. Mutation, each run against the test file and restored byte-identical (diff): never-full-by-code fails 2 tests (the risky-path and Closes cases); fallback-never-normal fails the provider-absent test; `raiseDepth` lowering fails its test; the composed depth always `full` fails the provider-on test.

platform: n/a (a seam over the existing decision provider, `decide`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
