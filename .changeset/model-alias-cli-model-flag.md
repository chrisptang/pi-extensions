---
"@chrisptang/pi-model-alias": minor
---

Start a session on an alias with `pi --model <alias>`.

Pi resolves `--model` against its own model catalog before any session exists, and that path exposes no extension hook, so an alias name was fuzzy-matched to whichever catalog model looked similar. `pi --model sonnet` could land on an unrelated provider's model and fail at the first request with a missing-credentials error.

The startup `--model` value is now read back from `process.argv` and re-resolved against the alias map once the session starts, applying the same candidate pick, held model, and thinking level as `/ma <alias>`. Because the correction lands after Pi has already selected a model, the startup header can briefly show Pi's own match, and an alias name that collides with a real model now resolves to the alias.

A value that is not a configured alias is left to Pi untouched, so ordinary `--model` patterns and `provider/model-id` references are unaffected. An explicit `--provider` also defers to Pi, since that pairing addresses the catalog directly. An alias with no usable candidate keeps the model Pi chose and reports why. Only the initial startup consults the flag, so a later `/new`, `/resume`, or fork keeps the session's current model.
