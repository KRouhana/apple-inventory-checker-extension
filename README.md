# Inventory Signal

A Chrome extension that watches Apple retail pickup availability and alerts you
when a selected phone is available at a selected store. Monitoring runs locally
while Chrome is running and the computer is awake and connected.

## Get the extension

**Chrome Web Store — coming soon.** The store link will be added when available.

Want to install from GitHub now? Follow the [installation guide](docs/install.md)
for downloads, setup and updates.

[Website](https://krouhana.github.io/apple-inventory-checker-extension/)
· [Privacy](site/privacy.html) · [Security](SECURITY.md)

## What it does

- iPhone 18 Pro, iPhone 18 Pro Max and iPhone Duo in Canada, the US and UK.
- Postal-code store lookup and multiple selected stores per watch.
- Checks every 2–60 minutes, with backoff for failed requests.
- Desktop alerts and optional personal Telegram bot notifications.
- A compact watch popup and matching **Open at Apple** product links.

Unknown results remain unknown; they are never treated as out of stock.
Apple can reject requests, and availability can change before checkout.
The extension does not reserve stock, place orders or automate Apple login.
Chrome must remain available for checks; a sleeping computer cannot monitor.
Firefox, Safari, a hosted checker and hosted notification services are outside
the current Chrome release. Shared platform abstractions remain for possible future work.

## Data and updates

Watches and history stay in this browser profile. Apple receives lookup/check
requests and Chrome may attach its existing Apple session cookies. The
extension does not read or extract cookie values. Optional Telegram connects
directly to Telegram; its saved connection is encrypted locally.

To update a manual installation, replace files in the same folder and use
**Reload** in Chrome. Do not remove the extension just to update it. Installing
from a new path or the Chrome Web Store may create a separate installation;
settings are not automatically transferred. Never export tokens or browser data
to GitHub. Disconnect Telegram separately from clearing monitor data.

## Development

Node.js 24+, pnpm 10.32.1, and `zip`/`unzip` are required.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run ci
```

`pnpm build` writes `apps/extension/dist/chrome`; `pnpm package` creates the
installable ZIP and SHA-256 checksum under `apps/extension/release`.
`site/` is static HTML/CSS served by GitHub Pages, without a backend or build.
The catalog is a validated public metadata snapshot, not a live-stock cache.

This is a clean Chrome-focused repository. It does not contain the earlier
private service repository's history, operational evidence or user data.

Independent software, not affiliated with or endorsed by Apple, Google or
Telegram. Licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE.md).
