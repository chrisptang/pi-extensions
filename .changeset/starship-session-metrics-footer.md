---
"@narumitw/pi-starship": minor
---

Make the built-in footer a two-line environment and session-metrics layout. Context now always shows tokens, window, and percentage with thresholds used only for color. The metrics row reports cumulative inclusive input, output, token-weighted session cache rate, and reported cost; it distinguishes unavailable usage from measured zero and labels subscription-backed amounts as estimates.

`$tokens.total_input` adds the explicit cumulative prompt input value (`input + cacheRead + cacheWrite`) while existing `$input` and `$total` retain their meanings. `$cache.session_rate` provides the new session rate while `$rate` remains the latest assistant-request rate.
