---
"@narumitw/pi-btw": patch
---

Adapt side-thread completions to Pi 1.1's branded `TranscriptContext` provider contract by normalizing the context before calling `provider.streamSimple`, matching the new required call shape.
