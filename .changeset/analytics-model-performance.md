---
"@chrisptang/pi-analytics": minor
---

Add a Model performance dashboard tab reporting per-model TTFT and output tok/s distributions (average, p95, maximum). TTFT is measured from request start to the first provider stream event, recorded through a new `first_token_at_ms` column that older databases gain through an idempotent migration.
