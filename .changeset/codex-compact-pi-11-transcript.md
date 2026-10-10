---
"@narumitw/pi-codex-compact": patch
---

Adapt remote compaction requests to Pi 1.1's branded `TranscriptContext` provider contract by normalizing the request context before calling `provider.stream`, matching the new required call shape.
