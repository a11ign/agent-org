---
"agent-org": patch
---

`agent-org doctor` now asks a service's port whether or not the service is registered. A service started by hand used to read "nothing answers" although it did. It now reads as answering, and the registration check says it was probably started by hand and how to register it so it starts at login.
