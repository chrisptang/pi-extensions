---
"@chrisptang/pi-model-alias": patch
---

Fix `/new` dropping the current model: Pi loads a fresh extension instance for the replacement session, so the carried model and thinking level now travel through a process-wide slot instead of the old instance's closure.
