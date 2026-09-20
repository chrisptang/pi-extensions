---
"@chrisptang/pi-model-alias": minor
---

Hold an alias on one model per session, and rotate off a candidate the provider rate-limits.

A multi-candidate alias previously redrew at random on every switch, so repeated `/ma pool` could land on a different model each time and reset the prompt cache. An alias now draws once and holds that model for the session, reporting `(held)` on later switches. Held picks are released by a new session and by `/model-alias-reload`, since reloaded definitions may no longer list the held candidate.

A `429` or `503` now puts the candidate on cooldown and rotates the alias onto another one. The cooldown length follows the same header precedence as Pi's own provider retry — `retry-after-ms`, then `retry-after` as either seconds or an HTTP-date — falling back to 60 seconds, capped at 15 minutes so a long quota reset cannot sideline a candidate for the whole session, and extended rather than shortened by a repeat limit. When every candidate is cooling down the alias still picks one, because the limit may have lifted early.

Rotation applies from the next turn rather than the failing request: `after_provider_response` reports the status but cannot alter the request in flight, so Pi's own retry handles the current one. A limit is attributed to the model the alias last switched to and ignored once something else has changed the model, and a single-candidate alias reports the limit without switching.
