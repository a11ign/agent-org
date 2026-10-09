`duplicateOf` in the board-truth audit no longer raises the row of record as the duplicate. It took a twin when `other.state === "CLOSED" || other.number < row.number`, so an open row with a CLOSED row filed AFTER it was asked to resolve a pair that was already resolved. A twin now counts only when its number is lower than the row's, open or closed. Seen live: #4623 (open, hand-reroute class row) against the closed #4624 (owner-unresolved, same title template) produced a `board-disagrees-with-reality` order to `product-manager` that sat deferred ("is working") for 30+ ticks, which is what the `1 order(s) had nowhere to go` repeating line was.

Acceptance:

```bash
cd /home/agent/repos/agent-org-wt-507 && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import tsx -e 'import("./src/board-truth-audit.ts").then(m=>{const t=(n,s,x={})=>({number:n,title:"Failure class "+x.k+" repeated: make its guard stop it everywhere",body:"",state:s,stateReason:s==="CLOSED"?"COMPLETED":null,labels:s==="OPEN"?["ready"]:[],...x});const facts=(o,c)=>({now:Date.now(),openRows:o,closedRows:c,mergedPrs:[],liveSessions:[],waitFacts:{items:{}}});const n=(o,c)=>m.boardTruthAudit(facts(o,c)).findings.filter(f=>f.question===m.QUESTIONS.DUPLICATE).length;console.log("later closed twin:",n([t(4623,"OPEN",{k:"hand-reroute"})],[t(4624,"CLOSED",{k:"owner-unresolved"})]),"earlier closed twin:",n([t(4624,"OPEN",{k:"owner-unresolved"})],[t(4623,"CLOSED",{k:"hand-reroute"})]))})'
```

Closes a11ign/agent-org#507

Measured: that command printed `later closed twin: 1 earlier closed twin: 1` on main and `later closed twin: 0 earlier closed twin: 1` on this branch (the second number is the control). Test (6) gains the closed-later-twin negative and its control (the same pair with the closed twin first is still found). The seeded BOARD's closed twin moved from #51 to #9 so it stays filed before open #14 (the emptiness control needs the duplicate question to fire). Locally the file is 43 of 45 with or without this change: two tests that assert `--repo a/b` on `gh` argv fail on untouched main here, so they are not this change.

Mutation: none -- the new test cases fail on main (the later-closed-twin negative) and the probe above shows both outcomes, so the change is its own mutant.

platform: n/a (audit reader)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
