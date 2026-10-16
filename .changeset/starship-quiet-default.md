---
"@chrisptang/pi-starship": minor
---

Replace the built-in footer with a quiet, iconless two-line layout: workspace and live activity at left, model and thinking at right, then inclusive session input, output, context, and precise reported cost including tools. Use theme-aware warnings and errors and adaptively middle-shorten long workspace, branch, and model labels without shortening usage.

Add activity `$live`/`$live_style` and Git status `$summary`/`$summary_style` variables while preserving legacy `$text`, `$all_status`, public module defaults, custom TOML (including empty files), and presets. Missing or malformed settings use the new fallback without writing a file; migrating an existing document requires explicitly confirmed Restore built-in replacement.
