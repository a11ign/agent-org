---
"agent-org": patch
---

A chairman brief whose `Ask:` or a `Steps:` item names a worker and asks for a hand act on it (press, click, restart, power on or off, log in, at the console) is refused, and nothing is sent, unless the brief has an `Ansible tried: <playbook> -l <worker>, failed: <log path or comment url>` line. The fleet is managed through Ansible (a11ign/a11ign#4405), so the refusal names that line and says to file an Ansible row instead. A ceo brief of 2026-10-15 asked him to press "Restart now" on worker 15 and was sent like any other brief (agent-org#1566). A brief that names no worker, a worker named in a decision, and a hand act on his own machine are sent unchanged.
