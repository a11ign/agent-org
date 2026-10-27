---
"agent-org": patch
---

Doctor's `merge flow` row reads every repository of each organisation that owns a clone of the host, not only the repositories the clones name, so a new repository fails it until it is set up (A11-274, step 4 of 4). A repository's arm flow now also needs an active ruleset with a merge queue that requires `gate`, as A11-237 set it up: auto-merge and `auto-arm.yml` arm nothing without the queue. An archived repository is passed over, a private repository still passes with the merge bot (A11-291), and a cloned repository the listing does not hold is read by name. An organisation whose listing fails fails the row. `node plugins/github/merge-flow-command.ts --owner a11ign` prints the row from a checkout and exits 1 while any repository lacks the flow.
