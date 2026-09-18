# Contributing

Focus this repository on the Chrome extension and its static documentation site.
Use small branches and pull requests. Run `pnpm run ci` before submitting changes.
Do not add remote executable code, new permissions, telemetry or other browser
distribution without an explicit product decision.

Keep upstream failures unknown. Preserve last successful observations separately.
Never store personal postal input or provider response bodies. Public product and
store metadata are acceptable; tokens, chat IDs, browser data and cookies are not.

Tests use synthetic credentials and data only. Passing mocks is not evidence of
live provider delivery or installed-browser behavior. Apple checkout remains
manual, and website claims must match the actual tested product.
