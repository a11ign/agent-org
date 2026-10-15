---
"agent-org": patch
---

The tick's teardown ends a worker seat that herdr lists with no pane (`paneless`) once every row it held is CLOSED: its workspace closes and the line `treated N listed agents with no pane as ended` stops repeating (a11ign/agent-org#1519). A paneless seat that still holds an open row, a paneless seat whose row GitHub could not read, and a plain `unknown` seat still starting up are left running.
