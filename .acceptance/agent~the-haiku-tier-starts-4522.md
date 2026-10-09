Haiku-tier workers start at `--effort high`, the same as the Sonnet workers, not `low`. `HAIKU_EFFORT` was the floor of `CLAUDE_EFFORTS`, assumed and never measured. `low` would confound the #4382 trial, since a Haiku failure could not be told apart from the effort. Haiku output is cheap, so the extra thinking costs far less than one wrong PR.

Evidence: `haiku-tier.test.ts` 10/10 pass at `high`. Mutation back to `CLAUDE_EFFORTS[0]` turns exactly the effort assertion red (1 of 10), and the restore was byte-identical. `pnpm run typecheck` shows 3 errors, all `Cannot find module '@a11ign/toolchain/mjs-ratchet'` in `mjs-ratchet.test.ts`, which this diff does not touch; none in the touched files. The repo has no `lint` script.

Acceptance: `bash -c 'cd "$AGENT_ORG_TOOL" 2>/dev/null || cd ~/repos/agent-org; grep -nE "HAIKU_EFFORT = \"high\"|HAIKU_EFFORT = CLAUDE_EFFORTS\[[0-9]\]" src/worker-profile.ts && ! grep -n "HAIKU_EFFORT = CLAUDE_EFFORTS\[0\]" src/worker-profile.ts'`

Closes a11ign/a11ign#4522

platform: n/a (a one-constant change plus its pin)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
