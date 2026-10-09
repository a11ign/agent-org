`readClosedAnswerRows` no longer reads a repository with no `answer:` label as a refusal. `gh label list --json` prints zero bytes (not `[]`) when nothing matches, so `JSON.parse("")` threw and the reader returned `null`; the gate then printed `NOTE: could not read the closed rows that still owe an answer` on every tick since agent-org became a declared tracker (325 ticks, 09:27Z to 20:40Z on 2026-10-09). An empty stdout is now `[]`; unparseable text, a non-array and a thrown `gh` stay `null`.

Acceptance:

```bash
cd /home/agent/repos/agent-org-wt-472 && GH_REPO=a11ign/agent-org AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx -e 'import("./src/work-gate.ts").then(m=>{const r=m.readClosedAnswerRows();console.log(r===null?"null":"rows:"+r.length)})'
```

Closes a11ign/agent-org#472

Measured: that command printed `null` on main and `rows:0` on this branch. `closed-pr-answer-owed.test.ts` is 11/11 here and the new test fails (1 of 11) with `work-gate.ts` reverted. Item 3 of the row: the other `JSON.parse(run(...))` readers in `work-gate.ts` use `issue list` / `pr list` / `api`, which print `[]` or an object when empty; only `label list` was seen printing zero bytes, so no other row is filed.

platform: n/a (gate reader)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
