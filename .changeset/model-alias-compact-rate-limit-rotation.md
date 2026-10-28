---
"@chrisptang/pi-model-alias": patch
---

Rotate the `compact` alias within the same compaction after HTTP 429 or 503 failures, sharing ordinary alias cooldowns and never retrying an exhausted candidate. Preserve current-model fallback for other failures and stop immediately on cancellation.
