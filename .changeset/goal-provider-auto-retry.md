---
"@chrisptang/pi-goal": patch
---

Automatically retry an active Goal after Pi exhausts transient provider retries, with backoff starting at 3 seconds, doubling to a 30-second cap, for up to 10 consecutive attempts before falling back to the follow-up wait.
